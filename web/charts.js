/* Canvas 手绘图表：折线、柱状、横向条形、饼图。无第三方依赖。 */
(function (global) {
  'use strict';

  const PALETTE = ['#2d7d92', '#1f4e5f', '#0f7b6c', '#d68910', '#c0392b',
    '#6c3483', '#1a5276', '#b9770e', '#7d6608', '#a93226'];
  const RISK_COLORS = {
    '重大风险': '#c0392b', '较大风险': '#e67e22', '一般风险': '#d4ac0d',
    '低风险': '#2e86c1', '未评级': '#95a5a6'
  };

  function setup(canvas) {
    const dpr = global.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(160, rect.width || canvas.clientWidth || 300);
    const h = Math.max(120, rect.height || canvas.clientHeight || 200);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    return { ctx, w, h };
  }

  function niceMax(v) {
    if (v <= 0) return 5;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function emptyHint(ctx, w, h, text) {
    ctx.fillStyle = '#8a99a8';
    ctx.textAlign = 'center';
    ctx.fillText(text || '暂无数据', w / 2, h / 2);
  }

  /* ---------------------------------------------------------- 折线图 */
  function line(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const labels = opts.labels || [];
    const series = opts.series || [];
    if (!labels.length) return emptyHint(ctx, w, h);

    const padL = 40, padR = 14, padT = 18, padB = 30;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    let maxV = 0;
    series.forEach(s => (s.data || []).forEach(v => { if (v > maxV) maxV = v; }));
    const top = niceMax(maxV);
    const yOf = v => padT + plotH - (v / top) * plotH;
    const xOf = i => labels.length === 1
      ? padL + plotW / 2
      : padL + (i / (labels.length - 1)) * plotW;

    // 网格
    ctx.strokeStyle = '#e8eef3';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8a99a8';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(top - (top / 4) * i)), padL - 7, y);
    }

    // x 轴标签
    ctx.textAlign = 'center';
    const stepX = Math.max(1, Math.ceil(labels.length / 12));
    labels.forEach((lb, i) => {
      if (i % stepX !== 0 && i !== labels.length - 1) return;
      ctx.fillText(String(lb).slice(5), xOf(i), padT + plotH + 14);
    });

    // 折线
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      const data = s.data || [];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = xOf(i), y = yOf(v || 0);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      if (data.length <= 24) {
        ctx.fillStyle = color;
        data.forEach((v, i) => {
          ctx.beginPath();
          ctx.arc(xOf(i), yOf(v || 0), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });

    // 图例
    if (series.length > 1) {
      let lx = padL;
      ctx.textAlign = 'left';
      series.forEach((s, si) => {
        const color = s.color || PALETTE[si % PALETTE.length];
        ctx.fillStyle = color;
        ctx.fillRect(lx, 6, 10, 3);
        ctx.fillStyle = '#5a6b7b';
        ctx.fillText(s.name || '', lx + 14, 8);
        lx += 14 + ctx.measureText(s.name || '').width + 16;
      });
    }
  }

  /* ---------------------------------------------------------- 柱状图 */
  function bar(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const items = opts.items || [];
    if (!items.length) return emptyHint(ctx, w, h);

    const padL = 40, padR = 14, padT = 18, padB = 46;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxV = Math.max.apply(null, items.map(i => i.value || 0));
    const top = niceMax(maxV);
    const slot = plotW / items.length;
    const bw = Math.min(46, slot * 0.6);

    ctx.strokeStyle = '#e8eef3';
    ctx.fillStyle = '#8a99a8';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(top - (top / 4) * i)), padL - 7, y);
    }

    items.forEach((it, i) => {
      const v = it.value || 0;
      const bh = top ? (v / top) * plotH : 0;
      const x = padL + slot * i + (slot - bw) / 2;
      const y = padT + plotH - bh;
      ctx.fillStyle = it.color || opts.color || PALETTE[0];
      ctx.fillRect(x, y, bw, Math.max(bh, v > 0 ? 2 : 0));
      ctx.fillStyle = '#5a6b7b';
      ctx.textAlign = 'center';
      if (v > 0) ctx.fillText(String(v), x + bw / 2, y - 9);
      // 标签（过长换行截断）
      ctx.fillStyle = '#5a6b7b';
      const label = String(it.name || '');
      const maxChars = Math.max(3, Math.floor(slot / 12));
      const txt = label.length > maxChars ? label.slice(0, maxChars) + '…' : label;
      ctx.fillText(txt, x + bw / 2, padT + plotH + 15);
    });
  }

  /* ---------------------------------------------------------- 横向条形 */
  function hbar(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const items = (opts.items || []).slice(0, 10);
    if (!items.length) return emptyHint(ctx, w, h);

    const padL = 92, padR = 46, padT = 10, padB = 10;
    const plotW = w - padL - padR;
    const rowH = Math.min(28, (h - padT - padB) / items.length);
    const barH = Math.max(9, rowH - 9);
    const maxV = Math.max.apply(null, items.map(i => i.value || 0)) || 1;

    items.forEach((it, i) => {
      const y = padT + i * rowH;
      const bw = Math.max(2, ((it.value || 0) / maxV) * plotW);
      ctx.fillStyle = '#f2f6f8';
      ctx.fillRect(padL, y + (rowH - barH) / 2, plotW, barH);
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
      ctx.fillRect(padL, y + (rowH - barH) / 2, bw, barH);

      ctx.fillStyle = '#5a6b7b';
      ctx.textAlign = 'right';
      const label = String(it.name || '');
      const txt = label.length > 7 ? label.slice(0, 7) + '…' : label;
      ctx.fillText(txt, padL - 8, y + rowH / 2);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#1a2733';
      ctx.fillText(String(it.value || 0), padL + bw + 6, y + rowH / 2);
    });
  }

  /* ---------------------------------------------------------- 饼图 */
  function pie(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    const items = (opts.items || []).filter(i => (i.value || 0) > 0);
    if (!items.length) return emptyHint(ctx, w, h);

    const total = items.reduce((s, i) => s + (i.value || 0), 0);
    const cx = Math.min(w * 0.34, 120);
    const cy = h / 2;
    const r = Math.min(cx - 14, h / 2 - 16);
    let ang = -Math.PI / 2;

    items.forEach((it, i) => {
      const slice = ((it.value || 0) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang, ang + slice);
      ctx.closePath();
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ang += slice;
    });

    // 图例
    let ly = Math.max(16, cy - items.length * 9);
    const lx = cx + r + 22;
    ctx.textAlign = 'left';
    items.forEach((it, i) => {
      if (ly > h - 6) return;
      ctx.fillStyle = it.color || PALETTE[i % PALETTE.length];
      ctx.fillRect(lx, ly - 4, 9, 9);
      ctx.fillStyle = '#5a6b7b';
      const name = String(it.name || '');
      const pct = Math.round((it.value / total) * 100);
      ctx.fillText(`${name} ${it.value} (${pct}%)`, lx + 14, ly);
      ly += 18;
    });
  }

  global.Charts = { line, bar, hbar, pie, PALETTE, RISK_COLORS };
})(window);
