# -*- coding: utf-8 -*-
"""集合与字段定义：整个工作台的唯一真源。

前端通过 /api/schema 拿到本文件的序列化结果，通用渲染列表与表单；
后端用同一份定义做校验、编号、Excel 表头。新增字段只改这里。
"""
from __future__ import annotations

import datetime as _dt

# ---------------------------------------------------------------- 字典

DEPARTMENTS = [
    "安全环保部", "生产部", "设备部", "技术部", "仓储物流部", "行政后勤部",
    "质检部", "工程部", "采购部", "财务部", "人力资源部", "其他",
]

DICTS = {
    "departments": DEPARTMENTS,
}

# ---------------------------------------------------------------- 字段工具


def f(key, label, type_="text", required=False, options=None, default="",
      in_list=True, width=140, help_="", compute=None, form=True,
      show_when=None):
    """构造一个字段定义。

    show_when: {"key": 另一字段, "in": [...]}，只有该字段取指定值时才在表单显示。
    """
    d = {
        "key": key,
        "label": label,
        "type": type_,
        "required": bool(required),
        "default": default,
        "in_list": bool(in_list),
        "width": int(width),
        "help": help_,
        "form": bool(form),
    }
    if options is not None:
        d["options"] = list(options)
    if compute is not None:
        d["compute"] = compute
    if show_when is not None:
        d["showWhen"] = show_when
    return d


# ---------------------------------------------------------------- 通用字段

def common_fields():
    return [
        f("remark", "备注", "textarea", in_list=False, width=200),
        f("createdAt", "创建时间", "datetime", in_list=False, form=False),
        f("updatedAt", "更新时间", "datetime", in_list=False, form=False),
    ]


ID_FIELD = f("id", "编号", "id", required=False, in_list=True, width=130,
             help_="系统自动生成，不可修改", form=False)


# ---------------------------------------------------------------- 计算器

def _today() -> _dt.date:
    return _dt.date.today()


def _parse_date(value):
    if not value:
        return None
    if isinstance(value, _dt.date):
        return value
    try:
        return _dt.datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _parse_dt(value):
    if not value:
        return None
    if isinstance(value, _dt.datetime):
        return value
    s = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


CYCLE_DAYS = {"每月": 30, "每季": 91, "每半年": 182, "每年": 365}


def compute_hazard_overdue(rec, _ctx=None):
    """未关闭且整改期限早于今天 → 逾期。"""
    if rec.get("status") == "已关闭":
        return False
    d = _parse_date(rec.get("deadline"))
    if not d:
        return False
    return d < _today()


def compute_hazard_overdue_days(rec, _ctx=None):
    if not compute_hazard_overdue(rec):
        return 0
    d = _parse_date(rec.get("deadline"))
    return (_today() - d).days if d else 0


def compute_risk_score(rec, _ctx=None):
    try:
        l_val = int(rec.get("likelihood") or 0)
        s_val = int(rec.get("severity") or 0)
    except (TypeError, ValueError):
        return None
    if l_val <= 0 or s_val <= 0:
        return None
    return l_val * s_val


def risk_level_of(score):
    """LEC 简化法分级。"""
    if score is None:
        return ""
    if score >= 20:
        return "重大风险"
    if score >= 15:
        return "较大风险"
    if score >= 9:
        return "一般风险"
    return "低风险"


def compute_risk_level(rec, _ctx=None):
    return risk_level_of(compute_risk_score(rec))


def compute_cert_days_left(rec, _ctx=None):
    d = _parse_date(rec.get("expireDate"))
    if not d:
        return None
    return (d - _today()).days


def compute_cert_warn(rec, _ctx=None):
    if rec.get("status") == "已注销":
        return "已注销"
    left = compute_cert_days_left(rec)
    if left is None:
        return ""
    if left < 0:
        return "已过期"
    if left <= 30:
        return "30天内到期"
    return "正常"


def compute_fire_next_check(rec, _ctx=None):
    last = _parse_date(rec.get("lastCheckDate"))
    days = CYCLE_DAYS.get(rec.get("checkCycle") or "")
    if not last or not days:
        return ""
    return (last + _dt.timedelta(days=days)).strftime("%Y-%m-%d")


def compute_fire_overdue(rec, _ctx=None):
    nxt = _parse_date(compute_fire_next_check(rec))
    if not nxt:
        return False
    if rec.get("status") in ("已停用", "已报废"):
        return False
    return nxt < _today()


def compute_contractor_expire_warn(rec, _ctx=None):
    d = _parse_date(rec.get("expireDate"))
    if not d:
        return ""
    left = (d - _today()).days
    if left < 0:
        return "已过期"
    if left <= 30:
        return "30天内到期"
    return "正常"


def compute_permit_state(rec, _ctx=None):
    """作业票时效：未结束且已过结束时间 → 超期。"""
    if rec.get("status") in ("已完工", "已关闭", "已作废"):
        return ""
    end = _parse_dt(rec.get("endTime"))
    if not end:
        return ""
    now = _dt.datetime.now()
    if end < now:
        return "已超期"
    if end - now <= _dt.timedelta(hours=24):
        return "24小时内到期"
    return "进行中"


def compute_equipment_next_check(rec, _ctx=None):
    """设备下次检验/校验日期 = 上次检验日期 + 检验周期。"""
    last = _parse_date(rec.get("lastCheckDate"))
    days = CYCLE_DAYS.get(rec.get("checkCycle") or "")
    if not last or not days:
        return ""
    return (last + _dt.timedelta(days=days)).strftime("%Y-%m-%d")


def compute_equipment_check_warn(rec, _ctx=None):
    """检验到期提醒：已过期 / 30天内到期 / 正常 / 空。"""
    if rec.get("status") in ("已停用", "已报废"):
        return "已停用"
    nxt = _parse_date(compute_equipment_next_check(rec))
    if not nxt:
        return ""
    left = (nxt - _today()).days
    if left < 0:
        return "已过期"
    if left <= 30:
        return "30天内到期"
    return "正常"


def compute_equipment_expire_warn(rec, _ctx=None):
    """下次外部检验有效期提醒（特种设备定期检验）。"""
    if rec.get("status") in ("已停用", "已报废"):
        return "已停用"
    d = _parse_date(rec.get("inspectExpire"))
    if not d:
        return ""
    left = (d - _today()).days
    if left < 0:
        return "已过期"
    if left <= 30:
        return "30天内到期"
    return "正常"


def compute_equipment_days_left(rec, _ctx=None):
    """距下次检验剩余天数（负数为已过期）。"""
    d = _parse_date(rec.get("inspectExpire"))
    if not d:
        return None
    return (d - _today()).days


def compute_equipment_category(rec, _ctx=None):
    """设备大类：按类别字段归到三大类，便于看板统计。"""
    t = rec.get("type") or ""
    if t in ("吊车", "叉车", "电梯", "储气罐", "锅炉", "压力容器", "起重机械"):
        return "特种设备类"
    if t in ("气包压力表", "气罐压力表", "安全阀", "流量计"):
        return "表阀类"
    return "其他类"


def compute_concern_overdue(rec, _ctx=None):
    """安全疑虑超过处理时限未关闭 → 超期。"""
    if rec.get("status") in ("已关闭", "已转隐患"):
        return False
    deadline = _parse_date(rec.get("deadline"))
    if not deadline:
        return False
    return deadline < _today()


def compute_concern_days_left(rec, _ctx=None):
    """距处理时限剩余天数（负数表示已超期）。"""
    if rec.get("status") in ("已关闭", "已转隐患"):
        return None
    deadline = _parse_date(rec.get("deadline"))
    if not deadline:
        return None
    return (deadline - _today()).days


def compute_concern_reply_state(rec, _ctx=None):
    """反馈状态：是否已答复提出人。"""
    if rec.get("status") in ("已关闭", "已转隐患"):
        return "已办结"
    if rec.get("replyDate"):
        return "已答复"
    return "待答复"


# 事件等级说明（依据公司《事件等级划分标准》）
INCIDENT_LEVEL_DESC = {
    ("急救箱事件", "A级"): "急救箱A：需到医院检查，停工休假 3 天以内",
    ("急救箱事件", "B级"): "急救箱B：需到医院清洗、消毒、清创、包扎",
    ("急救箱事件", "C级"): "急救箱C：用急救箱物品处理，不影响工作",
    ("医疗处置事件", "A级"): "医疗A：停工休假 15 天以上",
    ("医疗处置事件", "B级"): "医疗B：停工休假 15 天以内（含 15 天）",
    ("医疗处置事件", "C级"): "医疗C：停工休假 3 天以内（含 3 天）",
    ("一般事故", "A级"): "一般事故A：3 人以下死亡，或 3–10 人重伤，或 10 人以上轻伤，或 100–1000 万元损失",
    ("一般事故", "B级"): "一般事故B：3 人以下重伤，或 3–10 人轻伤，或 10–100 万元损失",
    ("一般事故", "C级"): "一般事故C：3 人以下轻伤，或 10 万元以下损失",
    ("安全疑虑", ""): "尚未发生事故，但可能引发事故的不安全因素",
    ("未遂事件", ""): "未造成伤害、疾病和损失的意外事件，但非常接近发生",
    ("一般事件", ""): "造成企业直接经济损失的事件（工业安全/道路交通/火灾/其他）",
}


def compute_incident_level_desc(rec, _ctx=None):
    """根据大类 + 细分等级返回等级说明。"""
    level1 = rec.get("level1") or ""
    grade = rec.get("grade") or ""
    key = (level1, grade)
    if key in INCIDENT_LEVEL_DESC:
        return INCIDENT_LEVEL_DESC[key]
    if (level1, "") in INCIDENT_LEVEL_DESC:
        return INCIDENT_LEVEL_DESC[(level1, "")]
    return ""


COMPUTERS = {
    "hazard_overdue": compute_hazard_overdue,
    "hazard_overdue_days": compute_hazard_overdue_days,
    "risk_score": compute_risk_score,
    "risk_level": compute_risk_level,
    "cert_days_left": compute_cert_days_left,
    "cert_warn": compute_cert_warn,
    "fire_next_check": compute_fire_next_check,
    "fire_overdue": compute_fire_overdue,
    "contractor_expire_warn": compute_contractor_expire_warn,
    "permit_state": compute_permit_state,
    "concern_overdue": compute_concern_overdue,
    "concern_days_left": compute_concern_days_left,
    "concern_reply_state": compute_concern_reply_state,
    "incident_level_desc": compute_incident_level_desc,
    "equipment_next_check": compute_equipment_next_check,
    "equipment_check_warn": compute_equipment_check_warn,
    "equipment_expire_warn": compute_equipment_expire_warn,
    "equipment_days_left": compute_equipment_days_left,
    "equipment_category": compute_equipment_category,
}

# ---------------------------------------------------------------- 集合定义


def _hazards():
    return {
        "key": "hazards",
        "label": "隐患排查治理",
        "short": "隐患",
        "prefix": "YH",
        "icon": "⚠",
        "desc": "排查发现 → 登记 → 整改 → 验收 → 关闭",
        "statusField": "status",
        "defaultStatus": "待整改",
        "fields": [
            ID_FIELD,
            f("title", "隐患描述", "text", required=True, width=240,
              help_="一句话说清问题，如「三车间东侧配电箱门锁损坏」"),
            f("category", "隐患类别", "select", required=True, width=110,
              options=["设备设施", "作业行为", "消防安全", "电气安全", "危化品",
                       "职业健康", "环境管理", "管理缺陷", "其他"]),
            f("level", "隐患等级", "select", required=True, width=100,
              options=["一般隐患", "重大隐患"], default="一般隐患"),
            f("source", "发现来源", "select", required=True, width=110,
              options=["日常巡检", "专项检查", "节前检查", "上级检查",
                       "第三方检查", "员工举报", "班组自查"], default="日常巡检"),
            f("foundDate", "发现日期", "date", required=True, width=110),
            f("foundBy", "发现人", "text", width=90),
            f("dept", "责任部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("location", "所在位置", "text", width=150,
              help_="厂区 / 车间 / 具体位置"),
            f("description", "详细描述", "textarea", in_list=False,
              help_="现场情况、可能造成的后果"),
            f("measure", "整改措施", "textarea", in_list=False),
            f("responsible", "整改责任人", "text", required=True, width=100),
            f("deadline", "整改期限", "date", required=True, width=110),
            f("status", "状态", "select", required=True, width=90,
              options=["待整改", "整改中", "待验收", "已关闭"], default="待整改"),
            f("overdue", "逾期", "computed", width=70, compute="hazard_overdue",
              form=False),
            f("rectifyDate", "整改完成日期", "date", width=120),
            f("rectifyNote", "整改情况说明", "textarea", in_list=False),
            f("cost", "整改投入(元)", "number", width=110, in_list=False),
            f("checkDate", "验收日期", "date", width=110),
            f("checkBy", "验收人", "text", width=90),
            f("checkResult", "验收结果", "select", width=90,
              options=["", "通过", "不通过"]),
        ] + common_fields(),
        "transitions": [
            {"action": "开始整改", "from": ["待整改"], "to": "整改中"},
            {"action": "提交验收", "from": ["整改中"], "to": "待验收",
             "requires": ["rectifyDate"]},
            {"action": "验收通过", "from": ["待验收"], "to": "已关闭",
             "requires": ["checkDate", "checkBy"], "set": {"checkResult": "通过"}},
            {"action": "验收不通过", "from": ["待验收"], "to": "整改中",
             "requires": ["checkBy"], "set": {"checkResult": "不通过", "checkDate": ""}},
            {"action": "撤销关闭", "from": ["已关闭"], "to": "待验收"},
        ],
    }


def _risks():
    return {
        "key": "risks",
        "label": "风险分级管控",
        "short": "风险",
        "prefix": "FX",
        "icon": "◈",
        "desc": "风险点辨识、四色分级、管控措施与检查频次",
        "statusField": "status",
        "defaultStatus": "受控",
        "fields": [
            ID_FIELD,
            f("riskPoint", "风险点名称", "text", required=True, width=200),
            f("location", "所在区域", "text", width=140),
            f("activity", "作业活动/设备", "text", width=160),
            f("hazardFactor", "危险有害因素", "textarea", required=True,
              in_list=False, help_="可能造成伤害的能量或物质"),
            f("accidentType", "可能导致的事故", "select", width=120,
              options=["物体打击", "车辆伤害", "机械伤害", "起重伤害", "触电",
                       "淹溺", "灼烫", "火灾", "高处坠落", "坍塌", "中毒和窒息",
                       "容器爆炸", "其他伤害"]),
            f("likelihood", "可能性 L", "number", required=True, width=90,
              default=3, help_="1–5 整数，越大越可能发生"),
            f("severity", "严重性 S", "number", required=True, width=90,
              default=3, help_="1–5 整数，越大后果越严重"),
            f("riskScore", "风险值 R", "computed", width=80, compute="risk_score",
              form=False, help_="R = L × S，系统自动计算"),
            f("riskLevel", "风险等级", "computed", width=90, compute="risk_level",
              form=False),
            f("controlMeasures", "管控措施", "textarea", required=True,
              in_list=False, help_="技术 / 管理 / 培训 / 个体防护 / 应急"),
            f("controlLevel", "管控层级", "select", required=True, width=100,
              options=["公司级", "部门级", "班组级", "岗位级"], default="班组级"),
            f("dept", "责任部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("responsible", "责任人", "text", width=90),
            f("checkFreq", "检查频次", "select", width=100,
              options=["每班", "每日", "每周", "每月", "每季", "每半年", "每年"]),
            f("lastCheckDate", "最近检查日期", "date", width=120),
            f("status", "受控状态", "select", required=True, width=90,
              options=["受控", "失控", "整改中", "已消除"], default="受控"),
        ] + common_fields(),
        "transitions": [],
    }


def _concerns():
    """安全疑虑：员工反映的安全顾虑，尚未确认为隐患。

    与隐患的区别：隐患是已确认的问题（有整改责任和期限）；
    安全疑虑是「我觉得这里不安全」的主观反馈，需要先核实判断，
    确认成立后转隐患走闭环，不成立则说明原因关闭。
    """
    return {
        "key": "concerns",
        "label": "安全疑虑",
        "short": "疑虑",
        "prefix": "AQ",   # 安全疑虑
        "icon": "💬",
        "desc": "员工反映的安全顾虑：登记 → 核实 → 答复 → 转隐患或关闭",
        "statusField": "status",
        "defaultStatus": "待核实",
        "fields": [
            ID_FIELD,
            f("title", "疑虑内容", "text", required=True, width=240,
              help_="一句话说清顾虑，如「三车间东侧地面油污容易滑倒」"),
            f("status", "处理状态", "select", required=True, width=100,
              options=["待核实", "核实中", "待答复", "已关闭", "已转隐患"],
              default="待核实"),
            f("overdue", "超期", "computed", width=76,
              compute="concern_overdue", form=False),
            f("replyState", "反馈", "computed", width=88,
              compute="concern_reply_state", form=False),
            f("severity", "初步判断", "select", width=90,
              options=["低", "中", "高"], default="中",
              help_="登记时的初步风险判断，核实后可调整"),
            f("category", "疑虑类别", "select", required=True, width=100,
              options=["设备设施", "作业行为", "消防安全", "电气安全", "危化品",
                       "职业健康", "环境管理", "作业环境", "管理缺陷", "其他"],
              default="作业环境"),
            f("dept", "所属部门", "select", required=True, width=100,
              options=DEPARTMENTS),
            f("deadline", "处理时限", "date", required=True, width=104,
              help_="承诺给反映人的答复期限，超期会标红"),
            f("daysLeft", "剩余", "computed", width=80,
              compute="concern_days_left", form=False),
            f("source", "反映渠道", "select", required=True, width=100,
              options=["现场反映", "班前会", "意见箱", "微信/电话", "工会",
                       "安全员巡查", "举报", "其他"],
              default="现场反映"),
            f("reporter", "反映人", "text", width=90,
              help_="可留空表示匿名反映"),
            f("reporterType", "反映人类型", "select", width=100,
              options=["本厂员工", "班组长", "承包商人员", "访客", "匿名"],
              default="本厂员工", in_list=False),
            f("location", "涉及位置", "text", width=140,
              help_="厂区 / 车间 / 具体位置"),
            f("foundDate", "反映日期", "date", required=True, width=104),
            f("description", "详细描述", "textarea", in_list=False,
              help_="把顾虑说清楚，便于核实"),
            f("verifyDate", "核实日期", "date", width=104, in_list=False),
            f("verifier", "核实人", "text", width=88, in_list=False),
            f("conclusion", "核实结论", "textarea", in_list=False,
              help_="是否属实、可能后果"),
            f("replyDate", "答复日期", "date", width=104, in_list=False),
            f("replyContent", "答复内容", "textarea", in_list=False,
              help_="向反映人反馈的处理意见"),
            f("handle", "处理措施", "textarea", in_list=False),
            f("hazardId", "转隐患编号", "text", width=130,
              help_="转隐患后填写生成的隐患编号，便于追溯"),
        ] + common_fields(),
        "transitions": [
            {"action": "开始核实", "from": ["待核实"], "to": "核实中"},
            {"action": "转隐患", "from": ["待核实", "核实中"], "to": "已转隐患",
             "requires": ["conclusion", "hazardId"],
             "help_": "确认成立后，请到「隐患排查治理」新建隐患，再把编号填到这里"},
            {"action": "答复并关闭", "from": ["待核实", "核实中", "待答复"], "to": "已关闭",
             "requires": ["replyDate", "replyContent"]},
            {"action": "退回待核实", "from": ["核实中", "待答复"], "to": "待核实"},
            {"action": "重新打开", "from": ["已关闭", "已转隐患"], "to": "待核实"},
        ],
    }


def _incidents():
    return {
        "key": "incidents",
        "label": "事故事件管理",
        "short": "事故",
        "prefix": "SG",
        "icon": "✖",
        "desc": "事故与未遂事件登记、原因分析、结案统计",
        "statusField": "status",
        "defaultStatus": "调查中",
        "fields": [
            ID_FIELD,
            f("title", "事件名称", "text", required=True, width=220),
            f("level1", "事件大类", "select", required=True, width=120,
              options=["安全疑虑", "未遂事件", "一般事件", "急救箱事件",
                       "医疗处置事件", "一般事故"],
              default="未遂事件",
              help_="按公司《事件等级划分标准》分类"),
            f("grade", "细分等级", "select", width=120,
              options=["", "A级", "B级", "C级"],
              show_when={"key": "level1", "in": ["急救箱事件", "医疗处置事件",
                                                 "一般事故"]},
              help_="急救箱/医疗处置/一般事故需细分为 A/B/C 级"),
            f("levelDesc", "等级说明", "computed", width=170,
              compute="incident_level_desc", form=False, in_list=False),
            f("type", "事件类型", "select", required=True, width=110,
              options=["人身伤害", "火灾爆炸", "设备事故", "交通事故", "环境污染",
                       "职业病", "未遂事件", "险兆事件", "其他"],
              default="人身伤害"),
            f("occurDate", "发生时间", "datetime", required=True, width=150),
            f("location", "发生地点", "text", required=True, width=150),
            f("dept", "责任部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("persons", "涉及人员", "text", width=120),
            f("injuryPart", "受伤部位", "text", width=110,
              show_when={"key": "level1", "in": ["急救箱事件", "医疗处置事件",
                                                 "一般事故"]}),
            f("loss", "直接经济损失(元)", "number", width=130),
            f("lossDays", "损失工日", "number", width=100,
              show_when={"key": "level1", "in": ["医疗处置事件", "一般事件",
                                                 "一般事故", "急救箱事件"]}),
            f("medicalCost", "医疗费用(元)", "number", width=120,
              show_when={"key": "level1", "in": ["急救箱事件", "医疗处置事件"]},
              help_="急救箱事件指医疗费用 1500 元以下"),
            f("cause", "直接原因", "textarea", required=True, in_list=False),
            f("rootCause", "根本原因", "textarea", in_list=False,
              help_="管理 / 制度 / 培训层面"),
            f("measures", "纠正预防措施", "textarea", required=True, in_list=False),
            f("status", "处理状态", "select", required=True, width=100,
              options=["调查中", "整改中", "已结案"], default="调查中"),
            f("reportDate", "上报日期", "date", width=110, in_list=False),
            f("closeDate", "结案日期", "date", width=110),
            f("reporter", "报告人", "text", width=90),
        ] + common_fields(),
        "transitions": [
            {"action": "转入整改", "from": ["调查中"], "to": "整改中"},
            {"action": "结案", "from": ["调查中", "整改中"], "to": "已结案",
             "requires": ["closeDate"]},
            {"action": "重新调查", "from": ["已结案"], "to": "调查中",
             "set": {"closeDate": ""}},
        ],
    }


def _trainings():
    return {
        "key": "trainings",
        "label": "教育培训",
        "short": "培训",
        "prefix": "PX",
        "icon": "✎",
        "desc": "三级教育、专项培训、复训与考核记录",
        "statusField": "status",
        "defaultStatus": "计划中",
        "fields": [
            ID_FIELD,
            f("title", "培训主题", "text", required=True, width=220),
            f("type", "培训类型", "select", required=True, width=120,
              options=["三级教育", "日常培训", "专项培训", "复训",
                       "应急演练培训", "外来人员教育"]),
            f("target", "培训对象", "text", width=150),
            f("dept", "组织部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("trainDate", "培训日期", "date", required=True, width=110),
            f("hours", "学时", "number", required=True, width=80),
            f("trainer", "讲师", "text", width=90),
            f("place", "培训地点", "text", width=140, in_list=False),
            f("method", "培训方式", "select", width=110,
              options=["集中授课", "现场实操", "线上学习", "会议宣贯", "其他"]),
            f("attendees", "参训人数", "number", required=True, width=100),
            f("passRate", "考核通过率(%)", "number", width=120,
              help_="0–100，未考核可留空"),
            f("status", "状态", "select", required=True, width=90,
              options=["计划中", "已完成", "已取消"], default="计划中"),
        ] + common_fields(),
        "transitions": [
            {"action": "标记完成", "from": ["计划中"], "to": "已完成"},
            {"action": "取消培训", "from": ["计划中"], "to": "已取消"},
            {"action": "恢复计划", "from": ["已完成", "已取消"], "to": "计划中"},
        ],
    }


def _certificates():
    return {
        "key": "certificates",
        "label": "人员资质证照",
        "short": "证照",
        "prefix": "ZZ",
        "icon": "🪪",
        "desc": "特种作业证与资格证台账、到期自动提醒",
        "statusField": "status",
        "defaultStatus": "有效",
        "fields": [
            ID_FIELD,
            f("personName", "姓名", "text", required=True, width=100),
            f("empNo", "工号", "text", width=90),
            f("dept", "所属部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("certType", "证书类型", "select", required=True, width=170,
              options=["特种作业操作证", "安全生产管理人员资格证", "特种设备作业证",
                       "消防设施操作员证", "职业健康培训证", "其他"]),
            f("certNo", "证书编号", "text", width=150),
            f("issuer", "发证机关", "text", width=150, in_list=False),
            f("issueDate", "发证日期", "date", width=110),
            f("expireDate", "到期日期", "date", required=True, width=110),
            f("daysLeft", "剩余天数", "computed", width=90,
              compute="cert_days_left", form=False),
            f("expiryWarn", "到期提醒", "computed", width=110,
              compute="cert_warn", form=False),
            f("status", "状态", "select", required=True, width=90,
              options=["有效", "已注销"], default="有效"),
        ] + common_fields(),
        "transitions": [
            {"action": "注销", "from": ["有效"], "to": "已注销"},
            {"action": "恢复有效", "from": ["已注销"], "to": "有效"},
        ],
    }


def _fire_equipments():
    return {
        "key": "fireEquipments",
        "label": "消防设施器材",
        "short": "消防设施",
        "prefix": "XF",
        "icon": "🧯",
        "desc": "灭火器、消火栓等设施台账与点检周期管理",
        "statusField": "status",
        "defaultStatus": "正常",
        "fields": [
            ID_FIELD,
            f("name", "设施名称", "text", required=True, width=180),
            f("type", "设施类型", "select", required=True, width=120,
              options=["灭火器", "消火栓", "自动喷淋", "火灾报警", "应急照明",
                       "疏散指示", "防排烟", "防火门", "消防泵", "其他"]),
            f("location", "安装位置", "text", required=True, width=170),
            f("model", "规格型号", "text", width=130, in_list=False),
            f("quantity", "数量", "number", required=True, width=80, default=1),
            f("checkCycle", "点检周期", "select", required=True, width=100,
              options=["每月", "每季", "每半年", "每年"], default="每月"),
            f("lastCheckDate", "最近点检日期", "date", width=120),
            f("nextCheckDate", "下次点检日期", "computed", width=120,
              compute="fire_next_check", form=False),
            f("checkResult", "点检结果", "select", width=100,
              options=["", "正常", "异常", "待维修"]),
            f("checkOverdue", "点检逾期", "computed", width=90,
              compute="fire_overdue", form=False),
            f("responsible", "责任人", "text", width=90),
            f("status", "设施状态", "select", required=True, width=100,
              options=["正常", "待维修", "已停用", "已报废"], default="正常"),
        ] + common_fields(),
        "transitions": [
            {"action": "标记待维修", "from": ["正常"], "to": "待维修"},
            {"action": "维修完成", "from": ["待维修"], "to": "正常"},
            {"action": "停用", "from": ["正常", "待维修"], "to": "已停用"},
            {"action": "恢复使用", "from": ["已停用"], "to": "正常"},
            {"action": "报废", "from": ["正常", "待维修", "已停用"], "to": "已报废"},
        ],
    }


def _fire_drills():
    return {
        "key": "fireDrills",
        "label": "应急演练",
        "short": "演练",
        "prefix": "YL",
        "icon": "🚨",
        "desc": "演练计划、实施记录、评估与改进措施",
        "statusField": "status",
        "defaultStatus": "计划中",
        "fields": [
            ID_FIELD,
            f("title", "演练名称", "text", required=True, width=220),
            f("type", "演练类型", "select", required=True, width=120,
              options=["综合演练", "专项演练", "桌面推演", "现场处置方案演练"]),
            f("plan", "对应预案", "text", width=160, in_list=False),
            f("planDate", "计划日期", "date", required=True, width=110),
            f("actualDate", "实际日期", "date", width=110),
            f("dept", "组织部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("location", "演练地点", "text", width=140),
            f("commander", "总指挥", "text", width=90),
            f("participants", "参演人数", "number", width=100),
            f("duration", "时长(分钟)", "number", width=110),
            f("conclusion", "演练评估", "textarea", in_list=False),
            f("problems", "发现问题", "textarea", in_list=False),
            f("improvements", "改进措施", "textarea", in_list=False),
            f("status", "状态", "select", required=True, width=100,
              options=["计划中", "已实施", "已评估", "已关闭"], default="计划中"),
        ] + common_fields(),
        "transitions": [
            {"action": "开始实施", "from": ["计划中"], "to": "已实施",
             "requires": ["actualDate"]},
            {"action": "完成评估", "from": ["已实施"], "to": "已评估",
             "requires": ["conclusion"]},
            {"action": "关闭", "from": ["已评估"], "to": "已关闭"},
            {"action": "重新计划", "from": ["已实施", "已评估", "已关闭"], "to": "计划中"},
        ],
    }


def _contractors():
    return {
        "key": "contractors",
        "label": "承包商管理",
        "short": "承包商",
        "prefix": "CBS",
        "icon": "🏗",
        "desc": "相关方准入审核、资质有效期与违章记录",
        "statusField": "status",
        "defaultStatus": "待审核",
        "fields": [
            ID_FIELD,
            f("name", "单位名称", "text", required=True, width=220),
            f("type", "业务类型", "select", required=True, width=120,
              options=["工程施工", "设备检修", "运输物流", "保洁绿化",
                       "设备安装", "劳务分包", "其他"]),
            f("contact", "联系人", "text", required=True, width=100),
            f("phone", "联系电话", "text", required=True, width=120),
            f("license", "营业执照号", "text", width=170, in_list=False),
            f("qualification", "资质等级/范围", "text", width=150, in_list=False),
            f("safetyAgreement", "安全协议", "select", required=True, width=100,
              options=["已签订", "未签订", "不适用"], default="未签订"),
            f("insurance", "保险情况", "text", width=150, in_list=False),
            f("entryDate", "准入日期", "date", width=110),
            f("expireDate", "资质有效期", "date", width=110),
            f("expiryWarn", "到期提醒", "computed", width=110,
              compute="contractor_expire_warn", form=False),
            f("status", "准入状态", "select", required=True, width=100,
              options=["已准入", "待审核", "已暂停", "已清退"], default="待审核"),
            f("violationCount", "违章次数", "number", width=100, default=0),
            f("lastEval", "最近评价", "select", width=100,
              options=["", "优秀", "良好", "合格", "不合格"]),
        ] + common_fields(),
        "transitions": [
            {"action": "审核通过", "from": ["待审核"], "to": "已准入"},
            {"action": "暂停作业", "from": ["已准入"], "to": "已暂停"},
            {"action": "恢复作业", "from": ["已暂停"], "to": "已准入"},
            {"action": "清退", "from": ["已准入", "已暂停", "待审核"], "to": "已清退"},
        ],
    }


def _permits():
    return {
        "key": "permits",
        "label": "作业许可票",
        "short": "作业票",
        "prefix": "ZY",
        "icon": "📋",
        "desc": "八大作业票办理、监护人、安全措施与时效跟踪",
        "statusField": "status",
        "defaultStatus": "待审批",
        "fields": [
            ID_FIELD,
            f("type", "作业类型", "select", required=True, width=130,
              options=["动火作业", "受限空间作业", "高处作业", "吊装作业",
                       "临时用电", "动土作业", "断路作业", "盲板抽堵", "检修作业"]),
            f("level", "作业级别", "select", required=True, width=90,
              options=["一级", "二级", "三级", "特殊"]),
            f("contractor", "施工单位", "text", required=True, width=180),
            f("applicant", "申请人", "text", required=True, width=90),
            f("dept", "申请部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("location", "作业地点", "text", required=True, width=150),
            f("startTime", "开始时间", "datetime", required=True, width=150),
            f("endTime", "结束时间", "datetime", required=True, width=150),
            f("content", "作业内容", "textarea", required=True, in_list=False),
            f("safetyMeasures", "安全措施", "textarea", required=True, in_list=False),
            f("guardian", "监护人", "text", required=True, width=90),
            f("approver", "审批人", "text", width=90),
            f("state", "时效", "computed", width=110, compute="permit_state",
              form=False),
            f("status", "状态", "select", required=True, width=100,
              options=["待审批", "已批准", "作业中", "已完工", "已关闭", "已作废"],
              default="待审批"),
        ] + common_fields(),
        "transitions": [
            {"action": "批准", "from": ["待审批"], "to": "已批准", "requires": ["approver"]},
            {"action": "开始作业", "from": ["已批准"], "to": "作业中"},
            {"action": "完工", "from": ["作业中"], "to": "已完工"},
            {"action": "关闭", "from": ["已完工"], "to": "已关闭"},
            {"action": "作废", "from": ["待审批", "已批准"], "to": "已作废"},
        ],
    }


def _equipments():
    """设备台账：特种设备类 / 表阀类 / 其他类。

    三类的差异用 category 分组 + showWhen 条件字段处理，
    避免为每类设备各建一张表，也便于统一做检验到期统计。
    """
    return {
        "key": "equipments",
        "label": "设备管理",
        "short": "设备",
        "prefix": "SB",
        "icon": "⚙",
        "desc": "特种设备（吊车/叉车/电梯/储气罐）、表阀（压力表/安全阀/流量计）及其他设备台账与检验到期管理",
        "statusField": "status",
        "defaultStatus": "在用",
        "groupField": "category",
        "groups": ["特种设备类", "表阀类", "其他类"],
        # 前端用它实时推算「设备大类」，让 showWhen 能依赖计算字段
        "computedMap": {
            "category": {
                "source": "type",
                "map": {
                    "吊车": "特种设备类", "叉车": "特种设备类", "电梯": "特种设备类",
                    "储气罐": "特种设备类", "锅炉": "特种设备类",
                    "压力容器": "特种设备类", "起重机械": "特种设备类",
                    "气包压力表": "表阀类", "气罐压力表": "表阀类",
                    "安全阀": "表阀类", "流量计": "表阀类",
                },
                "default": "其他类",
            },
        },
        "fields": [
            ID_FIELD,
            f("type", "设备类型", "select", required=True, width=120,
              options=["吊车", "叉车", "电梯", "储气罐", "锅炉", "压力容器",
                       "起重机械", "气包压力表", "气罐压力表", "安全阀", "流量计",
                       "其他设备"],
              help_="选择类型后会自动归入对应大类"),
            f("category", "设备大类", "computed", width=110,
              compute="equipment_category", form=False),
            f("name", "设备名称", "text", required=True, width=200),
            f("code", "设备编号/铭牌号", "text", width=150,
              help_="设备铭牌上的出厂编号或单位内部编号"),
            f("model", "规格型号", "text", width=140),
            f("location", "安装位置", "text", required=True, width=150),
            f("dept", "使用部门", "select", required=True, width=110,
              options=DEPARTMENTS),
            f("responsible", "责任人", "text", width=90),
            # ---- 特种设备类专属
            f("regCode", "使用登记证号", "text", width=170,
              show_when={"key": "category", "in": ["特种设备类"]},
              help_="特种设备须办理使用登记，如「梯 1100001234」"),
            f("ratedLoad", "额定载荷", "text", width=110,
              show_when={"key": "type", "in": ["吊车", "叉车", "起重机械"]},
              help_="如 5t、3t"),
            f("ratedSpeed", "额定速度", "text", width=110,
              show_when={"key": "type", "in": ["电梯"]},
              help_="如 1.75 m/s"),
            f("capacity", "容积/容量", "text", width=110,
              show_when={"key": "type", "in": ["储气罐", "压力容器"]},
              help_="如 2 m³"),
            f("pressure", "工作压力", "text", width=110,
              show_when={"key": "type", "in": ["储气罐", "压力容器", "气包压力表",
                                                "气罐压力表", "安全阀"]},
              help_="如 0.8 MPa"),
            f("nextInspectDate", "下次定期检验", "date", width=130,
              show_when={"key": "category", "in": ["特种设备类"]},
              help_="特种设备定期检验的到期日"),
            # ---- 表阀类专属
            f("range", "量程", "text", width=110,
              show_when={"key": "type", "in": ["气包压力表", "气罐压力表", "流量计"]},
              help_="如 0–1.6 MPa"),
            f("accuracy", "精度等级", "text", width=100,
              show_when={"key": "type", "in": ["气包压力表", "气罐压力表"]},
              help_="如 1.6 级"),
            f("calibCycle", "校验周期", "select", width=100,
              show_when={"key": "category", "in": ["表阀类"]},
              options=["每半年", "每年", "每两年", "每三年"],
              help_="压力表一般每半年校验一次"),
            f("calibDate", "最近校验日期", "date", width=120,
              show_when={"key": "category", "in": ["表阀类"]}),
            f("calibNext", "下次校验日期", "computed", width=120,
              compute="equipment_next_check", form=False),
            f("calibResult", "校验结果", "select", width=100,
              show_when={"key": "category", "in": ["表阀类"]},
              options=["", "合格", "不合格", "待校验"]),
            # ---- 其他类专属
            f("manufacturer", "制造单位", "text", width=160,
              show_when={"key": "category", "in": ["其他类"]}),
            f("installDate", "投用日期", "date", width=110,
              show_when={"key": "category", "in": ["其他类"]}),
            # ---- 通用
            f("inspectExpire", "检验有效期至", "date", width=120,
              help_="下次外部检验/校验的到期日，逾期会在看板提醒"),
            f("daysLeft", "剩余天数", "computed", width=90,
              compute="equipment_days_left", form=False),
            f("expiryWarn", "到期提醒", "computed", width=110,
              compute="equipment_expire_warn", form=False),
            f("status", "设备状态", "select", required=True, width=100,
              options=["在用", "备用", "停用", "维修中", "已报废"], default="在用"),
        ] + common_fields(),
        "transitions": [
            {"action": "转备用", "from": ["在用"], "to": "备用"},
            {"action": "启用", "from": ["备用", "停用"], "to": "在用"},
            {"action": "停用", "from": ["在用", "备用", "维修中"], "to": "停用"},
            {"action": "报修", "from": ["在用", "备用"], "to": "维修中"},
            {"action": "维修完成", "from": ["维修中"], "to": "在用"},
            {"action": "报废", "from": ["在用", "备用", "停用", "维修中"], "to": "已报废"},
        ],
    }


COLLECTIONS = {}
for _builder in (_hazards, _risks, _concerns, _incidents, _trainings, _certificates,
                 _fire_equipments, _fire_drills, _contractors, _permits,
                 _equipments):
    _c = _builder()
    COLLECTIONS[_c["key"]] = _c

COLLECTION_ORDER = list(COLLECTIONS.keys())


def get_collection(key):
    return COLLECTIONS.get(key)


def field_map(collection_key):
    c = COLLECTIONS.get(collection_key)
    if not c:
        return {}
    return {fd["key"]: fd for fd in c["fields"]}


def serialize_schema():
    """给前端的完整 schema。"""
    return {
        "collections": [COLLECTIONS[k] for k in COLLECTION_ORDER],
        "dicts": DICTS,
    }
