/* 安全管理数据工作台 — 前端业务功能
 *
 * 把原来 Python 后端做的事搬到浏览器：
 *   - Excel 导出（当前筛选结果）
 *   - Excel 模板下载
 *   - Excel 导入（按编号 upsert）
 *   - HTML 报表生成（含 SVG 图表）
 */
(function (global) {
  'use strict';

  // ================================================================ 工具

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowStr() {
    const d = new Date();
    return `${today()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 取导出用的字段（不含纯计算字段）。 */
  function exportFields(coll) {
    return (coll.fields || []).filter(fd => fd.type !== 'computed');
  }

  function cellValue(fd, v) {
    if (v === null || v === undefined || v === '') return '';
    if (fd.type === 'bool') return v ? '是' : '否';
    if (fd.type === 'number') {
      const n = Number(v);
      return isFinite(n) ? n : '';
    }
    return String(v);
  }

  function colWidth(fd) {
    const w = fd.width || 140;
    return Math.max(10, Math.min(40, Math.round(w / 8)));
  }

  // ================================================================ Excel 导出

  /**
   * 导出当前集合的数据为 xlsx。
   * @param {string} key 集合 key
   * @param {Array} items 记录
   * @param {object} coll 集合定义
   */
  function exportCollection(key, items, coll) {
    const fields = exportFields(coll);
    const header = fields.map(fd => fd.label);
    const rows = [header];

    items.forEach(it => {
      rows.push(fields.map(fd => cellValue(fd, it[fd.key])));
    });

    // 说明页
    const infoRows = [
      ['集合', coll.label],
      ['导出时间', nowStr()],
      ['记录数', items.length],
      [],
      ['字段', '说明'],
    ];
    fields.forEach(fd => {
      let hint = fd.help || '';
      if (fd.options && fd.options.length) {
        hint += (hint ? ' ' : '') + '可选值：' + fd.options.filter(Boolean).join(' / ');
      }
      if (fd.type === 'date') hint += (hint ? ' ' : '') + '格式：YYYY-MM-DD';
      if (fd.type === 'datetime') hint += (hint ? ' ' : '') + '格式：YYYY-MM-DD HH:mm';
      if (fd.required) hint = '【必填】' + hint;
      infoRows.push([fd.label, hint]);
    });

    const bytes = XLSX.build([
      {
        name: (coll.short || coll.label).slice(0, 30),
        rows,
        colWidths: fields.map(colWidth),
      },
      { name: '填写说明', rows: infoRows, colWidths: [18, 60] },
    ]);

    const fname = `${coll.label}_${today().replace(/-/g, '')}.xlsx`;
    XLSX.download(bytes, fname);
    return fname;
  }

  /** 下载导入模板。 */
  function exportTemplate(key, coll) {
    const fields = exportFields(coll);
    const header = fields.map(fd => fd.label);

    // 示例行
    const sample = fields.map(fd => {
      if (fd.key === 'id') return '留空自动生成';
      if (fd.options && fd.options.length) {
        const opt = fd.options.find(o => o);
        return opt || '';
      }
      if (fd.type === 'date') return today();
      if (fd.type === 'datetime') return nowStr().slice(0, 16);
      if (fd.type === 'number') return fd.default || 0;
      if (fd.type === 'bool') return '否';
      return fd.default || '';
    });

    const noteRows = [
      ['导入说明'],
      [],
      ['1. 第 1 行为表头，请勿修改表头文字；第 2 行为灰色示例行，导入前请删除。'],
      ['2. 编号列留空表示新增；填写已有编号表示更新该条记录。'],
      ['3. 日期格式 YYYY-MM-DD，日期时间格式 YYYY-MM-DD HH:mm。'],
      ['4. 下拉类字段请填写可选值中的某一项，不填视为空。'],
      ['5. 只支持 .xlsx 文件，.xls 请先另存为 .xlsx。'],
      [],
      ['字段', '说明'],
    ];
    fields.forEach(fd => {
      let hint = fd.help || '';
      if (fd.options && fd.options.length) {
        hint += (hint ? ' ' : '') + '可选值：' + fd.options.filter(Boolean).join(' / ');
      }
      if (fd.required) hint = '【必填】' + hint;
      noteRows.push([fd.label, hint]);
    });

    const bytes = XLSX.build([
      {
        name: (coll.short || coll.label).slice(0, 30),
        rows: [header, sample],
        colWidths: fields.map(colWidth),
      },
      { name: '填写说明', rows: noteRows, colWidths: [18, 60] },
    ]);

    const fname = `${coll.label}_导入模板.xlsx`;
    XLSX.download(bytes, fname);
    return fname;
  }

  // ================================================================ Excel 导入

  /**
   * 解析 xlsx 并按编号 upsert。
   * @returns {Promise<{inserted, updated, skipped, errors, totalErrors}>}
   */
  async function importCollection(file, key, coll, api) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const sheets = await XLSX.read(buf);
    if (!sheets.length) throw new Error('文件为空');

    const ws = sheets[0];
    const rows = ws.rows;
    if (!rows.length) throw new Error('文件为空');

    const fields = exportFields(coll);
    const labelToKey = {};
    fields.forEach(fd => { labelToKey[fd.label] = fd.key; });

    // 映射表头
    const header = rows[0] || [];
    const colMap = {};
    header.forEach((name, idx) => {
      const label = String(name || '').trim();
      const k = labelToKey[label];
      if (k) colMap[idx] = k;
    });
    if (!Object.keys(colMap).length) {
      throw new Error('表头与模板不匹配，请下载最新模板后再导入');
    }

    // 现有编号集合
    const existing = new Set();
    (api.all(key) || []).forEach(it => existing.add(String(it.id)));

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const lineNo = i + 1;
      // 整行为空则跳过
      if (!row.some(c => c !== null && c !== undefined && String(c).trim() !== '')) continue;

      const payload = {};
      Object.keys(colMap).forEach(idx => {
        payload[colMap[idx]] = row[idx];
      });

      let itemId = String(payload.id || '').trim();
      delete payload.id;
      if (itemId === '留空自动生成' || itemId === '编号') itemId = '';

      try {
        if (itemId && existing.has(itemId)) {
          api.update(key, itemId, payload);
          updated++;
        } else if (itemId && !existing.has(itemId)) {
          errors.push(`第 ${lineNo} 行：编号 ${itemId} 不存在，已跳过`);
          skipped++;
        } else {
          const created = api.create(key, payload);
          existing.add(String(created.id));
          inserted++;
        }
      } catch (e) {
        errors.push(`第 ${lineNo} 行：${e.message}`);
        skipped++;
      }
    }

    return {
      inserted, updated, skipped,
      errors: errors.slice(0, 50),
      totalErrors: errors.length,
    };
  }

  // ================================================================ HTML 报表

  const PALETTE = ['#2d7d92', '#1f4e5f', '#0f7b6c', '#d68910', '#c0392b',
    '#6c3483', '#1a5276', '#b9770e', '#7d6608', '#a93226'];

  const RISK_COLORS = {
    '重大风险': '#c0392b', '较大风险': '#e67e22',
    '一般风险': '#d4ac0d', '低风险': '#2e86c1', '未评级': '#95a5a6',
  };

  const STATUS_COLORS = {
    '已关闭': '#1e8449', '已结案': '#1e8449', '已完成': '#1e8449',
    '已准入': '#1e8449', '正常': '#1e8449', '有效': '#1e8449',
    '受控': '#1e8449', '已评估': '#1e8449', '已办结': '#1e8449',
    '待整改': '#d68910', '整改中': '#2d7d92', '待验收': '#6c3483',
    '调查中': '#d68910', '计划中': '#2d7d92', '待审核': '#d68910',
    '待审批': '#d68910', '已批准': '#2d7d92', '作业中': '#6c3483',
    '待维修': '#d68910', '维修中': '#d68910', '已实施': '#2d7d92',
    '待核实': '#d68910', '核实中': '#2d7d92', '待答复': '#6c3483',
    '已转隐患': '#7f8c8d', '已取消': '#7f8c8d', '已停用': '#7f8c8d',
    '已报废': '#7f8c8d', '已清退': '#7f8c8d', '已暂停': '#d68910',
    '已作废': '#7f8c8d', '已注销': '#7f8c8d', '失控': '#c0392b',
    '重大隐患': '#c0392b', '一般隐患': '#2d7d92',
    '急救箱事件': '#2d7d92', '医疗处置事件': '#d68910', '未遂事件': '#7f8c8d',
    '一般事件': '#6c3483', '一般事故': '#c0392b', '安全疑虑': '#7f8c8d',
    'A级': '#c0392b', 'B级': '#d68910', 'C级': '#d4ac0d',
  };

  function badge(text, color) {
    if (!text) return '—';
    const c = color || STATUS_COLORS[text];
    if (!c) return esc(text);
    return `<span class="b" style="background:${c}1a;color:${c};border-color:${c}55">${esc(text)}</span>`;
  }

  function fmtCell(fd, v, rec) {
    if (fd.type === 'computed') {
      if (fd.key === 'overdue' || fd.key === 'checkOverdue') {
        return v ? '<span class="b b-red">逾期</span>' : '<span class="b b-gray">—</span>';
      }
      if (fd.key === 'daysLeft') {
        if (v === null || v === undefined || v === '') return '—';
        const n = Number(v);
        const cls = n < 0 ? 'b-red' : (n <= 30 ? 'b-orange' : 'b-gray');
        return `<span class="b ${cls}">${n} 天</span>`;
      }
      if (fd.key === 'riskLevel') return badge(v, RISK_COLORS[v]);
      if (fd.key === 'expiryWarn' || fd.key === 'state') {
        const tone = ['已过期', '已超期'].includes(v) ? 'b-red'
          : ['30天内到期', '24小时内到期'].includes(v) ? 'b-orange'
            : v === '正常' ? 'b-green' : 'b-gray';
        return `<span class="b ${tone}">${esc(v || '—')}</span>`;
      }
      if (fd.key === 'replyState') {
        return `<span class="b ${['已答复', '已办结'].includes(v) ? 'b-green' : 'b-orange'}">${esc(v || '—')}</span>`;
      }
      if (typeof v === 'boolean') return v ? '是' : '否';
      return esc(v === null || v === undefined || v === '' ? '—' : v);
    }

    if (fd.type === 'bool') return v ? '是' : '否';
    if (['status', 'level', 'level1', 'grade', 'severity'].includes(fd.key)) return badge(v);
    if (fd.type === 'number' && v !== null && v !== undefined && v !== '') {
      const n = Number(v);
      if (isFinite(n)) return Number.isInteger(n) ? n.toLocaleString('zh-CN') : n.toFixed(2);
    }
    if (v === null || v === undefined || v === '') return '—';
    return esc(v);
  }

  function emptyChart(w, h) {
    return `<svg viewBox="0 0 ${w} ${h}" class="chart"><text x="${w / 2}" y="${h / 2}" ` +
      `text-anchor="middle" font-size="13" fill="#8a99a8">暂无数据</text></svg>`;
  }

  function niceMax(v) {
    if (v <= 0) return 5;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function svgLine(labels, series, w, h) {
    w = w || 560; h = h || 220;
    if (!labels || !labels.length) return emptyChart(w, h);
    const pl = 46, pr = 16, pt = 26, pb = 32;
    const pw = w - pl - pr, ph = h - pt - pb;
    let maxV = 0;
    series.forEach(s => s.data.forEach(v => { if (v > maxV) maxV = v; }));
    const top = niceMax(maxV);

    const parts = [`<svg viewBox="0 0 ${w} ${h}" class="chart">`];
    for (let i = 0; i < 5; i++) {
      const y = pt + ph * i / 4;
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${pl + pw}" y2="${y.toFixed(1)}" stroke="#e8eef3"/>`);
      parts.push(`<text x="${pl - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8a99a8">${Math.round(top - top * i / 4)}</text>`);
    }
    const step = Math.max(1, Math.floor(labels.length / 12));
    labels.forEach((lb, i) => {
      if (i % step && i !== labels.length - 1) return;
      const x = pl + pw * i / Math.max(1, labels.length - 1);
      parts.push(`<text x="${x.toFixed(1)}" y="${pt + ph + 18}" text-anchor="middle" font-size="10" fill="#8a99a8">${esc(String(lb).slice(5))}</text>`);
    });
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      const pts = s.data.map((v, i) => {
        const x = pl + pw * i / Math.max(1, s.data.length - 1);
        const y = pt + ph - (top ? v / top * ph : 0);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
      if (s.data.length <= 30) {
        s.data.forEach((v, i) => {
          const x = pl + pw * i / Math.max(1, s.data.length - 1);
          const y = pt + ph - (top ? v / top * ph : 0);
          parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color}"/>`);
        });
      }
    });
    let lx = pl;
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      parts.push(`<rect x="${lx}" y="8" width="11" height="3" fill="${color}"/>`);
      parts.push(`<text x="${lx + 15}" y="12" font-size="11" fill="#5a6b7b">${esc(s.name)}</text>`);
      lx += 22 + s.name.length * 12;
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function svgBar(items, w, h) {
    w = w || 560; h = h || 220;
    if (!items || !items.length) return emptyChart(w, h);
    const pl = 46, pr = 16, pt = 20, pb = 46;
    const pw = w - pl - pr, ph = h - pt - pb;
    const top = niceMax(Math.max(...items.map(i => i.value)));
    const slot = pw / items.length;
    const bw = Math.min(46, slot * 0.6);

    const parts = [`<svg viewBox="0 0 ${w} ${h}" class="chart">`];
    for (let i = 0; i < 5; i++) {
      const y = pt + ph * i / 4;
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${pl + pw}" y2="${y.toFixed(1)}" stroke="#e8eef3"/>`);
      parts.push(`<text x="${pl - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8a99a8">${Math.round(top - top * i / 4)}</text>`);
    }
    items.forEach((it, i) => {
      const v = it.value || 0;
      const bh = top ? v / top * ph : 0;
      const x = pl + slot * i + (slot - bw) / 2;
      const y = pt + ph - bh;
      const color = it.color || PALETTE[i % PALETTE.length];
      if (bh > 0) {
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" rx="2"/>`);
        parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#5a6b7b">${v}</text>`);
      }
      parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${pt + ph + 16}" text-anchor="middle" font-size="10.5" fill="#5a6b7b">${esc(it.name)}</text>`);
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function svgHbar(items, w, h) {
    w = w || 560; h = h || 220;
    items = (items || []).filter(i => i.value > 0).slice(0, 10);
    if (!items.length) return emptyChart(w, h);
    const pl = 96, pr = 46, pt = 12;
    const pw = w - pl - pr;
    const rowH = Math.min(26, (h - pt - 12) / items.length);
    const barH = Math.max(9, rowH - 9);
    const maxV = Math.max(...items.map(i => i.value)) || 1;

    const parts = [`<svg viewBox="0 0 ${w} ${h}" class="chart">`];
    items.forEach((it, i) => {
      const y = pt + i * rowH;
      const bw = Math.max(2, it.value / maxV * pw);
      const cy = y + (rowH - barH) / 2;
      parts.push(`<rect x="${pl}" y="${cy.toFixed(1)}" width="${pw}" height="${barH.toFixed(1)}" fill="#f2f6f8"/>`);
      parts.push(`<rect x="${pl}" y="${cy.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" fill="${it.color || PALETTE[i % PALETTE.length]}" rx="2"/>`);
      let name = String(it.name);
      if (name.length > 7) name = name.slice(0, 7) + '…';
      parts.push(`<text x="${pl - 8}" y="${(cy + barH / 2 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#5a6b7b">${esc(name)}</text>`);
      parts.push(`<text x="${(pl + bw + 7).toFixed(1)}" y="${(cy + barH / 2 + 4).toFixed(1)}" font-size="11" fill="#1a2733">${it.value}</text>`);
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function svgPie(items, w, h) {
    w = w || 560; h = h || 220;
    items = (items || []).filter(i => i.value > 0);
    if (!items.length) return emptyChart(w, h);
    const total = items.reduce((s, i) => s + i.value, 0);
    const cx = 118, cy = h / 2;
    const r = Math.min(cx - 16, h / 2 - 16);
    let ang = -Math.PI / 2;

    const parts = [`<svg viewBox="0 0 ${w} ${h}" class="chart">`];
    items.forEach((it, i) => {
      const frac = it.value / total;
      const end = ang + frac * Math.PI * 2;
      const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      const large = frac > 0.5 ? 1 : 0;
      const color = it.color || PALETTE[i % PALETTE.length];
      parts.push(`<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
      ang = end;
    });
    let ly = Math.max(16, cy - items.length * 9);
    const lx = cx + r + 24;
    items.forEach((it, i) => {
      if (ly > h - 8) return;
      const color = it.color || PALETTE[i % PALETTE.length];
      const pct = Math.round(it.value / total * 100);
      parts.push(`<rect x="${lx}" y="${(ly - 9).toFixed(1)}" width="9" height="9" fill="${color}" rx="2"/>`);
      parts.push(`<text x="${lx + 14}" y="${ly.toFixed(1)}" font-size="11" fill="#5a6b7b">${esc(it.name)} ${it.value} (${pct}%)</text>`);
      ly += 18;
    });
    parts.push('</svg>');
    return parts.join('');
  }

  const REPORT_CSS = `
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
}`;

  /** 生成完整 HTML 报表字符串。 */
  function buildReport(d, schema, allFn) {
    const k = d.kpi;
    const now = nowStr();
    const parts = [];
    parts.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
    parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    parts.push(`<title>安全管理数据报表 ${today()}</title>`);
    parts.push(`<style>${REPORT_CSS}</style></head><body><div class='wrap'>`);

    const rng = d.range;
    const rangeText = rng.from ? `${rng.from} 至 ${rng.to}` : '全部数据';
    parts.push('<header><h1>安全管理数据报表</h1>' +
      `<div class="meta">统计范围：${esc(rangeText)}　｜　` +
      `生成时间：${now}　｜　数据来源：浏览器本地存储</div></header>`);

    // KPI
    parts.push("<h2>核心指标</h2><div class='kpis'>");
    const money = v => {
      const n = Number(v || 0);
      return n >= 10000 ? [(n / 10000).toFixed(2), '万元'] : [String(Math.round(n)), '元'];
    };
    const pct = v => (v === null || v === undefined ? '—' : v);
    const m1 = money(k.incidentMedical);

    const kpis = [
      ['隐患总数', k.hazardTotal, '', `重大隐患 ${k.hazardMajor} 项`, ''],
      ['隐患整改率', pct(k.hazardCloseRate), '%', `已关闭 ${k.hazardClosed} / ${k.hazardTotal}`, 'ok'],
      ['按期整改率', pct(k.hazardOnTimeRate), '%', '按整改期限计算', ''],
      ['逾期未整改', k.hazardOverdue, '', '需重点关注', k.hazardOverdue ? 'danger' : 'ok'],
      ['安全疑虑', k.concernTotal, '', `待处理 ${k.concernOpen} · 转隐患 ${k.concernConverted}`, k.concernOverdue ? 'danger' : ''],
      ['疑虑超期未答复', k.concernOverdue, '', `待答复 ${k.concernUnreplied} 条`, k.concernOverdue ? 'danger' : 'ok'],
      ['风险点总数', k.riskTotal, '', `重大风险 ${k.riskMajor} 项`, k.riskMajor ? 'danger' : ''],
      ['事故/事件', k.incidentTotal, '', `未遂 ${k.incidentAttempt} · 一般事件 ${k.incidentGeneral}`, k.incidentTotal ? 'warn' : 'ok'],
      ['急救箱事件', k.incidentFirstAid, '', `医疗处置 ${k.incidentMedicalCase} 起`, ''],
      ['受伤人数', k.incidentPersons, '', `损失工日 ${k.incidentLossDays}`, k.incidentPersons ? 'warn' : 'ok'],
      ['医疗费用', m1[0], m1[1], '急救箱+医疗处置合计', ''],
      ['培训场次', k.trainingTotal, '', `参训 ${k.trainingPeople} 人次`, ''],
      ['培训完成率', pct(k.trainingRate), '%', `已完成 ${k.trainingDone} 场`, 'ok'],
      ['证照到期预警', k.certWarn, '', `已过期 ${k.certExpired} 张`, k.certWarn ? 'danger' : 'ok'],
      ['消防点检逾期', k.fireOverdue, '', `设施共 ${k.fireTotal} 项`, k.fireOverdue ? 'warn' : 'ok'],
      ['应急演练', k.drillTotal, '', '统计期内计划/实施', ''],
      ['承包商在册', k.contractorActive, '', `违章合计 ${k.contractorViolations} 次`, ''],
      ['设备总数', k.equipmentTotal, '', `特种设备 ${k.equipmentSpecial} 台 · 在用 ${k.equipmentActive}`, ''],
      ['设备检验到期', k.equipmentExpiring, '', `已过期 ${k.equipmentExpired} 台`, k.equipmentExpiring ? 'danger' : 'ok'],
      ['进行中作业票', k.permitRunning, '', `临期/超期 ${k.permitExpiring} 张`, k.permitExpiring ? 'warn' : ''],
    ];
    kpis.forEach(([label, value, unit, foot, tone]) => {
      parts.push(`<div class='kpi ${tone}'><div class='l'>${esc(label)}</div>` +
        `<div class='v'>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>` +
        `<div class='f'>${esc(foot)}</div></div>`);
    });
    parts.push('</div>');

    // 图表
    parts.push("<h2>数据分析</h2><div class='charts'>");
    const trend = d.trend;
    const charts = [
      ['隐患月度趋势', svgLine(trend.months, [
        { name: '发现隐患', data: trend.hazardFound, color: '#2d7d92' },
        { name: '关闭隐患', data: trend.hazardClosed, color: '#1e8449' },
        { name: '事故/事件', data: trend.incidents, color: '#c0392b' },
      ])],
      ['风险四色分布', svgBar(d.riskByLevel.map(i => ({
        name: i.name, value: i.value, color: RISK_COLORS[i.name],
      })))],
      ['隐患类别分布', svgHbar(d.hazardByCategory)],
      ['事故类型分布', svgPie(d.incidentByType)],
      ['设备分类分布', svgBar(d.equipmentByCategory.map(i => ({
        name: i.name, value: i.value,
        color: { '特种设备类': '#c0392b', '表阀类': '#d68910', '其他类': '#2d7d92' }[i.name],
      })))],
      ['安全疑虑类别分布', svgHbar(d.concernByCategory)],
      ['事件等级分布', svgBar(d.incidentByLevel1.map(i => ({
        name: i.name, value: i.value,
        color: { '急救箱事件': '#2d7d92', '医疗处置事件': '#d68910', '未遂事件': '#7f8c8d', '一般事件': '#e67e22', '一般事故': '#c0392b' }[i.name],
      })))],
    ];
    charts.forEach(([title, svg]) => {
      parts.push(`<div class='card'><div class='card-head'><h3>${esc(title)}</h3></div>` +
        `<div class='card-body'>${svg}</div></div>`);
    });
    parts.push('</div>');

    // 提醒
    const alerts = d.alerts;
    const alertDefs = [
      ['逾期未整改隐患', alerts.hazardOverdue,
        a => a.title, a => `${a.dept || ''} · 期限 ${a.deadline || '—'}`],
      ['待处理安全疑虑', alerts.concernPending,
        a => a.title, a => `${a.dept || ''} · ${a.status} · 限 ${a.deadline || '—'}`],
      ['证照到期提醒', alerts.certExpiring,
        a => `${a.personName} ${a.certType}`, a => `${a.expireDate} · ${a.daysLeft} 天`],
      ['消防点检逾期', alerts.fireOverdue,
        a => a.name, a => `${a.location || ''} · 应检 ${a.nextCheckDate || '—'}`],
      ['设备检验到期', alerts.equipmentExpiring,
        a => `${a.name}（${a.type}）`, a => `${a.location} · ${a.inspectExpire} · ${a.expiryWarn}`],
      ['承包商资质到期', alerts.contractorExpiring,
        a => a.name, a => `${a.expireDate} · ${a.expiryWarn}`],
      ['作业票临期/超期', alerts.permitExpiring,
        a => `${a.type} ${a.contractor}`, a => `${a.endTime} · ${a.state}`],
    ];
    parts.push("<h2>待办提醒</h2><div class='charts'>");
    alertDefs.forEach(([title, items, mainFn, metaFn]) => {
      parts.push(`<div class='card'><div class='card-head'><h3>${esc(title)}</h3>` +
        `<span class='n'>${(items || []).length} 项</span></div><div class='card-body'>`);
      if (items && items.length) {
        parts.push("<ul class='alerts'>");
        items.forEach(a => {
          parts.push(`<li><span class='t'>${esc(mainFn(a))}</span>` +
            `<span class='m'>${esc(metaFn(a))}</span></li>`);
        });
        parts.push('</ul>');
      } else {
        parts.push("<div class='empty'>暂无需要处理的事项</div>");
      }
      parts.push('</div></div>');
    });
    parts.push('</div>');

    // 台账
    parts.push("<h2>台账明细</h2>");
    (schema.collections || []).forEach(coll => {
      const items = allFn(coll.key) || [];
      const cols = (coll.fields || []).filter(fd => fd.in_list);
      parts.push(`<div class='card'><div class='card-head'><h3>${esc(coll.icon)} ${esc(coll.label)}</h3>` +
        `<span class='n'>${items.length} 条</span></div>`);
      if (!items.length) {
        parts.push("<div class='card-body'><div class='empty'>暂无数据</div></div></div>");
        return;
      }
      parts.push("<div class='scroll'><table><thead><tr>");
      cols.forEach(fd => parts.push(`<th>${esc(fd.label)}</th>`));
      parts.push('</tr></thead><tbody>');
      items.forEach(it => {
        parts.push('<tr>');
        cols.forEach(fd => {
          const classes = [];
          if (fd.type === 'number') classes.push('num');
          if (['title', 'riskPoint', 'name', 'location', 'description', 'hazardFactor'].includes(fd.key)) {
            classes.push('clip');
          }
          const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
          parts.push(`<td${cls}>${fmtCell(fd, it[fd.key], it)}</td>`);
        });
        parts.push('</tr>');
      });
      parts.push('</tbody></table></div>');
      parts.push("<div class='scroll-hint'>↔ 表格可左右滚动查看更多列</div></div>");
    });

    const total = Object.values(schema.collections.reduce((o, c) => {
      o[c.key] = (allFn(c.key) || []).length;
      return o;
    }, {})).reduce((a, b) => a + b, 0);

    parts.push(`<footer>本报表由「安全管理数据工作台」自动生成　｜　` +
      `共 ${total} 条记录　｜　生成时间 ${now}<br>` +
      '提示：浏览器中按 Ctrl+P 可打印或另存为 PDF</footer>');
    parts.push('</div></body></html>');
    return parts.join('');
  }

  function downloadReport(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `安全管理数据报表_${today()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ================================================================ 对外接口

  global.Biz = {
    exportCollection,
    exportTemplate,
    importCollection,
    buildReport,
    downloadReport,
    // 图表函数也导出，便于复用
    svgLine, svgBar, svgHbar, svgPie,
  };
})(window);
