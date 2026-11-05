# -*- coding: utf-8 -*-
"""导入钉钉审批导出的「安全疑虑」数据。

源文件结构（钉钉审批导出）：
    周 | 数据id | 厂区 | 人员姓名 | 发起班组 | 事故发生时间 | 事故等级 |
    事故情况描述 | 责任人 | 现状图片 | 现状文件 | 整改图片 | 整改后描述 |
    审批编号 | 创建时间 | 创建人 | 当前负责人 | 审批结果 | 审批状态 | ...

映射规则见 FIELD_MAP。用法：

    python app/import_concerns.py <xlsx路径>            # 预览，不写入
    python app/import_concerns.py <xlsx路径> --commit   # 实际导入
    python app/import_concerns.py <xlsx路径> --commit --reset  # 先清空再导入
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store  # noqa: E402

# 工作台部门字典固定，钉钉的「厂区 + 班组」信息映射到这里。
# 生产班组归生产部；物流组归仓储物流部；其他按名称判断。
DEPT_BY_TEAM_KEYWORD = [
    ("物流", "仓储物流部"),
    ("仓", "仓储物流部"),
    ("质检", "质检部"),
    ("技术", "技术部"),
    ("设备", "设备部"),
    ("维修", "设备部"),
    ("工程", "工程部"),
    ("采购", "采购部"),
    ("行政", "行政后勤部"),
    ("后勤", "行政后勤部"),
    ("食堂", "行政后勤部"),
    ("安全", "安全环保部"),
    ("环保", "安全环保部"),
]


def dept_of(plant: str, team: str, creator_dept: str) -> str:
    """按班组名称推断部门。"""
    for text in (team, creator_dept):
        if not text:
            continue
        for kw, dept in DEPT_BY_TEAM_KEYWORD:
            if kw in text:
                return dept
    # 班组名（如 C1班组、A2班组、F组、D组）默认归生产部
    return "生产部"

# 审批状态 → 工作台疑虑状态
STATUS_MAP = {
    "已结束": "已关闭",
    "审批中": "核实中",
    "终止": "已关闭",
}

# 按描述关键词猜类别（按优先级从高到低匹配）
CATEGORY_RULES = [
    ("电气安全", ["电线", "电缆", "漏电", "触电", "配电", "插座", "插排", "开关",
                  "接线", "短路", "绝缘", "电箱", "电闸", "断电", "带电", "电器",
                  "电源", "线路"]),
    ("消防安全", ["消防", "灭火器", "消火栓", "疏散", "逃生", "着火", "易燃",
                  "可燃", "燃气", "气瓶", "氧气瓶", "氩气瓶", "乙炔", "火源",
                  "烟头", "吸烟"]),
    ("职业健康", ["粉尘", "噪声", "噪音", "气味", "有毒", "有害", "口罩", "耳塞",
                  "劳保", "眼镜", "面罩", "尘肺", "水垢", "对身体", "健康", "刺眼",
                  "防护"]),
    ("危化品", ["危化", "化学品", "溶剂", "油漆", "酒精", "酸碱", "泄漏", "渗漏",
                "不明液体", "化工"]),
    ("环境管理", ["污水", "废气", "排放", "垃圾", "环保", "污染", "漏水", "积水",
                  "水龙头"]),
    ("作业环境", ["地面", "油污", "坑", "滑", "绊", "照明", "灯", "光线", "暗",
                  "通道", "堆物", "物料", "杂物", "摆放", "整理", "墙皮", "顶棚",
                  "天花板", "冰溜", "房檐", "窗户", "门", "阳光", "太暗", "积水",
                  "清理", "5S", "定置"]),
    ("作业行为", ["未戴", "未穿", "违规", "违章", "未按", "不按", "私自", "冒险",
                  "打闹", "疲劳", "违规操作", "横穿", "翻越"]),
    ("设备设施", ["设备", "机械", "吊车", "吊钩", "吊具", "吊带", "吊钳", "吊环",
                  "叉车", "行车", "机床", "机台", "油压机", "压力机", "压机", "冲床",
                  "折弯", "剪板", "砂轮", "无齿锯", "锯", "钻", "铣", "车床",
                  "螺丝", "螺栓", "松动", "脱落", "损坏", "坏了", "破损", "失效",
                  "故障", "护栏", "平台", "梯子", "限位", "气管", "管路", "阀门",
                  "压力表", "仪表", "管道", "排风", "风机", "泵", "电机", "轴承",
                  "工装", "货架", "托盘", "铁筐", "插车", "遥控器", "急停", "按钮",
                  "钢丝绳", "链条", "皮带", "油封", "漏油", "开裂", "变形", "翘起",
                  "塌陷", "倾斜", "倒下", "翻倒", "固定", "锁紧", "定位",
                  "花纹板", "小黄车", "转运车", "爬梯", "楼梯", "扶手", "开焊",
                  "焊接", "腐蚀", "老化", "磨损", "刹车", "制动", "轮胎", "轮子",
                  "气瓶", "电控柜", "路杆", "监控", "栏杆", "盖板", "铁削", "铁屑",
                  "胶皮锤", "锤头", "工具", "夹具", "模具", "砂轮片", "锯片"]),
]


def guess_category(text: str) -> str:
    if not text:
        return "其他"
    for cat, kws in CATEGORY_RULES:
        for kw in kws:
            if kw in text:
                return cat
    return "其他"


def parse_date(value) -> str:
    """把各种日期格式统一成 YYYY-MM-DD。"""
    if value is None or value == "":
        return ""
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", s)
    if not m:
        return ""
    try:
        return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def parse_datetime(value) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    s = str(value).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})", s)
    if not m:
        d = parse_date(s)
        return (d + " 00:00") if d else ""
    try:
        dt = _dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          int(m.group(4)), int(m.group(5)))
        return dt.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return ""


def severity_of(text: str) -> str:
    """按描述里的危险程度词粗略判断严重性。"""
    high_words = ["掉下", "坠落", "砸", "伤到人", "伤人", "砸到人", "着火", "爆炸",
                  "中毒", "触电", "切断", "夹手", "重物", "倒下", "翻倒"]
    if any(w in text for w in high_words):
        return "高"
    if len(text) >= 30:
        return "中"
    return "低"


def clean_text(value, limit: int = 500) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:limit]


def read_rows(path: str) -> list[dict]:
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    header = [("" if h is None else str(h).strip()) for h in rows[0]]
    idx = {h: i for i, h in enumerate(header) if h}

    def get(row, name, default=None):
        i = idx.get(name)
        if i is None or i >= len(row):
            return default
        return row[i]

    out = []
    for row in rows[1:]:
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        out.append({
            "plant": clean_text(get(row, "厂区")),
            "team": clean_text(get(row, "发起班组")),
            "person": clean_text(get(row, "人员姓名")),
            "occurDate": get(row, "事故发生时间"),
            "grade": clean_text(get(row, "事故等级")),
            "desc": clean_text(get(row, "事故情况描述"), 400),
            "owner": clean_text(get(row, "责任人")),
            "pic": clean_text(get(row, "现状图片"), 400),
            "fixDesc": clean_text(get(row, "整改后描述"), 200),
            "approvalNo": clean_text(get(row, "审批编号")),
            "createTime": get(row, "创建时间"),
            "creator": clean_text(get(row, "创建人")),
            "approvalResult": clean_text(get(row, "审批结果")),
            "approvalStatus": clean_text(get(row, "审批状态")),
            "approvalLog": clean_text(get(row, "审批记录"), 600),
            "creatorDept": clean_text(get(row, "创建人部门")),
        })
    return out


def to_record(row: dict, today: _dt.date) -> dict:
    """把一行钉钉数据转成工作台 concerns 记录。"""
    desc = row["desc"]
    plant = row["plant"] or "厂区"
    team = row["team"]
    creator = row["creator"] or row["person"]

    # 日期：优先用事故发生时间，没有则用创建时间
    found = parse_date(row["occurDate"])
    if not found:
        ct = parse_datetime(row["createTime"])
        found = ct[:10] if ct else today.strftime("%Y-%m-%d")

    # 处理时限：发现日期 + 7 天（钉钉审批通常一周内响应）
    try:
        fd = _dt.datetime.strptime(found, "%Y-%m-%d").date()
    except ValueError:
        fd = today
    deadline = (fd + _dt.timedelta(days=7)).strftime("%Y-%m-%d")

    status = STATUS_MAP.get(row["approvalStatus"], "待核实")
    # 已结束且审批通过 → 关闭；已结束但未通过 → 也关闭（走完流程了）
    if row["approvalStatus"] == "已结束":
        status = "已关闭"
    elif row["approvalStatus"] == "审批中":
        status = "核实中"
    elif row["approvalStatus"] == "终止":
        status = "已关闭"

    # 来源：钉钉审批
    source = "其他"

    # 位置：厂区 + 班组
    location = plant
    if team:
        location = f"{plant}·{team}"

    # 备注：保留原始追溯信息
    remark_parts = []
    if row["approvalNo"]:
        remark_parts.append(f"钉钉审批编号：{row['approvalNo']}")
    if row["approvalResult"] and row["approvalResult"] not in ("--", ""):
        remark_parts.append(f"审批结果：{row['approvalResult']}")
    if row["approvalStatus"]:
        remark_parts.append(f"审批状态：{row['approvalStatus']}")
    if row["creatorDept"] and row["creatorDept"] != team:
        remark_parts.append(f"创建人部门：{row['creatorDept']}")
    if row["pic"]:
        remark_parts.append(f"现场照片：{row['pic']}")
    if row["approvalLog"]:
        remark_parts.append(f"审批记录：{row['approvalLog']}")
    remark = "；".join(remark_parts)[:900]

    rec = {
        "title": desc or "（无描述）",
        "category": guess_category(desc),
        "source": source,
        "reporter": creator,
        "reporterType": "本厂员工",
        "dept": dept_of(plant, team, row["creatorDept"]),
        "location": location,
        "foundDate": found,
        "description": desc,
        "severity": severity_of(desc),
        "status": status,
        "deadline": deadline,
        "remark": remark,
    }

    # 已关闭的补上答复信息，满足校验规则
    if status == "已关闭":
        rec["verifyDate"] = found
        rec["verifier"] = row["owner"] or creator
        rec["replyDate"] = found
        fix = row["fixDesc"]
        if fix and fix != creator:
            rec["replyContent"] = f"已按流程处理。整改后情况：{fix}"
        else:
            rec["replyContent"] = "钉钉审批流程已结束。"
        rec["conclusion"] = desc[:200] if desc else "已核实"

    return rec


def main():
    ap = argparse.ArgumentParser(description="导入钉钉安全疑虑数据")
    ap.add_argument("path", help="xlsx 文件路径")
    ap.add_argument("--commit", action="store_true", help="实际写入（默认只预览）")
    ap.add_argument("--reset", action="store_true", help="导入前清空现有疑虑数据")
    ap.add_argument("--limit", type=int, default=0, help="只导入前 N 条（调试用）")
    args = ap.parse_args()

    if not os.path.exists(args.path):
        print(f"文件不存在：{args.path}")
        return 1

    print("=" * 66)
    print("钉钉「安全疑虑」数据导入")
    print("=" * 66)

    rows = read_rows(args.path)
    if args.limit:
        rows = rows[:args.limit]
    print(f"\n读取到 {len(rows)} 行数据")

    today = _dt.date.today()
    records = []
    failed = []
    for i, row in enumerate(rows, start=2):
        try:
            rec = to_record(row, today)
            # 用 store 的校验逻辑预检（不写入）
            store.validate_and_clean("concerns", rec)
            records.append(rec)
        except ValueError as exc:
            failed.append((i, str(exc), row.get("desc", "")[:40]))

    print(f"通过校验：{len(records)} 条")
    if failed:
        print(f"未通过：{len(failed)} 条")
        for line, msg, desc in failed[:10]:
            print(f"  第{line}行 [{desc}] -> {msg}")
        if len(failed) > 10:
            print(f"  ...还有 {len(failed) - 10} 条")

    # 统计预览
    from collections import Counter
    print("\n【将导入的数据分布】")
    print("  状态：", dict(Counter(r["status"] for r in records)))
    print("  类别：", dict(Counter(r["category"] for r in records)))
    print("  严重性：", dict(Counter(r["severity"] for r in records)))
    print("  部门：", dict(Counter(r["dept"] for r in records)))
    print("  厂区：", dict(Counter(r["location"].split("·")[0] for r in records)))

    print("\n【前 3 条预览】")
    for r in records[:3]:
        print(f"  · [{r['foundDate']}] {r['title'][:50]}")
        print(f"    类别={r['category']} 严重={r['severity']} 状态={r['status']} "
              f"位置={r['location']} 反映人={r['reporter'] or '匿名'}")

    if not args.commit:
        print("\n" + "=" * 66)
        print("这是预览模式，未写入任何数据。")
        print(f"确认无误后执行：python app\\import_concerns.py \"{args.path}\" --commit")
        print("=" * 66)
        return 0

    # 实际写入
    if args.reset:
        existing = store.all_items("concerns")
        for it in existing:
            store.delete_item("concerns", it["id"])
        print(f"\n已清空原有 {len(existing)} 条疑虑数据")

    print("\n开始写入…")
    ok = 0
    errors = []
    for i, rec in enumerate(records, start=1):
        try:
            store.create_item("concerns", rec)
            ok += 1
            if i % 50 == 0:
                print(f"  已导入 {i} / {len(records)}")
        except ValueError as exc:
            errors.append((i, str(exc), rec.get("title", "")[:40]))

    print("\n" + "=" * 66)
    print(f"导入完成：成功 {ok} 条，失败 {len(errors)} 条")
    if errors:
        for idx, msg, title in errors[:10]:
            print(f"  第{idx}条 [{title}] -> {msg}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
