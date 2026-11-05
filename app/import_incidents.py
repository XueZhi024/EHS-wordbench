# -*- coding: utf-8 -*-
"""导入「未遂事件/一般事件」与「急救箱/医疗处置」数据到事故事件模块。

按公司《事件等级划分标准》自动推断 A/B/C 细分等级：

  急救箱事件  A：需到医院检查，停工休假 3 天以内
             B：需到医院清洗、消毒、清创、包扎
             C：用急救箱物品处理，不影响工作
  医疗处置事件 A：停工休假 15 天以上
             B：停工休假 15 天以内（含 15 天）
             C：停工休假 3 天以内（含 3 天）

用法：
    python app/import_incidents.py <文件1> <文件2>           # 预览
    python app/import_incidents.py <文件1> <文件2> --commit  # 导入
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store  # noqa: E402

# 班组/部门 → 工作台部门
DEPT_KEYWORDS = [
    ("物流", "仓储物流部"),
    ("物料", "仓储物流部"),
    ("仓", "仓储物流部"),
    ("食堂", "行政后勤部"),
    ("组织人事", "人力资源部"),
    ("人力资源", "人力资源部"),
    ("质量", "质检部"),
    ("质检", "质检部"),
    ("技术", "技术部"),
    ("设备", "设备部"),
    ("维修", "设备部"),
    ("工程", "工程部"),
    ("市场", "其他"),
    ("商务", "其他"),
    ("经营", "其他"),
    ("计划", "其他"),
    ("安全", "安全环保部"),
    ("环保", "安全环保部"),
]


def dept_of(text: str) -> str:
    if not text:
        return "生产部"
    for kw, dept in DEPT_KEYWORDS:
        if kw in text:
            return dept
    # A1班组、C3班组 等归生产部
    return "生产部"


def parse_date(value) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    m = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if not m:
        return ""
    try:
        return _dt.date(int(m.group(1)), int(m.group(2)),
                        int(m.group(3))).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def to_number(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- 等级推断

def grade_first_aid(desc: str, cost, days) -> str:
    """急救箱事件 A/B/C 级。

    A：需到医院检查，停工休假 3 天以内
    B：需到医院进行清洗、消毒、清创、包扎等医疗处理
    C：使用急救箱内物品处理，不影响工作
    """
    d = days or 0
    if d > 0:
        return "A级"
    text = desc or ""
    # 明确说只用了创可贴/消毒，未去医院 → C
    no_hospital = ["创可贴", "使用创可贴", "自行处理", "碘伏"]
    went_hospital = ["医院", "就医", "去医院", "到医院", "就医处理", "诊"]
    if any(w in text for w in went_hospital):
        return "B级"
    if any(w in text for w in no_hospital):
        return "C级"
    # 有费用说明发生了实际医疗支出 → B
    if cost and cost > 0:
        return "B级"
    return "C级"


def grade_medical(desc: str, days) -> str:
    """医疗处置事件 A/B/C 级（按休假天数）。

    A：停工休假 15 天以上
    B：停工休假 15 天以内（含 15 天）
    C：停工休假 3 天以内（含 3 天）
    """
    d = days or 0
    if d > 15:
        return "A级"
    if d > 3:
        return "B级"
    return "C级"


def event_type_of(desc: str, level1: str) -> str:
    """推断事件类型。"""
    text = desc or ""
    fire_words = ["着火", "起火", "明火", "火苗", "冒烟", "引燃", "燃烧", "火灾",
                  "灭火", "火源", "打火"]
    vehicle_words = ["叉车", "行车", "吊车", "龙门吊", "车辆", "高速", "货车",
                     "转运车", "行驶", "司机"]
    if any(w in text for w in fire_words):
        return "火灾爆炸"
    if any(w in text for w in vehicle_words):
        return "交通事故"
    if level1 == "未遂事件":
        return "未遂事件"
    if "设备" in text or "损坏" in text or "故障" in text or "破损" in text:
        return "设备事故"
    return "人身伤害"


# ---------------------------------------------------------------- 读取

def read_file1(path: str) -> list[dict]:
    """未遂事件 / 一般事件。"""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [("" if h is None else str(h).strip()) for h in rows[0]]
    idx = {h: i for i, h in enumerate(header) if h}

    def g(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    out = []
    for row in rows[1:]:
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        level1 = str(g(row, "事故等级") or "").strip()
        if level1 not in ("未遂事件", "一般事件"):
            continue
        out.append({
            "source": "file1",
            "level1": level1,
            "date": g(row, "事故发生时间"),
            "dept": str(g(row, "部门/班组") or "").strip(),
            "desc": str(g(row, "事故情况描述") or "").strip(),
            "person": str(g(row, "姓名") or "").strip(),
        })
    return out


def read_file2(path: str) -> list[dict]:
    """急救箱事件 / 医疗处置事件。"""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [("" if h is None else str(h).strip()) for h in rows[0]]
    idx = {h: i for i, h in enumerate(header) if h}

    def g(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    out = []
    for row in rows[1:]:
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        level1 = str(g(row, "类型") or "").strip()
        if level1 not in ("急救箱事件", "医疗处置事件"):
            continue
        out.append({
            "source": "file2",
            "level1": level1,
            "date": g(row, "日期"),
            "dept": str(g(row, "岗位") or "").strip(),
            "desc": str(g(row, "事故情况描述") or "").strip(),
            "person": str(g(row, "人员姓名") or "").strip(),
            "cost": to_number(g(row, "费用总计")),
            "days": to_number(g(row, "工伤休假时间（天）")),
            "hours": to_number(g(row, "工伤休假时间（小时）")),
            "week": str(g(row, "周") or "").strip(),
            "remark": str(g(row, "备注") or "").strip(),
        })
    return out


def to_record(row: dict) -> dict:
    """转换成工作台 incidents 记录。"""
    desc = row["desc"]
    level1 = row["level1"]
    date = parse_date(row["date"]) or _dt.date.today().strftime("%Y-%m-%d")

    grade = ""
    if level1 == "急救箱事件":
        grade = grade_first_aid(desc, row.get("cost"), row.get("days"))
    elif level1 == "医疗处置事件":
        grade = grade_medical(desc, row.get("days"))
    elif level1 == "一般事故":
        grade = "C级"

    # 标题：取描述前 40 字，去掉开头的日期
    title = desc
    title = re.sub(r"^\s*20\d{2}[年./\-]\s*\d{1,2}[月./\-]\s*\d{1,2}[日]?[^，,。]*?[，,。]?", "", title)
    title = title.strip("，,。;； ")
    if not title:
        title = desc
    title = title[:60]

    # 备注保留原始信息
    remark_parts = []
    if row.get("person"):
        remark_parts.append(f"当事人：{row['person']}")
    if row.get("dept"):
        remark_parts.append(f"原班组/岗位：{row['dept']}")
    if row.get("cost"):
        remark_parts.append(f"费用总计：{row['cost']} 元")
    if row.get("days"):
        remark_parts.append(f"工伤休假：{row['days']} 天")
    elif row.get("hours"):
        remark_parts.append(f"工伤休假：{row['hours']} 小时")
    if row.get("week"):
        remark_parts.append(f"周次：{row['week']}")
    if row.get("remark"):
        remark_parts.append(f"备注：{row['remark']}")
    remark_parts.append("来源：公司事故台账导入")

    rec = {
        "title": title,
        "level1": level1,
        "grade": grade,
        "type": event_type_of(desc, level1),
        "occurDate": date + " 00:00",
        "location": row.get("dept") or "厂区",
        "dept": dept_of(row.get("dept", "")),
        "persons": row.get("person") or "",
        "cause": desc[:400] or "（原记录未填写）",
        "measures": "按公司事故处理流程执行。",
        "status": "已结案",
        "closeDate": date,
        "reporter": row.get("person") or "系统导入",
        "remark": "；".join(remark_parts),
    }

    if row.get("cost"):
        rec["medicalCost"] = row["cost"]
        rec["loss"] = row["cost"]
    if row.get("days"):
        rec["lossDays"] = row["days"]
    elif row.get("hours"):
        rec["lossDays"] = round((row["hours"] or 0) / 8, 2)

    # 受伤部位：从描述里粗略提取
    parts = ["眼", "手", "脚", "腿", "臂", "头", "胸", "背", "腰", "膝", "鼻",
             "指", "肋", "臂"]
    found = [p for p in parts if p in desc]
    if found and level1 in ("急救箱事件", "医疗处置事件"):
        rec["injuryPart"] = "、".join(dict.fromkeys(found))[:20]

    return rec


def main():
    ap = argparse.ArgumentParser(description="导入事故台账数据")
    ap.add_argument("file1", help="未遂事件/一般事件 xlsx")
    ap.add_argument("file2", help="急救箱/医疗处置 xlsx")
    ap.add_argument("--commit", action="store_true", help="实际写入")
    ap.add_argument("--reset", action="store_true", help="先清空现有事故数据")
    args = ap.parse_args()

    for p in (args.file1, args.file2):
        if not os.path.exists(p):
            print(f"文件不存在：{p}")
            return 1

    print("=" * 70)
    print("事故台账数据导入（未遂/一般事件 + 急救箱/医疗处置）")
    print("=" * 70)

    rows = read_file1(args.file1) + read_file2(args.file2)
    print(f"\n读取到 {len(rows)} 条")

    records = []
    failed = []
    for i, row in enumerate(rows, start=2):
        try:
            rec = to_record(row)
            store.validate_and_clean("incidents", rec)
            records.append(rec)
        except ValueError as exc:
            failed.append((i, str(exc), row["desc"][:40]))

    print(f"通过校验：{len(records)} 条")
    if failed:
        print(f"未通过：{len(failed)} 条")
        for line, msg, desc in failed[:8]:
            print(f"  第{line}行 [{desc}] -> {msg}")

    from collections import Counter
    print("\n【数据分布】")
    print("  大类：", dict(Counter(r["level1"] for r in records)))
    level_counter = Counter(
        r["level1"] + "-" + (r["grade"] or "无") for r in records)
    print("  等级：", dict(level_counter))
    print("  类型：", dict(Counter(r["type"] for r in records)))
    print("  部门：", dict(Counter(r["dept"] for r in records)))

    print("\n【前 5 条预览】")
    for r in records[:5]:
        print(f"  · [{r['occurDate'][:10]}] {r['level1']}"
              f"{('-' + r['grade']) if r['grade'] else ''} | {r['title'][:45]}")
        print(f"    类型={r['type']} 部门={r['dept']} 人员={r['persons'] or '-'}")

    if not args.commit:
        print("\n" + "=" * 70)
        print("预览模式，未写入。确认后加 --commit 执行")
        print("=" * 70)
        return 0

    if args.reset:
        existing = store.all_items("incidents")
        for it in existing:
            store.delete_item("incidents", it["id"])
        print(f"\n已清空原有 {len(existing)} 条事故数据")

    print("\n开始写入…")
    ok = 0
    errors = []
    for i, rec in enumerate(records, start=1):
        try:
            store.create_item("incidents", rec)
            ok += 1
        except ValueError as exc:
            errors.append((i, str(exc), rec["title"][:30]))

    print("\n" + "=" * 70)
    print(f"导入完成：成功 {ok} 条，失败 {len(errors)} 条")
    for idx, msg, title in errors[:8]:
        print(f"  第{idx}条 [{title}] -> {msg}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
