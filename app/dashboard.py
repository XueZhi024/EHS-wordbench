# -*- coding: utf-8 -*-
"""看板 KPI 聚合与提醒清单。口径见 docs/数据模型设计.md 第六节。"""
from __future__ import annotations

import datetime as _dt
from collections import Counter, defaultdict

import store


def _parse_date(value):
    if not value:
        return None
    try:
        return _dt.datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _parse_dt(value):
    if not value:
        return None
    s = str(value).replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(s[:19] if len(s) > 16 else s, fmt)
        except ValueError:
            continue
    return None


def _month_key(d: _dt.date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _in_range(d, start, end) -> bool:
    if d is None:
        return False
    if start and d < start:
        return False
    if end and d > end:
        return False
    return True


def _pct(num, den):
    if not den:
        return None
    return round(num * 100.0 / den, 1)


def build_dashboard(frm: str = "", to: str = "", dept: str = "") -> dict:
    today = _dt.date.today()
    start = _parse_date(frm)
    end = _parse_date(to)
    if not start and not end:
        start = _dt.date(today.year, 1, 1)
        end = _dt.date(today.year, 12, 31)

    def keep(rec, date_key="createdAt"):
        if dept and rec.get("dept") != dept:
            return False
        d = _parse_date(rec.get(date_key))
        if d is None:
            # 无日期字段的记录：仅在未指定时间范围时纳入
            return not (start or end)
        return _in_range(d, start, end)

    hazards = [r for r in store.all_items("hazards") if keep(r, "foundDate")]
    all_hazards = store.all_items("hazards")
    risks = [r for r in store.all_items("risks")
             if (not dept or r.get("dept") == dept)]
    incidents = [r for r in store.all_items("incidents") if keep(r, "occurDate")]
    trainings = [r for r in store.all_items("trainings") if keep(r, "trainDate")]
    certs = store.all_items("certificates")
    fires = store.all_items("fireEquipments")
    contractors = store.all_items("contractors")
    permits = store.all_items("permits")
    drills = [r for r in store.all_items("fireDrills") if keep(r, "planDate")]

    # ---- 隐患
    hz_total = len(hazards)
    hz_closed = sum(1 for r in hazards if r.get("status") == "已关闭")
    closed_ontime = 0
    for r in hazards:
        if r.get("status") != "已关闭":
            continue
        done = _parse_date(r.get("checkDate")) or _parse_date(r.get("rectifyDate"))
        dl = _parse_date(r.get("deadline"))
        if done and dl and done <= dl:
            closed_ontime += 1
    hz_overdue = sum(1 for r in all_hazards
                     if r.get("status") != "已关闭" and r.get("overdue"))
    hz_major = sum(1 for r in hazards if r.get("level") == "重大隐患")

    # ---- 风险
    risk_counter = Counter(r.get("riskLevel") or "未评级" for r in risks)
    risk_major = sum(1 for r in risks
                     if r.get("riskLevel") == "重大风险" and r.get("status") != "已消除")

    # ---- 事故
    inc_loss_days = sum(float(r.get("lossDays") or 0) for r in incidents)
    inc_loss_money = sum(float(r.get("loss") or 0) for r in incidents)
    inc_medical = sum(float(r.get("medicalCost") or 0) for r in incidents)
    inc_by_level1 = Counter(r.get("level1") or "未分类" for r in incidents)
    # 按公司事件等级统计
    inc_faid = inc_by_level1.get("急救箱事件", 0)
    inc_med = inc_by_level1.get("医疗处置事件", 0)
    inc_attempt = inc_by_level1.get("未遂事件", 0)
    inc_general = inc_by_level1.get("一般事件", 0)
    inc_accident = inc_by_level1.get("一般事故", 0)
    # 受伤人员（去重）
    inc_persons = len({r.get("persons") for r in incidents
                       if r.get("persons")})

    # ---- 培训
    tr_done = sum(1 for r in trainings if r.get("status") == "已完成")
    tr_people = sum(float(r.get("attendees") or 0) for r in trainings)

    # ---- 证照
    cert_warn = [r for r in certs
                 if r.get("status") == "有效"
                 and (r.get("daysLeft") is not None and r.get("daysLeft") <= 30)]
    cert_expired = [r for r in certs
                    if r.get("status") == "有效"
                    and (r.get("daysLeft") is not None and r.get("daysLeft") < 0)]

    # ---- 消防
    fire_overdue = [r for r in fires if r.get("checkOverdue")]

    # ---- 承包商
    cbs_active = sum(1 for r in contractors if r.get("status") == "已准入")
    cbs_violations = sum(float(r.get("violationCount") or 0) for r in contractors)
    cbs_expiring = [r for r in contractors
                    if r.get("expiryWarn") in ("30天内到期", "已过期")]

    # ---- 作业票
    permit_running = sum(1 for r in permits if r.get("status") in ("已批准", "作业中"))
    permit_expiring = [r for r in permits if r.get("state") in ("24小时内到期", "已超期")]

    # ---- 安全疑虑
    concerns = [r for r in store.all_items("concerns") if keep(r, "foundDate")]
    all_concerns = store.all_items("concerns")
    cn_total = len(concerns)
    cn_closed = sum(1 for r in concerns if r.get("status") == "已关闭")
    cn_converted = sum(1 for r in concerns if r.get("status") == "已转隐患")
    cn_open = sum(1 for r in all_concerns
                  if r.get("status") not in ("已关闭", "已转隐患"))
    cn_overdue = sum(1 for r in all_concerns if r.get("overdue"))
    cn_unreplied = sum(1 for r in all_concerns
                       if r.get("status") not in ("已关闭", "已转隐患")
                       and not r.get("replyDate"))
    cn_high = sum(1 for r in concerns if r.get("severity") == "高")

    # ---- 设备
    equips = store.all_items("equipments")
    eq_active = [r for r in equips if r.get("status") not in ("已报废", "停用")]
    eq_by_category = Counter(r.get("category") or "其他类" for r in equips)
    eq_by_type = Counter(r.get("type") or "未分类" for r in equips)
    eq_expiring = [r for r in eq_active
                   if r.get("expiryWarn") in ("30天内到期", "已过期")]
    eq_expired = [r for r in eq_active if r.get("expiryWarn") == "已过期"]
    eq_special = sum(1 for r in eq_active if r.get("category") == "特种设备类")

    # ---- 趋势（近 12 个月或所选区间）
    trend_start = start or _dt.date(today.year, 1, 1)
    months = []
    y, m = trend_start.year, trend_start.month
    end_m = end or today
    while (y, m) <= (end_m.year, end_m.month) and len(months) < 24:
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    hz_found_by_month = defaultdict(int)
    hz_closed_by_month = defaultdict(int)
    for r in hazards:
        d = _parse_date(r.get("foundDate"))
        if d:
            hz_found_by_month[_month_key(d)] += 1
        if r.get("status") == "已关闭":
            cd = _parse_date(r.get("checkDate")) or _parse_date(r.get("rectifyDate"))
            if cd:
                hz_closed_by_month[_month_key(cd)] += 1
    inc_by_month = defaultdict(int)
    for r in incidents:
        d = _parse_date(r.get("occurDate"))
        if d:
            inc_by_month[_month_key(d)] += 1

    # ---- 提醒清单
    overdue_list = sorted(
        [r for r in all_hazards if r.get("status") != "已关闭" and r.get("overdue")],
        key=lambda r: str(r.get("deadline") or ""))[:20]

    return {
        "range": {"from": start.strftime("%Y-%m-%d") if start else "",
                  "to": end.strftime("%Y-%m-%d") if end else "",
                  "dept": dept},
        "kpi": {
            "hazardTotal": hz_total,
            "hazardClosed": hz_closed,
            "hazardCloseRate": _pct(hz_closed, hz_total),
            "hazardOnTimeRate": _pct(closed_ontime, hz_closed),
            "hazardOverdue": hz_overdue,
            "hazardMajor": hz_major,
            "riskTotal": len(risks),
            "riskMajor": risk_major,
            "incidentTotal": len(incidents),
            "incidentLossDays": round(inc_loss_days, 1),
            "incidentLossMoney": round(inc_loss_money, 2),
            "incidentMedical": round(inc_medical, 2),
            "incidentPersons": inc_persons,
            "incidentFirstAid": inc_faid,
            "incidentMedicalCase": inc_med,
            "incidentAttempt": inc_attempt,
            "incidentGeneral": inc_general,
            "incidentAccident": inc_accident,
            "trainingTotal": len(trainings),
            "trainingDone": tr_done,
            "trainingRate": _pct(tr_done, len(trainings)),
            "trainingPeople": int(tr_people),
            "certWarn": len(cert_warn),
            "certExpired": len(cert_expired),
            "fireOverdue": len(fire_overdue),
            "fireTotal": len(fires),
            "drillTotal": len(drills),
            "contractorActive": cbs_active,
            "contractorViolations": int(cbs_violations),
            "permitRunning": permit_running,
            "permitExpiring": len(permit_expiring),
            "equipmentTotal": len(equips),
            "equipmentActive": len(eq_active),
            "equipmentSpecial": eq_special,
            "equipmentExpiring": len(eq_expiring),
            "equipmentExpired": len(eq_expired),
            "concernTotal": cn_total,
            "concernOpen": cn_open,
            "concernClosed": cn_closed,
            "concernConverted": cn_converted,
            "concernOverdue": cn_overdue,
            "concernUnreplied": cn_unreplied,
            "concernHigh": cn_high,
        },
        "hazardByCategory": _counter_list(hazards, "category"),
        "hazardByLevel": _counter_list(hazards, "level"),
        "hazardByDept": _counter_list(hazards, "dept", limit=12),
        "riskByLevel": [
            {"name": lv, "value": risk_counter.get(lv, 0)}
            for lv in ("重大风险", "较大风险", "一般风险", "低风险", "未评级")
        ],
        "incidentByType": _counter_list(incidents, "type"),
        "incidentByLevel1": [
            {"name": "急救箱事件", "value": inc_faid},
            {"name": "医疗处置事件", "value": inc_med},
            {"name": "未遂事件", "value": inc_attempt},
            {"name": "一般事件", "value": inc_general},
            {"name": "一般事故", "value": inc_accident},
        ],
        "incidentByGrade": [
            {"name": f"{lv}-{g}", "value": sum(
                1 for r in incidents
                if r.get("level1") == lv and r.get("grade") == g)}
            for lv in ("急救箱事件", "医疗处置事件", "一般事故")
            for g in ("A级", "B级", "C级")
            if any(r.get("level1") == lv and r.get("grade") == g
                   for r in incidents)
        ],
        "concernByCategory": _counter_list(concerns, "category"),
        "concernByStatus": [
            {"name": s, "value": sum(1 for r in concerns if r.get("status") == s)}
            for s in ("待核实", "核实中", "待答复", "已关闭", "已转隐患")
        ],
        "equipmentByCategory": [
            {"name": g, "value": eq_by_category.get(g, 0)}
            for g in ("特种设备类", "表阀类", "其他类")
        ],
        "equipmentByType": _counter_list(equips, "type", limit=12),
        "trend": {
            "months": months,
            "hazardFound": [hz_found_by_month.get(mk, 0) for mk in months],
            "hazardClosed": [hz_closed_by_month.get(mk, 0) for mk in months],
            "incidents": [inc_by_month.get(mk, 0) for mk in months],
        },
        "alerts": {
            "hazardOverdue": [_brief(r, ("title", "dept", "deadline", "level"))
                              for r in overdue_list],
            "certExpiring": [_brief(r, ("personName", "certType", "expireDate",
                                        "daysLeft"))
                             for r in sorted(cert_warn,
                                             key=lambda x: x.get("daysLeft") or 0)[:20]],
            "fireOverdue": [_brief(r, ("name", "location", "nextCheckDate"))
                            for r in fire_overdue[:20]],
            "contractorExpiring": [_brief(r, ("name", "expireDate", "expiryWarn"))
                                   for r in cbs_expiring[:20]],
            "permitExpiring": [_brief(r, ("id", "type", "contractor", "endTime",
                                          "state"))
                               for r in permit_expiring[:20]],
            "equipmentExpiring": [_brief(r, ("id", "name", "type", "location",
                                             "inspectExpire", "expiryWarn"))
                                  for r in sorted(eq_expiring,
                                                  key=lambda x: x.get("inspectExpire") or "")[:20]],
            "concernPending": [_brief(r, ("id", "title", "dept", "deadline",
                                          "status", "severity", "overdue"))
                               for r in sorted(
                                   [r for r in all_concerns
                                    if r.get("status") not in ("已关闭", "已转隐患")],
                                   key=lambda x: str(x.get("deadline") or ""))[:20]],
        },
        "generatedAt": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _counter_list(items, key, limit=20):
    c = Counter(str(r.get(key) or "未填写") for r in items)
    return [{"name": k, "value": v}
            for k, v in c.most_common(limit)]


def _brief(rec: dict, keys) -> dict:
    out = {"id": rec.get("id", "")}
    for k in keys:
        out[k] = rec.get(k)
    return out
