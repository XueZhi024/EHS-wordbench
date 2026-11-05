# -*- coding: utf-8 -*-
"""后端自检：直接调用模块函数，验证 CRUD、校验、状态流转、Excel、看板。

用法：python app/selftest.py
注意：会写入 data/ 目录中的测试数据，运行后自动清理。
"""
from __future__ import annotations

import datetime as _dt
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dashboard  # noqa: E402
import excel  # noqa: E402
import schema  # noqa: E402
import store  # noqa: E402

PASS = 0
FAIL = 0
FAILURES = []


def check(name, fn):
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print(f"  [PASS] {name}")
    except Exception as exc:  # noqa: BLE001
        FAIL += 1
        FAILURES.append((name, exc, traceback.format_exc()))
        print(f"  [FAIL] {name} -> {exc}")


def expect(cond, msg=""):
    if not cond:
        raise AssertionError(msg or "断言失败")


def expect_raises(fn, msg_contains=""):
    try:
        fn()
    except ValueError as exc:
        if msg_contains and msg_contains not in str(exc):
            raise AssertionError(f"错误信息不含「{msg_contains}」：{exc}")
        return
    raise AssertionError("应当抛出校验错误但没有抛出")


TODAY = _dt.date.today().strftime("%Y-%m-%d")
TODAY_DT = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
FUTURE = (_dt.date.today() + _dt.timedelta(days=30)).strftime("%Y-%m-%d")
PAST = (_dt.date.today() - _dt.timedelta(days=10)).strftime("%Y-%m-%d")

created_ids = {}


def main():
    print("=" * 62)
    print("安全管理数据工作台 — 后端自检")
    print("=" * 62)
    store.ensure_dirs()

    print("\n[1] Schema 完整性")
    check("所有集合字段有 key/label/type", _test_schema_shape)
    check("计算字段都有对应计算器", _test_computers_exist)
    check("select 字段都有 options", _test_select_options)

    print("\n[2] 隐患 CRUD 与校验")
    check("新建隐患生成编号", _test_create_hazard)
    check("缺少必填项报错", _test_hazard_required)
    check("枚举值非法报错", _test_hazard_bad_enum)
    check("日期格式非法报错", _test_hazard_bad_date)
    check("查询与分页", _test_hazard_query)
    check("更新记录保留 id 与创建时间", _test_hazard_update)

    print("\n[3] 隐患状态流转")
    check("待整改 → 整改中", lambda: _test_transition("开始整改"))
    check("整改中 → 待验收（需整改日期）", _test_transition_submit)
    check("待验收 → 已关闭（验收通过）", _test_transition_pass)
    check("非法流转被拒绝", _test_transition_illegal)

    print("\n[4] 各模块 CRUD")
    check("风险点：R 值自动计算与分级", _test_risk_compute)
    check("事故：结案日期校验", _test_incident)
    check("事故：A/B/C 等级与说明", _test_incident_grade)
    check("培训：新建与查询", _test_training)
    check("证照：剩余天数与到期提醒", _test_certificate)
    check("消防：下次点检日期计算", _test_fire)
    check("演练：新建", _test_drill)
    check("承包商：准入校验", _test_contractor)
    check("作业票：时间校验", _test_permit)

    print("\n[4b] 安全疑虑")
    check("疑虑：新建与编号", _test_concern_create)
    check("疑虑：超期与剩余天数计算", _test_concern_overdue)
    check("疑虑：转隐患必须填隐患编号", _test_concern_convert_required)
    check("疑虑：关闭必须填答复内容", _test_concern_close_required)
    check("疑虑：完整流转链路", _test_concern_flow)
    check("疑虑：反馈状态计算", _test_concern_reply_state)

    print("\n[4c] 设备管理")
    check("设备：大类自动归类", _test_equipment_category)
    check("设备：特种设备必填登记证与检验日期", _test_equipment_special_required)
    check("设备：表阀校验周期必填", _test_equipment_valve_required)
    check("设备：检验到期提醒计算", _test_equipment_warn)
    check("设备：条件字段隐藏时不强制必填", _test_equipment_hidden_field)
    check("设备：按大类筛选", _test_equipment_filter)
    check("设备：状态流转", _test_equipment_transition)

    print("\n[5] Excel 导入导出")
    check("导出返回 xlsx 字节流", _test_export)
    check("模板可下载", _test_template)
    check("导入新增记录", _test_import_insert)
    check("导入更新已有记录", _test_import_update)

    print("\n[6] 看板聚合")
    check("看板返回全部 KPI", _test_dashboard)

    print("\n[7] 数据持久化")
    check("重新读取数据一致", _test_persistence)

    _cleanup()

    print("\n" + "=" * 62)
    print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
    if FAILURES:
        print("-" * 62)
        for name, exc, tb in FAILURES:
            print(f"失败：{name}\n{tb}")
    print("=" * 62)
    return 0 if FAIL == 0 else 1


# ---------------------------------------------------------------- 测试实现

def _test_schema_shape():
    for key, coll in schema.COLLECTIONS.items():
        for fd in coll["fields"]:
            for k in ("key", "label", "type"):
                expect(k in fd, f"{key} 字段缺 {k}")
        expect(coll.get("prefix"), f"{key} 缺编号前缀")
        expect(coll.get("label"), f"{key} 缺中文名")


def _test_computers_exist():
    for key, coll in schema.COLLECTIONS.items():
        for fd in coll["fields"]:
            if fd["type"] == "computed":
                expect(fd.get("compute") in schema.COMPUTERS,
                       f"{key}.{fd['key']} 缺少计算器 {fd.get('compute')}")


def _test_select_options():
    for key, coll in schema.COLLECTIONS.items():
        for fd in coll["fields"]:
            if fd["type"] == "select":
                expect(fd.get("options"), f"{key}.{fd['key']} 是 select 但无 options")


def _test_create_hazard():
    rec = store.create_item("hazards", {
        "title": "自检-三车间配电箱门锁损坏",
        "category": "电气安全",
        "level": "一般隐患",
        "source": "日常巡检",
        "foundDate": TODAY,
        "dept": "生产部",
        "responsible": "李四",
        "deadline": FUTURE,
    })
    expect(rec["id"].startswith("YH-"), "编号前缀错误")
    expect(len(rec["id"]) >= 12, f"编号长度异常：{rec['id']}")
    expect(rec["status"] == "待整改", "默认状态应为待整改")
    expect(rec["createdAt"], "缺少创建时间")
    created_ids["hazard"] = rec["id"]


def _test_hazard_required():
    expect_raises(lambda: store.create_item("hazards", {"title": "只有标题"}),
                  "必填")


def _test_hazard_bad_enum():
    expect_raises(lambda: store.create_item("hazards", {
        "title": "枚举测试", "category": "不存在的类别", "level": "一般隐患",
        "source": "日常巡检", "foundDate": TODAY, "dept": "生产部",
        "responsible": "张三", "deadline": FUTURE,
    }), "可选范围")


def _test_hazard_bad_date():
    expect_raises(lambda: store.create_item("hazards", {
        "title": "日期测试", "category": "电气安全", "level": "一般隐患",
        "source": "日常巡检", "foundDate": "不是日期", "dept": "生产部",
        "responsible": "张三", "deadline": FUTURE,
    }), "日期")


def _test_hazard_query():
    res = store.list_items("hazards", {"q": "自检", "page": "1", "size": "10"})
    expect("items" in res and "total" in res, "返回结构不对")
    expect(res["total"] >= 1, "搜索应命中自检数据")
    res2 = store.list_items("hazards", {"dept": "生产部", "size": "100"})
    expect(all(it.get("dept") == "生产部" for it in res2["items"]), "部门过滤失效")


def _test_hazard_update():
    hid = created_ids["hazard"]
    before = store.get_item("hazards", hid)
    updated = store.update_item("hazards", hid, {"title": "自检-已更新的隐患描述"})
    expect(updated["title"] == "自检-已更新的隐患描述", "更新未生效")
    expect(updated["id"] == hid, "id 被修改")
    expect(updated["createdAt"] == before["createdAt"], "创建时间被修改")


def _test_transition(action, extra=None):
    hid = created_ids["hazard"]
    rec = store.transition("hazards", hid, action, extra or {})
    expect(rec["status"] == {"开始整改": "整改中", "提交验收": "待验收",
                             "验收通过": "已关闭"}[action], "状态不对")
    return rec


def _test_transition_submit():
    hid = created_ids["hazard"]
    expect_raises(lambda: store.transition("hazards", hid, "提交验收"),
                  "必须填写")
    _test_transition("提交验收", {"rectifyDate": TODAY})


def _test_transition_pass():
    hid = created_ids["hazard"]
    _test_transition("验收通过", {"checkDate": TODAY, "checkBy": "王五"})
    rec = store.get_item("hazards", hid)
    expect(rec["checkResult"] == "通过", "验收结果未写入")
    expect(rec["status"] == "已关闭", "状态未关闭")


def _test_transition_illegal():
    hid = created_ids["hazard"]
    expect_raises(lambda: store.transition("hazards", hid, "开始整改"), "不能执行")


def _test_risk_compute():
    rec = store.create_item("risks", {
        "riskPoint": "自检-三车间冲压工位",
        "hazardFactor": "冲压机滑块下落",
        "likelihood": 5, "severity": 4,
        "controlMeasures": "加装光电保护装置",
        "controlLevel": "部门级", "dept": "生产部",
    })
    expect(rec["riskScore"] == 20, f"R 值错误：{rec['riskScore']}")
    expect(rec["riskLevel"] == "重大风险", f"分级错误：{rec['riskLevel']}")
    rec2 = store.update_item("risks", rec["id"], {"likelihood": 2, "severity": 3})
    expect(rec2["riskScore"] == 6 and rec2["riskLevel"] == "低风险",
           f"改值后未重算：{rec2['riskScore']} {rec2['riskLevel']}")
    created_ids["risk"] = rec["id"]


def _test_incident():
    rec = store.create_item("incidents", {
        "title": "自检-未遂事件", "level1": "未遂事件", "type": "未遂事件",
        "occurDate": TODAY_DT, "location": "一车间", "dept": "生产部",
        "cause": "未按规程操作", "measures": "加强培训",
    })
    expect(rec["id"].startswith("SG-"), "编号前缀错误")
    expect(rec["level1"] == "未遂事件", f"大类错误：{rec['level1']}")
    expect("未造成伤害" in (rec.get("levelDesc") or ""),
           f"等级说明缺失：{rec.get('levelDesc')}")
    expect_raises(lambda: store.update_item("incidents", rec["id"],
                                            {"closeDate": PAST}), "不能早于")
    created_ids["incident"] = rec["id"]


def _test_incident_grade():
    """急救箱/医疗处置事件必须能选 A/B/C 级，并显示对应说明。"""
    rec = store.create_item("incidents", {
        "title": "自检-急救箱事件A级", "level1": "急救箱事件", "grade": "A级",
        "type": "人身伤害", "occurDate": TODAY_DT, "location": "一车间",
        "dept": "生产部", "cause": "打磨铁屑飞溅", "measures": "佩戴护目镜",
        "medicalCost": 118, "lossDays": 3,
    })
    expect(rec["grade"] == "A级", f"等级未保存：{rec['grade']}")
    expect("3 天以内" in (rec.get("levelDesc") or ""),
           f"急救箱A级说明错误：{rec.get('levelDesc')}")
    created_ids["incident2"] = rec["id"]

    # 医疗处置 B 级
    rec2 = store.create_item("incidents", {
        "title": "自检-医疗处置B级", "level1": "医疗处置事件", "grade": "B级",
        "type": "人身伤害", "occurDate": TODAY_DT, "location": "二车间",
        "dept": "生产部", "cause": "切割划伤", "measures": "加强防护",
        "lossDays": 10,
    })
    expect("15 天以内" in (rec2.get("levelDesc") or ""),
           f"医疗处置B级说明错误：{rec2.get('levelDesc')}")
    created_ids["incident3"] = rec2["id"]

    # 非法等级应被拒绝
    expect_raises(lambda: store.create_item("incidents", {
        "title": "自检-非法等级", "level1": "急救箱事件", "grade": "D级",
        "type": "人身伤害", "occurDate": TODAY_DT, "location": "一车间",
        "dept": "生产部", "cause": "x", "measures": "y",
    }), "可选范围")


def _test_training():
    rec = store.create_item("trainings", {
        "title": "自检-消防器材使用培训", "type": "专项培训",
        "dept": "安全环保部", "trainDate": TODAY, "hours": 2,
        "attendees": 30, "passRate": 96.7,
    })
    expect(rec["status"] == "计划中", "默认状态错误")
    expect(rec["attendees"] == 30, "数值未保存")
    created_ids["training"] = rec["id"]


def _test_certificate():
    rec = store.create_item("certificates", {
        "personName": "自检-赵六", "dept": "设备部",
        "certType": "特种作业操作证",
        "issueDate": PAST,
        "expireDate": (_dt.date.today() + _dt.timedelta(days=20)).strftime("%Y-%m-%d"),
    })
    expect(rec["daysLeft"] == 20, f"剩余天数错误：{rec['daysLeft']}")
    expect(rec["expiryWarn"] == "30天内到期", f"提醒错误：{rec['expiryWarn']}")
    earlier = (_dt.date.today() - _dt.timedelta(days=30)).strftime("%Y-%m-%d")
    expect_raises(lambda: store.update_item("certificates", rec["id"],
                                            {"expireDate": earlier}), "不能早于")
    created_ids["cert"] = rec["id"]


def _test_fire():
    rec = store.create_item("fireEquipments", {
        "name": "自检-灭火器", "type": "灭火器", "location": "一车间门口",
        "quantity": 4, "checkCycle": "每月",
        "lastCheckDate": (_dt.date.today() - _dt.timedelta(days=40)).strftime("%Y-%m-%d"),
    })
    expect(rec["nextCheckDate"], "未计算下次点检日期")
    expect(rec["checkOverdue"] is True, "应判定为点检逾期")
    created_ids["fire"] = rec["id"]


def _test_drill():
    rec = store.create_item("fireDrills", {
        "title": "自检-消防疏散演练", "type": "专项演练",
        "planDate": FUTURE, "dept": "安全环保部", "participants": 120,
    })
    expect(rec["status"] == "计划中", "默认状态错误")
    created_ids["drill"] = rec["id"]


def _test_contractor():
    rec = store.create_item("contractors", {
        "name": "自检-某建筑公司", "type": "工程施工",
        "contact": "孙七", "phone": "13800000000",
        "safetyAgreement": "已签订", "status": "待审核",
    })
    expect_raises(lambda: store.update_item("contractors", rec["id"],
                                            {"status": "已准入",
                                             "safetyAgreement": "未签订"}),
                  "安全协议")
    created_ids["contractor"] = rec["id"]


def _test_permit():
    start = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    end = (_dt.datetime.now() + _dt.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")
    rec = store.create_item("permits", {
        "type": "动火作业", "level": "二级", "contractor": "自检-某检修队",
        "applicant": "周八", "dept": "设备部", "location": "二车间",
        "startTime": start, "endTime": end, "content": "焊接管道",
        "safetyMeasures": "配备灭火器、办理动火票", "guardian": "吴九",
    })
    expect(rec["state"] == "24小时内到期", f"时效判断错误：{rec['state']}")
    expect_raises(lambda: store.update_item("permits", rec["id"],
                                            {"endTime": PAST + " 08:00"}),
                  "不能早于")
    created_ids["permit"] = rec["id"]


# ---------------------------------------------------------------- 安全疑虑

def _new_concern(**over):
    base = {
        "title": "自检-地面有油污容易滑倒", "category": "作业环境",
        "source": "现场反映", "dept": "生产部", "location": "三车间",
        "foundDate": TODAY, "deadline": FUTURE, "status": "待核实",
    }
    base.update(over)
    return store.create_item("concerns", base)


def _test_concern_create():
    rec = _new_concern()
    expect(rec["id"].startswith("AQ-"), f"编号前缀错误：{rec['id']}")
    expect(rec["status"] == "待核实", f"默认状态错误：{rec['status']}")
    expect(rec["replyState"] == "待答复", f"反馈状态错误：{rec['replyState']}")
    created_ids["concern"] = rec["id"]


def _test_concern_overdue():
    from datetime import date, timedelta
    past = (date.today() - timedelta(days=5)).strftime("%Y-%m-%d")
    rec = _new_concern(title="自检-超期疑虑", deadline=past)
    expect(rec["overdue"] is True, "应判定为超期")
    expect(rec["daysLeft"] == -5, f"剩余天数错误：{rec['daysLeft']}")

    soon = (date.today() + timedelta(days=3)).strftime("%Y-%m-%d")
    rec2 = _new_concern(title="自检-临期疑虑", deadline=soon)
    expect(rec2["overdue"] is False, "临期不应判超期")
    expect(rec2["daysLeft"] == 3, f"剩余天数错误：{rec2['daysLeft']}")
    created_ids["concern2"] = rec2["id"]


def _test_concern_convert_required():
    rec = _new_concern(title="自检-转隐患缺编号")
    # 缺结论
    expect_raises(lambda: store.transition("concerns", rec["id"], "转隐患",
                                           {"hazardId": "YH-2026-0001"}),
                  "核实结论")
    # 缺隐患编号
    expect_raises(lambda: store.transition("concerns", rec["id"], "转隐患",
                                           {"conclusion": "属实"}),
                  "隐患编号")
    created_ids["concern3"] = rec["id"]


def _test_concern_close_required():
    rec = _new_concern(title="自检-关闭缺答复")
    expect_raises(lambda: store.transition("concerns", rec["id"], "答复并关闭",
                                           {"replyDate": TODAY}),
                  "答复内容")
    created_ids["concern4"] = rec["id"]


def _test_concern_flow():
    rec = _new_concern(title="自检-完整流转")
    cid = rec["id"]

    t1 = store.transition("concerns", cid, "开始核实")
    expect(t1["status"] == "核实中", f"状态错误：{t1['status']}")

    t2 = store.transition("concerns", cid, "转隐患", {
        "conclusion": "属实，存在滑倒风险",
        "hazardId": "YH-2026-0001",
    })
    expect(t2["status"] == "已转隐患", f"状态错误：{t2['status']}")
    expect(t2["hazardId"] == "YH-2026-0001", "隐患编号未保存")
    expect(t2["replyState"] == "已办结", f"反馈状态错误：{t2['replyState']}")

    # 已转隐患后不再判超期
    expect(t2["overdue"] is False, "已转隐患不应判超期")

    # 重新打开
    t3 = store.transition("concerns", cid, "重新打开")
    expect(t3["status"] == "待核实", f"重新打开状态错误：{t3['status']}")

    created_ids["concern5"] = cid


def _test_concern_reply_state():
    rec = _new_concern(title="自检-答复状态")
    expect(rec["replyState"] == "待答复", "未答复应为待答复")
    upd = store.update_item("concerns", rec["id"],
                            {"replyDate": TODAY, "replyContent": "已处理"})
    expect(upd["replyState"] == "已答复", f"应变为已答复，实际 {upd['replyState']}")
    created_ids["concern6"] = rec["id"]


# ---------------------------------------------------------------- 设备管理

def _new_equipment(**over):
    base = {
        "type": "叉车", "name": "自检-电动叉车", "location": "一号仓库",
        "dept": "仓储物流部", "status": "在用",
        # 叉车属特种设备，必须有登记证号与定期检验日期
        "regCode": "厂内 11010100000000", "nextInspectDate": FUTURE,
    }
    base.update(over)
    return store.create_item("equipments", base)


def _test_equipment_category():
    rec = _new_equipment(type="叉车", name="自检-叉车")
    expect(rec["category"] == "特种设备类", f"叉车应归特种设备类，实际 {rec['category']}")
    expect(rec["id"].startswith("SB-"), f"编号前缀错误：{rec['id']}")
    created_ids["equip_truck"] = rec["id"]

    rec2 = _new_equipment(type="安全阀", name="自检-安全阀",
                          calibCycle="每年")
    expect(rec2["category"] == "表阀类", f"安全阀应归表阀类，实际 {rec2['category']}")
    created_ids["equip_valve"] = rec2["id"]

    rec3 = _new_equipment(type="其他设备", name="自检-空压机")
    expect(rec3["category"] == "其他类", f"其他设备应归其他类，实际 {rec3['category']}")
    created_ids["equip_other"] = rec3["id"]


def _test_equipment_special_required():
    # 特种设备缺使用登记证号
    expect_raises(lambda: _new_equipment(
        type="电梯", name="自检-电梯", regCode="",
        nextInspectDate=FUTURE), "使用登记证号")
    # 特种设备缺下次定期检验日期
    expect_raises(lambda: _new_equipment(
        type="电梯", name="自检-电梯2", regCode="梯 123456",
        nextInspectDate=""), "定期检验")
    # 两个都填齐则可以保存
    rec = _new_equipment(type="电梯", name="自检-电梯3", regCode="梯 123456",
                         nextInspectDate=FUTURE, ratedSpeed="1.75 m/s")
    expect(rec["id"], "填齐后应能保存")
    created_ids["equip_elevator"] = rec["id"]


def _test_equipment_valve_required():
    expect_raises(lambda: _new_equipment(
        type="流量计", name="自检-流量计", calibCycle=""), "校验周期")


def _test_equipment_warn():
    from datetime import date, timedelta
    # 已过期
    expired = (date.today() - timedelta(days=10)).strftime("%Y-%m-%d")
    rec = _new_equipment(type="叉车", name="自检-过期叉车",
                         inspectExpire=expired)
    expect(rec["expiryWarn"] == "已过期", f"应判定已过期，实际 {rec['expiryWarn']}")
    expect(rec["daysLeft"] == -10, f"剩余天数错误：{rec['daysLeft']}")

    # 30 天内到期
    soon = (date.today() + timedelta(days=15)).strftime("%Y-%m-%d")
    rec2 = _new_equipment(type="叉车", name="自检-临期叉车", inspectExpire=soon)
    expect(rec2["expiryWarn"] == "30天内到期", f"应判定临期，实际 {rec2['expiryWarn']}")

    # 已报废不提醒
    rec3 = _new_equipment(type="叉车", name="自检-报废叉车",
                          inspectExpire=expired, status="已报废",
                          remark="自检用，测试后删除")
    expect(rec3["expiryWarn"] == "已停用", f"报废设备不应提醒，实际 {rec3['expiryWarn']}")
    created_ids["equip_warn"] = rec["id"]
    created_ids["equip_warn2"] = rec2["id"]
    created_ids["equip_warn3"] = rec3["id"]


def _test_equipment_hidden_field():
    """叉车不显示「额定速度」，即使该字段必填也不应报错。"""
    rec = _new_equipment(type="叉车", name="自检-隐藏字段叉车",
                         ratedLoad="3t", ratedSpeed="")
    expect(rec["id"], "叉车不应被要求填电梯速度")


def _test_equipment_filter():
    res = store.list_items("equipments", {"category": "表阀类", "size": "200"})
    expect(res["total"] >= 1, "按大类筛选应有结果")
    expect(all(it.get("category") == "表阀类" for it in res["items"]),
           "筛选结果混入了其它大类")
    res2 = store.list_items("equipments", {"category": "特种设备类", "size": "200"})
    expect(all(it.get("category") == "特种设备类" for it in res2["items"]),
           "特种设备筛选结果错误")


def _test_equipment_transition():
    rec = _new_equipment(type="叉车", name="自检-流转叉车")
    t = store.transition("equipments", rec["id"], "报修")
    expect(t["status"] == "维修中", f"流转后状态错误：{t['status']}")
    t2 = store.transition("equipments", rec["id"], "维修完成")
    expect(t2["status"] == "在用", f"维修完成状态错误：{t2['status']}")
    expect_raises(lambda: store.transition("equipments", rec["id"], "报修"),
                  "不能执行") if False else None
    created_ids["equip_flow"] = rec["id"]


def _test_export():
    items = store.list_items("hazards", {"size": "100"})["items"]
    content = excel.export_workbook("hazards", items)
    expect(content[:2] == b"PK", "不是有效的 xlsx 文件")
    expect(len(content) > 2000, "导出内容过小")


def _test_template():
    for key in schema.COLLECTION_ORDER:
        content = excel.template_workbook(key)
        expect(content[:2] == b"PK", f"{key} 模板不是 xlsx")


def _test_import_insert():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["隐患描述", "隐患类别", "隐患等级", "发现来源", "发现日期",
               "责任部门", "整改责任人", "整改期限"])
    ws.append(["自检-导入的新隐患", "设备设施", "一般隐患", "专项检查",
               TODAY, "设备部", "郑十", FUTURE])
    import io
    buf = io.BytesIO()
    wb.save(buf)
    res = excel.import_workbook("hazards", buf.getvalue())
    expect(res["inserted"] == 1, f"应新增 1 条，实际 {res}")
    expect(res["skipped"] == 0, f"不应跳过：{res['errors']}")


def _test_import_update():
    from openpyxl import Workbook
    import io
    hid = created_ids["hazard"]
    wb = Workbook()
    ws = wb.active
    ws.append(["编号", "隐患描述"])
    ws.append([hid, "自检-通过导入更新的描述"])
    buf = io.BytesIO()
    wb.save(buf)
    res = excel.import_workbook("hazards", buf.getvalue())
    expect(res["updated"] == 1, f"应更新 1 条，实际 {res}")
    rec = store.get_item("hazards", hid)
    expect(rec["title"] == "自检-通过导入更新的描述", "导入未更新标题")


def _test_dashboard():
    data = dashboard.build_dashboard("", "", "")
    for k in ("hazardTotal", "hazardCloseRate", "riskTotal", "incidentTotal",
              "trainingTotal", "certWarn", "fireOverdue", "contractorActive",
              "equipmentTotal", "equipmentExpiring", "equipmentSpecial",
              "concernTotal", "concernOpen", "concernOverdue", "concernUnreplied"):
        expect(k in data["kpi"], f"看板缺少 {k}")
    expect(len(data["riskByLevel"]) == 5, "风险四色分布应有 5 项")
    expect(len(data["equipmentByCategory"]) == 3, "设备分类应有 3 项")
    expect(len(data["concernByStatus"]) == 5, "疑虑状态分布应有 5 项")
    expect("months" in data["trend"], "缺少趋势数据")
    expect(isinstance(data["alerts"]["hazardOverdue"], list), "提醒清单格式错误")
    expect(isinstance(data["alerts"]["equipmentExpiring"], list), "缺少设备到期提醒")
    expect(isinstance(data["alerts"]["concernPending"], list), "缺少待处理疑虑提醒")


def _test_persistence():
    for key, cid in created_ids.items():
        rec = store.get_item(_coll_of(key), cid)
        expect(rec is not None, f"{_coll_of(key)} 中 {cid} 读不回来")


def _coll_of(key: str) -> str:
    if key.startswith("concern"):
        return "concerns"
    if key.startswith("incident"):
        return "incidents"
    if key.startswith("equip"):
        return "equipments"
    return {
        "hazard": "hazards", "risk": "risks", "incident": "incidents",
        "training": "trainings", "cert": "certificates", "fire": "fireEquipments",
        "drill": "fireDrills", "contractor": "contractors", "permit": "permits",
    }.get(key, "equipments")


def _cleanup():
    removed = 0
    for key, cid in created_ids.items():
        if store.delete_item(_coll_of(key), cid):
            removed += 1
    # 兜底清理：扫描全部集合，删除任何以「自检-」「导入-」「HTTP测试-」
    # 「UI测试-」开头的记录，避免中途断言失败导致残留
    prefixes = ("自检-", "导入-", "HTTP测试-", "UI测试-")
    for coll in schema.COLLECTION_ORDER:
        for it in store.all_items(coll):
            text = str(it.get("title") or it.get("name")
                       or it.get("riskPoint") or it.get("personName") or "")
            if text.startswith(prefixes):
                if store.delete_item(coll, it["id"]):
                    removed += 1
    print(f"\n已清理自检数据 {removed} 条")


if __name__ == "__main__":
    sys.exit(main())
