# -*- coding: utf-8 -*-
"""端到端 HTTP 测试：启动服务 → 打全部接口 → 关闭。

用法：python app/httptest.py [port]
不会污染正式数据：测试期间写入的记录在结束时删除。
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

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
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


def req(method, path, body=None, raw=False):
    # 浏览器会自动对中文做百分号编码，这里模拟同样的行为
    url = BASE + urllib.parse.quote(path, safe="/?&=#:")
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            content = resp.read()
            if raw:
                return resp.status, content, dict(resp.headers)
            return resp.status, json.loads(content.decode("utf-8")), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        content = exc.read()
        try:
            return exc.code, json.loads(content.decode("utf-8")), dict(exc.headers)
        except json.JSONDecodeError:
            return exc.code, {"raw": content[:200]}, dict(exc.headers)


def ok(path, **kw):
    status, data, _ = req("GET", path, **kw)
    assert status == 200, f"{path} 返回 {status}: {data}"
    assert data.get("ok") is True, f"{path} ok=false: {data}"
    return data["data"]


def expect_fail(method, path, body=None, contains=""):
    status, data, _ = req(method, path, body)
    assert status >= 400, f"{path} 应失败但返回 {status}"
    assert data.get("ok") is False, f"{path} 应返回 ok=false"
    if contains:
        assert contains in str(data.get("error", "")), \
            f"错误信息不含「{contains}」：{data.get('error')}"


TODAY = time.strftime("%Y-%m-%d")
FUTURE = time.strftime("%Y-%m-%d", time.localtime(time.time() + 20 * 86400))

created = []
HID = None
EID = None
CID = None


def main():
    print("=" * 62)
    print(f"端到端 HTTP 测试（端口 {PORT}）")
    print("=" * 62)
    proc = subprocess.Popen([PY, os.path.join(BASE_DIR, "app", "server.py"),
                             str(PORT), "--no-browser"],
                            cwd=BASE_DIR,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        _wait_ready()
        print("\n[1] 基础接口")
        check("GET /api/health", _t_health)
        check("GET /api/schema 返回 9 个集合", _t_schema)
        check("GET /api/dicts", _t_dicts)
        check("GET / 返回前端页面", _t_index)

        print("\n[2] 隐患 HTTP CRUD")
        check("POST 新建隐患", _t_create)
        check("GET 单条详情", _t_detail)
        check("PUT 更新", _t_update)
        check("POST 状态流转", _t_transition)
        check("POST 非法流转返回 400", _t_transition_bad)
        check("POST 缺必填返回 400", _t_validation)
        check("GET 分页与过滤", _t_list)

        print("\n[3] Excel 接口")
        check("GET export.xlsx", _t_export)
        check("GET template.xlsx", _t_template)
        check("POST import 新增", _t_import)

        print("\n[4] 看板与备份")
        check("GET /api/dashboard", _t_dashboard)
        check("GET /api/backup", _t_backup)

        print("\n[4b] 安全疑虑")
        check("POST 新建疑虑", _t_concern_create)
        check("疑虑流转：开始核实", _t_concern_verify)
        check("疑虑转隐患缺编号返回 400", _t_concern_convert_bad)
        check("疑虑转隐患成功", _t_concern_convert)
        check("疑虑看板统计", _t_concern_dashboard)

        print("\n[4c] 设备管理")
        check("POST 新建特种设备", _t_equip_create)
        check("设备大类自动计算", _t_equip_category)
        check("特种设备缺登记证返回 400", _t_equip_required)
        check("按大类筛选", _t_equip_filter)
        check("设备状态流转", _t_equip_transition)
        check("设备导出与模板", _t_equip_excel)
        check("看板含设备 KPI", _t_equip_dashboard)

        print("\n[4d] HTML 报表")
        check("GET /api/report.html 返回 HTML", _t_report_html)
        check("报表含 KPI 与表格", _t_report_content)
        check("报表支持日期范围", _t_report_range)

        print("\n[4e] 数据位置")
        check("health 返回数据目录", _t_health_datadir)
        check("POST /api/open-folder 可用", _t_open_folder)

        print("\n[5] 静态资源")
        check("GET /app.js", lambda: _t_static("/app.js"))
        check("GET /styles.css", lambda: _t_static("/styles.css"))
        check("GET /charts.js", lambda: _t_static("/charts.js"))
        check("路径穿越被拒绝", _t_traversal)

        print("\n[6] 删除")
        check("DELETE 记录", _t_delete)
    finally:
        _cleanup()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("\n" + "=" * 62)
    print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
    for name, exc in FAILS:
        print(f"  失败：{name} -> {exc}")
    print("=" * 62)
    return 0 if FAIL == 0 else 1


def _wait_ready(timeout=20):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    raise RuntimeError("服务启动超时")


def _t_health():
    d = ok("/api/health")
    assert d["version"], "缺少版本号"
    assert isinstance(d["counts"], dict), "counts 格式错误"


def _t_schema():
    d = ok("/api/schema")
    assert len(d["collections"]) == 11, f"集合数应为 11，实际 {len(d['collections'])}"
    for c in d["collections"]:
        assert c["label"] and c["prefix"] and c["fields"], f"{c['key']} 定义不全"


def _t_dicts():
    d = ok("/api/dicts")
    assert "departments" in d and len(d["departments"]) > 5, "部门字典缺失"


def _t_index():
    status, content, headers = req("GET", "/", raw=True)
    assert status == 200, f"首页返回 {status}"
    assert b"<html" in content.lower() or b"<!doctype" in content.lower(), "首页不是 HTML"


def _t_create():
    global HID
    status, data, _ = req("POST", "/api/hazards", {
        "title": "HTTP测试-配电箱门锁损坏",
        "category": "电气安全", "level": "一般隐患", "source": "日常巡检",
        "foundDate": TODAY, "dept": "生产部", "responsible": "李四",
        "deadline": FUTURE,
    })
    assert status == 200, f"新建失败 {status}: {data}"
    rec = data["data"]
    assert rec["id"].startswith("YH-"), f"编号异常：{rec['id']}"
    assert rec["status"] == "待整改", "默认状态错误"
    created.append(("hazards", rec["id"]))
    HID = rec["id"]


def _t_detail():
    d = ok(f"/api/hazards/{HID}")
    assert d["title"] == "HTTP测试-配电箱门锁损坏", "详情内容不符"


def _t_update():
    status, data, _ = req("PUT", f"/api/hazards/{HID}",
                          {"responsible": "王五", "cost": 350})
    assert status == 200, f"更新失败 {status}: {data}"
    assert data["data"]["responsible"] == "王五", "更新未生效"
    assert data["data"]["cost"] == 350, "数值未保存"


def _t_transition():
    status, data, _ = req("POST", f"/api/hazards/{HID}/transition",
                          {"action": "开始整改"})
    assert status == 200, f"流转失败 {status}: {data}"
    assert data["data"]["status"] == "整改中", "状态未变更"


def _t_transition_bad():
    expect_fail("POST", f"/api/hazards/{HID}/transition",
                {"action": "验收通过"}, "不能执行")


def _t_validation():
    expect_fail("POST", "/api/hazards", {"title": "缺字段"}, "必填")
    expect_fail("POST", "/api/hazards", {
        "title": "枚举错", "category": "不存在的类别", "level": "一般隐患",
        "source": "日常巡检", "foundDate": TODAY, "dept": "生产部",
        "responsible": "张三", "deadline": FUTURE,
    }, "可选范围")


def _t_list():
    d = ok("/api/hazards?page=1&size=5")
    assert "items" in d and "total" in d and "page" in d, "分页结构错误"
    d2 = ok("/api/hazards?q=HTTP测试")
    assert d2["total"] >= 1, "全文搜索未命中"
    d3 = ok("/api/hazards?dept=设备部&size=100")
    assert all(i.get("dept") == "设备部" for i in d3["items"]), "过滤失效"
    d4 = ok("/api/hazards?sort=foundDate&dir=asc&size=100")
    dates = [i.get("foundDate") for i in d4["items"] if i.get("foundDate")]
    assert dates == sorted(dates), "排序未生效"


def _t_export():
    status, content, headers = req("GET", "/api/hazards/export.xlsx", raw=True)
    assert status == 200, f"导出失败 {status}"
    assert content[:2] == b"PK", "不是 xlsx"
    assert len(content) > 3000, "导出内容过小"
    assert "spreadsheetml" in headers.get("Content-Type", ""), "Content-Type 错误"


def _t_template():
    for key in ("hazards", "risks", "concerns", "incidents", "trainings",
                "certificates", "fireEquipments", "fireDrills", "contractors",
                "permits", "equipments"):
        status, content, _ = req("GET", f"/api/{key}/template.xlsx", raw=True)
        assert status == 200, f"{key} 模板失败 {status}"
        assert content[:2] == b"PK", f"{key} 模板不是 xlsx"


def _t_import():
    from io import BytesIO

    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["隐患描述", "隐患类别", "隐患等级", "发现来源", "发现日期",
               "责任部门", "整改责任人", "整改期限"])
    ws.append(["HTTP测试-导入记录", "设备设施", "一般隐患", "专项检查",
               TODAY, "设备部", "郑十", FUTURE])
    buf = BytesIO()
    wb.save(buf)
    r = urllib.request.Request(BASE + "/api/hazards/import",
                               data=buf.getvalue(),
                               headers={"X-Filename": "test.xlsx",
                                        "Content-Type": "application/octet-stream"},
                               method="POST")
    with urllib.request.urlopen(r, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    assert data["ok"] and data["data"]["inserted"] == 1, f"导入失败：{data}"
    for it in ok("/api/hazards?q=HTTP测试-导入记录")["items"]:
        created.append(("hazards", it["id"]))


def _t_dashboard():
    d = ok("/api/dashboard")
    for k in ("hazardTotal", "hazardCloseRate", "riskTotal", "incidentTotal",
              "certWarn", "fireOverdue", "contractorActive", "permitRunning"):
        assert k in d["kpi"], f"缺少 KPI {k}"
    assert len(d["riskByLevel"]) == 5, "风险分布项数错误"
    assert "months" in d["trend"], "缺少趋势"
    d2 = ok("/api/dashboard?from=2026-01-01&to=2026-12-31&dept=生产部")
    assert d2["range"]["dept"] == "生产部", "部门参数未生效"


def _t_backup():
    status, content, headers = req("GET", "/api/backup", raw=True)
    assert status == 200, f"备份失败 {status}"
    assert content[:2] == b"PK", "备份不是 zip"
    assert "attachment" in headers.get("Content-Disposition", ""), "缺少下载头"


def _t_concern_create():
    global CID
    status, data, _ = req("POST", "/api/concerns", {
        "title": "HTTP测试-地面油污容易滑倒", "category": "作业环境",
        "source": "现场反映", "dept": "生产部", "location": "三车间",
        "foundDate": TODAY, "deadline": FUTURE, "status": "待核实",
    })
    assert status == 200, f"新建疑虑失败 {status}: {data}"
    rec = data["data"]
    assert rec["id"].startswith("AQ-"), f"编号异常：{rec['id']}"
    assert rec["status"] == "待核实", "默认状态错误"
    assert rec["replyState"] == "待答复", f"反馈状态错误：{rec['replyState']}"
    CID = rec["id"]
    created.append(("concerns", rec["id"]))


def _t_concern_verify():
    status, data, _ = req("POST", f"/api/concerns/{CID}/transition",
                          {"action": "开始核实"})
    assert status == 200, f"流转失败 {status}: {data}"
    assert data["data"]["status"] == "核实中", "状态未变更"


def _t_concern_convert_bad():
    expect_fail("POST", f"/api/concerns/{CID}/transition",
                {"action": "转隐患", "extra": {"conclusion": "属实"}},
                "隐患编号")


def _t_concern_convert():
    status, data, _ = req("POST", f"/api/concerns/{CID}/transition", {
        "action": "转隐患",
        "extra": {"conclusion": "属实，存在滑倒风险", "hazardId": "YH-2026-0001"},
    })
    assert status == 200, f"转隐患失败 {status}: {data}"
    rec = data["data"]
    assert rec["status"] == "已转隐患", f"状态错误：{rec['status']}"
    assert rec["hazardId"] == "YH-2026-0001", "隐患编号未保存"
    assert rec["replyState"] == "已办结", f"反馈状态错误：{rec['replyState']}"


def _t_concern_dashboard():
    d = ok("/api/dashboard")
    for k in ("concernTotal", "concernOpen", "concernOverdue", "concernUnreplied"):
        assert k in d["kpi"], f"看板缺少 {k}"
    assert len(d["concernByStatus"]) == 5, "疑虑状态分布应为 5 项"
    assert isinstance(d["alerts"]["concernPending"], list), "缺少待处理疑虑提醒"


def _t_equip_create():
    global EID
    status, data, _ = req("POST", "/api/equipments", {
        "type": "叉车", "name": "HTTP测试-电动叉车", "location": "一号仓库",
        "dept": "仓储物流部", "status": "在用",
        "regCode": "厂内 11010100009999", "nextInspectDate": FUTURE,
        "ratedLoad": "3t",
    })
    assert status == 200, f"新建设备失败 {status}: {data}"
    rec = data["data"]
    assert rec["id"].startswith("SB-"), f"编号异常：{rec['id']}"
    EID = rec["id"]
    created.append(("equipments", rec["id"]))


def _t_equip_category():
    d = ok(f"/api/equipments/{EID}")
    assert d["category"] == "特种设备类", f"大类错误：{d['category']}"


def _t_equip_required():
    expect_fail("POST", "/api/equipments", {
        "type": "电梯", "name": "缺登记证", "location": "办公楼",
        "dept": "行政后勤部", "status": "在用",
    }, "使用登记证号")


def _t_equip_filter():
    d = ok("/api/equipments?category=表阀类&size=200")
    assert d["total"] >= 1, "表阀类筛选应有结果"
    assert all(i.get("category") == "表阀类" for i in d["items"]), "筛选混入其它大类"
    d2 = ok("/api/equipments?category=特种设备类&size=200")
    assert all(i.get("category") == "特种设备类" for i in d2["items"]), "特种设备筛选错误"


def _t_equip_transition():
    status, data, _ = req("POST", f"/api/equipments/{EID}/transition",
                          {"action": "报修"})
    assert status == 200, f"流转失败 {status}: {data}"
    assert data["data"]["status"] == "维修中", "状态未变更"
    status, data, _ = req("POST", f"/api/equipments/{EID}/transition",
                          {"action": "维修完成"})
    assert data["data"]["status"] == "在用", "维修完成状态错误"


def _t_equip_excel():
    status, content, _ = req("GET", "/api/equipments/export.xlsx", raw=True)
    assert status == 200 and content[:2] == b"PK", "设备导出失败"
    status, content, _ = req("GET", "/api/equipments/template.xlsx", raw=True)
    assert status == 200 and content[:2] == b"PK", "设备模板失败"


def _t_equip_dashboard():
    d = ok("/api/dashboard")
    for k in ("equipmentTotal", "equipmentActive", "equipmentSpecial",
              "equipmentExpiring", "equipmentExpired"):
        assert k in d["kpi"], f"看板缺少 {k}"
    assert len(d["equipmentByCategory"]) == 3, "设备分类应为 3 项"
    assert isinstance(d["alerts"]["equipmentExpiring"], list), "缺少设备到期提醒"


def _t_report_html():
    status, content, headers = req("GET", "/api/report.html", raw=True)
    assert status == 200, f"报表返回 {status}"
    assert b"<!DOCTYPE html" in content[:200], "不是 HTML"
    assert "text/html" in headers.get("Content-Type", ""), "Content-Type 错误"
    assert "attachment" in headers.get("Content-Disposition", ""), "缺少下载头"
    assert len(content) > 20000, f"报表过小：{len(content)} 字节"


def _t_report_content():
    status, content, _ = req("GET", "/api/report.html", raw=True)
    text = content.decode("utf-8")
    assert "安全管理数据报表" in text, "缺少标题"
    assert "核心指标" in text, "缺少 KPI 段"
    assert "数据分析" in text, "缺少图表段"
    assert "台账明细" in text, "缺少台账段"
    assert text.count("<svg") >= 6, f"图表数量不足：{text.count('<svg')}"
    assert text.count("<table") >= 11, f"表格数量不足：{text.count('<table')}"
    # 完全离线：不应有外部资源引用
    import re
    ext = re.findall(r'<script[^>]+src=["\']https?://', text)
    ext += re.findall(r'<link[^>]+href=["\']https?://', text)
    assert not ext, f"存在外部资源：{ext[:2]}"


def _t_report_range():
    status, content, _ = req(
        "GET", "/api/report.html?from=2026-10-01&to=2026-10-31", raw=True)
    assert status == 200, f"带日期范围返回 {status}"
    text = content.decode("utf-8")
    assert "2026-10-01" in text and "2026-10-31" in text, "日期范围未体现"


def _t_health_datadir():
    d = ok("/api/health")
    assert "dataDir" in d, "health 缺少 dataDir"
    assert os.path.isdir(d["dataDir"]), f"数据目录不存在：{d['dataDir']}"
    assert d["dataDir"].endswith("data"), f"数据目录异常：{d['dataDir']}"


def _t_open_folder():
    status, data, _ = req("POST", "/api/open-folder")
    assert status == 200, f"打开文件夹返回 {status}: {data}"
    assert data["ok"] is True, f"应成功：{data}"
    assert data["data"]["path"], "未返回路径"


def _t_static(path):
    status, content, headers = req("GET", path, raw=True)
    assert status == 200, f"{path} 返回 {status}"
    assert len(content) > 100, f"{path} 内容过小"


def _t_traversal():
    status, data, _ = req("GET", "/../app/server.py")
    assert status in (400, 404), f"路径穿越未被拒绝，返回 {status}"


def _t_delete():
    status, data, _ = req("DELETE", f"/api/hazards/{HID}")
    assert status == 200, f"删除失败 {status}: {data}"
    expect_fail("GET", f"/api/hazards/{HID}", contains="不存在")
    created.remove(("hazards", HID))


def _cleanup():
    for coll, cid in list(created):
        try:
            req("DELETE", f"/api/{coll}/{cid}")
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
