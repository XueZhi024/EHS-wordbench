# -*- coding: utf-8 -*-
"""Excel 导入导出：基于 openpyxl，中文表头，导入按编号 upsert。"""
from __future__ import annotations

import datetime as _dt
import io

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import schema
import store

HEADER_FILL = PatternFill("solid", fgColor="1F4E5F")
HEADER_FONT = Font(color="FFFFFF", bold=True, size=11)
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def _form_fields(collection_key: str):
    """导出/导入使用的字段（含 id，不含纯计算字段）。"""
    coll = schema.get_collection(collection_key)
    out = []
    for fd in coll["fields"]:
        if fd["type"] == "computed":
            continue
        out.append(fd)
    return out


def _write_header(ws, fields):
    for col, fd in enumerate(fields, start=1):
        cell = ws.cell(row=1, column=col, value=fd["label"])
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER
        width = max(10, min(40, int(fd.get("width", 140) / 8)))
        ws.column_dimensions[get_column_letter(col)].width = width
    ws.row_dimensions[1].height = 24
    ws.freeze_panes = "A2"


def _cell_value(value, ftype):
    if value is None:
        return ""
    if ftype == "bool":
        return "是" if value else "否"
    if isinstance(value, bool):
        return "是" if value else "否"
    return value


def export_workbook(collection_key: str, items: list[dict]) -> bytes:
    coll = schema.get_collection(collection_key)
    fields = _form_fields(collection_key)
    wb = Workbook()
    ws = wb.active
    ws.title = coll["short"][:30]
    _write_header(ws, fields)

    for row, item in enumerate(items, start=2):
        for col, fd in enumerate(fields, start=1):
            cell = ws.cell(row=row, column=col,
                           value=_cell_value(item.get(fd["key"]), fd["type"]))
            cell.border = BORDER
            cell.alignment = Alignment(vertical="center", wrap_text=False)

    ws.auto_filter.ref = f"A1:{get_column_letter(len(fields))}{max(1, len(items) + 1)}"

    # 说明页
    info = wb.create_sheet("填写说明")
    info.column_dimensions["A"].width = 18
    info.column_dimensions["B"].width = 60
    info["A1"] = "集合"
    info["B1"] = coll["label"]
    info["A2"] = "导出时间"
    info["B2"] = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    info["A3"] = "记录数"
    info["B3"] = len(items)
    row = 5
    for fd in fields:
        info.cell(row=row, column=1, value=fd["label"])
        hint = fd.get("help") or ""
        if fd.get("options"):
            hint = (hint + " " if hint else "") + "可选值：" + " / ".join(
                o for o in fd["options"] if o)
        if fd["type"] == "date":
            hint = (hint + " " if hint else "") + "格式：YYYY-MM-DD"
        if fd["type"] == "datetime":
            hint = (hint + " " if hint else "") + "格式：YYYY-MM-DD HH:mm"
        if fd.get("required"):
            hint = "【必填】" + hint
        info.cell(row=row, column=2, value=hint)
        row += 1
    for r in range(1, row):
        info.cell(row=r, column=2).alignment = Alignment(wrap_text=True, vertical="top")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def template_workbook(collection_key: str) -> bytes:
    coll = schema.get_collection(collection_key)
    fields = _form_fields(collection_key)
    wb = Workbook()
    ws = wb.active
    ws.title = coll["short"][:30]
    _write_header(ws, fields)

    # 一行示例
    sample = {}
    for fd in fields:
        if fd["key"] == "id":
            sample[fd["key"]] = "留空自动生成"
            continue
        if fd.get("options"):
            sample[fd["key"]] = next((o for o in fd["options"] if o), "")
        elif fd["type"] == "date":
            sample[fd["key"]] = _dt.date.today().strftime("%Y-%m-%d")
        elif fd["type"] == "datetime":
            sample[fd["key"]] = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        elif fd["type"] == "number":
            sample[fd["key"]] = fd.get("default") or 0
        elif fd["type"] == "bool":
            sample[fd["key"]] = "否"
        else:
            sample[fd["key"]] = fd.get("default") or ""
    for col, fd in enumerate(fields, start=1):
        cell = ws.cell(row=2, column=col, value=sample.get(fd["key"]))
        cell.font = Font(color="808080", italic=True)
        cell.border = BORDER

    note = wb.create_sheet("填写说明")
    note.column_dimensions["A"].width = 18
    note.column_dimensions["B"].width = 60
    note["A1"] = "导入说明"
    note["A1"].font = Font(bold=True, size=12)
    lines = [
        "1. 第 1 行为表头，请勿修改表头文字；第 2 行为灰色示例行，导入前请删除。",
        "2. 编号列留空表示新增；填写已有编号表示更新该条记录。",
        "3. 日期格式 YYYY-MM-DD，日期时间格式 YYYY-MM-DD HH:mm。",
        "4. 下拉类字段请填写可选值中的某一项，不填视为空。",
        "5. 只支持 .xlsx 文件，.xls 请先另存为 .xlsx。",
    ]
    for i, line in enumerate(lines, start=3):
        note.cell(row=i, column=1, value=line)
    row = 10
    for fd in fields:
        note.cell(row=row, column=1, value=fd["label"])
        hint = fd.get("help") or ""
        if fd.get("options"):
            hint = (hint + " " if hint else "") + "可选值：" + " / ".join(
                o for o in fd["options"] if o)
        if fd.get("required"):
            hint = "【必填】" + hint
        note.cell(row=row, column=2, value=hint)
        note.cell(row=row, column=2).alignment = Alignment(wrap_text=True, vertical="top")
        row += 1

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def import_workbook(collection_key: str, content: bytes) -> dict:
    """按表头中文名映射字段，编号存在则更新，否则新增。"""
    coll = schema.get_collection(collection_key)
    fields = _form_fields(collection_key)
    label_to_key = {fd["label"]: fd["key"] for fd in fields}

    try:
        wb = load_workbook(io.BytesIO(content), data_only=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"无法读取 Excel 文件：{exc}")

    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise ValueError("文件为空")

    header = [str(c).strip() if c is not None else "" for c in rows[0]]
    col_map = {}
    for idx, name in enumerate(header):
        key = label_to_key.get(name)
        if key:
            col_map[idx] = key
    if not col_map:
        raise ValueError("表头与模板不匹配，请下载最新模板后再导入")

    inserted = updated = skipped = 0
    errors: list[str] = []
    existing = {str(it.get("id")): it for it in store.all_items(collection_key)}

    for line_no, row in enumerate(rows[1:], start=2):
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        payload = {}
        for idx, key in col_map.items():
            if idx < len(row):
                payload[key] = row[idx]

        item_id = str(payload.pop("id", "") or "").strip()
        if item_id in ("留空自动生成", "编号", "None"):
            item_id = ""

        try:
            if item_id and item_id in existing:
                store.update_item(collection_key, item_id, payload)
                updated += 1
            elif item_id and item_id not in existing:
                errors.append(f"第 {line_no} 行：编号 {item_id} 不存在，已跳过")
                skipped += 1
            else:
                store.create_item(collection_key, payload)
                inserted += 1
        except ValueError as exc:
            errors.append(f"第 {line_no} 行：{exc}")
            skipped += 1

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "errors": errors[:50],
        "totalErrors": len(errors),
    }
