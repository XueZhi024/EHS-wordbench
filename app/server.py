# -*- coding: utf-8 -*-
"""本地 HTTP 服务：支持局域网访问，远程可设为只读。

启动参数：
    python app/server.py                    仅本机访问（默认）
    python app/server.py --lan              局域网可访问（远程只读）
    python app/server.py --lan --remote-edit 局域网可访问（远程可编辑）
    python app/server.py --lan --password 1234  局域网访问需密码
    python app/server.py 8080 --lan         指定端口
"""
from __future__ import annotations

import io
import ipaddress
import json
import mimetypes
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dashboard
import excel
import schema
import store

VERSION = "1.1.0"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "web")
DEFAULT_PORT = 8765

# 运行配置（由 serve() 写入，Handler 读取）
CONFIG = {
    "lan": False,            # 是否允许局域网访问
    "remoteEdit": False,     # 远程（非本机）是否允许写操作
    "password": "",          # 非空则要求密码
    "port": DEFAULT_PORT,
}


def find_port(start=DEFAULT_PORT, tries=30, host="127.0.0.1"):
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"端口 {start}-{start + tries - 1} 都被占用，请指定其它端口")


def lan_ips() -> list[str]:
    """列出本机可能用于局域网访问的 IPv4 地址。"""
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    # 通过 UDP 探测默认出口地址（不实际发包）
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.3)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip not in ips:
                ips.insert(0, ip)
    except OSError:
        pass
    out = []
    for ip in ips:
        try:
            addr = ipaddress.ip_address(ip)
            if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
                continue
            out.append(ip)
        except ValueError:
            continue
    return out


def _is_local(addr: str) -> bool:
    """判断请求是否来自本机。"""
    if not addr:
        return False
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    # 本机的局域网 IP 也算本机
    return addr in lan_ips()


class Handler(BaseHTTPRequestHandler):
    server_version = f"SafetyWorkbench/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---------------------------------------------------------- 工具
    def log_message(self, fmt, *args):
        if os.environ.get("SAFETY_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str,
              extra_headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _ok(self, data=None, **extra):
        payload = {"ok": True, "data": data}
        payload.update(extra)
        self._json(payload)

    def _err(self, message, code=400):
        self._json({"ok": False, "error": str(message)}, code)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise ValueError("请求体应为 JSON 对象")
        return data

    def _download(self, content: bytes, filename: str):
        quoted = urllib.parse.quote(filename)
        self._send(200, content,
                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                   {"Content-Disposition":
                    f"attachment; filename=\"download.xlsx\"; filename*=UTF-8''{quoted}"})

    # ---------------------------------------------------------- 访问控制
    def _client_is_local(self) -> bool:
        return _is_local(self.client_address[0])

    def _cookie_token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith("sw_token="):
                return part[len("sw_token="):]
        return ""

    def _password_ok(self) -> bool:
        """密码为空则始终通过；否则检查 cookie 或 Authorization 头。"""
        if not CONFIG["password"]:
            return True
        token = self._cookie_token()
        if token and token == _make_token(CONFIG["password"]):
            return True
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Basic "):
            import base64
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                return False
            _, _, pwd = decoded.partition(":")
            return pwd == CONFIG["password"]
        return False

    def _guard(self, method: str) -> bool:
        """返回 True 表示放行；False 表示已返回错误响应。"""
        local = self._client_is_local()

        # 远程访问且启用了密码：未通过则拒绝
        if not local and CONFIG["password"] and not self._password_ok():
            if self.path.startswith("/api/login"):
                return True
            self._err("需要密码访问，请先登录", 401)
            return False

        # 远程只读：写操作直接拒绝
        if not local and not CONFIG["remoteEdit"] and method in ("POST", "PUT", "DELETE"):
            if self.path.startswith("/api/login"):
                return True
            self._err("远程访问为只读模式，不能修改数据。请在本机操作。", 403)
            return False

        return True

    # ---------------------------------------------------------- 路由
    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        flat_query = {k: v[-1] for k, v in query.items()}

        try:
            if not self._guard(method):
                return
            if path.startswith("/api/"):
                self._api(method, path, flat_query)
            else:
                self._static(path)
        except BrokenPipeError:
            pass
        except ValueError as exc:
            self._err(exc, 400)
        except FileNotFoundError as exc:
            self._err(exc or "资源不存在", 404)
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._err(f"服务器内部错误：{exc}", 500)

    # ---------------------------------------------------------- API
    def _api(self, method: str, path: str, query: dict):
        parts = [p for p in path.split("/") if p]
        parts = parts[1:]
        if not parts:
            return self._err("缺少接口路径", 404)

        head = parts[0]

        if head == "login" and method == "POST":
            return self._login()

        if head == "health":
            return self._ok({"version": VERSION,
                             "counts": store.count_all(),
                             "dataDir": store.DATA_DIR,
                             "mode": self._mode_info()})

        if head == "session":
            return self._ok(self._mode_info())

        if head == "schema":
            return self._ok(schema.serialize_schema())

        if head == "dicts":
            return self._ok(schema.DICTS)

        if head == "dashboard":
            return self._ok(dashboard.build_dashboard(
                query.get("from", ""), query.get("to", ""), query.get("dept", "")))

        if head == "backup":
            return self._backup_zip()

        if head == "report.html" and method == "GET":
            return self._html_report(query)

        if head == "open-folder" and method == "POST":
            # 仅允许本机操作，避免远程触发
            if not self._client_is_local():
                return self._err("仅本机可以打开文件夹", 403)
            return self._open_data_folder()

        collection = head
        if collection not in schema.COLLECTIONS:
            return self._err(f"未知集合：{collection}", 404)

        rest = parts[1:]

        if not rest:
            if method == "GET":
                return self._ok(store.list_items(collection, query))
            if method == "POST":
                body = self._read_json()
                rec = store.create_item(collection, body)
                return self._ok(rec)
            return self._err("不支持的方法", 405)

        action = rest[0]

        if action == "export.xlsx" and method == "GET":
            q = dict(query)
            q["size"] = "100000"
            q["page"] = "1"
            items = store.list_items(collection, q)["items"]
            content = excel.export_workbook(collection, items)
            name = f"{schema.COLLECTIONS[collection]['label']}_{_today()}.xlsx"
            return self._download(content, name)

        if action == "template.xlsx" and method == "GET":
            content = excel.template_workbook(collection)
            name = f"{schema.COLLECTIONS[collection]['label']}_导入模板.xlsx"
            return self._download(content, name)

        if action == "import" and method == "POST":
            raw = self._read_body()
            if not raw:
                return self._err("没有收到文件内容")
            result = excel.import_workbook(collection, raw)
            return self._ok(result)

        item_id = action
        if len(rest) >= 2 and rest[1] == "transition":
            if method != "POST":
                return self._err("不支持的方法", 405)
            body = self._read_json()
            act = body.get("action") or ""
            extra = body.get("extra") or {}
            rec = store.transition(collection, item_id, act, extra)
            return self._ok(rec)

        if method == "GET":
            rec = store.get_item(collection, item_id)
            if rec is None:
                return self._err("记录不存在", 404)
            return self._ok(rec)
        if method == "PUT":
            body = self._read_json()
            return self._ok(store.update_item(collection, item_id, body))
        if method == "DELETE":
            ok = store.delete_item(collection, item_id)
            if not ok:
                return self._err("记录不存在", 404)
            return self._ok({"deleted": item_id})
        return self._err("不支持的方法", 405)

    def _mode_info(self) -> dict:
        """告诉前端当前访问模式，用于隐藏/禁用写操作按钮。"""
        local = self._client_is_local()
        return {
            "local": local,
            "readonly": (not local) and (not CONFIG["remoteEdit"]),
            "lan": CONFIG["lan"],
            "needLogin": bool(CONFIG["password"]) and not local,
            "loggedIn": self._password_ok() if CONFIG["password"] else True,
            "client": self.client_address[0],
        }

    def _login(self):
        body = self._read_json()
        pwd = str(body.get("password") or "")
        if not CONFIG["password"]:
            return self._ok({"loggedIn": True})
        if pwd != CONFIG["password"]:
            return self._err("密码错误", 401)
        token = _make_token(CONFIG["password"])
        body_out = json.dumps({"ok": True, "data": {"loggedIn": True}},
                              ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body_out)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie",
                         f"sw_token={token}; Path=/; Max-Age=86400; SameSite=Lax")
        self.end_headers()
        self.wfile.write(body_out)

    def _open_data_folder(self):
        """在资源管理器中打开数据目录（仅本机）。"""
        try:
            if sys.platform == "win32":
                os.startfile(store.DATA_DIR)  # noqa: S606
            elif sys.platform == "darwin":
                import subprocess
                subprocess.Popen(["open", store.DATA_DIR])
            else:
                import subprocess
                subprocess.Popen(["xdg-open", store.DATA_DIR])
            return self._ok({"path": store.DATA_DIR})
        except Exception as exc:  # noqa: BLE001
            return self._err(f"无法打开文件夹：{exc}", 500)

    def _html_report(self, query: dict):
        """生成并下载完整 HTML 报表。"""
        import export_html
        text = export_html.build_report(query.get("from", ""), query.get("to", ""))
        body = text.encode("utf-8")
        name = f"安全管理数据报表_{_today()}.html"
        quoted = urllib.parse.quote(name)
        self._send(200, body, "text/html; charset=utf-8", {
            "Content-Disposition":
                f"attachment; filename=\"report.html\"; filename*=UTF-8''{quoted}",
        })

    def _backup_zip(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if os.path.isdir(store.DATA_DIR):
                for name in sorted(os.listdir(store.DATA_DIR)):
                    full = os.path.join(store.DATA_DIR, name)
                    if os.path.isfile(full) and name.endswith(".json"):
                        zf.write(full, arcname=os.path.join("data", name))
        self._send(200, buf.getvalue(), "application/zip",
                   {"Content-Disposition":
                    f"attachment; filename=\"safety-data-{_today()}.zip\""})

    # ---------------------------------------------------------- 静态文件
    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/").replace("\\", "/")
        if ".." in rel.split("/"):
            return self._err("非法路径", 400)
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.normpath(WEB_DIR)):
            return self._err("非法路径", 400)
        if not os.path.isfile(full):
            return self._err("文件不存在", 404)
        ctype, _ = mimetypes.guess_type(full)
        if full.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif full.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        ctype = ctype or "application/octet-stream"
        with open(full, "rb") as fp:
            body = fp.read()
        self._send(200, body, ctype)


def _make_token(password: str) -> str:
    import hashlib
    return hashlib.sha256(("safety-workbench|" + password).encode("utf-8")).hexdigest()[:32]


def _today():
    import datetime
    return datetime.date.today().strftime("%Y%m%d")


def serve(port: int | None = None, open_browser=True, lan=False,
          remote_edit=False, password=""):
    store.ensure_dirs()
    host = "0.0.0.0" if lan else "127.0.0.1"
    port = port or find_port(host=host)
    CONFIG["lan"] = lan
    CONFIG["remoteEdit"] = remote_edit
    CONFIG["password"] = password
    CONFIG["port"] = port

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    local_url = f"http://127.0.0.1:{port}/"
    print("=" * 66)
    print("  安全管理数据工作台  v" + VERSION)
    print("=" * 66)
    print(f"  本机访问：{local_url}")
    if lan:
        ips = lan_ips()
        if ips:
            print("  局域网访问（同一办公网内的手机/电脑输入以下地址）：")
            for ip in ips:
                print(f"            http://{ip}:{port}/")
        else:
            print("  局域网访问：未检测到可用网络地址，请确认已连接网络")
        mode = "可编辑" if remote_edit else "只读（推荐）"
        print(f"  远程权限：{mode}")
        if password:
            print("  访问密码：已启用")
        print("  提示：Windows 防火墙首次可能弹窗，请点「允许访问」")
    else:
        print("  访问范围：仅本机（如需手机/其他电脑查看，用 --lan 启动）")
    print(f"  数据目录：{store.DATA_DIR}")
    print("  关闭本窗口即停止服务（数据已自动保存）")
    print("=" * 66)
    sys.stdout.flush()

    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


def parse_args(argv):
    opts = {"port": None, "lan": False, "remote_edit": False, "password": "",
            "open_browser": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--lan":
            opts["lan"] = True
        elif a == "--remote-edit":
            opts["remote_edit"] = True
        elif a == "--no-browser":
            opts["open_browser"] = False
        elif a == "--password":
            if i + 1 < len(argv):
                opts["password"] = argv[i + 1]
                i += 1
            else:
                raise SystemExit("--password 后面需要跟密码")
        elif a.isdigit():
            opts["port"] = int(a)
        i += 1
    return opts


if __name__ == "__main__":
    o = parse_args(sys.argv[1:])
    serve(port=o["port"], open_browser=o["open_browser"], lan=o["lan"],
          remote_edit=o["remote_edit"], password=o["password"])
