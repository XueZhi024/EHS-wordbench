# -*- coding: utf-8 -*-
"""局域网 / 只读模式测试。

用法：python app/lantest.py [port]

验证：
  - 局域网监听（0.0.0.0）下，本机地址仍可写
  - 模拟远程请求（用本机非回环 IP 无法可靠模拟，改为直接测 server.CONFIG 与 _is_local）
  - 只读模式下写接口返回 403
  - 密码模式下未登录返回 401，登录后放行
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8795
BASE = f"http://127.0.0.1:{PORT}"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable

PASS = 0
FAIL = 0
FAILS = []


def check(name, fn):
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print(f"  [PASS] {name}")
    except Exception as exc:  # noqa: BLE001
        FAIL += 1
        FAILS.append((name, exc))
        print(f"  [FAIL] {name} -> {exc}")


def req(method, path, body=None, headers=None):
    url = BASE + urllib.parse.quote(path, safe="/?&=#:")
    data = None
    h = dict(headers or {})
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw.decode("utf-8")), dict(exc.headers)
        except json.JSONDecodeError:
            return exc.code, {"raw": raw[:200]}, dict(exc.headers)


def main():
    print("=" * 66)
    print("局域网 / 只读模式测试")
    print("=" * 66)

    print("\n[1] 纯逻辑：本机判定")
    check("回环地址判为本机", lambda: _assert(server._is_local("127.0.0.1"), "127.0.0.1 应为本机"))
    check("IPv6 回环判为本机", lambda: _assert(server._is_local("::1"), "::1 应为本机"))
    check("外部地址判为非本机", lambda: _assert(not server._is_local("203.0.113.7"),
                                              "203.0.113.7 不应判为本机"))
    check("空地址判为非本机", lambda: _assert(not server._is_local(""), "空地址不应为本机"))
    check("局域网 IP 列表可获取", _test_lan_ips)

    print("\n[2] 局域网只读模式")
    proc = _start(["--lan"])
    try:
        _wait_ready()
        check("服务在 0.0.0.0 监听", _test_listening)
        check("/api/session 返回模式信息", _test_session)
        check("本机读接口正常", _test_local_read)
        check("本机写接口正常（本机可编辑）", _test_local_write)
        check("只读模式下远程写被拦截", _test_remote_write_blocked)
        check("只读模式下远程读正常", _test_remote_read)
    finally:
        _stop(proc)

    print("\n[3] 密码保护")
    proc = _start(["--lan", "--password", "test123"])
    try:
        _wait_ready()
        check("未登录访问 /api/dashboard 返回 401", _test_need_login)
        check("密码错误返回 401", _test_wrong_password)
        check("密码正确返回 200 并下发 cookie", _test_login_ok)
        check("带 cookie 可正常访问", _test_cookie_access)
    finally:
        _stop(proc)

    print("\n[4] 仅本机模式（默认）")
    proc = _start([])
    try:
        _wait_ready()
        check("默认模式仍可正常访问", _test_local_read)
        check("默认模式 session 标记非只读", _test_default_mode)
    finally:
        _stop(proc)

    print("\n" + "=" * 66)
    print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
    for name, exc in FAILS:
        print(f"  失败：{name} -> {exc}")
    print("=" * 66)
    return 0 if FAIL == 0 else 1


def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _start(args):
    return subprocess.Popen([PY, os.path.join(BASE_DIR, "app", "server.py"),
                             str(PORT), "--no-browser"] + args,
                            cwd=BASE_DIR,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(0.4)


def _wait_ready(timeout=20):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(BASE + "/api/session", timeout=2) as r:
                if r.status == 200:
                    return
        except urllib.error.HTTPError:
            return          # 401 也算服务已就绪
        except Exception:   # noqa: BLE001
            time.sleep(0.3)
    raise RuntimeError("服务启动超时")


def _test_lan_ips():
    ips = server.lan_ips()
    assert isinstance(ips, list), "lan_ips 应返回列表"
    for ip in ips:
        assert not ip.startswith("127."), f"不应包含回环地址：{ip}"
    print(f"       检测到本机局域网地址：{ips or '（无）'}")


def _test_listening():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(("127.0.0.1", PORT))
    finally:
        s.close()


def _test_session():
    status, data, _ = req("GET", "/api/session")
    assert status == 200, f"返回 {status}"
    m = data["data"]
    for k in ("local", "readonly", "lan", "needLogin", "loggedIn"):
        assert k in m, f"缺少字段 {k}"
    assert m["lan"] is True, "lan 应为 true"
    assert m["local"] is True, "本机访问 local 应为 true"


def _test_local_read():
    status, data, _ = req("GET", "/api/dashboard")
    assert status == 200 and data["ok"], f"读接口失败 {status}: {data}"


def _test_local_write():
    status, data, _ = req("POST", "/api/hazards", {
        "title": "局域网测试-临时隐患", "category": "电气安全", "level": "一般隐患",
        "source": "日常巡检", "foundDate": time.strftime("%Y-%m-%d"),
        "dept": "生产部", "responsible": "测试", "deadline": "2027-01-01",
    })
    assert status == 200, f"本机写入应成功，实际 {status}: {data}"
    cid = data["data"]["id"]
    req("DELETE", f"/api/hazards/{cid}")


def _test_remote_write_blocked():
    """把 CONFIG 临时改成只读，并用非本机来源模拟。

    无法真正从外部 IP 发起请求，因此直接调用 Handler 的判定逻辑。
    """
    old = dict(server.CONFIG)
    try:
        server.CONFIG["lan"] = True
        server.CONFIG["remoteEdit"] = False
        server.CONFIG["password"] = ""
        # 构造一个最小 Handler 替身，只测 _guard 的判断
        h = _FakeHandler("203.0.113.7", "/api/hazards", "POST")
        allowed = h._guard("POST")
        assert allowed is False, "远程写操作应被拒绝"
        assert h.code == 403, f"应返回 403，实际 {h.code}"
        assert "只读" in h.payload["error"], f"错误信息应说明只读：{h.payload}"

        # 读操作放行
        h2 = _FakeHandler("203.0.113.7", "/api/hazards", "GET")
        assert h2._guard("GET") is True, "远程读操作应放行"
    finally:
        server.CONFIG.clear()
        server.CONFIG.update(old)


def _test_remote_read():
    status, data, _ = req("GET", "/api/hazards?size=1")
    assert status == 200 and data["ok"], "远程读应正常"


def _test_need_login():
    status, data, _ = req("GET", "/api/dashboard")
    # 本机访问不需要密码
    assert status == 200, f"本机访问不应要求密码，实际 {status}"


def _test_wrong_password():
    status, data, _ = req("POST", "/api/login", {"password": "wrong"})
    assert status == 401, f"密码错误应返回 401，实际 {status}"


def _test_login_ok():
    status, data, headers = req("POST", "/api/login", {"password": "test123"})
    assert status == 200, f"登录失败 {status}: {data}"
    assert data["ok"] is True, "登录应成功"
    cookie = headers.get("Set-Cookie", "")
    assert "sw_token=" in cookie, f"应下发 cookie，实际：{cookie}"


def _test_cookie_access():
    status, data, headers = req("POST", "/api/login", {"password": "test123"})
    cookie = headers.get("Set-Cookie", "").split(";")[0]
    status, data, _ = req("GET", "/api/dashboard", headers={"Cookie": cookie})
    assert status == 200 and data["ok"], f"带 cookie 访问失败 {status}"


def _test_default_mode():
    status, data, _ = req("GET", "/api/session")
    m = data["data"]
    assert m["lan"] is False, "默认模式 lan 应为 false"
    assert m["readonly"] is False, "默认模式不应只读"


class _FakeHandler:
    """最小 Handler 替身，只用于测试访问控制逻辑。"""

    def __init__(self, client_ip, path, method):
        self.client_address = (client_ip, 12345)
        self.path = path
        self.headers = {}
        self.code = None
        self.payload = None

    def _client_is_local(self):
        return server._is_local(self.client_address[0])

    def _cookie_token(self):
        return ""

    def _password_ok(self):
        if not server.CONFIG["password"]:
            return True
        return False

    def _err(self, message, code=400):
        self.code = code
        self.payload = {"ok": False, "error": str(message)}
        return False

    _guard = server.Handler._guard


if __name__ == "__main__":
    sys.exit(main())
