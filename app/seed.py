# -*- coding: utf-8 -*-
"""生成演示数据，便于初次打开时看到完整效果。

用法：
    python app/seed.py          生成演示数据（已有数据时跳过，不会覆盖）
    python app/seed.py --force  先清空全部集合再生成
    python app/seed.py --clear  只清空数据，不生成
"""
from __future__ import annotations

import datetime as _dt
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import store  # noqa: E402

TODAY = _dt.date.today()
random.seed(20261101)


def d(days_offset=0) -> str:
    return (TODAY + _dt.timedelta(days=days_offset)).strftime("%Y-%m-%d")


def dt(days_offset=0, hour=9, minute=0) -> str:
    return (TODAY + _dt.timedelta(days=days_offset)).strftime("%Y-%m-%d") + \
        f" {hour:02d}:{minute:02d}"


HAZARD_SEEDS = [
    ("三车间东侧配电箱门锁损坏，箱门无法锁闭", "电气安全", "一般隐患", "日常巡检", -42, "生产部", "张建国", -18, "已关闭", "更换门锁并加装防误碰挡板"),
    ("一号仓库西侧消防通道堆放成品纸箱", "消防安全", "重大隐患", "专项检查", -35, "仓储物流部", "李海涛", -20, "整改中", "清理通道并划设禁放标线，每日巡查"),
    ("二车间行车吊钩防脱装置缺失", "设备设施", "重大隐患", "上级检查", -28, "设备部", "王振华", -6, "待整改", "更换防脱钩装置，全面排查同型号吊具"),
    ("焊接工位未配置防护面罩", "职业健康", "一般隐患", "班组自查", -25, "生产部", "赵明", -10, "已关闭", "按岗位配发防护面罩并培训使用"),
    ("危化品库房通风风机故障", "危化品", "重大隐患", "日常巡检", -22, "安全环保部", "陈志强", -3, "整改中", "更换风机并加装运行状态监测"),
    ("员工上下楼梯未扶扶手", "作业行为", "一般隐患", "日常巡检", -20, "生产部", "刘伟", -8, "已关闭", "班前会强调并增设提示标识"),
    ("污水处理站应急池盖板腐蚀", "环境管理", "一般隐患", "专项检查", -16, "安全环保部", "孙丽", 4, "待整改", "更换不锈钢盖板"),
    ("四车间地面油污未及时清理", "作业行为", "一般隐患", "节前检查", -14, "生产部", "周涛", -2, "待验收", "清理油污并增加防滑垫"),
    ("叉车作业区与人员通道未隔离", "设备设施", "重大隐患", "第三方检查", -12, "仓储物流部", "李海涛", 8, "待整改", "设置物理隔离栏并划定人行通道"),
    ("安全操作规程版本未更新至最新", "管理缺陷", "一般隐患", "上级检查", -10, "技术部", "吴强", 2, "整改中", "梳理全部规程，完成换版发布"),
    ("配电室未配备绝缘手套", "电气安全", "一般隐患", "日常巡检", -8, "设备部", "王振华", 6, "待整改", "按标准配置绝缘工器具并定期试验"),
    ("危废暂存间标识不清晰", "环境管理", "一般隐患", "专项检查", -6, "安全环保部", "孙丽", 10, "待整改", "重新制作危废标识牌"),
    ("三车间除尘管道积尘严重", "职业健康", "重大隐患", "日常巡检", -4, "生产部", "张建国", 12, "待整改", "清理管道积尘，缩短清灰周期"),
    ("消防水泵接合器被车辆遮挡", "消防安全", "一般隐患", "日常巡检", -2, "行政后勤部", "郑晓东", 15, "待整改", "划设禁停线并设置警示牌"),
    ("临时用电线路私拉乱接", "电气安全", "一般隐患", "班组自查", -1, "工程部", "何军", 9, "整改中", "拆除违规线路，规范接电流程"),
]

RISK_SEEDS = [
    ("三车间冲压工位", "三车间", "160T 冲压机", "滑块下落、模具飞出", "机械伤害", 5, 4, "加装光电保护装置、双手操作按钮、定期检验", "部门级", "生产部", "张建国", "每班", "受控"),
    ("一号仓库叉车作业", "一号仓库", "电动叉车", "车辆碰撞、货物倾覆", "车辆伤害", 4, 4, "限速行驶、人车分流、持证上岗", "部门级", "仓储物流部", "李海涛", "每日", "受控"),
    ("危化品库房储存", "危化品库", "甲醇、乙醇储罐", "易燃液体泄漏遇火源", "火灾", 3, 5, "防爆电气、可燃气体报警、通风联锁、禁火管理", "公司级", "安全环保部", "陈志强", "每日", "受控"),
    ("二车间行车吊装作业", "二车间", "10T 桥式起重机", "吊物坠落、钢丝绳断裂", "起重伤害", 3, 5, "定期检验、持证操作、吊装区域警戒", "公司级", "设备部", "王振华", "每周", "整改中"),
    ("污水站受限空间清理", "污水处理站", "调节池、应急池", "硫化氢中毒、缺氧窒息", "中毒和窒息", 3, 5, "作业许可、气体检测、监护人全程监护", "公司级", "安全环保部", "孙丽", "每月", "受控"),
    ("厂区高处检修作业", "厂区各车间", "登高车、脚手架", "人员坠落", "高处坠落", 4, 4, "双钩安全带、作业票、下方警戒", "部门级", "设备部", "王振华", "每周", "受控"),
    ("配电室高压操作", "配电室", "10kV 开关柜", "触电、电弧灼伤", "触电", 2, 5, "两票三制、绝缘工器具、双人操作", "公司级", "设备部", "王振华", "每月", "受控"),
    ("砂轮机打磨作业", "四车间", "台式砂轮机", "砂轮片碎裂飞出", "物体打击", 4, 3, "防护罩齐全、佩戴护目镜、定期更换砂轮", "班组级", "生产部", "周涛", "每周", "受控"),
    ("高温管道巡检", "锅炉房", "蒸汽管道", "高温表面接触烫伤", "灼烫", 4, 2, "保温层完好、设置警示标识、配备隔热手套", "班组级", "设备部", "王振华", "每日", "受控"),
    ("成品装卸作业", "发货区", "装卸平台", "货物倒塌、叉车碾压", "物体打击", 3, 3, "装卸规范、专人指挥、限高堆放", "部门级", "仓储物流部", "李海涛", "每日", "受控"),
    ("粉尘作业环境", "三车间", "除尘系统", "粉尘爆炸、尘肺病", "容器爆炸", 3, 5, "除尘设施运行监控、定期清灰、佩戴防尘口罩", "公司级", "生产部", "张建国", "每班", "失控"),
    ("夜间厂区巡逻", "全厂", "巡逻路线", "车辆伤害、治安事件", "车辆伤害", 2, 2, "反光背心、两人一组、巡逻打卡", "岗位级", "行政后勤部", "郑晓东", "每班", "受控"),
]

# (名称, 大类, 细分等级, 类型, 天数偏移, 地点, 部门, 涉及人员, 损失, 工日,
#  直接原因, 根本原因, 措施, 状态, 医疗费用, 受伤部位)
INCIDENT_SEEDS = [
    ("二车间行车吊物摆动撞击护栏", "未遂事件", "", "未遂事件", -30, "二车间",
     "设备部", "", 0, 0,
     "吊装指挥信号不明确", "特种作业培训不到位", "重新培训指挥人员并考核",
     "已结案", 0, ""),
    ("成品仓库叉车剐蹭货架", "一般事件", "", "交通事故", -25, "一号仓库",
     "仓储物流部", "叉车司机", 3200, 0,
     "叉车司机疲劳作业", "排班制度未落实", "调整排班，增加午间休息",
     "已结案", 0, ""),
    ("三车间员工手部划伤", "急救箱事件", "C级", "人身伤害", -18, "三车间",
     "生产部", "刘伟", 0, 0,
     "清理边角料未戴手套", "班前教育流于形式", "补充劳保用品，加强班前检查",
     "已结案", 0, "手"),
    ("配电室电缆沟积水", "未遂事件", "", "设备事故", -12, "配电室",
     "设备部", "", 0, 0,
     "雨季前未排查排水系统", "季节性检查清单缺失", "增加雨季专项检查项",
     "整改中", 0, ""),
    ("污水处理站人员轻微中毒", "医疗处置事件", "B级", "人身伤害", -6, "污水处理站",
     "安全环保部", "孙丽", 15000, 12,
     "未检测气体即下池", "作业许可管理执行不到位", "全面推行作业票，加强监护人培训",
     "整改中", 15000, "头部"),
    ("危化品库房发现渗漏", "未遂事件", "", "环境污染", -2, "危化品库",
     "安全环保部", "", 2000, 0,
     "储罐法兰垫片老化", "设备预防性维护缺失", "建立密封件更换周期台账",
     "调查中", 0, ""),
    ("打磨铁屑飞溅入眼", "急救箱事件", "B级", "人身伤害", -15, "一车间打磨区",
     "生产部", "示例员工甲", 0, 0,
     "打磨未佩戴护目镜", "个体防护用品佩戴监督不足", "强制佩戴护目镜并抽查",
     "已结案", 118.09, "眼"),
    ("搬抬物料手指划伤", "急救箱事件", "C级", "人身伤害", -10, "二车间",
     "生产部", "张国金", 0, 0,
     "徒手搬抬带锐边物料", "劳保手套配备不足", "配发防割手套",
     "已结案", 0, "手"),
    ("锯床作业左手拇指被锯片划伤", "医疗处置事件", "A级", "人身伤害", -8, "锯床区",
     "生产部", "示例员工丙", 28211.96, 43,
     "启动锯床后违规伸手", "设备防护罩缺失、操作规程未落实",
     "加装锯片防护罩，重新培训操作规程", "已结案", 28211.96, "手"),
    ("下班车时跌倒肋骨骨折", "医疗处置事件", "A级", "人身伤害", -20, "厂区门口",
     "生产部", "示例员工乙", 8077.13, 32,
     "下车时未注意脚下", "通勤车辆停靠点地面不平", "修整停靠点地面并加装扶手",
     "已结案", 8077.13, "肋"),
    ("叉车后轮刮坏轮胎", "一般事件", "", "设备事故", -5, "一号仓库",
     "仓储物流部", "", 1200, 0,
     "叉车转弯半径不足", "作业区域通道过窄", "拓宽通道并设置转弯提示",
     "已结案", 0, ""),
    ("焊接火花引燃隔音棉", "一般事件", "", "火灾爆炸", -35, "A3 班组",
     "生产部", "", 5000, 0,
     "动火作业未清理下方可燃物", "动火票审批与监护不到位",
     "严格执行动火作业许可，作业前清理可燃物", "已结案", 0, ""),
]

TRAINING_SEEDS = [
    ("新员工三级安全教育（第 4 批）", "三级教育", "新入职员工 32 人", "人力资源部", -60, 24, "安全环保部 陈志强", "培训室", "集中授课", 32, 100, "已完成"),
    ("特种作业人员复训", "复训", "特种作业人员", "安全环保部", -45, 16, "外部机构讲师", "培训室", "集中授课", 26, 96.2, "已完成"),
    ("消防器材实操培训", "专项培训", "车间班组长", "安全环保部", -30, 4, "消防维保单位", "厂区空地", "现场实操", 45, 100, "已完成"),
    ("危化品安全管理培训", "专项培训", "危化品岗位人员", "安全环保部", -20, 8, "陈志强", "培训室", "集中授课", 18, 94.4, "已完成"),
    ("有限空间作业安全培训", "专项培训", "检维修人员", "设备部", -12, 6, "王振华", "培训室", "集中授课", 22, 90.9, "已完成"),
    ("安全生产月主题宣贯", "日常培训", "全体员工", "安全环保部", -6, 2, "安全环保部", "食堂", "会议宣贯", 186, None, "已完成"),
    ("冬季防火专项培训", "专项培训", "全体员工", "安全环保部", 5, 2, "陈志强", "培训室", "集中授课", 180, None, "计划中"),
    ("应急疏散演练培训", "应急演练培训", "各车间应急小组", "安全环保部", 12, 4, "孙丽", "厂区", "现场实操", 40, None, "计划中"),
    ("承包商入场安全教育", "外来人员教育", "在厂承包商人员", "安全环保部", -8, 3, "陈志强", "培训室", "集中授课", 28, 100, "已完成"),
    ("班组长安全管理能力提升", "专项培训", "班组长", "人力资源部", 20, 12, "外部机构讲师", "培训室", "集中授课", 24, None, "计划中"),
]

CERT_SEEDS = [
    ("张建国", "P2021001", "生产部", "特种作业操作证", "T110101198501010011", "应急管理局", -900, 120, "有效"),
    ("李海涛", "P2019032", "仓储物流部", "特种设备作业证", "N110101198703020022", "市场监管局", -700, 45, "有效"),
    ("王振华", "P2018015", "设备部", "特种作业操作证", "T110101198205030033", "应急管理局", -1100, 18, "有效"),
    ("陈志强", "P2017008", "安全环保部", "安全生产管理人员资格证", "A110101198001040044", "应急管理局", -600, 210, "有效"),
    ("孙丽", "P2020045", "安全环保部", "职业健康培训证", "Z110101199002050055", "卫健委", -400, -25, "有效"),
    ("周涛", "P2021067", "生产部", "特种作业操作证", "T110101199205060066", "应急管理局", -500, 9, "有效"),
    ("郑晓东", "P2022011", "行政后勤部", "消防设施操作员证", "X110101198803070077", "消防救援机构", -300, 300, "有效"),
    ("吴强", "P2019022", "技术部", "安全生产管理人员资格证", "A110101198604080088", "应急管理局", -800, 60, "有效"),
    ("何军", "P2023055", "工程部", "特种作业操作证", "T110101199009090099", "应急管理局", -200, 520, "有效"),
    ("赵明", "P2020013", "生产部", "特种设备作业证", "N110101198410100100", "市场监管局", -950, -60, "有效"),
]

FIRE_SEEDS = [
    ("手提式干粉灭火器 4kg", "灭火器", "一车间东门", "MFZ/ABC4", 6, "每月", -38, "正常", "张建国", "正常"),
    ("手提式干粉灭火器 4kg", "灭火器", "二车间北侧", "MFZ/ABC4", 8, "每月", -12, "正常", "王振华", "正常"),
    ("推车式干粉灭火器 35kg", "灭火器", "危化品库房门口", "MFTZ/ABC35", 2, "每月", -5, "正常", "陈志强", "正常"),
    ("室内消火栓", "消火栓", "三车间中部", "SN65", 4, "每季", -70, "正常", "张建国", "正常"),
    ("室内消火栓", "消火栓", "一号仓库", "SN65", 6, "每季", -95, "异常", "李海涛", "待维修"),
    ("自动喷水灭火系统", "自动喷淋", "成品仓库", "湿式系统", 1, "每月", -20, "正常", "李海涛", "正常"),
    ("火灾自动报警系统", "火灾报警", "全厂", "JB-QB-GST200", 1, "每月", -8, "正常", "郑晓东", "正常"),
    ("应急照明灯", "应急照明", "各车间疏散通道", "LED 双头", 48, "每半年", -150, "正常", "郑晓东", "正常"),
    ("疏散指示标志", "疏散指示", "全厂疏散通道", "蓄光型", 62, "每半年", -160, "正常", "郑晓东", "正常"),
    ("机械排烟风机", "防排烟", "一号仓库", "HTF-I-8", 2, "每季", -40, "正常", "李海涛", "正常"),
    ("甲级防火门", "防火门", "楼梯间", "FM甲1021", 12, "每半年", -55, "正常", "郑晓东", "正常"),
    ("消防水泵", "消防泵", "消防泵房", "XBD5.0/40", 2, "每月", -3, "正常", "郑晓东", "正常"),
]

DRILL_SEEDS = [
    ("2026 年度消防疏散综合演练", "综合演练", "火灾事故专项应急预案", -90, -88, "安全环保部", "厂区", "陈志强", 320, 45, "已关闭",
     "达到预期效果，疏散用时 3 分 20 秒", "个别车间疏散路线不熟悉", "增设疏散路线标识并组织复训"),
    ("危化品泄漏应急处置演练", "专项演练", "危险化学品事故应急预案", -60, -59, "安全环保部", "危化品库", "陈志强", 45, 30, "已关闭",
     "响应及时，处置流程完整", "围堰沙袋储备不足", "补充应急物资储备"),
    ("有限空间中毒救援演练", "现场处置方案演练", "有限空间作业事故应急预案", -30, -30, "设备部", "污水处理站", "王振华", 22, 40, "已评估",
     "救援流程基本正确", "正压式空气呼吸器佩戴不熟练", "组织专项复训"),
    ("高处坠落救援演练", "专项演练", "高处坠落事故应急预案", 15, None, "设备部", "二车间", "王振华", 30, 35, "计划中", "", "", ""),
    ("食堂火灾应急演练", "现场处置方案演练", "火灾事故专项应急预案", 40, None, "行政后勤部", "食堂", "郑晓东", 25, 20, "计划中", "", "", ""),
]

CONTRACTOR_SEEDS = [
    ("华建工程有限公司", "工程施工", "刘经理", "13800138001", "91330100MA2XXXXX01", "建筑工程施工总承包二级",
     "已签订", "团体意外险 100 万/人", -120, 240, "已准入", 2, "良好"),
    ("恒信设备检修有限公司", "设备检修", "陈工", "13800138002", "91330100MA2XXXXX02", "机电安装工程三级",
     "已签订", "团体意外险 80 万/人", -200, 25, "已准入", 0, "优秀"),
    ("顺达物流有限公司", "运输物流", "王师傅", "13800138003", "91330100MA2XXXXX03", "道路运输经营许可证",
     "已签订", "承运人责任险 50 万", -300, 400, "已准入", 1, "合格"),
    ("绿源保洁服务有限公司", "保洁绿化", "赵主管", "13800138004", "91330100MA2XXXXX04", "无特殊资质要求",
     "已签订", "雇主责任险 30 万/人", -90, 500, "已准入", 0, "良好"),
    ("众诚劳务分包有限公司", "劳务分包", "孙经理", "13800138005", "91330100MA2XXXXX05", "劳务分包资质",
     "已签订", "团体意外险 60 万/人", -150, 15, "已准入", 3, "合格"),
    ("金石机电安装有限公司", "设备安装", "周工", "13800138006", "91330100MA2XXXXX06", "机电安装工程二级",
     "未签订", "暂无", -10, 180, "待审核", 0, ""),
    ("宏远建筑劳务有限公司", "劳务分包", "吴经理", "13800138007", "91330100MA2XXXXX07", "劳务分包资质",
     "已签订", "团体意外险 50 万/人", -400, -20, "已暂停", 5, "不合格"),
]

CONCERN_SEEDS = [
    dict(title="三车间东侧地面油污多，走路容易滑倒", category="作业环境",
         source="现场反映", reporter="刘伟", reporterType="本厂员工", dept="生产部",
         location="三车间东侧", foundDate=d(-25), severity="中", status="已关闭",
         deadline=d(-18), verifyDate=d(-23), verifier="陈志强",
         conclusion="属实，地面有长期渗油，存在滑倒风险",
         replyDate=d(-17), replyContent="已安排清理并加铺防滑垫，感谢反馈",
         handle="清理油污、铺设防滑垫、排查渗漏点"),
    dict(title="二号仓库叉车开得太快，人走路不安全", category="作业行为",
         source="班前会", reporter="张三", reporterType="班组长", dept="仓储物流部",
         location="二号仓库", foundDate=d(-20), severity="高", status="已转隐患",
         deadline=d(-13), verifyDate=d(-18), verifier="李海涛",
         conclusion="属实，叉车限速规定执行不到位，人车混行",
         replyDate=d(-16), replyContent="已按隐患流程处理",
         handle="设置隔离栏、划定人行通道、限速标识", hazardId="YH-2026-0009"),
    dict(title="配电室的门好像经常开着，怕有人误入", category="电气安全",
         source="意见箱", reporter="", reporterType="匿名", dept="设备部",
         location="配电室", foundDate=d(-15), severity="中", status="待答复",
         deadline=d(3), verifyDate=d(-12), verifier="王振华",
         conclusion="属实，配电室门锁失效，外来人员可随意进入",
         handle="更换门锁、加装警示标识、加强巡查"),
    dict(title="夜班车间照明太暗，看不清设备状态", category="作业环境",
         source="微信/电话", reporter="周涛", reporterType="本厂员工", dept="生产部",
         location="四车间", foundDate=d(-10), severity="中", status="核实中",
         deadline=d(-2), verifyDate=d(-8), verifier="张建国",
         conclusion="部分属实，夜班照明照度不足，已委托检测"),
    dict(title="除尘设备声音很大，担心会影响听力", category="职业健康",
         source="现场反映", reporter="赵明", reporterType="本厂员工", dept="生产部",
         location="三车间除尘区", foundDate=d(-8), severity="高", status="待核实",
         deadline=d(5)),
    dict(title="食堂后厨的燃气管道好像有点味道", category="消防安全",
         source="现场反映", reporter="郑晓东", reporterType="本厂员工", dept="行政后勤部",
         location="食堂后厨", foundDate=d(-5), severity="高", status="待核实",
         deadline=d(-1)),
    dict(title="高处检修平台护栏有点晃", category="设备设施",
         source="安全员巡查", reporter="陈志强", reporterType="本厂员工", dept="设备部",
         location="二车间检修平台", foundDate=d(-3), severity="高", status="待核实",
         deadline=d(4)),
    dict(title="更衣室插座太少，大家用插排串着用", category="电气安全",
         source="意见箱", reporter="", reporterType="匿名", dept="行政后勤部",
         location="更衣室", foundDate=d(-2), severity="中", status="待核实",
         deadline=d(7)),
]

EQUIPMENT_SEEDS = [
    # ---- 特种设备类
    dict(type="吊车", name="桥式起重机 10t", code="QD-2021-0031", model="LD10t-16.5m",
         location="二车间", dept="设备部", responsible="王振华", regCode="起 11010120210031",
         ratedLoad="10t", pressure="", nextInspectDate=d(-5), inspectExpire=d(-5),
         status="在用", remark=""),
    dict(type="吊车", name="门式起重机 5t", code="QD-2019-0012", model="MH5t-12m",
         location="成品发货区", dept="仓储物流部", responsible="李海涛", regCode="起 11010120190012",
         ratedLoad="5t", nextInspectDate=d(120), inspectExpire=d(120),
         status="在用", remark=""),
    dict(type="叉车", name="电动叉车 3t", code="CC-2022-0008", model="CPD30",
         location="一号仓库", dept="仓储物流部", responsible="李海涛", regCode="厂内 11010120220008",
         ratedLoad="3t", nextInspectDate=d(20), inspectExpire=d(20),
         status="在用", remark=""),
    dict(type="叉车", name="内燃叉车 2t", code="CC-2018-0003", model="CPCD20",
         location="二号仓库", dept="仓储物流部", responsible="李海涛", regCode="厂内 11010120180003",
         ratedLoad="2t", nextInspectDate=d(-40), inspectExpire=d(-40),
         status="在用", remark="检验已过期，待安排年检"),
    dict(type="电梯", name="载货电梯 2t", code="DT-2020-0001", model="THJ2000",
         location="综合楼", dept="行政后勤部", responsible="郑晓东", regCode="梯 11010120200001",
         ratedSpeed="1.0 m/s", nextInspectDate=d(60), inspectExpire=d(60),
         status="在用", remark=""),
    dict(type="电梯", name="客梯 1000kg", code="DT-2020-0002", model="TKJ1000",
         location="办公楼", dept="行政后勤部", responsible="郑晓东", regCode="梯 11010120200002",
         ratedSpeed="1.75 m/s", nextInspectDate=d(15), inspectExpire=d(15),
         status="在用", remark=""),
    dict(type="储气罐", name="压缩空气储罐 2m³", code="CG-2021-0002", model="C-2/0.8",
         location="空压站", dept="设备部", responsible="王振华", regCode="容 11010120210002",
         capacity="2 m³", pressure="0.8 MPa", nextInspectDate=d(180), inspectExpire=d(180),
         status="在用", remark=""),
    dict(type="储气罐", name="压缩空气储罐 1m³", code="CG-2017-0001", model="C-1/0.8",
         location="三车间", dept="设备部", responsible="王振华", regCode="容 11010120170001",
         capacity="1 m³", pressure="0.8 MPa", nextInspectDate=d(-15), inspectExpire=d(-15),
         status="维修中", remark="罐体防腐层脱落，已安排检修"),
    # ---- 表阀类
    dict(type="气包压力表", name="空压机气包压力表", code="YB-2023-0101", model="Y-100",
         location="空压站", dept="设备部", responsible="王振华", pressure="0.8 MPa",
         range="0–1.6 MPa", accuracy="1.6 级", calibCycle="每半年",
         calibDate=d(-190), calibResult="合格", inspectExpire=d(-5), status="在用", remark=""),
    dict(type="气包压力表", name="三车间气包压力表", code="YB-2023-0102", model="Y-100",
         location="三车间", dept="生产部", responsible="张建国", pressure="0.8 MPa",
         range="0–1.6 MPa", accuracy="1.6 级", calibCycle="每半年",
         calibDate=d(-60), calibResult="合格", inspectExpire=d(120), status="在用", remark=""),
    dict(type="气罐压力表", name="储气罐压力表 2m³", code="YB-2023-0201", model="Y-100",
         location="空压站", dept="设备部", responsible="王振华", pressure="0.8 MPa",
         range="0–1.6 MPa", accuracy="1.6 级", calibCycle="每半年",
         calibDate=d(-175), calibResult="合格", inspectExpire=d(10), status="在用", remark=""),
    dict(type="气罐压力表", name="储气罐压力表 1m³", code="YB-2023-0202", model="Y-100",
         location="三车间", dept="设备部", responsible="王振华", pressure="0.8 MPa",
         range="0–1.6 MPa", accuracy="1.6 级", calibCycle="每半年",
         calibDate=d(-200), calibResult="不合格", inspectExpire=d(-20), status="维修中",
         remark="指针不回零，已送检"),
    dict(type="安全阀", name="储气罐安全阀 2m³", code="AF-2022-0301", model="A28H-16C",
         location="空压站", dept="设备部", responsible="王振华", pressure="0.8 MPa",
         calibCycle="每年", calibDate=d(-340), calibResult="合格",
         inspectExpire=d(25), status="在用", remark=""),
    dict(type="安全阀", name="锅炉安全阀", code="AF-2021-0302", model="A48Y-16C",
         location="锅炉房", dept="设备部", responsible="王振华", pressure="1.0 MPa",
         calibCycle="每年", calibDate=d(-380), calibResult="合格",
         inspectExpire=d(-15), status="在用", remark="已超期未校验，需立即安排"),
    dict(type="流量计", name="蒸汽流量计", code="LL-2022-0401", model="LUGB-50",
         location="锅炉房", dept="设备部", responsible="王振华",
         range="0–500 kg/h", calibCycle="每两年", calibDate=d(-500), calibResult="合格",
         inspectExpire=d(230), status="在用", remark=""),
    dict(type="流量计", name="压缩空气流量计", code="LL-2022-0402", model="LUGB-80",
         location="空压站", dept="设备部", responsible="王振华",
         range="0–1000 m³/h", calibCycle="每两年", calibDate=d(-700), calibResult="合格",
         inspectExpire=d(40), status="在用", remark=""),
    # ---- 其他类
    dict(type="其他设备", name="空压机 1#", code="KYJ-2020-001", model="GA55",
         location="空压站", dept="设备部", responsible="王振华", manufacturer="阿特拉斯",
         installDate=d(-1500), inspectExpire="", status="在用", remark=""),
    dict(type="其他设备", name="空压机 2#", code="KYJ-2020-002", model="GA55",
         location="空压站", dept="设备部", responsible="王振华", manufacturer="阿特拉斯",
         installDate=d(-1500), inspectExpire="", status="备用", remark=""),
    dict(type="其他设备", name="锅炉 2t/h", code="GL-2019-001", model="WNS2-1.0",
         location="锅炉房", dept="设备部", responsible="王振华", manufacturer="无锡锅炉厂",
         installDate=d(-2000), inspectExpire=d(90), status="在用", remark=""),
    dict(type="其他设备", name="除尘系统", code="CCXT-2021-001", model="MC-96",
         location="三车间", dept="生产部", responsible="张建国", manufacturer="环保设备厂",
         installDate=d(-900), inspectExpire="", status="维修中", remark="滤袋破损，正在更换"),
    dict(type="其他设备", name="污水处理设备", code="WSCL-2018-001", model="MBR-50",
         location="污水处理站", dept="安全环保部", responsible="孙丽", manufacturer="环保科技",
         installDate=d(-2400), inspectExpire="", status="在用", remark=""),
]

PERMIT_SEEDS = [
    ("动火作业", "二级", "恒信设备检修有限公司", "陈工", "设备部", "二车间焊接区", -1, -1,
     8, 0, 17, 0,
     "管道补焊作业", "配备灭火器 2 具、动火前清理可燃物、监护人全程监护", "王振华", "陈志强", "已关闭"),
    ("受限空间作业", "一级", "华建工程有限公司", "刘经理", "安全环保部", "污水处理站调节池", 0, 0,
     9, 0, 16, 0,
     "调节池清淤", "气体检测、强制通风、正压式呼吸器、双人监护", "孙丽", "陈志强", "作业中"),
    ("高处作业", "二级", "华建工程有限公司", "刘经理", "工程部", "三车间屋面", 0, 0,
     8, 0, 12, 0,
     "屋面防水维修", "双钩安全带、安全绳、下方警戒", "何军", "陈志强", "作业中"),
    ("吊装作业", "一级", "华建工程有限公司", "刘经理", "设备部", "二车间北侧", 1, 1,
     9, 0, 11, 0,
     "行车大梁更换", "吊装方案审批、警戒隔离、专人指挥", "王振华", "陈志强", "已批准"),
    ("临时用电", "三级", "恒信设备检修有限公司", "陈工", "设备部", "一车间检修区", 2, 2,
     8, 0, 17, 0,
     "检修临时照明", "漏电保护、线缆架空、每日检查", "王振华", "", "待审批"),
    ("动土作业", "二级", "金石机电安装有限公司", "周工", "工程部", "厂区北侧管廊", 3, 3,
     8, 0, 17, 0,
     "管沟开挖", "地下管线探测、警示标识、放坡支护", "何军", "", "待审批"),
    ("检修作业", "三级", "恒信设备检修有限公司", "陈工", "设备部", "三车间冲压线", -5, -5,
     8, 0, 17, 0,
     "冲压机年度保养", "断电挂牌上锁、能量隔离、专人监护", "王振华", "陈志强", "已关闭"),
]


def clear_all():
    for key in store.schema.COLLECTION_ORDER:
        data = store.load_raw(key)
        data["items"] = []
        data["seq"] = 0
        store.save_raw(key, data)
    print("已清空全部集合。")


def seed_hazards():
    n = 0
    for (title, cat, level, source, found_off, dept, resp, dl_off, status, measure) in HAZARD_SEEDS:
        rec = {
            "title": title, "category": cat, "level": level, "source": source,
            "foundDate": d(found_off), "foundBy": resp, "dept": dept,
            "location": {"生产部": "生产车间", "仓储物流部": "仓库区",
                         "设备部": "设备间", "安全环保部": "厂区",
                         "行政后勤部": "生活区", "工程部": "施工区",
                         "技术部": "技术中心"}.get(dept, "厂区"),
            "description": title + "。",
            "measure": measure, "responsible": resp, "deadline": d(dl_off),
            "status": status,
        }
        if status in ("待验收", "已关闭"):
            rec["rectifyDate"] = d(dl_off - 2)
            rec["rectifyNote"] = "已按措施完成整改。"
            rec["cost"] = random.choice([200, 350, 800, 1200, 2600, 5000])
        if status == "已关闭":
            rec["checkDate"] = d(dl_off - 1)
            rec["checkBy"] = "陈志强"
            rec["checkResult"] = "通过"
        store.create_item("hazards", rec)
        n += 1
    return n


def seed_risks():
    n = 0
    for (point, loc, act, factor, acc, l, s, measures, ctl, dept, resp, freq, status) in RISK_SEEDS:
        store.create_item("risks", {
            "riskPoint": point, "location": loc, "activity": act,
            "hazardFactor": factor, "accidentType": acc,
            "likelihood": l, "severity": s,
            "controlMeasures": measures, "controlLevel": ctl,
            "dept": dept, "responsible": resp, "checkFreq": freq,
            "lastCheckDate": d(-random.randint(1, 20)), "status": status,
        })
        n += 1
    return n


def seed_concerns():
    n = 0
    for row in CONCERN_SEEDS:
        payload = {k: v for k, v in row.items() if v not in (None, "")}
        store.create_item("concerns", payload)
        n += 1
    return n


def seed_incidents():
    n = 0
    for (title, level1, grade, typ, off, loc, dept, persons, loss, lossdays,
         cause, root, measures, status, medical, injury) in INCIDENT_SEEDS:
        rec = {
            "title": title, "level1": level1, "grade": grade, "type": typ,
            "occurDate": dt(off, 10, 30), "location": loc, "dept": dept,
            "persons": persons, "loss": loss, "lossDays": lossdays,
            "cause": cause, "rootCause": root, "measures": measures,
            "status": status, "reportDate": d(off + 1), "reporter": "陈志强",
        }
        if medical:
            rec["medicalCost"] = medical
        if injury:
            rec["injuryPart"] = injury
        if status == "已结案":
            rec["closeDate"] = d(off + 7)
        store.create_item("incidents", rec)
        n += 1
    return n


def seed_trainings():
    n = 0
    for (title, typ, target, dept, off, hours, trainer, place, method,
         attendees, pass_rate, status) in TRAINING_SEEDS:
        store.create_item("trainings", {
            "title": title, "type": typ, "target": target, "dept": dept,
            "trainDate": d(off), "hours": hours, "trainer": trainer,
            "place": place, "method": method, "attendees": attendees,
            "passRate": pass_rate, "status": status,
        })
        n += 1
    return n


def seed_certificates():
    n = 0
    for (name, emp, dept, ctype, cno, issuer, issue_off, expire_off, status) in CERT_SEEDS:
        store.create_item("certificates", {
            "personName": name, "empNo": emp, "dept": dept,
            "certType": ctype, "certNo": cno, "issuer": issuer,
            "issueDate": d(issue_off), "expireDate": d(expire_off),
            "status": status,
        })
        n += 1
    return n


def seed_fire():
    n = 0
    for (name, typ, loc, model, qty, cycle, last_off, result, resp, status) in FIRE_SEEDS:
        store.create_item("fireEquipments", {
            "name": name, "type": typ, "location": loc, "model": model,
            "quantity": qty, "checkCycle": cycle, "lastCheckDate": d(last_off),
            "checkResult": result, "responsible": resp, "status": status,
        })
        n += 1
    return n


def seed_drills():
    n = 0
    for (title, typ, plan, plan_off, actual_off, dept, loc, commander,
         people, minutes, status, conclusion, problems, improvements) in DRILL_SEEDS:
        rec = {
            "title": title, "type": typ, "plan": plan,
            "planDate": d(plan_off), "dept": dept, "location": loc,
            "commander": commander, "participants": people,
            "duration": minutes, "status": status,
        }
        if actual_off is not None:
            rec["actualDate"] = d(actual_off)
        if conclusion:
            rec["conclusion"] = conclusion
        if problems:
            rec["problems"] = problems
        if improvements:
            rec["improvements"] = improvements
        store.create_item("fireDrills", rec)
        n += 1
    return n


def seed_contractors():
    n = 0
    for (name, typ, contact, phone, lic, qual, agreement, insurance,
         entry_off, expire_off, status, viol, ev) in CONTRACTOR_SEEDS:
        store.create_item("contractors", {
            "name": name, "type": typ, "contact": contact, "phone": phone,
            "license": lic, "qualification": qual,
            "safetyAgreement": agreement, "insurance": insurance,
            "entryDate": d(entry_off), "expireDate": d(expire_off),
            "status": status, "violationCount": viol, "lastEval": ev,
        })
        n += 1
    return n


def seed_equipments():
    n = 0
    for row in EQUIPMENT_SEEDS:
        payload = {k: v for k, v in row.items() if v not in (None, "")}
        store.create_item("equipments", payload)
        n += 1
    return n


def seed_permits():
    n = 0
    for (typ, level, contractor, applicant, dept, loc, s_off, e_off,
         sh, sm, eh, em, content, measures, guardian, approver, status) in PERMIT_SEEDS:
        store.create_item("permits", {
            "type": typ, "level": level, "contractor": contractor,
            "applicant": applicant, "dept": dept, "location": loc,
            "startTime": dt(s_off, sh, sm), "endTime": dt(e_off, eh, em),
            "content": content, "safetyMeasures": measures,
            "guardian": guardian, "approver": approver, "status": status,
        })
        n += 1
    return n


def main():
    force = "--force" in sys.argv
    only_clear = "--clear" in sys.argv
    store.ensure_dirs()

    if only_clear:
        clear_all()
        return 0

    existing = sum(len(store.load_raw(k)["items"])
                   for k in store.schema.COLLECTION_ORDER)
    if existing > 0 and not force:
        print(f"已有 {existing} 条数据，跳过生成。")
        print("如需重新生成，请运行：python app/seed.py --force")
        return 0

    if force:
        clear_all()

    print("正在生成演示数据…")
    counts = {
        "隐患": seed_hazards(),
        "风险点": seed_risks(),
        "安全疑虑": seed_concerns(),
        "事故/事件": seed_incidents(),
        "培训": seed_trainings(),
        "证照": seed_certificates(),
        "消防设施": seed_fire(),
        "应急演练": seed_drills(),
        "承包商": seed_contractors(),
        "设备": seed_equipments(),
        "作业票": seed_permits(),
    }
    total = 0
    for k, v in counts.items():
        print(f"  {k}：{v} 条")
        total += v
    print(f"完成，共生成 {total} 条演示数据。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
