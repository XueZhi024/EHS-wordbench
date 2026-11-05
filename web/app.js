/* 安全管理数据工作台 — 前端主逻辑
 * 通用引擎：schema 驱动列表/表单/筛选/分页/流转/导入导出
 */
(function () {
  'use strict';

  // ============================================================ 状态
  const S = {
    schema: null,
    dicts: {},
    collMap: {},
    route: { view: 'dashboard' },
    list: { page: 1, size: 20, q: '', sort: '', dir: 'desc', filters: {} },
    cache: {},
    counts: {},
    mode: { local: true, readonly: false, lan: false, needLogin: false, loggedIn: true },
    autoRefresh: true,
    refreshTimer: null,
  };

  const REFRESH_MS = 30000;   // 看板自动刷新间隔

  const STATUS_TONE = {
    '待整改': 'orange', '整改中': 'blue', '待验收': 'purple', '已关闭': 'green',
    '受控': 'green', '失控': 'red', '已消除': 'gray',
    '调查中': 'orange', '已结案': 'green',
    '计划中': 'blue', '已完成': 'green', '已取消': 'gray',
    '已实施': 'blue', '已评估': 'green',
    '有效': 'green', '已注销': 'gray',
    '正常': 'green', '待维修': 'orange', '已停用': 'gray', '已报废': 'gray',
    '已准入': 'green', '待审核': 'orange', '已暂停': 'orange', '已清退': 'gray',
    '待审批': 'orange', '已批准': 'blue', '作业中': 'purple', '已完工': 'green', '已作废': 'gray',
    '一般隐患': 'blue', '重大隐患': 'red',
    '待核实': 'orange', '核实中': 'blue', '待答复': 'purple', '已转隐患': 'gray',
    '已答复': 'green', '已办结': 'green',
    // 事件大类
    '急救箱事件': 'blue', '医疗处置事件': 'orange', '未遂事件': 'gray',
    '一般事件': 'purple', '一般事故': 'red', '安全疑虑': 'gray',
    // 细分等级
    'A级': 'red', 'B级': 'orange', 'C级': 'yellow',
  };

  // ============================================================ 工具
  const $ = sel => document.querySelector(sel);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) {
          node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
        }
      }
    }
    (children || []).forEach(c => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    const box = $('#toast');
    const t = el('div', { class: 'toast ' + (kind || ''), text: msg });
    box.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, kind === 'err' ? 4200 : 2400);
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return digits === undefined ? String(n) : n.toFixed(digits);
  }

  // ============================================================ 运行模式
  // 'server' = 有 Python 后端（本地运行）
  // 'static' = 纯前端（GitHub Pages）
  let RUN_MODE = 'server';

  // ============================================================ API
  async function api(path, opts) {
    if (RUN_MODE === 'static') {
      return staticApi(path, opts);
    }
    const o = opts || {};
    const init = { method: o.method || 'GET', headers: {} };
    if (o.body !== undefined) {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(o.body);
    }
    const resp = await fetch(path, init);
    const ctype = resp.headers.get('Content-Type') || '';
    if (ctype.indexOf('json') === -1) {
      if (!resp.ok) throw new Error('请求失败（' + resp.status + '）');
      return resp;
    }
    const data = await resp.json();
    if (!resp.ok || data.ok === false) {
      throw new Error(data.error || ('请求失败（' + resp.status + '）'));
    }
    return data.data;
  }

  // 静态模式的 API 路由（映射到 LocalAPI）
  function staticApi(path, opts) {
    const o = opts || {};
    const method = (o.method || 'GET').toUpperCase();
    const L = window.LocalAPI;
    if (!L) throw new Error('本地数据层未加载');

    const u = new URL(path, 'http://x');
    const parts = u.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    const qs = {};
    u.searchParams.forEach((v, k) => { qs[k] = v; });

    const head = parts[0];

    if (head === 'session') {
      return Promise.resolve({
        local: true, readonly: false, lan: false,
        needLogin: false, loggedIn: true, client: 'local', mode: 'static',
      });
    }

    if (head === 'health') {
      const meta = L.getMeta();
      return Promise.resolve({
        version: '2.0.0-static',
        counts: meta.counts,
        dataDir: '浏览器本地存储',
        mode: { local: true, readonly: false, lan: false, mode: 'static' },
      });
    }

    if (head === 'schema') return Promise.resolve(L.getSchema());
    if (head === 'dicts') {
      const sch = L.getSchema();
      return Promise.resolve(sch.dicts || {});
    }
    if (head === 'dashboard') {
      return Promise.resolve(L.dashboard(qs.from || '', qs.to || '', qs.dept || ''));
    }
    if (head === 'backup') {
      const dump = L.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)],
        { type: 'application/json' });
      return Promise.resolve(blob);
    }

    // 集合操作
    const key = head;
    if (!L.getSchema().collections.some(c => c.key === key)) {
      throw new Error('未知集合：' + key);
    }
    const rest = parts.slice(1);

    if (!rest.length) {
      if (method === 'GET') return Promise.resolve(L.list(key, qs));
      if (method === 'POST') return Promise.resolve(L.create(key, o.body || {}));
    }

    const id = rest[0];
    if (rest[1] === 'transition' && method === 'POST') {
      const body = o.body || {};
      return Promise.resolve(L.transition(key, id, body.action || '', body.extra || {}));
    }

    if (method === 'GET') {
      const rec = L.get(key, id);
      if (!rec) throw new Error('记录不存在');
      return Promise.resolve(rec);
    }
    if (method === 'PUT') return Promise.resolve(L.update(key, id, o.body || {}));
    if (method === 'DELETE') {
      const ok = L.remove(key, id);
      if (!ok) throw new Error('记录不存在');
      return Promise.resolve({ deleted: id });
    }
    throw new Error('不支持的操作');
  }

  async function download(path, fallbackName) {
    const resp = await fetch(path);
    if (!resp.ok) {
      let msg = '下载失败（' + resp.status + '）';
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const cd = resp.headers.get('Content-Disposition') || '';
    let name = fallbackName;
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    if (m) name = decodeURIComponent(m[1]);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ============================================================ 字段渲染
  function collOf(key) { return S.collMap[key]; }

  function statusTone(v) { return STATUS_TONE[v] || 'gray'; }

  function riskTone(level) {
    return { '重大风险': 'risk-red', '较大风险': 'risk-orange',
      '一般风险': 'risk-yellow', '低风险': 'risk-blue' }[level] || 'badge gray';
  }

  function renderValue(fd, value, rec) {
    if (fd.type === 'computed') {
      if (fd.key === 'overdue') {
        return value ? el('span', { class: 'badge red', text: '逾期' })
                     : el('span', { class: 'badge gray', text: '正常' });
      }
      if (fd.key === 'checkOverdue') {
        return value ? el('span', { class: 'badge red', text: '已逾期' })
                     : el('span', { class: 'badge gray', text: '—' });
      }
      if (fd.key === 'daysLeft') {
        if (value === null || value === undefined || value === '') return '—';
        const tone = value < 0 ? 'red' : value <= 3 ? 'orange' : 'gray';
        return el('span', { class: 'badge ' + tone, text: value < 0 ? `超${-value}天` : `${value}天` });
      }
      if (fd.key === 'replyState') {
        const tone = value === '已答复' || value === '已办结' ? 'green' : 'orange';
        return el('span', { class: 'badge ' + tone, text: value || '—' });
      }
      if (fd.key === 'riskLevel') {
        return el('span', { class: 'badge ' + riskTone(value), text: value || '—' });
      }
      if (fd.key === 'expiryWarn') {
        const tone = value === '已过期' ? 'red' : value === '30天内到期' ? 'orange'
          : value === '正常' ? 'green' : 'gray';
        return el('span', { class: 'badge ' + tone, text: value || '—' });
      }
      if (fd.key === 'daysLeft') {
        if (value === null || value === undefined || value === '') return '—';
        const tone = value < 0 ? 'red' : value <= 30 ? 'orange' : 'gray';
        return el('span', { class: 'badge ' + tone, text: value + ' 天' });
      }
      if (fd.key === 'state') {
        const tone = value === '已超期' ? 'red' : value === '24小时内到期' ? 'orange'
          : value === '进行中' ? 'blue' : 'gray';
        return el('span', { class: 'badge ' + tone, text: value || '—' });
      }
      if (typeof value === 'boolean') {
        return el('span', { class: 'badge ' + (value ? 'red' : 'gray'), text: value ? '是' : '否' });
      }
      return value === null || value === undefined || value === '' ? '—' : String(value);
    }
    if (fd.key === 'status' || fd.key === 'level1' || fd.key === 'grade'
        || (fd.key === 'level' && rec && rec.level === '重大隐患')) {
      if (!value) return '—';
      return el('span', { class: 'badge ' + statusTone(value), text: value });
    }
    if (fd.type === 'select' && fd.key === 'level') {
      return el('span', { class: 'badge ' + statusTone(value), text: value || '—' });
    }
    if (fd.type === 'number') {
      return value === null || value === undefined || value === '' ? '—' : fmtNum(value);
    }
    if (value === null || value === undefined || value === '') return '—';
    return String(value);
  }

  // ============================================================ 导航
  function buildNav() {
    const nav = $('#nav');
    nav.innerHTML = '';
    nav.appendChild(el('div', { class: 'nav-group-title', text: '概览' }));
    nav.appendChild(navLink('#/dashboard', '▦', '综合看板', null));

    nav.appendChild(el('div', { class: 'nav-group-title', text: '核心业务' }));
    ['hazards', 'risks', 'concerns', 'incidents'].forEach(k => {
      const c = collOf(k);
      nav.appendChild(navLink('#/' + k, c.icon, c.label, k));
    });

    nav.appendChild(el('div', { class: 'nav-group-title', text: '保障管理' }));
    ['equipments', 'trainings', 'certificates', 'fireEquipments', 'fireDrills',
      'permits'].forEach(k => {
      const c = collOf(k);
      nav.appendChild(navLink('#/' + k, c.icon, c.label, k));
    });
  }

  function navLink(href, icon, label, collKey) {
    const a = el('a', { href: href, 'data-coll': collKey || '' }, [
      el('span', { class: 'ico', text: icon }),
      el('span', { class: 'txt', text: label }),
    ]);
    if (collKey) {
      const badge = el('span', { class: 'count', text: S.counts[collKey] || 0 });
      a.appendChild(badge);
    }
    return a;
  }

  function setActiveNav(view) {
    document.querySelectorAll('.nav a').forEach(a => {
      const href = a.getAttribute('href') || '';
      a.classList.toggle('active', href === '#/' + view);
    });
  }

  // ============================================================ 自动刷新
  function scheduleRefresh() {
    if (S.refreshTimer) { clearInterval(S.refreshTimer); S.refreshTimer = null; }
    if (!S.autoRefresh) return;
    S.refreshTimer = setInterval(() => {
      // 只在不编辑、不弹窗、页面可见时刷新，避免打断操作
      if (document.hidden) return;
      if (document.querySelector('.modal')) return;
      if (S.route.view === 'dashboard') {
        renderDashboard(true);
      } else if (S.collMap[S.route.view]) {
        renderList(S.route.view, true);
      }
    }, REFRESH_MS);
  }

  // ============================================================ 路由
  function parseHash() {
    const h = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    return { view: parts[0] || 'dashboard', id: parts[1] || '' };
  }

  async function route() {
    const r = parseHash();
    S.route = r;
    setActiveNav(r.view);
    if (r.view === 'dashboard') {
      $('#pageTitle').textContent = '综合看板';
      $('#pageSub').textContent = '安全指标一览与到期提醒';
      await renderDashboard();
    } else if (S.collMap[r.view]) {
      const c = S.collMap[r.view];
      $('#pageTitle').textContent = c.label;
      $('#pageSub').textContent = c.desc || '';
      S.list = { page: 1, size: 20, q: '', sort: '', dir: 'desc', filters: {} };
      await renderList(r.view);
    } else {
      location.hash = '#/dashboard';
    }
  }

  // ============================================================ 列表页
  async function renderList(key, silent) {
    const coll = collOf(key);
    const content = $('#content');

    // 静默刷新：只重画表格区，保留工具栏焦点与筛选状态
    if (silent) {
      const wrapEl = content.querySelector('.table-wrap');
      const pagerEl = content.querySelector('.pager');
      if (!wrapEl) { return renderList(key, false); }
      try {
        const qs = new URLSearchParams({
          page: S.list.page, size: S.list.size, q: S.list.q,
          sort: S.list.sort, dir: S.list.dir,
        });
        Object.keys(S.list.filters).forEach(k => qs.set(k, S.list.filters[k]));
        const data = await api(`/api/${key}?` + qs.toString());
        paintTable(coll, data, wrapEl);
        if (pagerEl) paintPager(coll, data, pagerEl);
      } catch (e) { /* 静默失败，保持原样 */ }
      return;
    }

    content.innerHTML = '<div class="loading">正在加载…</div>';

    const card = el('div', { class: 'card' });
    const toolbar = el('div', { class: 'toolbar' });
    const wrap = el('div', { class: 'table-wrap' });
    const pager = el('div', { class: 'pager' });
    card.appendChild(toolbar);
    card.appendChild(wrap);
    card.appendChild(pager);
    content.innerHTML = '';

    // ---- 分组页签（如设备管理的三大类）
    if (coll.groups && coll.groups.length && coll.groupField) {
      const tabs = el('div', { class: 'tabs', style: 'background:#fff;border:1px solid var(--line);border-radius:var(--radius) var(--radius) 0 0;margin-bottom:-1px' });
      const mk = (label, value) => {
        const b = el('button', {
          class: S.list.filters[coll.groupField] === value || (!S.list.filters[coll.groupField] && !value) ? 'active' : '',
          text: label,
        });
        b.addEventListener('click', () => {
          if (value) S.list.filters[coll.groupField] = value;
          else delete S.list.filters[coll.groupField];
          S.list.page = 1;
          tabs.querySelectorAll('button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          load();
        });
        return b;
      };
      tabs.appendChild(mk('全部', ''));
      coll.groups.forEach(g => tabs.appendChild(mk(g, g)));
      content.appendChild(tabs);
    }

    content.appendChild(card);

    // ---- 工具栏
    const search = el('input', {
      type: 'search', placeholder: '搜索编号或关键词…', value: S.list.q,
      oninput: debounce(e => { S.list.q = e.target.value; S.list.page = 1; load(); }, 260),
    });
    toolbar.appendChild(search);

    // 状态筛选
    const statusFd = coll.fields.find(f => f.key === (coll.statusField || 'status'));
    if (statusFd && statusFd.options) {
      const sel = el('select', {
        onchange: e => {
          if (e.target.value) S.list.filters[statusFd.key] = e.target.value;
          else delete S.list.filters[statusFd.key];
          S.list.page = 1; load();
        },
      }, [el('option', { value: '', text: '全部状态' })].concat(
        statusFd.options.filter(Boolean).map(o => el('option', { value: o, text: o }))));
      toolbar.appendChild(sel);
    }
    // 部门筛选
    const deptFd = coll.fields.find(f => f.key === 'dept');
    if (deptFd) {
      const sel = el('select', {
        onchange: e => {
          if (e.target.value) S.list.filters.dept = e.target.value;
          else delete S.list.filters.dept;
          S.list.page = 1; load();
        },
      }, [el('option', { value: '', text: '全部部门' })].concat(
        (S.dicts.departments || []).map(d => el('option', { value: d, text: d }))));
      toolbar.appendChild(sel);
    }

    toolbar.appendChild(el('div', { class: 'grow' }));
    if (!S.mode.readonly) {
      toolbar.appendChild(el('button', {
        class: 'btn primary', text: '＋ 新增',
        onclick: () => openForm(key, null),
      }));
      toolbar.appendChild(el('button', {
        class: 'btn', text: '导入 Excel',
        onclick: () => openImport(key),
      }));
    }
    toolbar.appendChild(el('button', {
      class: 'btn', text: '导出 Excel',
      onclick: () => doExport(key),
    }));
    if (!S.mode.readonly) {
      toolbar.appendChild(el('button', {
        class: 'btn', text: '下载模板',
        onclick: () => doTemplate(key),
      }));
    }
    if (S.mode.readonly) {
      toolbar.appendChild(el('span', {
        class: 'badge gray', style: 'margin-left:8px',
        text: '只读模式',
        title: '远程访问为只读，如需修改请在本机操作',
      }));
    }

    async function load() {
      wrap.innerHTML = '<div class="loading">加载中…</div>';
      try {
        // 首次进入时按业务日期倒序（而不是按导入顺序）
        if (!S.list.sort) {
          const dateField = coll.fields.find(fd =>
            fd.type === 'date' && ['foundDate', 'occurDate', 'trainDate',
              'planDate', 'issueDate'].includes(fd.key));
          if (dateField) {
            S.list.sort = dateField.key;
            S.list.dir = 'desc';
          }
        }
        const qs = new URLSearchParams({
          page: S.list.page, size: S.list.size, q: S.list.q,
          sort: S.list.sort, dir: S.list.dir,
        });
        Object.keys(S.list.filters).forEach(k => qs.set(k, S.list.filters[k]));
        const data = await api(`/api/${key}?` + qs.toString());
        paintTable(coll, data, wrap);
        paintPager(coll, data, pager);
      } catch (e) {
        wrap.innerHTML = '';
        wrap.appendChild(el('div', { class: 'empty' }, [e.message]));
      }
    }

    function paintTable(coll, data, wrap) {
      wrap.innerHTML = '';
      const cols = coll.fields.filter(f => f.in_list);
      if (!data.items.length) {
        wrap.appendChild(el('div', { class: 'empty' }, [
          el('span', { class: 'big', text: '◌' }),
          el('div', { text: S.list.q || Object.keys(S.list.filters).length
            ? '没有符合条件的记录' : '还没有数据，点击右上角「新增」开始录入' }),
        ]));
        return;
      }
      const table = el('table', { class: 'grid' });
      const thead = el('thead');
      const tr = el('tr');
      cols.forEach(fd => {
        const arrow = S.list.sort === fd.key
          ? el('span', { class: 'arrow', text: S.list.dir === 'asc' ? '▲' : '▼' })
          : null;
        const th = el('th', {
          style: `min-width:${Math.min(fd.width, 200)}px;max-width:${Math.min(fd.width * 1.6, 300)}px`,
          title: fd.help || '',
          onclick: () => {
            if (S.list.sort === fd.key) {
              S.list.dir = S.list.dir === 'asc' ? 'desc' : 'asc';
            } else { S.list.sort = fd.key; S.list.dir = 'asc'; }
            load();
          },
        }, [fd.label, arrow]);
        tr.appendChild(th);
      });
      tr.appendChild(el('th', { style: 'min-width:130px', text: '操作' }));
      thead.appendChild(tr);
      table.appendChild(thead);

      const tbody = el('tbody');
      data.items.forEach(rec => {
        const row = el('tr');
        cols.forEach(fd => {
          const td = el('td', { class: fd.type === 'number' ? 'num' : '' });
          td.appendChild(document.createTextNode(''));
          const v = renderValue(fd, rec[fd.key], rec);
          td.innerHTML = '';
          if (typeof v === 'string') td.textContent = v;
          else td.appendChild(v);
          // 长文本列限制宽度，超出显示省略号，悬停看全文
          const rawText = String(rec[fd.key] === null || rec[fd.key] === undefined
            ? '' : rec[fd.key]);
          if (rawText.length > 24) {
            td.classList.add('clip');
            td.title = rawText;
          }
          if (fd.key === 'title' || fd.key === 'riskPoint' || fd.key === 'name'
              || fd.key === 'personName' || fd.key === 'eventName') {
            td.style.cursor = 'pointer';
            td.title = (td.title ? td.title + '\n' : '') + '点击查看详情';
            td.addEventListener('click', () => openDetail(key, rec));
          }
          row.appendChild(td);
        });
        const actions = el('td', { class: 'actions' });
        actions.appendChild(el('button', {
          class: 'btn sm', text: '详情', onclick: () => openDetail(key, rec),
        }));
        if (!S.mode.readonly) {
          actions.appendChild(el('button', {
            class: 'btn sm', text: '编辑', onclick: () => openForm(key, rec),
          }));
          if ((coll.transitions || []).length) {
            const avail = coll.transitions.filter(t => t.from.indexOf(rec[coll.statusField]) >= 0);
            if (avail.length) {
              actions.appendChild(el('button', {
                class: 'btn sm', text: '流转 ▾',
                onclick: ev => showTransitionMenu(ev.currentTarget, key, rec, avail),
              }));
            }
          }
          actions.appendChild(el('button', {
            class: 'btn sm danger', text: '删除', onclick: () => confirmDelete(key, rec),
          }));
        }
        row.appendChild(actions);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    function paintPager(coll, data, pager) {
      pager.innerHTML = '';
      const pages = Math.max(1, Math.ceil(data.total / data.size));
      pager.appendChild(el('span', {
        text: `共 ${data.total} 条，第 ${data.page} / ${pages} 页`,
      }));
      pager.appendChild(el('div', { class: 'spacer' }));
      const sizeSel = el('select', {
        onchange: e => { S.list.size = Number(e.target.value); S.list.page = 1; load(); },
      }, [10, 20, 50, 100].map(n => el('option', {
        value: n, text: n + ' 条/页', selected: n === data.size,
      })));
      pager.appendChild(sizeSel);
      pager.appendChild(el('button', {
        class: 'btn sm', text: '上一页', disabled: data.page <= 1,
        onclick: () => { S.list.page = Math.max(1, data.page - 1); load(); },
      }));
      pager.appendChild(el('button', {
        class: 'btn sm', text: '下一页', disabled: data.page >= pages,
        onclick: () => { S.list.page = Math.min(pages, data.page + 1); load(); },
      }));
    }

    await load();
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ============================================================ 表单
  function openForm(key, rec) {
    const coll = collOf(key);
    const isEdit = !!rec;
    const formFields = coll.fields.filter(f => f.form && f.type !== 'id' && f.type !== 'computed');
    const values = {};
    formFields.forEach(fd => {
      values[fd.key] = rec ? (rec[fd.key] === undefined || rec[fd.key] === null ? '' : rec[fd.key])
        : (fd.default !== undefined ? fd.default : '');
    });
    if (!isEdit) {
      formFields.forEach(fd => {
        if (fd.type === 'date' && !values[fd.key] && ['foundDate', 'trainDate', 'planDate', 'issueDate'].indexOf(fd.key) >= 0) {
          values[fd.key] = todayStr();
        }
      });
    }

    const errBox = el('div', { class: 'err', style: 'color:#c0392b;font-size:12.5px;margin-bottom:8px' });
    const grid = el('div', { class: 'form-grid' });
    const inputs = {};
    const fieldNodes = [];

    // 条件字段依赖的其它字段值：取输入框当前值；计算字段按 computedMap 现算
    function currentValue(k) {
      if (inputs[k]) return inputs[k].value;
      const rule = coll.computedMap && coll.computedMap[k];
      if (rule) {
        const src = currentValue(rule.source);
        return (rule.map && rule.map[src]) || rule.default || '';
      }
      return rec ? rec[k] : '';
    }

    function applyVisibility() {
      fieldNodes.forEach(({ fd, node }) => {
        if (!fd.showWhen) return;
        const cur = currentValue(fd.showWhen.key);
        const allowed = fd.showWhen.in || [];
        node.style.display = allowed.indexOf(cur) >= 0 ? '' : 'none';
      });
    }

    formFields.forEach(fd => {
      const isWide = fd.type === 'textarea';
      const field = el('div', { class: 'field' + (isWide ? ' span2' : '') });
      const label = el('label', { for: 'f_' + fd.key }, [
        fd.label, fd.required ? el('span', { class: 'req', text: '*' }) : null,
      ]);
      field.appendChild(label);

      let input;
      if (fd.type === 'textarea') {
        input = el('textarea', { id: 'f_' + fd.key, rows: fd.key === 'description' || fd.key === 'measure' ? 2 : 2 });
        input.value = values[fd.key] || '';
      } else if (fd.type === 'select') {
        input = el('select', { id: 'f_' + fd.key });
        if (!fd.required) input.appendChild(el('option', { value: '', text: '（未选择）' }));
        (fd.options || []).forEach(o => {
          if (o === '') return;
          input.appendChild(el('option', { value: o, text: o, selected: values[fd.key] === o }));
        });
        if (fd.required && !values[fd.key] && (fd.options || []).length) {
          input.value = fd.options.filter(Boolean)[0];
        }
      } else if (fd.type === 'date') {
        input = el('input', { id: 'f_' + fd.key, type: 'date' });
        input.value = values[fd.key] || '';
      } else if (fd.type === 'datetime') {
        input = el('input', { id: 'f_' + fd.key, type: 'datetime-local' });
        input.value = values[fd.key] ? String(values[fd.key]).replace(' ', 'T') : '';
      } else if (fd.type === 'number') {
        input = el('input', { id: 'f_' + fd.key, type: 'number', step: 'any' });
        input.value = values[fd.key] === '' || values[fd.key] === null ? '' : values[fd.key];
      } else if (fd.type === 'bool') {
        input = el('input', { id: 'f_' + fd.key, type: 'checkbox' });
        input.checked = !!values[fd.key];
      } else {
        input = el('input', { id: 'f_' + fd.key, type: 'text' });
        input.value = values[fd.key] || '';
      }
      inputs[fd.key] = input;
      field.appendChild(input);
      if (fd.help) field.appendChild(el('div', { class: 'help', text: fd.help }));
      grid.appendChild(field);
      fieldNodes.push({ fd, node: field });

      // 条件字段：依赖字段变化时重新计算可见性
      if (fd.showWhen && inputs[fd.showWhen.key] === undefined) {
        input.addEventListener('change', applyVisibility);
      }
    });

    // 任何输入变化都重算一次可见性（开销很小）
    grid.addEventListener('change', applyVisibility);
    grid.addEventListener('input', applyVisibility);
    applyVisibility();

    const body = el('div', { class: 'modal-body' }, [errBox, grid]);
    const saveBtn = el('button', {
      class: 'btn primary', text: '保存',
      onclick: async () => {
        errBox.textContent = '';
        saveBtn.disabled = true;
        const payload = {};
        formFields.forEach(fd => {
          const node = inputs[fd.key];
          let v;
          if (fd.type === 'bool') v = node.checked;
          else if (fd.type === 'number') v = node.value === '' ? null : Number(node.value);
          else if (fd.type === 'datetime') v = node.value ? node.value.replace('T', ' ') : '';
          else v = node.value;
          payload[fd.key] = v;
        });
        try {
          if (isEdit) {
            await api(`/api/${key}/${encodeURIComponent(rec.id)}`,
              { method: 'PUT', body: payload });
            toast('已保存', 'ok');
          } else {
            const created = await api(`/api/${key}`, { method: 'POST', body: payload });
            toast('已新增：' + created.id, 'ok');
            // 回到第 1 页并清空搜索，让新记录可见
            S.list.page = 1;
            S.list.q = '';
            const searchBox = document.querySelector('.toolbar input[type=search]');
            if (searchBox) searchBox.value = '';
          }
          closeModal();
          refresh();
        } catch (e) {
          errBox.textContent = e.message;
          saveBtn.disabled = false;
        }
      },
    });

    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: (isEdit ? '编辑' : '新增') + coll.label + (isEdit ? '　' + rec.id : '') }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      body,
      el('div', { class: 'modal-foot' }, [
        el('span', { class: 'hint', text: '带 * 的为必填项' }),
        el('button', { class: 'btn', text: '取消', onclick: closeModal }),
        saveBtn,
      ]),
    ]);
    showModal(modal);
    setTimeout(() => {
      const first = formFields.find(f => f.required && inputs[f.key] && inputs[f.key].tagName !== 'SELECT');
      if (first) inputs[first.key].focus();
    }, 60);
  }

  // ============================================================ 详情
  function openDetail(key, rec) {
    const coll = collOf(key);
    const dl = el('dl', { class: 'dl' });
    coll.fields.forEach(fd => {
      if (fd.type === 'computed' && fd.key === 'overdue') return;
      const v = renderValue(fd, rec[fd.key], rec);
      const dd = el('dd');
      if (typeof v === 'string') dd.textContent = v;
      else dd.appendChild(v);
      dl.appendChild(el('dt', { text: fd.label }));
      dl.appendChild(dd);
    });

    const body = el('div', { class: 'modal-body' }, [dl]);
    const foot = el('div', { class: 'modal-foot' });
    if (!S.mode.readonly) {
      (coll.transitions || []).forEach(t => {
        if (t.from.indexOf(rec[coll.statusField]) < 0) return;
        foot.appendChild(el('button', {
          class: 'btn', text: t.action,
          onclick: () => { closeModal(); doTransition(key, rec, t); },
        }));
      });
    }
    foot.appendChild(el('div', { class: 'spacer', style: 'flex:1' }));
    if (!S.mode.readonly) {
      foot.appendChild(el('button', {
        class: 'btn', text: '编辑',
        onclick: () => { closeModal(); openForm(key, rec); },
      }));
    }
    foot.appendChild(el('button', { class: 'btn primary', text: '关闭', onclick: closeModal }));

    showModal(el('div', { class: 'modal' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: coll.label + '　' + rec.id }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      body, foot,
    ]));
  }

  // ============================================================ 状态流转
  function showTransitionMenu(anchor, key, rec, avail) {
    document.querySelectorAll('.popmenu').forEach(n => n.remove());
    const rect = anchor.getBoundingClientRect();
    const menu = el('div', {
      class: 'popmenu',
      style: `position:fixed;left:${Math.min(rect.left, window.innerWidth - 200)}px;` +
        `top:${rect.bottom + 4}px;background:#fff;border:1px solid #e2e8ee;` +
        'border-radius:8px;box-shadow:0 8px 26px rgba(16,34,48,.18);padding:5px;z-index:300;min-width:150px',
    });
    avail.forEach(t => {
      menu.appendChild(el('div', {
        text: t.action,
        style: 'padding:7px 11px;border-radius:5px;cursor:pointer;font-size:13px',
        onmouseenter: e => e.currentTarget.style.background = '#f0f6f8',
        onmouseleave: e => e.currentTarget.style.background = '',
        onclick: () => { menu.remove(); doTransition(key, rec, t); },
      }));
    });
    document.body.appendChild(menu);
    setTimeout(() => {
      document.addEventListener('click', function close(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
      });
    }, 0);
  }

  async function doTransition(key, rec, rule) {
    const coll = collOf(key);
    const missing = (rule.requires || []).filter(k => !rec[k]);
    if (missing.length) {
      const fd = coll.fields.find(f => f.key === missing[0]);
      const fd2 = fd || { key: missing[0], label: missing[0], type: 'text' };
      openTransitionExtra(key, rec, rule, missing.map(mk => coll.fields.find(f => f.key === mk) || { key: mk, label: mk, type: 'text' }));
      return;
    }
    if (!confirm(`确定要执行「${rule.action}」吗？\n${rec.id} 将变为「${rule.to}」`)) return;
    await runTransition(key, rec, rule, {});
  }

  function openTransitionExtra(key, rec, rule, fields) {
    const inputs = {};
    const grid = el('div', { class: 'form-grid' });
    fields.forEach(fd => {
      const f = el('div', { class: 'field' + (fd.type === 'textarea' ? ' span2' : '') });
      f.appendChild(el('label', {}, [fd.label, el('span', { class: 'req', text: '*' })]));
      let input;
      if (fd.type === 'date') {
        input = el('input', { type: 'date' });
        input.value = todayStr();
      } else if (fd.type === 'datetime') {
        input = el('input', { type: 'datetime-local' });
      } else if (fd.type === 'textarea') {
        input = el('textarea', { rows: 3 });
      } else if (fd.type === 'select') {
        input = el('select');
        (fd.options || []).filter(Boolean).forEach(o =>
          input.appendChild(el('option', { value: o, text: o })));
      } else {
        input = el('input', { type: 'text' });
      }
      inputs[fd.key] = input;
      f.appendChild(input);
      if (fd.help) f.appendChild(el('div', { class: 'help', text: fd.help }));
      grid.appendChild(f);
    });
    const errBox = el('div', { style: 'color:#c0392b;font-size:12.5px;margin-bottom:8px' });
    showModal(el('div', { class: 'modal', style: 'width:min(560px,100%)' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: rule.action + '　' + rec.id }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      el('div', { class: 'modal-body' }, [errBox, grid]),
      el('div', { class: 'modal-foot' }, [
        el('span', { class: 'hint', text: `将变更为「${rule.to}」` }),
        el('button', { class: 'btn', text: '取消', onclick: closeModal }),
        el('button', {
          class: 'btn primary', text: '确定',
          onclick: async () => {
            const extra = {};
            fields.forEach(fd => {
              const node = inputs[fd.key];
              extra[fd.key] = fd.type === 'datetime'
                ? (node.value ? node.value.replace('T', ' ') : '') : node.value;
            });
            errBox.textContent = '';
            try {
              await runTransition(key, rec, rule, extra);
              closeModal();
            } catch (e) { errBox.textContent = e.message; }
          },
        }),
      ]),
    ]));
  }

  async function runTransition(key, rec, rule, extra) {
    try {
      await api(`/api/${key}/${encodeURIComponent(rec.id)}/transition`,
        { method: 'POST', body: { action: rule.action, extra: extra || {} } });
      toast(`已${rule.action} → ${rule.to}`, 'ok');
      closeModal();
      refresh();
    } catch (e) {
      toast(e.message, 'err');
      throw e;
    }
  }

  // ============================================================ 删除
  async function confirmDelete(key, rec) {
    const coll = collOf(key);
    if (!confirm(`确定删除「${rec.id}」吗？\n${rec.title || rec.riskPoint || rec.name || rec.personName || ''}\n\n删除后不可恢复（可在 data/backup 中找到历史备份）。`)) return;
    try {
      await api(`/api/${key}/${encodeURIComponent(rec.id)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ============================================================ 导入导出
  async function doExport(key) {
    const coll = collOf(key);
    try {
      if (RUN_MODE === 'static') {
        // 纯前端：取当前筛选的全部记录，本地生成 xlsx
        const qs = { q: S.list.q, sort: S.list.sort, dir: S.list.dir, size: 100000, page: 1 };
        Object.keys(S.list.filters).forEach(k => { qs[k] = S.list.filters[k]; });
        const res = await api(`/api/${key}?` + new URLSearchParams(qs).toString());
        Biz.exportCollection(key, res.items, coll);
        toast(`已导出 ${res.items.length} 条`, 'ok');
        return;
      }
      const qs = new URLSearchParams({ q: S.list.q, sort: S.list.sort, dir: S.list.dir });
      Object.keys(S.list.filters).forEach(k => qs.set(k, S.list.filters[k]));
      await download(`/api/${key}/export.xlsx?` + qs.toString(),
        coll.label + '_' + todayStr().replace(/-/g, '') + '.xlsx');
      toast('已导出', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // 下载模板（两种模式统一入口）
  async function doTemplate(key) {
    const coll = collOf(key);
    try {
      if (RUN_MODE === 'static') {
        Biz.exportTemplate(key, coll);
        toast('模板已下载', 'ok');
        return;
      }
      await download(`/api/${key}/template.xlsx`, coll.label + '_导入模板.xlsx');
    } catch (e) { toast(e.message, 'err'); }
  }

  function openImport(key) {
    const coll = collOf(key);
    const fileInput = el('input', { type: 'file', accept: '.xlsx' });
    const resultBox = el('div', { style: 'margin-top:12px;font-size:13px' });
    const btn = el('button', {
      class: 'btn primary', text: '开始导入',
      onclick: async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) { toast('请先选择文件', 'err'); return; }
        btn.disabled = true;
        resultBox.innerHTML = '正在导入…';
        try {
          let r;
          if (RUN_MODE === 'static') {
            // 纯前端：本地解析 xlsx
            r = await Biz.importCollection(file, key, coll, window.LocalAPI);
          } else {
            const buf = await file.arrayBuffer();
            const resp = await fetch(`/api/${key}/import`, {
              method: 'POST', body: buf,
              headers: { 'X-Filename': encodeURIComponent(file.name) },
            });
            const data = await resp.json();
            if (!resp.ok || data.ok === false) throw new Error(data.error || '导入失败');
            r = data.data;
          }
          resultBox.innerHTML = '';
          resultBox.appendChild(el('div', {
            style: 'color:#1e8449;font-weight:600',
            text: `导入完成：新增 ${r.inserted} 条，更新 ${r.updated} 条，跳过 ${r.skipped} 条`,
          }));
          if (r.errors && r.errors.length) {
            const ul = el('ul', { style: 'color:#c0392b;margin:8px 0 0;padding-left:18px;max-height:200px;overflow:auto' });
            r.errors.forEach(e => ul.appendChild(el('li', { text: e })));
            resultBox.appendChild(ul);
          }
          refresh();
        } catch (e) {
          resultBox.innerHTML = '';
          resultBox.appendChild(el('div', { style: 'color:#c0392b', text: e.message }));
        } finally { btn.disabled = false; }
      },
    });

    showModal(el('div', { class: 'modal', style: 'width:min(600px,100%)' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: '导入 ' + coll.label }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      el('div', { class: 'modal-body' }, [
        el('div', {
          style: 'background:#f6f9fb;border:1px solid #e2e8ee;border-radius:7px;padding:11px 13px;font-size:13px;margin-bottom:14px',
          html: '<b>导入说明</b><br>1. 请使用「下载模板」得到的表头，不要修改表头文字；<br>' +
            '2. 编号列留空表示新增，填写已有编号表示更新该条；<br>' +
            '3. 只支持 .xlsx 文件。',
        }),
        fileInput,
        resultBox,
      ]),
      el('div', { class: 'modal-foot' }, [
        el('button', {
          class: 'btn', text: '下载模板',
          onclick: () => doTemplate(key),
        }),
        el('div', { style: 'flex:1' }),
        el('button', { class: 'btn', text: '关闭', onclick: closeModal }),
        btn,
      ]),
    ]));
  }

  // ============================================================ 看板
  async function renderDashboard(silent) {
    const content = $('#content');
    if (!silent) content.innerHTML = '<div class="loading">正在加载看板…</div>';
    let d;
    try {
      d = await api('/api/dashboard' + (S.dashQuery || ''));
    } catch (e) {
      if (silent) return;   // 静默刷新失败保持原样，不打断查看
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'empty', text: e.message }));
      return;
    }

    content.innerHTML = '';
    // 过滤条
    const bar = el('div', { class: 'card' }, [
      el('div', { class: 'card-body', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:11px 14px' }, [
        el('span', { text: '统计范围：', style: 'font-size:13px;color:#5a6b7b' }),
        dateInput('dashFrom', d.range.from, '开始'),
        el('span', { text: '至' }),
        dateInput('dashTo', d.range.to, '结束'),
        deptSelect(d.range.dept),
        el('button', {
          class: 'btn primary sm', text: '查询',
          onclick: () => {
            const from = $('#dashFrom').value, to = $('#dashTo').value;
            const dept = $('#dashDept').value;
            const qs = new URLSearchParams();
            if (from) qs.set('from', from);
            if (to) qs.set('to', to);
            if (dept) qs.set('dept', dept);
            S.dashQuery = qs.toString() ? '?' + qs.toString() : '';
            renderDashboard();
          },
        }),
        el('button', {
          class: 'btn sm', text: '重置',
          onclick: () => { S.dashQuery = ''; renderDashboard(); },
        }),
        el('div', { style: 'flex:1' }),
        el('span', {
          id: 'dashUpdated',
          style: 'font-size:12px;color:#8a99a8',
          text: '更新于 ' + d.generatedAt,
        }),
        el('button', {
          class: 'btn sm', text: '刷新', title: '立即刷新数据',
          onclick: () => renderDashboard(),
        }),
        el('button', {
          class: 'btn sm', text: '导出 HTML 报表',
          title: '生成包含全部图表的完整报表，可离线查看或打印为 PDF',
          onclick: async () => {
            try {
              if (RUN_MODE === 'static') {
                // 纯前端：本地生成报表
                const qs = S.dashQuery || '';
                const params = new URLSearchParams(qs.replace(/^\?/, ''));
                const d = await api('/api/dashboard?' + params.toString());
                const html = Biz.buildReport(d, S.schema, k => window.LocalAPI.all(k));
                Biz.downloadReport(html,
                  '安全管理数据报表_' + todayStr().replace(/-/g, '') + '.html');
                toast('报表已下载，双击即可打开', 'ok');
                return;
              }
              const qs = S.dashQuery || '';
              await download('/api/report.html' + qs,
                '安全管理数据报表_' + todayStr().replace(/-/g, '') + '.html');
              toast('报表已下载，双击即可打开', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
        el('label', {
          style: 'font-size:12px;color:#5a6b7b;display:flex;align-items:center;gap:4px;cursor:pointer',
          title: '每 30 秒自动刷新一次',
        }, [
          (() => {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = S.autoRefresh;
            cb.addEventListener('change', () => {
              S.autoRefresh = cb.checked;
              scheduleRefresh();
              toast(cb.checked ? '已开启自动刷新（每 30 秒）' : '已关闭自动刷新');
            });
            return cb;
          })(),
          document.createTextNode('自动刷新'),
        ]),
      ]),
    ]);
    content.appendChild(bar);

    const k = d.kpi;
    // KPI
    const grid = el('div', { class: 'kpi-grid' });
    const kpis = [
      { label: '隐患总数', value: k.hazardTotal, foot: `重大隐患 ${k.hazardMajor} 项`, tone: '' },
      { label: '隐患整改率', value: k.hazardCloseRate === null ? '—' : k.hazardCloseRate, unit: '%', foot: `已关闭 ${k.hazardClosed} / ${k.hazardTotal}`, tone: 'ok' },
      { label: '按期整改率', value: k.hazardOnTimeRate === null ? '—' : k.hazardOnTimeRate, unit: '%', foot: '按整改期限计算', tone: '' },
      { label: '逾期未整改', value: k.hazardOverdue, foot: '需重点关注', tone: k.hazardOverdue > 0 ? 'danger' : 'ok' },
      { label: '安全疑虑', value: k.concernTotal, foot: `待处理 ${k.concernOpen} · 已转隐患 ${k.concernConverted}`, tone: k.concernOverdue > 0 ? 'danger' : '' },
      { label: '疑虑超期未答复', value: k.concernOverdue, foot: `待答复 ${k.concernUnreplied} 条`, tone: k.concernOverdue > 0 ? 'danger' : 'ok' },
      { label: '风险点总数', value: k.riskTotal, foot: `重大风险 ${k.riskMajor} 项`, tone: k.riskMajor > 0 ? 'danger' : '' },
      { label: '事故/事件', value: k.incidentTotal, foot: `未遂 ${k.incidentAttempt} · 一般事件 ${k.incidentGeneral}`, tone: k.incidentTotal > 0 ? 'warn' : 'ok' },
      { label: '急救箱事件', value: k.incidentFirstAid, foot: `医疗处置 ${k.incidentMedicalCase} 起`, tone: '' },
      { label: '受伤人数', value: k.incidentPersons, foot: `损失工日 ${k.incidentLossDays}`, tone: k.incidentPersons > 0 ? 'warn' : 'ok' },
      { label: '医疗费用', value: fmtMoney(k.incidentMedical).value, unit: fmtMoney(k.incidentMedical).unit, foot: '急救箱+医疗处置合计', tone: '' },
      { label: '培训场次', value: k.trainingTotal, foot: `参训 ${k.trainingPeople} 人次`, tone: '' },
      { label: '培训完成率', value: k.trainingRate === null ? '—' : k.trainingRate, unit: '%', foot: `已完成 ${k.trainingDone} 场`, tone: 'ok' },
      { label: '证照到期预警', value: k.certWarn, foot: `已过期 ${k.certExpired} 张`, tone: k.certWarn > 0 ? 'danger' : 'ok' },
      { label: '消防点检逾期', value: k.fireOverdue, foot: `设施共 ${k.fireTotal} 项`, tone: k.fireOverdue > 0 ? 'warn' : 'ok' },
      { label: '应急演练', value: k.drillTotal, foot: '统计期内计划/实施', tone: '' },
      { label: '设备总数', value: k.equipmentTotal, foot: `特种设备 ${k.equipmentSpecial} 台 · 在用 ${k.equipmentActive}`, tone: '' },
      { label: '设备检验到期', value: k.equipmentExpiring, foot: `已过期 ${k.equipmentExpired} 台`, tone: k.equipmentExpiring > 0 ? 'danger' : 'ok' },
      { label: '进行中作业票', value: k.permitRunning, foot: `临期/超期 ${k.permitExpiring} 张`, tone: k.permitExpiring > 0 ? 'warn' : '' },
    ];
    kpis.forEach(item => {
      grid.appendChild(el('div', { class: 'kpi ' + (item.tone || '') }, [
        el('div', { class: 'label', text: item.label }),
        el('div', { class: 'value' }, [
          String(item.value),
          item.unit ? el('small', { text: item.unit }) : null,
        ]),
        el('div', { class: 'foot', text: item.foot || '' }),
      ]));
    });
    content.appendChild(grid);

    // 图表
    const charts = el('div', { class: 'chart-grid' });
    charts.appendChild(chartCard('隐患月度趋势', 'lineTrend', 236));
    charts.appendChild(chartCard('风险四色分布', 'riskBar', 236));
    charts.appendChild(chartCard('隐患类别分布', 'catHbar', 236));
    charts.appendChild(chartCard('事故类型分布', 'incPie', 236));
    charts.appendChild(chartCard('事件等级分布', 'incLevelBar', 236));
    charts.appendChild(chartCard('设备分类分布', 'eqBar', 236));
    charts.appendChild(chartCard('安全疑虑类别分布', 'concernHbar', 236));
    content.appendChild(charts);

    // 提醒
    const alertGrid = el('div', { class: 'chart-grid' });
    alertGrid.appendChild(alertCard('逾期未整改隐患', d.alerts.hazardOverdue, 'hazards',
      a => `${a.title}`, a => `${a.dept || ''} · 期限 ${a.deadline || '—'}`));
    alertGrid.appendChild(alertCard('待处理安全疑虑', d.alerts.concernPending, 'concerns',
      a => `${a.title}`, a => `${a.dept || ''} · ${a.status} · 限 ${a.deadline || '—'}`));
    alertGrid.appendChild(alertCard('证照到期提醒', d.alerts.certExpiring, 'certificates',
      a => `${a.personName} ${a.certType}`, a => `${a.expireDate} · ${a.daysLeft < 0 ? '已过期' + (-a.daysLeft) + '天' : '剩' + a.daysLeft + '天'}`));
    alertGrid.appendChild(alertCard('消防点检逾期', d.alerts.fireOverdue, 'fireEquipments',
      a => `${a.name}`, a => `${a.location || ''} · 应检 ${a.nextCheckDate || '—'}`));
    alertGrid.appendChild(alertCard('作业票临期/超期', d.alerts.permitExpiring, 'permits',
      a => `${a.type} ${a.contractor || ''}`, a => `${a.endTime || ''} · ${a.state}`));
    alertGrid.appendChild(alertCard('设备检验到期', d.alerts.equipmentExpiring, 'equipments',
      a => `${a.name}（${a.type}）`, a => `${a.location || ''} · ${a.inspectExpire || '—'} · ${a.expiryWarn}`));
    content.appendChild(alertGrid);

    // 绘制
    setTimeout(() => {
      const trend = d.trend;
      Charts.line(document.getElementById('lineTrend'), {
        labels: trend.months,
        series: [
          { name: '发现隐患', data: trend.hazardFound, color: '#2d7d92' },
          { name: '关闭隐患', data: trend.hazardClosed, color: '#1e8449' },
          { name: '事故/事件', data: trend.incidents, color: '#c0392b' },
        ],
      });
      Charts.bar(document.getElementById('riskBar'), {
        items: d.riskByLevel.map(i => ({
          name: i.name, value: i.value, color: Charts.RISK_COLORS[i.name],
        })),
      });
      Charts.hbar(document.getElementById('catHbar'), { items: d.hazardByCategory });
      Charts.pie(document.getElementById('incPie'), { items: d.incidentByType });
      Charts.bar(document.getElementById('incLevelBar'), {
        items: (d.incidentByLevel1 || []).map(i => ({
          name: i.name, value: i.value,
          color: { '急救箱事件': '#2d7d92', '医疗处置事件': '#d68910',
                   '未遂事件': '#7f8c8d', '一般事件': '#e67e22',
                   '一般事故': '#c0392b' }[i.name] || '#95a5a6',
        })),
      });
      Charts.bar(document.getElementById('eqBar'), {
        items: (d.equipmentByCategory || []).map(i => ({
          name: i.name, value: i.value,
          color: { '特种设备类': '#c0392b', '表阀类': '#d68910', '其他类': '#2d7d92' }[i.name] || '#95a5a6',
        })),
      });
      Charts.hbar(document.getElementById('concernHbar'),
        { items: d.concernByCategory || [] });
    }, 30);

    function dateInput(id, val, ph) {
      const i = el('input', { id: id, type: 'date', value: val || '', placeholder: ph });
      i.style.cssText = 'border:1px solid #e2e8ee;border-radius:6px;padding:5px 8px;background:#fff';
      return i;
    }
    function deptSelect(val) {
      const s = el('select', { id: 'dashDept' });
      s.style.cssText = 'border:1px solid #e2e8ee;border-radius:6px;padding:5px 8px;background:#fff';
      s.appendChild(el('option', { value: '', text: '全部部门' }));
      (S.dicts.departments || []).forEach(dep =>
        s.appendChild(el('option', { value: dep, text: dep, selected: dep === val })));
      return s;
    }
  }

  function fmtMoney(v) {
    const n = Number(v || 0);
    if (n >= 10000) return { value: (n / 10000).toFixed(2), unit: '万元' };
    return { value: String(Math.round(n)), unit: '元' };
  }

  function chartCard(title, canvasId, height) {
    return el('div', { class: 'card', style: 'margin-bottom:0' }, [
      el('div', { class: 'card-head' }, [el('h3', { text: title })]),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'chart-box', style: `height:${height}px` }, [
          el('canvas', { id: canvasId }),
        ]),
      ]),
    ]);
  }

  function alertCard(title, items, collKey, mainFn, metaFn) {
    const body = el('div', { class: 'card-body flush' });
    if (!items || !items.length) {
      body.appendChild(el('div', { class: 'empty', style: 'padding:28px', text: '暂无需要处理的事项' }));
    } else {
      const ul = el('ul', { class: 'alert-list', style: 'padding:6px 15px' });
      items.forEach(a => {
        const li = el('li', {
          style: 'cursor:pointer',
          onclick: () => {
            location.hash = '#/' + collKey;
            setTimeout(() => {
              const inp = document.querySelector('.toolbar input[type=search]');
              if (inp && a.id) {
                S.list.q = a.id;
                inp.value = a.id;
                inp.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }, 260);
          },
        }, [
          el('span', { class: 't', text: mainFn(a) }),
          el('span', { class: 'm', text: metaFn(a) }),
        ]);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    return el('div', { class: 'card', style: 'margin-bottom:0' }, [
      el('div', { class: 'card-head' }, [
        el('h3', { text: title }),
        el('div', { style: 'flex:1' }),
        el('span', { style: 'font-size:12px;color:#8a99a8', text: (items || []).length + ' 项' }),
      ]),
      body,
    ]);
  }

  // ============================================================ 弹窗基础
  function showModal(node) {
    const root = $('#modalRoot');
    root.innerHTML = '';
    const mask = el('div', { class: 'modal-mask', onclick: e => { if (e.target === mask) closeModal(); } });
    mask.appendChild(node);
    root.appendChild(mask);
    document.addEventListener('keydown', escHandler);
  }

  function escHandler(e) { if (e.key === 'Escape') closeModal(); }

  function closeModal() {
    $('#modalRoot').innerHTML = '';
    document.removeEventListener('keydown', escHandler);
    document.querySelectorAll('.popmenu').forEach(n => n.remove());
  }

  // ============================================================ 刷新
  async function refresh() {
    await loadCounts();
    if (S.route.view === 'dashboard') await renderDashboard();
    else if (S.collMap[S.route.view]) await renderList(S.route.view);
  }

  async function loadCounts() {
    try {
      const h = await api('/api/health');
      S.counts = h.counts || {};
      document.querySelectorAll('.nav a[data-coll]').forEach(a => {
        const k = a.getAttribute('data-coll');
        const badge = a.querySelector('.count');
        if (badge) badge.textContent = S.counts[k] || 0;
      });
      const total = Object.values(S.counts).reduce((a, b) => a + b, 0);
      $('#footStat').textContent = `共 ${total} 条记录`;
      $('#healthText').textContent = 'v' + h.version;
      // 记住数据目录，供「数据位置」按钮使用
      if (h.dataDir) S.dataDir = h.dataDir;
    } catch (e) { /* 忽略 */ }
  }

  // ============================================================ 启动
  async function boot() {
    checkZoom();

    // 检测运行环境：有 Python 后端就用后端，否则用纯前端模式
    await detectMode();

    // 先取访问模式，决定是否显示只读提示、是否需要登录
    try {
      S.mode = await api('/api/session');
    } catch (e) { /* 老版本服务端无此接口时按本机可编辑处理 */ }

    if (S.mode.needLogin && !S.mode.loggedIn) {
      showLogin();
      return;
    }

    try {
      const sch = await api('/api/schema');
      S.schema = sch;
      S.dicts = sch.dicts || {};
      sch.collections.forEach(c => { S.collMap[c.key] = c; });
    } catch (e) {
      $('#content').innerHTML = '';
      $('#content').appendChild(el('div', {
        class: 'empty',
        text: RUN_MODE === 'static'
          ? '无法加载数据：' + e.message
          : '无法连接本地服务：' + e.message + '　请确认「启动工作台.bat」窗口仍在运行。',
      }));
      return;
    }
    buildNav();
    await loadCounts();
    applyModeUI();
    applyStaticUI();

    $('#btnBackup').addEventListener('click', async () => {
      try {
        if (RUN_MODE === 'static') {
          // 纯前端：导出 JSON
          const dump = window.LocalAPI.exportAll();
          const blob = new Blob([JSON.stringify(dump, null, 2)],
            { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `EHS数据备份_${todayStr()}.json` });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          toast('已导出数据备份', 'ok');
          return;
        }
        await download('/api/backup', 'safety-data-' + todayStr() + '.zip');
        toast('已打包下载全部数据', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // 「数据位置」按钮：静态模式下改为数据管理
    const btnInfo = $('#btnDataInfo');
    if (btnInfo) {
      if (RUN_MODE === 'static') {
        btnInfo.textContent = '数据管理';
        btnInfo.addEventListener('click', showStaticDataPanel);
      } else {
        btnInfo.addEventListener('click', showDataInfo);
      }
    }

    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/dashboard';
    await route();
    scheduleRefresh();
    window.addEventListener('resize', debounce(() => {
      if (S.route.view === 'dashboard') renderDashboard();
    }, 260));
  }

  // 检测运行环境：尝试连后端，失败则用纯前端模式
  async function detectMode() {
    // 优先用 bundle 是否存在来判断（GitHub Pages 上只有静态文件）
    const hasBundle = !!window.__EHS_BUNDLE__;
    const hasLocalAPI = !!window.LocalAPI;

    if (hasBundle && hasLocalAPI) {
      // 有 bundle 时再确认后端是否真的在跑（本地开发时两者都有）
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1200);
        const resp = await fetch('/api/health', { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const j = await resp.json();
          if (j && j.ok) {
            RUN_MODE = 'server';
            return;
          }
        }
      } catch (e) {
        // 后端不可用
      }
      RUN_MODE = 'static';
      window.LocalAPI.init();
      return;
    }

    if (hasLocalAPI) {
      RUN_MODE = 'static';
      window.LocalAPI.init();
      return;
    }
    RUN_MODE = 'server';
  }

  // 静态模式下的界面调整
  function applyStaticUI() {
    if (RUN_MODE !== 'static') return;

    // 顶栏右上角加一个固定的「本地存储」徽标（不会被路由覆盖）
    const topbar = document.querySelector('.topbar');
    if (topbar && !document.getElementById('staticBadge')) {
      const badge = el('span', {
        id: 'staticBadge',
        class: 'badge gray',
        style: 'margin-right:8px;font-size:11.5px',
        title: '数据保存在当前浏览器，不会上传到服务器',
        text: '数据存于本浏览器',
      });
      const spacer = topbar.querySelector('.spacer');
      if (spacer && spacer.nextSibling) {
        topbar.insertBefore(badge, spacer.nextSibling);
      } else {
        topbar.appendChild(badge);
      }
    }

    // 隐藏「备份全部数据」（静态模式下用「数据管理」里的导出）
    const btnBackup = $('#btnBackup');
    if (btnBackup) btnBackup.style.display = 'none';
  }

  // 静态模式的数据管理面板
  function showStaticDataPanel() {
    const L = window.LocalAPI;
    const meta = L.getMeta();
    const total = meta.total;
    const bundleTotal = (meta.bundleMeta && meta.bundleMeta.total) || 0;

    const body = el('div', { class: 'modal-body' });
    body.innerHTML = `
      <div style="background:#f6f9fb;border:1px solid #e2e8ee;border-radius:8px;
                  padding:12px 14px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">当前数据</div>
        <div style="font-size:12.5px;color:#5a6b7b;line-height:1.9">
          浏览器本地存储：<b style="color:#1a2733">${total}</b> 条记录<br>
          初始数据包：<b>${bundleTotal}</b> 条（${esc((meta.bundleMeta && meta.bundleMeta.generatedAt) || '未知')}）<br>
          存储位置：<code>localStorage</code>（本浏览器，换设备不同步）
        </div>
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:10px">数据操作</div>
      <div style="display:flex;flex-direction:column;gap:9px">
        <button class="btn" id="btnExportJson" style="text-align:left;padding:11px 14px">
          <b>导出全部数据（JSON）</b><br>
          <span style="font-size:12px;color:#8a99a8">备份当前数据，可导入到其他浏览器</span>
        </button>
        <button class="btn" id="btnImportJson" style="text-align:left;padding:11px 14px">
          <b>导入数据（JSON）</b><br>
          <span style="font-size:12px;color:#8a99a8">用备份文件覆盖当前数据</span>
        </button>
        <button class="btn" id="btnResetBundle" style="text-align:left;padding:11px 14px">
          <b>恢复初始数据</b><br>
          <span style="font-size:12px;color:#8a99a8">丢弃所有修改，回到 ${bundleTotal} 条初始数据</span>
        </button>
        <button class="btn danger" id="btnClearAll" style="text-align:left;padding:11px 14px">
          <b>清空所有数据</b><br>
          <span style="font-size:12px;color:#8a99a8">删除全部记录，谨慎操作</span>
        </button>
      </div>

      <div style="margin-top:16px;background:#fdf8e1;border:1px solid #f7dc6f;
                  border-radius:7px;padding:10px 13px;font-size:12.5px;color:#7d6608">
        <b>说明</b>：网页版数据存在你自己的浏览器里。清除浏览器数据会丢失记录，
        建议定期用「导出全部数据」备份。
      </div>
    `;

    showModal(el('div', { class: 'modal', style: 'width:min(560px,100%)' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: '数据管理' }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      body,
      el('div', { class: 'modal-foot' }, [
        el('span', { class: 'hint', text: '数据仅保存在本浏览器' }),
        el('button', { class: 'btn primary', text: '关闭', onclick: closeModal }),
      ]),
    ]));

    // 导出 JSON
    const be = document.getElementById('btnExportJson');
    if (be) be.addEventListener('click', () => {
      const dump = L.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `EHS数据备份_${todayStr()}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出数据文件', 'ok');
    });

    // 导入 JSON
    const bi = document.getElementById('btnImportJson');
    if (bi) bi.addEventListener('click', () => {
      const input = el('input', { type: 'file', accept: '.json' });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const obj = JSON.parse(text);
          if (!confirm('导入将覆盖当前全部数据，确定继续？')) return;
          const n = L.importAll(obj);
          toast(`已导入 ${n} 条记录`, 'ok');
          closeModal();
          refresh();
        } catch (e) {
          toast('导入失败：' + e.message, 'err');
        }
      });
      input.click();
    });

    // 恢复初始数据
    const br = document.getElementById('btnResetBundle');
    if (br) br.addEventListener('click', () => {
      if (!confirm(`将丢弃所有修改，恢复到 ${bundleTotal} 条初始数据。\n确定继续？`)) return;
      try {
        const n = L.resetToBundle();
        toast(`已恢复 ${n} 条初始数据`, 'ok');
        closeModal();
        refresh();
      } catch (e) {
        toast('恢复失败：' + e.message, 'err');
      }
    });

    // 清空
    const bc = document.getElementById('btnClearAll');
    if (bc) bc.addEventListener('click', () => {
      if (!confirm('将删除全部记录，且无法撤销。\n确定清空？')) return;
      if (!confirm('再次确认：真的要清空所有数据吗？')) return;
      L.clearAll();
      toast('已清空全部数据', 'ok');
      closeModal();
      refresh();
    });
  }

  // 数据位置与更新方式说明
  function showDataInfo() {
    const dir = S.dataDir || '（未获取到）';
    const rows = Object.keys(S.collMap).map(k => {
      const c = S.collMap[k];
      return `<tr><td style="padding:4px 10px 4px 0">${esc(c.icon)} ${esc(c.label)}</td>
        <td style="padding:4px 0;color:#8a99a8">${esc(k)}.json</td>
        <td style="padding:4px 0;text-align:right;font-weight:600">${S.counts[k] || 0} 条</td></tr>`;
    }).join('');
    const total = Object.values(S.counts).reduce((a, b) => a + b, 0);

    const body = el('div', { class: 'modal-body' });
    body.innerHTML = `
      <div style="background:#f6f9fb;border:1px solid #e2e8ee;border-radius:8px;
                  padding:12px 14px;margin-bottom:16px">
        <div style="font-size:12.5px;color:#5a6b7b;margin-bottom:5px">数据存放位置</div>
        <div style="font-family:Consolas,monospace;font-size:13px;word-break:break-all;
                    background:#fff;border:1px solid #e2e8ee;border-radius:5px;
                    padding:8px 10px;user-select:all" id="dataPathBox">${esc(dir)}</div>
        <div style="margin-top:9px;display:flex;gap:8px">
          <button class="btn sm" id="copyPathBtn">复制路径</button>
          <button class="btn sm" id="openFolderBtn">在资源管理器中打开</button>
        </div>
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:8px">
        各模块数据文件（共 ${total} 条）
      </div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">${rows}</table>

      <div style="margin-top:18px;font-size:13px;font-weight:600;margin-bottom:8px">
        如何更新数据
      </div>
      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;color:#3d4f5f">
        <li><b>界面录入</b>（推荐）—— 左侧选模块，点「＋ 新增」或行末「编辑」。
            自动校验、自动编号、自动备份。</li>
        <li><b>Excel 批量导入</b> —— 点「下载模板」，填好后点「导入 Excel」。
            编号留空是新增，填已有编号是更新。</li>
        <li><b>恢复备份</b> —— 备份在 <code>data/backup/</code> 里，
            每个模块保留最近 20 份，文件名带时间戳。</li>
        <li><b>直接改 JSON</b>（不推荐）—— 必须先关闭服务再改，改完重启。
            格式错了会导致该模块读不出来。</li>
      </ol>

      <div style="margin-top:14px;background:#fdf8e1;border:1px solid #f7dc6f;
                  border-radius:7px;padding:10px 13px;font-size:12.5px;color:#7d6608">
        <b>注意</b>：这个目录在百度网盘同步范围内，数据会自动上云。
        如果不希望上云，请把整个工作台文件夹移到非同步目录。
      </div>
    `;

    const modal = el('div', { class: 'modal', style: 'width:min(680px,100%)' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: '数据位置与更新方式' }),
        el('button', { class: 'x', text: '×', onclick: closeModal }),
      ]),
      body,
      el('div', { class: 'modal-foot' }, [
        el('span', { class: 'hint', text: '详细说明见 docs/数据管理.md' }),
        el('button', { class: 'btn primary', text: '关闭', onclick: closeModal }),
      ]),
    ]);
    showModal(modal);

    // 复制路径
    const copyBtn = document.getElementById('copyPathBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(dir);
          toast('路径已复制', 'ok');
        } catch (e) {
          // 非 https 环境下 clipboard 可能不可用，退回选中文本
          const box = document.getElementById('dataPathBox');
          if (box) {
            const r = document.createRange();
            r.selectNodeContents(box);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
          toast('已选中，按 Ctrl+C 复制');
        }
      });
    }
    // 打开文件夹
    const openBtn = document.getElementById('openFolderBtn');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        try {
          await api('/api/open-folder', { method: 'POST' });
          toast('已打开文件夹', 'ok');
        } catch (e) {
          toast('无法自动打开，请手动复制路径打开', 'err');
        }
      });
    }
  }

  // 检测浏览器缩放：缩放过大时页面会显得拥挤、侧栏被挤压
  function checkZoom() {
    const dpr = window.devicePixelRatio || 1;
    // 常见缩放比例：125% → 1.25，150% → 1.5
    if (dpr < 1.2) return;
    const bar = el('div', {
      style: 'position:fixed;bottom:14px;right:14px;z-index:400;max-width:320px;' +
        'background:#22384a;color:#fff;padding:11px 14px;border-radius:9px;' +
        'font-size:12.5px;line-height:1.6;box-shadow:0 8px 26px rgba(16,34,48,.3)',
    }, [
      el('div', { style: 'font-weight:600;margin-bottom:4px', text: '页面显示偏大？' }),
      el('div', {
        style: 'color:#b8d4de',
        text: `当前浏览器缩放约 ${Math.round(dpr * 100)}%。按 Ctrl + 0 可恢复 100%，显示会更完整。`,
      }),
      el('button', {
        text: '知道了',
        style: 'margin-top:8px;background:rgba(255,255,255,.15);border:0;color:#fff;' +
          'padding:4px 12px;border-radius:5px;cursor:pointer;font-size:12px',
        onclick: e => e.currentTarget.parentNode.remove(),
      }),
    ]);
    document.body.appendChild(bar);
    setTimeout(() => { if (bar.parentNode) bar.remove(); }, 12000);
  }

  // 登录页（仅当服务端设置了密码且本次访问不是本机时出现）
  function showLogin() {
    const inp = el('input', { type: 'password', placeholder: '请输入访问密码' });
    inp.style.cssText = 'width:100%;padding:9px 11px;border:1px solid #e2e8ee;border-radius:7px';
    const err = el('div', { style: 'color:#c0392b;font-size:12.5px;min-height:18px;margin-top:8px' });
    const btn = el('button', { class: 'btn primary', text: '进入工作台', style: 'width:100%;margin-top:10px;padding:9px' });
    const submit = async () => {
      btn.disabled = true;
      err.textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: { password: inp.value } });
        location.reload();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
        inp.focus();
      }
    };
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

    $('#content').innerHTML = '';
    $('#content').appendChild(el('div', {
      style: 'max-width:340px;margin:80px auto;background:#fff;border:1px solid #e2e8ee;' +
        'border-radius:10px;padding:24px;box-shadow:0 8px 30px rgba(16,34,48,.1)',
    }, [
      el('div', { style: 'font-size:17px;font-weight:600;margin-bottom:4px', text: '安全管理数据工作台' }),
      el('div', { style: 'font-size:12.5px;color:#8a99a8;margin-bottom:18px', text: '远程访问需要密码' }),
      inp, err, btn,
    ]));
    inp.focus();
  }

  // 按访问模式调整界面（只读时提示条 + 隐藏备份按钮）
  function applyModeUI() {
    if (!S.mode.readonly) return;
    const foot = $('.sidebar-foot');
    if (foot) {
      const btn = $('#btnBackup');
      if (btn) btn.style.display = 'none';
      const tip = el('div', {
        style: 'color:#8fb4c1;font-size:11.5px;line-height:1.5;margin-bottom:4px',
        text: '只读模式 · 如需修改请在本机操作',
      });
      foot.insertBefore(tip, foot.firstChild);
    }
    const sub = $('#pageSub');
    if (sub && !sub.textContent.includes('只读')) {
      sub.textContent = sub.textContent + '　·　只读模式';
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
