# -*- coding: utf-8 -*-
"""导出 HTML 报表：把看板 + 全部台账生成为单个可直接打开的 HTML 文件。

用法：
    python app/export_html.py                 # 导出到 reports/安全管理数据报表_日期.html
    python app/export_html.py --out 报表.html  # 指定输出路径

特点：
    - 单文件，无外部依赖（CSS/JS/图表全部内联），双击即可在任何浏览器打开
    - 图表用 SVG 绘制（矢量，可打印、可缩放）
    - 包含：看板 KPI、全部图表、各台账明细表、提醒清单
    - 可离线查看、发邮件、存档
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dashboard  # noqa: E402
import schema  # noqa: E402
import store  # noqa: E402

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PALETTE = ["#2d7d92", "#1f4e5f", "#0f7b6c", "#d68910", "#c0392b",
           "#6c3483", "#1a5276", "#b9770e", "#7d6608", "#a93226"]

RISK_COLORS = {"重大风险": "#c0392b", "较大风险": "#e67e22",
               "一般风险": "#d4ac0d", "低风险": "#2e86c1", "未评级": "#95a5a6"}

STATUS_COLORS = {
    "已关闭": "#1e8449", "已结案": "#1e8449", "已完成": "#1e8449",
    "已准入": "#1e8449", "正常": "#1e8449", "有效": "#1e8449",
    "受控": "#1e8449", "已评估": "#1e8449", "已办结": "#1e8449",
    "待整改": "#d68910", "整改中": "#2d7d92", "待验收": "#6c3483",
    "调查中": "#d68910", "计划中": "#2d7d92", "待审核": "#d68910",
    "待审批": "#d68910", "已批准": "#2d7d92", "作业中": "#6c3483",
    "待维修": "#d68910", "维修中": "#d68910", "已实施": "#2d7d92",
    "待核实": "#d68910", "核实中": "#2d7d92", "待答复": "#6c3483",
    "已转隐患": "#7f8c8d", "已取消": "#7f8c8d", "已停用": "#7f8c8d",
    "已报废": "#7f8c8d", "已清退": "#7f8c8d", "已暂停": "#d68910",
    "已作废": "#7f8c8d", "已注销": "#7f8c8d", "失控": "#c0392b",
    "重大隐患": "#c0392b", "一般隐患": "#2d7d92",
}


def esc(v) -> str:
    return html.escape("" if v is None else str(v))


def fmt_cell(fd, value, rec) -> str:
    """把字段值渲染成 HTML 单元格内容。"""
    key = fd["key"]
    ftype = fd["type"]

    if ftype == "computed":
        if key == "overdue" or key == "checkOverdue":
            if value:
                return '<span class="b b-red">逾期</span>'
            return '<span class="b b-gray">—</span>'
        if key == "daysLeft":
            if value is None or value == "":
                return "—"
            try:
                n = int(value)
            except (TypeError, ValueError):
                return esc(value)
            cls = "b-red" if n < 0 else ("b-orange" if n <= 30 else "b-gray")
            return f'<span class="b {cls}">{n} 天</span>'
        if key == "riskLevel":
            color = RISK_COLORS.get(str(value), "#95a5a6")
            return (f'<span class="b" style="background:{color}1a;color:{color};'
                    f'border-color:{color}55">{esc(value)}</span>')
        if key == "expiryWarn" or key == "state":
            tone = ("b-red" if value in ("已过期", "已超期") else
                    "b-orange" if value in ("30天内到期", "24小时内到期") else
                    "b-green" if value in ("正常",) else "b-gray")
            return f'<span class="b {tone}">{esc(value or "—")}</span>'
        if key == "replyState":
            tone = "b-green" if value in ("已答复", "已办结") else "b-orange"
            return f'<span class="b {tone}">{esc(value or "—")}</span>'
        if isinstance(value, bool):
            return "是" if value else "否"
        return esc(value if value not in (None, "") else "—")

    if ftype == "bool":
        return "是" if value else "否"

    if key in ("status", "level", "severity"):
        color = STATUS_COLORS.get(str(value))
        if color:
            return (f'<span class="b" style="background:{color}1a;color:{color};'
                    f'border-color:{color}55">{esc(value)}</span>')
        if key == "severity":
            sev = {"高": "#c0392b", "中": "#d68910", "低": "#1e8449"}
            c = sev.get(str(value), "#7f8c8d")
            return (f'<span class="b" style="background:{c}1a;color:{c};'
                    f'border-color:{c}55">{esc(value)}</span>')
        return esc(value)

    if ftype == "number" and value not in (None, ""):
        try:
            n = float(value)
            return f"{n:,.0f}" if n.is_integer() else f"{n:,.2f}"
        except (TypeError, ValueError):
            return esc(value)

    if value is None or value == "":
        return "—"
    return esc(value)


# ---------------------------------------------------------------- 图表（SVG）

def svg_line(labels, series, width=560, height=220) -> str:
    if not labels:
        return _empty_chart(width, height)
    pad_l, pad_r, pad_t, pad_b = 46, 16, 26, 32
    pw, ph = width - pad_l - pad_r, height - pad_t - pad_b
    max_v = max([v for s in series for v in s["data"]] or [1])
    top = _nice_max(max_v)

    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    # 网格
    for i in range(5):
        y = pad_t + ph * i / 4
        val = round(top - top * i / 4)
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l+pw}" y2="{y:.1f}" stroke="#e8eef3"/>')
        parts.append(f'<text x="{pad_l-8}" y="{y+4:.1f}" text-anchor="end" '
                     f'font-size="11" fill="#8a99a8">{val}</text>')
    # x 标签
    step = max(1, len(labels) // 12)
    for i, lb in enumerate(labels):
        if i % step and i != len(labels) - 1:
            continue
        x = pad_l + (pw * i / max(1, len(labels) - 1))
        parts.append(f'<text x="{x:.1f}" y="{pad_t+ph+18}" text-anchor="middle" '
                     f'font-size="10" fill="#8a99a8">{esc(str(lb)[5:])}</text>')
    # 折线
    for si, s in enumerate(series):
        color = s.get("color", PALETTE[si % len(PALETTE)])
        pts = []
        for i, v in enumerate(s["data"]):
            x = pad_l + (pw * i / max(1, len(s["data"]) - 1))
            y = pad_t + ph - (v / top * ph if top else 0)
            pts.append(f"{x:.1f},{y:.1f}")
        parts.append(f'<polyline points="{" ".join(pts)}" fill="none" '
                     f'stroke="{color}" stroke-width="2" stroke-linejoin="round"/>')
        if len(s["data"]) <= 30:
            for i, v in enumerate(s["data"]):
                x = pad_l + (pw * i / max(1, len(s["data"]) - 1))
                y = pad_t + ph - (v / top * ph if top else 0)
                parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{color}"/>')
    # 图例
    lx = pad_l
    for si, s in enumerate(series):
        color = s.get("color", PALETTE[si % len(PALETTE)])
        parts.append(f'<rect x="{lx}" y="8" width="11" height="3" fill="{color}"/>')
        parts.append(f'<text x="{lx+15}" y="12" font-size="11" fill="#5a6b7b">{esc(s["name"])}</text>')
        lx += 22 + len(s["name"]) * 12
    parts.append("</svg>")
    return "".join(parts)


def svg_bar(items, width=560, height=220) -> str:
    if not items:
        return _empty_chart(width, height)
    pad_l, pad_r, pad_t, pad_b = 46, 16, 20, 46
    pw, ph = width - pad_l - pad_r, height - pad_t - pad_b
    top = _nice_max(max(i["value"] for i in items))
    slot = pw / len(items)
    bw = min(46, slot * 0.6)

    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    for i in range(5):
        y = pad_t + ph * i / 4
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l+pw}" y2="{y:.1f}" stroke="#e8eef3"/>')
        parts.append(f'<text x="{pad_l-8}" y="{y+4:.1f}" text-anchor="end" '
                     f'font-size="11" fill="#8a99a8">{round(top - top*i/4)}</text>')
    for i, it in enumerate(items):
        v = it["value"]
        bh = (v / top * ph) if top else 0
        x = pad_l + slot * i + (slot - bw) / 2
        y = pad_t + ph - bh
        color = it.get("color", PALETTE[i % len(PALETTE)])
        if bh > 0:
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" '
                         f'height="{bh:.1f}" fill="{color}" rx="2"/>')
            parts.append(f'<text x="{x+bw/2:.1f}" y="{y-6:.1f}" text-anchor="middle" '
                         f'font-size="11" fill="#5a6b7b">{v}</text>')
        parts.append(f'<text x="{x+bw/2:.1f}" y="{pad_t+ph+16}" text-anchor="middle" '
                     f'font-size="10.5" fill="#5a6b7b">{esc(it["name"])}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_hbar(items, width=560, height=220) -> str:
    items = [i for i in items if i["value"] > 0][:10]
    if not items:
        return _empty_chart(width, height)
    pad_l, pad_r, pad_t = 96, 46, 12
    pw = width - pad_l - pad_r
    row_h = min(26, (height - pad_t - 12) / len(items))
    bar_h = max(9, row_h - 9)
    max_v = max(i["value"] for i in items) or 1

    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    for i, it in enumerate(items):
        y = pad_t + i * row_h
        bw = max(2, it["value"] / max_v * pw)
        cy = y + (row_h - bar_h) / 2
        parts.append(f'<rect x="{pad_l}" y="{cy:.1f}" width="{pw}" height="{bar_h:.1f}" fill="#f2f6f8"/>')
        parts.append(f'<rect x="{pad_l}" y="{cy:.1f}" width="{bw:.1f}" height="{bar_h:.1f}" '
                     f'fill="{it.get("color", PALETTE[i % len(PALETTE)])}" rx="2"/>')
        name = str(it["name"])
        if len(name) > 7:
            name = name[:7] + "…"
        parts.append(f'<text x="{pad_l-8}" y="{cy+bar_h/2+4:.1f}" text-anchor="end" '
                     f'font-size="11" fill="#5a6b7b">{esc(name)}</text>')
        parts.append(f'<text x="{pad_l+bw+7:.1f}" y="{cy+bar_h/2+4:.1f}" '
                     f'font-size="11" fill="#1a2733">{it["value"]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_pie(items, width=560, height=220) -> str:
    items = [i for i in items if i["value"] > 0]
    if not items:
        return _empty_chart(width, height)
    import math
    total = sum(i["value"] for i in items)
    cx, cy = 118, height / 2
    r = min(cx - 16, height / 2 - 16)
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    ang = -math.pi / 2
    for i, it in enumerate(items):
        frac = it["value"] / total
        end = ang + frac * 2 * math.pi
        x1, y1 = cx + r * math.cos(ang), cy + r * math.sin(ang)
        x2, y2 = cx + r * math.cos(end), cy + r * math.sin(end)
        large = 1 if frac > 0.5 else 0
        color = it.get("color", PALETTE[i % len(PALETTE)])
        parts.append(
            f'<path d="M{cx},{cy} L{x1:.1f},{y1:.1f} '
            f'A{r},{r} 0 {large} 1 {x2:.1f},{y2:.1f} Z" '
            f'fill="{color}" stroke="#fff" stroke-width="1.5"/>')
        ang = end
    # 图例
    ly = max(16, cy - len(items) * 9)
    lx = cx + r + 24
    for i, it in enumerate(items):
        if ly > height - 8:
            break
        color = it.get("color", PALETTE[i % len(PALETTE)])
        pct = round(it["value"] / total * 100)
        parts.append(f'<rect x="{lx}" y="{ly-9:.1f}" width="9" height="9" fill="{color}" rx="2"/>')
        parts.append(f'<text x="{lx+14}" y="{ly:.1f}" font-size="11" fill="#5a6b7b">'
                     f'{esc(it["name"])} {it["value"]} ({pct}%)</text>')
        ly += 18
    parts.append("</svg>")
    return "".join(parts)


def _empty_chart(width, height) -> str:
    return (f'<svg viewBox="0 0 {width} {height}" class="chart">'
            f'<text x="{width/2}" y="{height/2}" text-anchor="middle" '
            f'font-size="13" fill="#8a99a8">暂无数据</text></svg>')


def _nice_max(v):
    if v <= 0:
        return 5
    import math
    mag = 10 ** math.floor(math.log10(v))
    n = v / mag
    step = 1 if n <= 1 else 2 if n <= 2 else 5 if n <= 5 else 10
    return int(step * mag)


# ---------------------------------------------------------------- 页面组装

CSS = """
*{box-sizing:border-box}
body{margin:0;background:#f4f6f8;color:#1a2733;
  font:14px/1.6 "Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:24px 20px 60px}
header{background:linear-gradient(135deg,#1f4e5f,#2d7d92);color:#fff;
  padding:22px 28px;border-radius:10px;margin-bottom:20px;
  box-shadow:0 4px 18px rgba(16,34,48,.15)}
header h1{margin:0;font-size:21px;letter-spacing:.5px}
header .meta{margin-top:6px;font-size:12.5px;color:#b8d4de}
h2{font-size:16px;margin:26px 0 12px;padding-left:10px;
  border-left:4px solid #2d7d92;line-height:1.3}
.card{background:#fff;border:1px solid #e2e8ee;border-radius:9px;
  box-shadow:0 1px 3px rgba(16,34,48,.06);margin-bottom:16px;overflow:hidden}
.card-head{padding:11px 16px;border-bottom:1px solid #e2e8ee;
  display:flex;align-items:center;gap:10px;background:#fbfcfd}
.card-head h3{margin:0;font-size:14px;font-weight:600}
.card-head .n{margin-left:auto;font-size:12px;color:#8a99a8}
.card-body{padding:14px 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:12px}
.kpi{background:#fff;border:1px solid #e2e8ee;border-left:3px solid #2d7d92;
  border-radius:8px;padding:12px 14px}
.kpi.warn{border-left-color:#d68910}
.kpi.danger{border-left-color:#c0392b}
.kpi.ok{border-left-color:#1e8449}
.kpi .l{font-size:12.5px;color:#5a6b7b}
.kpi .v{font-size:25px;font-weight:600;line-height:1.2;margin-top:3px}
.kpi .v small{font-size:13px;font-weight:400;color:#8a99a8;margin-left:3px}
.kpi .f{font-size:11.5px;color:#8a99a8;margin-top:2px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}
.chart{width:100%;height:auto;display:block}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:6px 9px;border-bottom:1px solid #e8eef3;text-align:left;
  vertical-align:middle;white-space:nowrap;line-height:1.45}
th{background:#f6f9fb;color:#5a6b7b;font-weight:600;position:sticky;top:0;z-index:1}
tbody tr:hover{background:#f7fbfc}
td.num{text-align:right}
td.clip{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scroll-hint{font-size:11.5px;color:#8a99a8;padding:6px 16px 8px;
  border-top:1px dashed #e8eef3;background:#fbfcfd}
.b{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11.5px;
  border:1px solid transparent;white-space:nowrap}
.b-red{background:#fdecea;color:#c0392b;border-color:#f5b7b1}
.b-orange{background:#fdf1e0;color:#b9770e;border-color:#f8c471}
.b-green{background:#e6f5ec;color:#1e8449;border-color:#a9dfbf}
.b-gray{background:#eef2f5;color:#5a6b7b;border-color:#dfe6ec}
.alerts{list-style:none;margin:0;padding:0}
.alerts li{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed #e8eef3;font-size:13px}
.alerts li:last-child{border:0}
.alerts .t{flex:1}
.alerts .m{color:#8a99a8;font-size:12px;white-space:nowrap}
.scroll{max-height:520px;overflow:auto}
.empty{padding:34px;text-align:center;color:#8a99a8}
footer{text-align:center;color:#8a99a8;font-size:12px;margin-top:34px;
  padding-top:16px;border-top:1px solid #e2e8ee}
@media print{
  body{background:#fff}
  .wrap{max-width:none;padding:0}
  header{background:#1f4e5f !important;-webkit-print-color-adjust:exact;
    print-color-adjust:exact}
  .card{box-shadow:none;page-break-inside:avoid}
  .scroll{max-height:none;overflow:visible}
  th{position:static}
}
"""


def build_report(from_date: str = "", to_date: str = "") -> str:
    d = dashboard.build_dashboard(from_date, to_date, "")
    k = d["kpi"]
    now = _dt.datetime.now()

    parts = []
    parts.append('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    parts.append(f'<title>安全管理数据报表 {now.strftime("%Y-%m-%d")}</title>')
    parts.append(f"<style>{CSS}</style></head><body><div class='wrap'>")

    # ---- 头部
    rng = d["range"]
    range_text = f'{rng["from"]} 至 {rng["to"]}' if rng["from"] else "全部数据"
    parts.append(
        "<header><h1>安全管理数据报表</h1>"
        f'<div class="meta">统计范围：{esc(range_text)}　｜　'
        f'生成时间：{now.strftime("%Y-%m-%d %H:%M:%S")}　｜　'
        f'数据目录：{esc(os.path.basename(store.DATA_DIR))}</div></header>')

    # ---- KPI
    parts.append("<h2>核心指标</h2><div class='kpis'>")
    kpis = [
        ("隐患总数", k["hazardTotal"], "", f"重大隐患 {k['hazardMajor']} 项", ""),
        ("隐患整改率", _pct(k["hazardCloseRate"]), "%",
         f"已关闭 {k['hazardClosed']} / {k['hazardTotal']}", "ok"),
        ("按期整改率", _pct(k["hazardOnTimeRate"]), "%", "按整改期限计算", ""),
        ("逾期未整改", k["hazardOverdue"], "", "需重点关注",
         "danger" if k["hazardOverdue"] else "ok"),
        ("安全疑虑", k["concernTotal"], "",
         f"待处理 {k['concernOpen']} · 转隐患 {k['concernConverted']}",
         "danger" if k["concernOverdue"] else ""),
        ("疑虑超期未答复", k["concernOverdue"], "",
         f"待答复 {k['concernUnreplied']} 条",
         "danger" if k["concernOverdue"] else "ok"),
        ("风险点总数", k["riskTotal"], "", f"重大风险 {k['riskMajor']} 项",
         "danger" if k["riskMajor"] else ""),
        ("事故/事件", k["incidentTotal"], "", f"损失工日 {k['incidentLossDays']}",
         "warn" if k["incidentTotal"] else "ok"),
        ("直接经济损失", _money(k["incidentLossMoney"])[0],
         _money(k["incidentLossMoney"])[1], "统计期内合计", ""),
        ("培训场次", k["trainingTotal"], "", f"参训 {k['trainingPeople']} 人次", ""),
        ("培训完成率", _pct(k["trainingRate"]), "%",
         f"已完成 {k['trainingDone']} 场", "ok"),
        ("证照到期预警", k["certWarn"], "", f"已过期 {k['certExpired']} 张",
         "danger" if k["certWarn"] else "ok"),
        ("消防点检逾期", k["fireOverdue"], "", f"设施共 {k['fireTotal']} 项",
         "warn" if k["fireOverdue"] else "ok"),
        ("应急演练", k["drillTotal"], "", "统计期内计划/实施", ""),
        ("承包商在册", k["contractorActive"], "",
         f"违章合计 {k['contractorViolations']} 次", ""),
        ("设备总数", k["equipmentTotal"], "",
         f"特种设备 {k['equipmentSpecial']} 台 · 在用 {k['equipmentActive']}", ""),
        ("设备检验到期", k["equipmentExpiring"], "",
         f"已过期 {k['equipmentExpired']} 台",
         "danger" if k["equipmentExpiring"] else "ok"),
        ("进行中作业票", k["permitRunning"], "",
         f"临期/超期 {k['permitExpiring']} 张",
         "warn" if k["permitExpiring"] else ""),
    ]
    for label, value, unit, foot, tone in kpis:
        parts.append(f"<div class='kpi {tone}'><div class='l'>{esc(label)}</div>"
                     f"<div class='v'>{esc(value)}"
                     f"{f'<small>{esc(unit)}</small>' if unit else ''}</div>"
                     f"<div class='f'>{esc(foot)}</div></div>")
    parts.append("</div>")

    # ---- 图表
    parts.append("<h2>数据分析</h2><div class='charts'>")
    trend = d["trend"]
    chart_defs = [
        ("隐患月度趋势",
         svg_line(trend["months"], [
             {"name": "发现隐患", "data": trend["hazardFound"], "color": "#2d7d92"},
             {"name": "关闭隐患", "data": trend["hazardClosed"], "color": "#1e8449"},
             {"name": "事故/事件", "data": trend["incidents"], "color": "#c0392b"},
         ])),
        ("风险四色分布",
         svg_bar([{"name": i["name"], "value": i["value"],
                   "color": RISK_COLORS.get(i["name"])} for i in d["riskByLevel"]])),
        ("隐患类别分布", svg_hbar(d["hazardByCategory"])),
        ("事故类型分布", svg_pie(d["incidentByType"])),
        ("设备分类分布",
         svg_bar([{"name": i["name"], "value": i["value"],
                   "color": {"特种设备类": "#c0392b", "表阀类": "#d68910",
                             "其他类": "#2d7d92"}.get(i["name"])}
                  for i in d["equipmentByCategory"]])),
        ("安全疑虑类别分布", svg_hbar(d["concernByCategory"])),
    ]
    for title, svg in chart_defs:
        parts.append(f"<div class='card'><div class='card-head'><h3>{esc(title)}</h3></div>"
                     f"<div class='card-body'>{svg}</div></div>")
    parts.append("</div>")

    # ---- 提醒清单
    alerts = d["alerts"]
    alert_defs = [
        ("逾期未整改隐患", alerts["hazardOverdue"],
         lambda a: a.get("title"), lambda a: f"{a.get('dept','')} · 期限 {a.get('deadline','—')}"),
        ("待处理安全疑虑", alerts["concernPending"],
         lambda a: a.get("title"), lambda a: f"{a.get('dept','')} · {a.get('status','')} · 限 {a.get('deadline','—')}"),
        ("证照到期提醒", alerts["certExpiring"],
         lambda a: f"{a.get('personName','')} {a.get('certType','')}",
         lambda a: f"{a.get('expireDate','')} · {a.get('daysLeft','')} 天"),
        ("消防点检逾期", alerts["fireOverdue"],
         lambda a: a.get("name"), lambda a: f"{a.get('location','')} · 应检 {a.get('nextCheckDate','—')}"),
        ("设备检验到期", alerts["equipmentExpiring"],
         lambda a: f"{a.get('name','')}（{a.get('type','')}）",
         lambda a: f"{a.get('location','')} · {a.get('inspectExpire','')} · {a.get('expiryWarn','')}"),
        ("承包商资质到期", alerts["contractorExpiring"],
         lambda a: a.get("name"), lambda a: f"{a.get('expireDate','')} · {a.get('expiryWarn','')}"),
        ("作业票临期/超期", alerts["permitExpiring"],
         lambda a: f"{a.get('type','')} {a.get('contractor','')}",
         lambda a: f"{a.get('endTime','')} · {a.get('state','')}"),
    ]
    parts.append("<h2>待办提醒</h2><div class='charts'>")
    for title, items, main_fn, meta_fn in alert_defs:
        parts.append("<div class='card'><div class='card-head'>"
                     f"<h3>{esc(title)}</h3><span class='n'>{len(items)} 项</span></div>"
                     "<div class='card-body'>")
        if items:
            parts.append("<ul class='alerts'>")
            for a in items:
                parts.append(f"<li><span class='t'>{esc(main_fn(a))}</span>"
                             f"<span class='m'>{esc(meta_fn(a))}</span></li>")
            parts.append("</ul>")
        else:
            parts.append("<div class='empty'>暂无需要处理的事项</div>")
        parts.append("</div></div>")
    parts.append("</div>")

    # ---- 各台账明细
    parts.append("<h2>台账明细</h2>")
    for key in schema.COLLECTION_ORDER:
        coll = schema.get_collection(key)
        items = store.all_items(key)
        cols = [fd for fd in coll["fields"] if fd["in_list"]]
        parts.append("<div class='card'><div class='card-head'>"
                     f"<h3>{esc(coll['icon'])} {esc(coll['label'])}</h3>"
                     f"<span class='n'>{len(items)} 条</span></div>")
        if not items:
            parts.append("<div class='card-body'><div class='empty'>暂无数据</div></div></div>")
            continue
        parts.append("<div class='scroll'><table><thead><tr>")
        for fd in cols:
            parts.append(f"<th>{esc(fd['label'])}</th>")
        parts.append("</tr></thead><tbody>")
        for it in items:
            parts.append("<tr>")
            for fd in cols:
                classes = []
                extra = ""
                if fd["type"] == "number":
                    classes.append("num")
                # 长文本列限制宽度并显示省略号，鼠标悬停可看全文
                if fd["key"] in ("title", "riskPoint", "name", "location",
                                 "description", "hazardFactor"):
                    classes.append("clip")
                    raw = it.get(fd["key"])
                    if raw:
                        extra = f' title="{esc(raw)}"'
                cls = f" class='{' '.join(classes)}'" if classes else ""
                parts.append(f"<td{cls}{extra}>{fmt_cell(fd, it.get(fd['key']), it)}</td>")
            parts.append("</tr>")
        parts.append("</tbody></table></div>")
        parts.append("<div class='scroll-hint'>↔ 表格可左右滚动查看更多列</div></div>")

    # ---- 页脚
    total = sum(store.count_all().values())
    parts.append(f"<footer>本报表由「安全管理数据工作台」自动生成　｜　"
                 f"共 {total} 条记录　｜　生成时间 {now.strftime('%Y-%m-%d %H:%M')}<br>"
                 f"提示：浏览器中按 Ctrl+P 可打印或另存为 PDF</footer>")
    parts.append("</div></body></html>")
    return "".join(parts)


def _pct(v):
    return "—" if v is None else v


def _money(v):
    n = float(v or 0)
    if n >= 10000:
        return f"{n/10000:.2f}", "万元"
    return f"{n:.0f}", "元"


def main():
    ap = argparse.ArgumentParser(description="导出 HTML 报表")
    ap.add_argument("--out", default="", help="输出文件路径")
    ap.add_argument("--from", dest="frm", default="", help="起始日期 YYYY-MM-DD")
    ap.add_argument("--to", dest="to", default="", help="结束日期 YYYY-MM-DD")
    args = ap.parse_args()

    html_text = build_report(args.frm, args.to)

    out = args.out
    if not out:
        reports = os.path.join(BASE_DIR, "reports")
        os.makedirs(reports, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M")
        out = os.path.join(reports, f"安全管理数据报表_{stamp}.html")
    else:
        if not os.path.isabs(out):
            out = os.path.join(BASE_DIR, out)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    with open(out, "w", encoding="utf-8") as fp:
        fp.write(html_text)

    size_kb = os.path.getsize(out) / 1024
    total = sum(store.count_all().values())
    print(f"已生成报表：{out}")
    print(f"文件大小：{size_kb:.1f} KB　｜　包含 {total} 条记录")
    print("双击即可用浏览器打开，也可按 Ctrl+P 另存为 PDF")
    return 0


if __name__ == "__main__":
    sys.exit(main())
