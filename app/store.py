# -*- coding: utf-8 -*-
"""JSON 存储层：读写、编号生成、校验、状态流转、备份。"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import shutil
import threading
import time
from typing import Any

import schema

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")

_lock = threading.RLock()
_last_backup: dict[str, float] = {}
BACKUP_INTERVAL = 600          # 10 分钟内不重复备份
BACKUP_KEEP = 20               # 每个集合保留 20 份

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")


# ------------------------------------------------------------------ 基础

def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)


def _path(collection: str) -> str:
    return os.path.join(DATA_DIR, f"{collection}.json")


def _empty(collection: str) -> dict:
    return {
        "collection": collection,
        "version": 1,
        "seq": 0,
        "updatedAt": "",
        "items": [],
    }


def load_raw(collection: str) -> dict:
    ensure_dirs()
    p = _path(collection)
    if not os.path.exists(p):
        return _empty(collection)
    try:
        with open(p, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (json.JSONDecodeError, OSError):
        # 文件损坏：改名保留现场，返回空集合，避免整体不可用
        broken = p + ".broken-" + _dt.datetime.now().strftime("%Y%m%d%H%M%S")
        try:
            shutil.move(p, broken)
        except OSError:
            pass
        return _empty(collection)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return _empty(collection)
    data.setdefault("seq", len(data["items"]))
    data.setdefault("collection", collection)
    return data


def _backup_before_write(collection: str):
    p = _path(collection)
    if not os.path.exists(p):
        return
    now = time.time()
    if now - _last_backup.get(collection, 0) < BACKUP_INTERVAL:
        return
    _last_backup[collection] = now
    ensure_dirs()
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        shutil.copy2(p, os.path.join(BACKUP_DIR, f"{collection}-{stamp}.json"))
    except OSError:
        return
    files = sorted(
        f for f in os.listdir(BACKUP_DIR) if f.startswith(collection + "-")
    )
    for old in files[:-BACKUP_KEEP]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass


def save_raw(collection: str, data: dict):
    ensure_dirs()
    _backup_before_write(collection)
    data["updatedAt"] = _now_str()
    p = _path(collection)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
    # 云同步盘（百度网盘/OneDrive 等）可能短暂占用目标文件，
    # os.replace 会抛 PermissionError，这里做几次退避重试。
    last_exc = None
    for attempt in range(6):
        try:
            os.replace(tmp, p)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.08 * (attempt + 1))
    # 重试仍失败：退化为直接写入（不原子，但至少不丢数据）
    try:
        with open(p, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
        try:
            os.remove(tmp)
        except OSError:
            pass
    except OSError:
        raise last_exc if last_exc else OSError(f"无法写入 {p}")


def _now_str() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _today_str() -> str:
    return _dt.date.today().strftime("%Y-%m-%d")


# ------------------------------------------------------------------ 编号

def next_id(data: dict, prefix: str) -> str:
    """前缀-年份-4位流水，按当年已有最大流水 +1。"""
    year = _dt.date.today().year
    head = f"{prefix}-{year}-"
    max_no = 0
    for item in data.get("items", []):
        iid = str(item.get("id", ""))
        if iid.startswith(head):
            try:
                max_no = max(max_no, int(iid[len(head):]))
            except ValueError:
                continue
    return f"{head}{max_no + 1:04d}"


# ------------------------------------------------------------------ 校验

def _coerce_number(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    s = str(value).strip().replace(",", "").replace("，", "")
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        raise ValueError(f"「{value}」不是有效数字")
    return int(f) if f.is_integer() else f


def _coerce_bool(value):
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    return s in ("1", "true", "是", "y", "yes", "√")


def _normalize_date(value):
    if value is None or value == "":
        return ""
    s = str(value).strip()
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    s = s.replace("/", "-").replace(".", "-").replace("年", "-").replace("月", "-").replace("日", "")
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if not m:
        raise ValueError(f"「{value}」不是有效日期，应为 YYYY-MM-DD")
    y, mo, d = (int(x) for x in m.groups())
    try:
        return _dt.date(y, mo, d).strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError(f"「{value}」不是有效日期")


def _normalize_datetime(value):
    if value is None or value == "":
        return ""
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    s = str(value).strip().replace("T", " ").replace("/", "-")
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ]+(\d{1,2}):(\d{2}))?", s)
    if not m:
        raise ValueError(f"「{value}」不是有效时间，应为 YYYY-MM-DD HH:mm")
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hh = int(m.group(4)) if m.group(4) else 0
    mi = int(m.group(5)) if m.group(5) else 0
    try:
        return _dt.datetime(y, mo, d, hh, mi).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        raise ValueError(f"「{value}」不是有效时间")


def validate_and_clean(collection_key: str, payload: dict,
                       existing: dict | None = None,
                       for_update: bool = False) -> dict:
    """按 schema 校验并清洗一条记录。返回可直接落盘的 dict。"""
    coll = schema.get_collection(collection_key)
    if not coll:
        raise ValueError(f"未知集合：{collection_key}")

    cleaned: dict[str, Any] = {}
    errors: list[str] = []

    # 第一阶段：类型清洗，暂不做必填判断（必填要看字段是否可见）
    for fd in coll["fields"]:
        key = fd["key"]
        ftype = fd["type"]
        if ftype == "id" or key in ("createdAt", "updatedAt"):
            continue
        if ftype == "computed":
            continue

        if key in payload:
            raw = payload[key]
        elif existing is not None and key in existing:
            raw = existing[key]
        else:
            raw = fd.get("default", "")

        try:
            if ftype == "number":
                val = _coerce_number(raw)
            elif ftype == "bool":
                val = _coerce_bool(raw)
            elif ftype == "date":
                val = _normalize_date(raw)
            elif ftype == "datetime":
                val = _normalize_datetime(raw)
            elif ftype == "select":
                s = "" if raw is None else str(raw).strip()
                opts = fd.get("options") or []
                if s and s not in opts:
                    raise ValueError(f"「{s}」不在可选范围内")
                val = s
            else:  # text / textarea
                val = "" if raw is None else str(raw).strip()
        except ValueError as exc:
            errors.append(f"{fd['label']}：{exc}")
            val = "" if ftype != "number" else None

        cleaned[key] = val

    # 第二阶段：先算出 computed 字段（如设备大类依赖设备类型），
    # 再判断每个字段是否可见，只对可见字段做必填校验。
    probe = dict(existing or {})
    probe.update(cleaned)
    apply_computed(collection_key, probe)

    for fd in coll["fields"]:
        if not fd.get("required"):
            continue
        key = fd["key"]
        if fd["type"] in ("id", "computed"):
            continue
        if not _field_visible(fd, probe):
            continue
        val = cleaned.get(key)
        if val is None or val == "" or val is False:
            if not (fd["type"] == "bool" and val is False):
                errors.append(f"{fd['label']}为必填项")

    if errors:
        raise ValueError("；".join(errors))

    _cross_validate(collection_key, cleaned)
    return cleaned


def _field_visible(fd: dict, rec: dict) -> bool:
    """按 showWhen 判断字段在表单中是否可见（隐藏的字段不强制必填）。"""
    rule = fd.get("showWhen")
    if not rule:
        return True
    other = rec.get(rule.get("key"))
    allowed = rule.get("in") or []
    return other in allowed


def _cross_validate(collection_key: str, rec: dict):
    """跨字段业务规则。"""
    errors: list[str] = []

    def d(key):
        v = rec.get(key)
        if not v:
            return None
        try:
            return _dt.datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
        except ValueError:
            return None

    if collection_key == "certificates":
        i, e = d("issueDate"), d("expireDate")
        if i and e and e < i:
            errors.append("到期日期不能早于发证日期")

    if collection_key == "incidents":
        o, c = d("occurDate"), d("closeDate")
        if o and c and c < o:
            errors.append("结案日期不能早于发生时间")
        if rec.get("status") == "已结案" and not c:
            errors.append("状态为「已结案」时必须填写结案日期")

    if collection_key == "permits":
        s = _normalize_datetime_safe(rec.get("startTime"))
        e = _normalize_datetime_safe(rec.get("endTime"))
        if s and e and e < s:
            errors.append("结束时间不能早于开始时间")

    if collection_key == "contractors":
        if rec.get("status") == "已准入":
            if rec.get("safetyAgreement") == "未签订":
                errors.append("状态为「已准入」时安全协议必须已签订")
            e = d("expireDate")
            if e and e < _dt.date.today():
                errors.append("资质已过期，不能置为「已准入」")

    if collection_key == "hazards":
        if rec.get("status") == "已关闭" and rec.get("checkResult") != "通过":
            errors.append("状态为「已关闭」时验收结果必须为「通过」")

    if collection_key == "concerns":
        # 转隐患必须有核实结论和隐患编号，形成可追溯链条
        if rec.get("status") == "已转隐患":
            if not rec.get("conclusion"):
                errors.append("转隐患前必须填写核实结论")
            if not rec.get("hazardId"):
                errors.append("转隐患时必须填写隐患编号，便于追溯")
        # 已关闭必须有答复内容
        if rec.get("status") == "已关闭" and not rec.get("replyContent"):
            errors.append("关闭前必须填写答复内容")

    if collection_key == "equipments":
        # 特种设备必须有使用登记证号与下次定期检验日期
        cat = _equipment_category_of(rec)
        if cat == "特种设备类":
            if not rec.get("regCode"):
                errors.append("特种设备必须填写使用登记证号")
            if not rec.get("nextInspectDate"):
                errors.append("特种设备必须填写下次定期检验日期")
        if cat == "表阀类" and not rec.get("calibCycle"):
            errors.append("表阀类设备必须填写校验周期")
        if rec.get("status") == "已报废" and not rec.get("remark"):
            errors.append("设备报废时请在备注中说明原因与处置方式")

    if errors:
        raise ValueError("；".join(errors))


def _equipment_category_of(rec) -> str:
    t = rec.get("type") or ""
    if t in ("吊车", "叉车", "电梯", "储气罐", "锅炉", "压力容器", "起重机械"):
        return "特种设备类"
    if t in ("气包压力表", "气罐压力表", "安全阀", "流量计"):
        return "表阀类"
    return "其他类"


def _normalize_datetime_safe(value):
    if not value:
        return None
    try:
        return _dt.datetime.strptime(str(value)[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        return None


# ------------------------------------------------------------------ 计算字段

def apply_computed(collection_key: str, rec: dict) -> dict:
    coll = schema.get_collection(collection_key) or {}
    for fd in coll.get("fields", []):
        if fd["type"] != "computed":
            continue
        fn = schema.COMPUTERS.get(fd.get("compute", ""))
        if fn:
            try:
                rec[fd["key"]] = fn(rec)
            except Exception:  # noqa: BLE001 计算失败不应阻断保存
                rec[fd["key"]] = None
    return rec


# ------------------------------------------------------------------ CRUD

def list_items(collection_key: str, query: dict) -> dict:
    with _lock:
        data = load_raw(collection_key)
        items = data["items"]

        # 等值过滤 + 全文搜索
        q = (query.get("q") or "").strip().lower()
        coll = schema.get_collection(collection_key) or {}
        text_keys = [fd["key"] for fd in coll.get("fields", [])
                     if fd["type"] in ("text", "textarea")]
        filters = {}
        for k, v in query.items():
            if k in ("q", "page", "size", "sort", "dir", "_"):
                continue
            if v is None or v == "":
                continue
            filters[k] = str(v)

        def match(item):
            for k, v in filters.items():
                # 分组字段是计算字段，落盘数据里没有，需要现算
                iv = item.get(k)
                if iv is None:
                    fd = next((x for x in coll.get("fields", []) if x["key"] == k), None)
                    if fd and fd["type"] == "computed":
                        iv = apply_computed(collection_key, dict(item)).get(k)
                if isinstance(iv, bool):
                    iv = "true" if iv else "false"
                if str(iv) != v:
                    return False
            if q:
                hay = " ".join(str(item.get(k, "")) for k in text_keys).lower()
                if q not in hay and q not in str(item.get("id", "")).lower():
                    return False
            return True

        filtered = [it for it in items if match(it)]

        sort_key = query.get("sort") or ""
        reverse = (query.get("dir") or "desc").lower() == "desc"
        if sort_key:
            def sort_val(it):
                v = it.get(sort_key)
                if v is None or v == "":
                    return (1, "")
                if isinstance(v, bool):
                    return (0, 1 if v else 0)
                return (0, str(v))
            try:
                filtered.sort(key=sort_val, reverse=reverse)
            except TypeError:
                pass
        else:
            filtered.sort(key=lambda it: str(it.get("createdAt", "")), reverse=True)

        total = len(filtered)
        try:
            page = max(1, int(query.get("page") or 1))
            size = int(query.get("size") or 20)
        except ValueError:
            page, size = 1, 20
        size = max(1, min(size, 500))
        start = (page - 1) * size
        page_items = [apply_computed(collection_key, dict(it))
                      for it in filtered[start:start + size]]

        return {"items": page_items, "total": total, "page": page, "size": size}


def get_item(collection_key: str, item_id: str) -> dict | None:
    with _lock:
        data = load_raw(collection_key)
        for it in data["items"]:
            if str(it.get("id")) == str(item_id):
                return apply_computed(collection_key, dict(it))
    return None


def create_item(collection_key: str, payload: dict) -> dict:
    coll = schema.get_collection(collection_key)
    if not coll:
        raise ValueError(f"未知集合：{collection_key}")
    with _lock:
        data = load_raw(collection_key)
        cleaned = validate_and_clean(collection_key, payload)
        now = _now_str()
        rec = {"id": next_id(data, coll["prefix"])}
        rec.update(cleaned)
        rec["createdAt"] = now
        rec["updatedAt"] = now
        apply_computed(collection_key, rec)
        data["items"].append(rec)
        data["seq"] = len(data["items"])
        save_raw(collection_key, data)
        return dict(rec)


def update_item(collection_key: str, item_id: str, payload: dict) -> dict:
    with _lock:
        data = load_raw(collection_key)
        for idx, it in enumerate(data["items"]):
            if str(it.get("id")) != str(item_id):
                continue
            cleaned = validate_and_clean(collection_key, payload, existing=it,
                                         for_update=True)
            merged = dict(it)
            merged.update(cleaned)
            merged["id"] = it["id"]
            merged["createdAt"] = it.get("createdAt", _now_str())
            merged["updatedAt"] = _now_str()
            apply_computed(collection_key, merged)
            data["items"][idx] = merged
            save_raw(collection_key, data)
            return dict(merged)
    raise ValueError(f"记录不存在：{item_id}")


def delete_item(collection_key: str, item_id: str) -> bool:
    with _lock:
        data = load_raw(collection_key)
        before = len(data["items"])
        data["items"] = [it for it in data["items"]
                         if str(it.get("id")) != str(item_id)]
        if len(data["items"]) == before:
            return False
        save_raw(collection_key, data)
        return True


def transition(collection_key: str, item_id: str, action: str,
               extra: dict | None = None) -> dict:
    """按 schema 中定义的流转规则执行状态变更。"""
    coll = schema.get_collection(collection_key)
    if not coll:
        raise ValueError(f"未知集合：{collection_key}")
    rules = coll.get("transitions") or []
    rule = next((r for r in rules if r["action"] == action), None)
    if not rule:
        raise ValueError(f"不支持的操作：{action}")

    with _lock:
        data = load_raw(collection_key)
        for idx, it in enumerate(data["items"]):
            if str(it.get("id")) != str(item_id):
                continue
            cur = it.get(coll["statusField"], "")
            if cur not in rule["from"]:
                raise ValueError(f"当前状态「{cur}」不能执行「{action}」")

            merged = dict(it)
            if extra:
                cleaned_extra = validate_and_clean(collection_key, extra, existing=it)
                merged.update(cleaned_extra)
            for req in rule.get("requires", []):
                if not merged.get(req):
                    label = next((fd["label"] for fd in coll["fields"]
                                  if fd["key"] == req), req)
                    raise ValueError(f"执行「{action}」前必须填写：{label}")
            for k, v in (rule.get("set") or {}).items():
                merged[k] = v
            merged[coll["statusField"]] = rule["to"]
            merged["updatedAt"] = _now_str()
            apply_computed(collection_key, merged)
            data["items"][idx] = merged
            save_raw(collection_key, data)
            return dict(merged)
    raise ValueError(f"记录不存在：{item_id}")


def count_all() -> dict:
    out = {}
    for key in schema.COLLECTION_ORDER:
        out[key] = len(load_raw(key)["items"])
    return out


def all_items(collection_key: str) -> list[dict]:
    with _lock:
        data = load_raw(collection_key)
        return [apply_computed(collection_key, dict(it)) for it in data["items"]]
