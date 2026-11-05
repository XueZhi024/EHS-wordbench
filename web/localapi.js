/* 安全管理数据工作台 — 本地数据层
 *
 * 纯浏览器实现，不依赖后端。数据存在 localStorage，
 * 首次访问时从 web/data/bundle.js 载入初始数据。
 *
 * 复刻了后端的全部能力：
 *   增删改查、字段校验、跨字段业务规则、编号生成、
 *   状态流转、计算字段、看板聚合
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'ehs_workbench_data_v1';
  const SCHEMA_KEY = 'ehs_workbench_schema_v1';

  let SCHEMA = null;
  let COLL = {};          // key -> collection 定义
  let DATA = {};          // key -> items[]
  let SEQ = {};           // key -> 流水号
  let dirty = false;

  // ---------------------------------------------------------------- 工具

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowStr() {
    const d = new Date();
    return `${today()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function parseDate(v) {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseDateTime(v) {
    if (!v) return null;
    const m = String(v).replace('T', ' ').match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ ]+(\d{1,2}):(\d{2})/);
    if (!m) return parseDate(v);
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d.getTime()) ? null : d;
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // ---------------------------------------------------------------- 计算字段

  const CYCLE_DAYS = { '每月': 30, '每季': 91, '每半年': 182, '每年': 365 };

  function riskLevelOf(score) {
    if (score === null || score === undefined) return '';
    if (score >= 20) return '重大风险';
    if (score >= 15) return '较大风险';
    if (score >= 9) return '一般风险';
    return '低风险';
  }

  const INCIDENT_LEVEL_DESC = {
    '急救箱事件|A级': '急救箱A：需到医院检查，停工休假 3 天以内',
    '急救箱事件|B级': '急救箱B：需到医院清洗、消毒、清创、包扎',
    '急救箱事件|C级': '急救箱C：用急救箱物品处理，不影响工作',
    '医疗处置事件|A级': '医疗A：停工休假 15 天以上',
    '医疗处置事件|B级': '医疗B：停工休假 15 天以内（含 15 天）',
    '医疗处置事件|C级': '医疗C：停工休假 3 天以内（含 3 天）',
    '一般事故|A级': '一般事故A：3 人以下死亡，或 3–10 人重伤，或 10 人以上轻伤，或 100–1000 万元损失',
    '一般事故|B级': '一般事故B：3 人以下重伤，或 3–10 人轻伤，或 10–100 万元损失',
    '一般事故|C级': '一般事故C：3 人以下轻伤，或 10 万元以下损失',
    '安全疑虑|': '尚未发生事故，但可能引发事故的不安全因素',
    '未遂事件|': '未造成伤害、疾病和损失的意外事件，但非常接近发生',
    '一般事件|': '造成企业直接经济损失的事件（工业安全/道路交通/火灾/其他）',
  };

  const COMPUTERS = {
    hazard_overdue(rec) {
      if (rec.status === '已关闭') return false;
      const d = parseDate(rec.deadline);
      return d ? d < parseDate(today()) : false;
    },
    hazard_overdue_days(rec) {
      if (rec.status === '已关闭') return 0;
      const d = parseDate(rec.deadline);
      if (!d) return 0;
      const diff = daysBetween(d, parseDate(today()));
      return diff > 0 ? diff : 0;
    },
    risk_score(rec) {
      const l = parseInt(rec.likelihood, 10);
      const s = parseInt(rec.severity, 10);
      if (!l || !s || l <= 0 || s <= 0) return null;
      return l * s;
    },
    risk_level(rec) {
      return riskLevelOf(COMPUTERS.risk_score(rec));
    },
    cert_days_left(rec) {
      const d = parseDate(rec.expireDate);
      return d ? daysBetween(parseDate(today()), d) : null;
    },
    cert_warn(rec) {
      if (rec.status === '已注销') return '已注销';
      const left = COMPUTERS.cert_days_left(rec);
      if (left === null) return '';
      if (left < 0) return '已过期';
      if (left <= 30) return '30天内到期';
      return '正常';
    },
    fire_next_check(rec) {
      const last = parseDate(rec.lastCheckDate);
      const days = CYCLE_DAYS[rec.checkCycle];
      if (!last || !days) return '';
      const d = new Date(last.getTime() + days * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    fire_overdue(rec) {
      if (rec.status === '已停用' || rec.status === '已报废') return false;
      const nxt = parseDate(COMPUTERS.fire_next_check(rec));
      return nxt ? nxt < parseDate(today()) : false;
    },
    contractor_expire_warn(rec) {
      const d = parseDate(rec.expireDate);
      if (!d) return '';
      const left = daysBetween(parseDate(today()), d);
      if (left < 0) return '已过期';
      if (left <= 30) return '30天内到期';
      return '正常';
    },
    permit_state(rec) {
      if (['已完工', '已关闭', '已作废'].includes(rec.status)) return '';
      const end = parseDateTime(rec.endTime);
      if (!end) return '';
      const now = new Date();
      if (end < now) return '已超期';
      if (end - now <= 86400000) return '24小时内到期';
      return '进行中';
    },
    concern_overdue(rec) {
      if (['已关闭', '已转隐患'].includes(rec.status)) return false;
      const d = parseDate(rec.deadline);
      return d ? d < parseDate(today()) : false;
    },
    concern_days_left(rec) {
      if (['已关闭', '已转隐患'].includes(rec.status)) return null;
      const d = parseDate(rec.deadline);
      return d ? daysBetween(parseDate(today()), d) : null;
    },
    concern_reply_state(rec) {
      if (['已关闭', '已转隐患'].includes(rec.status)) return '已办结';
      if (rec.replyDate) return '已答复';
      return '待答复';
    },
    equipment_next_check(rec) {
      const last = parseDate(rec.lastCheckDate);
      const days = CYCLE_DAYS[rec.checkCycle];
      if (!last || !days) return '';
      const d = new Date(last.getTime() + days * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    equipment_check_warn(rec) {
      if (['已停用', '已报废'].includes(rec.status)) return '已停用';
      const nxt = parseDate(COMPUTERS.equipment_next_check(rec));
      if (!nxt) return '';
      const left = daysBetween(parseDate(today()), nxt);
      if (left < 0) return '已过期';
      if (left <= 30) return '30天内到期';
      return '正常';
    },
    equipment_expire_warn(rec) {
      if (['已停用', '已报废'].includes(rec.status)) return '已停用';
      const d = parseDate(rec.inspectExpire);
      if (!d) return '';
      const left = daysBetween(parseDate(today()), d);
      if (left < 0) return '已过期';
      if (left <= 30) return '30天内到期';
      return '正常';
    },
    equipment_days_left(rec) {
      const d = parseDate(rec.inspectExpire);
      return d ? daysBetween(parseDate(today()), d) : null;
    },
    equipment_category(rec) {
      const t = rec.type || '';
      if (['吊车', '叉车', '电梯', '储气罐', '锅炉', '压力容器', '起重机械'].includes(t)) {
        return '特种设备类';
      }
      if (['气包压力表', '气罐压力表', '安全阀', '流量计'].includes(t)) return '表阀类';
      return '其他类';
    },
    incident_level_desc(rec) {
      const k1 = `${rec.level1 || ''}|${rec.grade || ''}`;
      if (INCIDENT_LEVEL_DESC[k1]) return INCIDENT_LEVEL_DESC[k1];
      const k2 = `${rec.level1 || ''}|`;
      return INCIDENT_LEVEL_DESC[k2] || '';
    },
  };

  function applyComputed(key, rec) {
    const coll = COLL[key];
    if (!coll) return rec;
    (coll.fields || []).forEach(fd => {
      if (fd.type !== 'computed') return;
      const fn = COMPUTERS[fd.compute];
      if (!fn) return;
      try {
        rec[fd.key] = fn(rec);
      } catch (e) {
        rec[fd.key] = null;
      }
    });
    return rec;
  }

  // ---------------------------------------------------------------- 校验

  function fieldVisible(fd, rec) {
    if (!fd.showWhen) return true;
    const other = rec[fd.showWhen.key];
    return (fd.showWhen.in || []).indexOf(other) >= 0;
  }

  function normalizeDate(v) {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).trim()
      .replace(/\//g, '-').replace(/\./g, '-')
      .replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '');
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) throw new Error(`「${v}」不是有效日期，应为 YYYY-MM-DD`);
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d.getTime())) throw new Error(`「${v}」不是有效日期`);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function normalizeDateTime(v) {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v).trim().replace('T', ' ').replace(/\//g, '-');
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ]+(\d{1,2}):(\d{2}))?/);
    if (!m) throw new Error(`「${v}」不是有效时间`);
    const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    if (isNaN(d.getTime())) throw new Error(`「${v}」不是有效时间`);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function coerceNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(/,/g, '').replace(/，/g, '');
    if (!s) return null;
    const f = parseFloat(s);
    if (isNaN(f)) throw new Error(`「${v}」不是有效数字`);
    return Number.isInteger(f) ? f : f;
  }

  function validate(key, payload, existing) {
    const coll = COLL[key];
    if (!coll) throw new Error('未知集合：' + key);

    const cleaned = {};
    const errors = [];

    // 第一阶段：类型清洗
    (coll.fields || []).forEach(fd => {
      if (fd.type === 'id' || fd.type === 'computed') return;
      if (fd.key === 'createdAt' || fd.key === 'updatedAt') return;

      let raw;
      if (payload.hasOwnProperty(fd.key)) raw = payload[fd.key];
      else if (existing && existing.hasOwnProperty(fd.key)) raw = existing[fd.key];
      else raw = fd.default !== undefined ? fd.default : '';

      let val;
      try {
        if (fd.type === 'number') val = coerceNumber(raw);
        else if (fd.type === 'bool') val = raw === true || raw === 'true' || raw === '是';
        else if (fd.type === 'date') val = normalizeDate(raw);
        else if (fd.type === 'datetime') val = normalizeDateTime(raw);
        else if (fd.type === 'select') {
          const s = raw === null || raw === undefined ? '' : String(raw).trim();
          if (s && (fd.options || []).indexOf(s) < 0) {
            throw new Error(`「${s}」不在可选范围内`);
          }
          val = s;
        } else val = raw === null || raw === undefined ? '' : String(raw).trim();
      } catch (e) {
        errors.push(`${fd.label}：${e.message}`);
        val = fd.type === 'number' ? null : '';
      }
      cleaned[fd.key] = val;
    });

    // 第二阶段：算出 computed，再判断可见字段的必填
    const probe = Object.assign({}, existing || {}, cleaned);
    applyComputed(key, probe);

    (coll.fields || []).forEach(fd => {
      if (!fd.required) return;
      if (fd.type === 'id' || fd.type === 'computed') return;
      if (!fieldVisible(fd, probe)) return;
      const v = cleaned[fd.key];
      if (v === null || v === undefined || v === '' || v === false) {
        if (!(fd.type === 'bool' && v === false)) {
          errors.push(`${fd.label}为必填项`);
        }
      }
    });

    if (errors.length) throw new Error(errors.join('；'));

    crossValidate(key, cleaned);
    return cleaned;
  }

  function crossValidate(key, rec) {
    const errors = [];
    const D = k => parseDate(rec[k]);

    if (key === 'certificates') {
      const i = D('issueDate'), e = D('expireDate');
      if (i && e && e < i) errors.push('到期日期不能早于发证日期');
    }
    if (key === 'incidents') {
      const o = D('occurDate'), c = D('closeDate');
      if (o && c && c < o) errors.push('结案日期不能早于发生时间');
      if (rec.status === '已结案' && !c) errors.push('状态为「已结案」时必须填写结案日期');
    }
    if (key === 'permits') {
      const s = parseDateTime(rec.startTime), e = parseDateTime(rec.endTime);
      if (s && e && e < s) errors.push('结束时间不能早于开始时间');
    }
    if (key === 'contractors') {
      if (rec.status === '已准入') {
        if (rec.safetyAgreement === '未签订') errors.push('状态为「已准入」时安全协议必须已签订');
        const e = D('expireDate');
        if (e && e < parseDate(today())) errors.push('资质已过期，不能置为「已准入」');
      }
    }
    if (key === 'hazards') {
      if (rec.status === '已关闭' && rec.checkResult !== '通过') {
        errors.push('状态为「已关闭」时验收结果必须为「通过」');
      }
    }
    if (key === 'concerns') {
      if (rec.status === '已转隐患') {
        if (!rec.conclusion) errors.push('转隐患前必须填写核实结论');
        if (!rec.hazardId) errors.push('转隐患时必须填写隐患编号，便于追溯');
      }
      if (rec.status === '已关闭' && !rec.replyContent) errors.push('关闭前必须填写答复内容');
    }
    if (key === 'equipments') {
      const cat = COMPUTERS.equipment_category(rec);
      if (cat === '特种设备类') {
        if (!rec.regCode) errors.push('特种设备必须填写使用登记证号');
        if (!rec.nextInspectDate) errors.push('特种设备必须填写下次定期检验日期');
      }
      if (cat === '表阀类' && !rec.calibCycle) errors.push('表阀类设备必须填写校验周期');
      if (rec.status === '已报废' && !rec.remark) {
        errors.push('设备报废时请在备注中说明原因与处置方式');
      }
    }
    if (errors.length) throw new Error(errors.join('；'));
  }

  // ---------------------------------------------------------------- 编号

  function nextId(key) {
    const coll = COLL[key];
    const year = new Date().getFullYear();
    const head = `${coll.prefix}-${year}-`;
    let max = 0;
    (DATA[key] || []).forEach(it => {
      const id = String(it.id || '');
      if (id.indexOf(head) === 0) {
        const n = parseInt(id.slice(head.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
    return `${head}${String(max + 1).padStart(4, '0')}`;
  }

  // ---------------------------------------------------------------- 持久化

  function save() {
    try {
      const payload = { data: DATA, savedAt: nowStr() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      dirty = false;
      return true;
    } catch (e) {
      // localStorage 满了或不可用
      console.error('保存失败:', e);
      return false;
    }
  }

  function load() {
    const bundle = global.__EHS_BUNDLE__;
    let stored = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      stored = null;
    }

    if (stored && stored.data) {
      DATA = stored.data;
      // schema 始终用 bundle 里的（代码更新后 schema 会变）
      if (bundle && bundle.schema) {
        SCHEMA = bundle.schema;
      }
    } else if (bundle) {
      SCHEMA = bundle.schema;
      DATA = clone(bundle.data || {});
    } else {
      throw new Error('没有数据源：既没有本地数据，也没有 bundle');
    }

    COLL = {};
    (SCHEMA.collections || []).forEach(c => { COLL[c.key] = c; });

    // 补齐缺失的集合
    (SCHEMA.collections || []).forEach(c => {
      if (!DATA[c.key]) DATA[c.key] = [];
    });
    return true;
  }

  // ---------------------------------------------------------------- 查询

  function listItems(key, query) {
    query = query || {};
    const coll = COLL[key];
    if (!coll) return { items: [], total: 0, page: 1, size: 20 };

    let items = (DATA[key] || []).slice();

    // 等值过滤
    const filters = {};
    Object.keys(query).forEach(k => {
      if (['q', 'page', 'size', 'sort', 'dir', '_'].indexOf(k) >= 0) return;
      if (query[k] === null || query[k] === undefined || query[k] === '') return;
      filters[k] = String(query[k]);
    });

    if (Object.keys(filters).length) {
      items = items.filter(it => {
        for (const k in filters) {
          let v = it[k];
          if (v === undefined || v === null) {
            const fd = (coll.fields || []).find(f => f.key === k);
            if (fd && fd.type === 'computed') v = applyComputed(key, clone(it))[k];
          }
          if (typeof v === 'boolean') v = v ? 'true' : 'false';
          if (String(v) !== filters[k]) return false;
        }
        return true;
      });
    }

    // 全文搜索
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
      const textKeys = (coll.fields || [])
        .filter(f => ['text', 'textarea'].indexOf(f.type) >= 0)
        .map(f => f.key);
      items = items.filter(it => {
        if (String(it.id || '').toLowerCase().indexOf(q) >= 0) return true;
        return textKeys.some(k => String(it[k] || '').toLowerCase().indexOf(q) >= 0);
      });
    }

    // 排序
    const sortKey = query.sort || '';
    const reverse = (query.dir || 'desc').toLowerCase() === 'desc';
    if (sortKey) {
      items.sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (va === undefined || va === null || va === '') va = '\uffff';
        if (vb === undefined || vb === null || vb === '') vb = '\uffff';
        if (typeof va === 'number' && typeof vb === 'number') return va - vb;
        return String(va).localeCompare(String(vb), 'zh');
      });
      if (reverse) items.reverse();
    } else {
      items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    const total = items.length;
    const page = Math.max(1, parseInt(query.page || 1, 10) || 1);
    const size = Math.max(1, Math.min(parseInt(query.size || 20, 10) || 20, 500));
    const start = (page - 1) * size;
    const pageItems = items.slice(start, start + size).map(it => applyComputed(key, clone(it)));

    return { items: pageItems, total, page, size };
  }

  function getItem(key, id) {
    const it = (DATA[key] || []).find(x => String(x.id) === String(id));
    return it ? applyComputed(key, clone(it)) : null;
  }

  function allItems(key) {
    return (DATA[key] || []).map(it => applyComputed(key, clone(it)));
  }

  // ---------------------------------------------------------------- 增删改

  function createItem(key, payload) {
    const cleaned = validate(key, payload, null);
    const now = nowStr();
    const rec = { id: nextId(key) };
    Object.assign(rec, cleaned);
    rec.createdAt = now;
    rec.updatedAt = now;
    applyComputed(key, rec);
    DATA[key].push(rec);
    save();
    return clone(rec);
  }

  function updateItem(key, id, payload) {
    const list = DATA[key] || [];
    const idx = list.findIndex(x => String(x.id) === String(id));
    if (idx < 0) throw new Error('记录不存在：' + id);
    const old = list[idx];
    const cleaned = validate(key, payload, old);
    const merged = Object.assign({}, old, cleaned);
    merged.id = old.id;
    merged.createdAt = old.createdAt || nowStr();
    merged.updatedAt = nowStr();
    applyComputed(key, merged);
    list[idx] = merged;
    save();
    return clone(merged);
  }

  function deleteItem(key, id) {
    const list = DATA[key] || [];
    const before = list.length;
    DATA[key] = list.filter(x => String(x.id) !== String(id));
    if (DATA[key].length === before) return false;
    save();
    return true;
  }

  function transition(key, id, action, extra) {
    const coll = COLL[key];
    const rules = coll.transitions || [];
    const rule = rules.find(r => r.action === action);
    if (!rule) throw new Error('不支持的操作：' + action);

    const list = DATA[key] || [];
    const idx = list.findIndex(x => String(x.id) === String(id));
    if (idx < 0) throw new Error('记录不存在：' + id);

    const it = list[idx];
    const cur = it[coll.statusField];
    if (rule.from.indexOf(cur) < 0) {
      throw new Error(`当前状态「${cur}」不能执行「${action}」`);
    }

    let merged = Object.assign({}, it);
    if (extra && Object.keys(extra).length) {
      const cleaned = validate(key, extra, it);
      Object.assign(merged, cleaned);
    }
    (rule.requires || []).forEach(req => {
      if (!merged[req]) {
        const fd = (coll.fields || []).find(f => f.key === req);
        throw new Error(`执行「${action}」前必须填写：${fd ? fd.label : req}`);
      }
    });
    Object.assign(merged, rule.set || {});
    merged[coll.statusField] = rule.to;
    merged.updatedAt = nowStr();
    applyComputed(key, merged);
    list[idx] = merged;
    save();
    return clone(merged);
  }

  function countAll() {
    const out = {};
    (SCHEMA.collections || []).forEach(c => {
      out[c.key] = (DATA[c.key] || []).length;
    });
    return out;
  }

  // ---------------------------------------------------------------- 看板

  function buildDashboard(from, to, dept) {
    const todayD = parseDate(today());
    let start = parseDate(from);
    let end = parseDate(to);
    if (!start && !end) {
      start = new Date(todayD.getFullYear(), 0, 1);
      end = new Date(todayD.getFullYear(), 11, 31);
    }

    function inRange(d) {
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    }

    function keep(rec, dateKey) {
      if (dept && rec.dept !== dept) return false;
      const d = parseDate(rec[dateKey]);
      if (!d) return !(start || end);
      return inRange(d);
    }

    const hazardsAll = allItems('hazards');
    const hazards = hazardsAll.filter(r => keep(r, 'foundDate'));
    const risks = allItems('risks').filter(r => !dept || r.dept === dept);
    const incidents = allItems('incidents').filter(r => keep(r, 'occurDate'));
    const trainings = allItems('trainings').filter(r => keep(r, 'trainDate'));
    const certs = allItems('certificates');
    const fires = allItems('fireEquipments');
    const contractors = allItems('contractors');
    const permits = allItems('permits');
    const drills = allItems('fireDrills').filter(r => keep(r, 'planDate'));
    const concernsAll = allItems('concerns');
    const concerns = concernsAll.filter(r => keep(r, 'foundDate'));
    const equips = allItems('equipments');

    // 隐患
    const hzTotal = hazards.length;
    const hzClosed = hazards.filter(r => r.status === '已关闭').length;
    let closedOnTime = 0;
    hazards.forEach(r => {
      if (r.status !== '已关闭') return;
      const done = parseDate(r.checkDate) || parseDate(r.rectifyDate);
      const dl = parseDate(r.deadline);
      if (done && dl && done <= dl) closedOnTime++;
    });
    const hzOverdue = hazardsAll.filter(r => r.status !== '已关闭' && r.overdue).length;
    const hzMajor = hazards.filter(r => r.level === '重大隐患').length;

    // 风险
    const riskCounter = {};
    risks.forEach(r => {
      const lv = r.riskLevel || '未评级';
      riskCounter[lv] = (riskCounter[lv] || 0) + 1;
    });
    const riskMajor = risks.filter(r => r.riskLevel === '重大风险' && r.status !== '已消除').length;

    // 事故
    const incLossDays = incidents.reduce((s, r) => s + (Number(r.lossDays) || 0), 0);
    const incLossMoney = incidents.reduce((s, r) => s + (Number(r.loss) || 0), 0);
    const incMedical = incidents.reduce((s, r) => s + (Number(r.medicalCost) || 0), 0);
    const incByLevel1 = {};
    incidents.forEach(r => {
      const k = r.level1 || '未分类';
      incByLevel1[k] = (incByLevel1[k] || 0) + 1;
    });
    const incPersons = new Set(incidents.map(r => r.persons).filter(Boolean)).size;

    // 培训
    const trDone = trainings.filter(r => r.status === '已完成').length;
    const trPeople = trainings.reduce((s, r) => s + (Number(r.attendees) || 0), 0);

    // 证照
    const certWarn = certs.filter(r => r.status === '有效' && r.daysLeft !== null
      && r.daysLeft !== undefined && r.daysLeft <= 30);
    const certExpired = certs.filter(r => r.status === '有效' && r.daysLeft !== null
      && r.daysLeft !== undefined && r.daysLeft < 0);

    // 消防
    const fireOverdue = fires.filter(r => r.checkOverdue);

    // 承包商
    const cbsActive = contractors.filter(r => r.status === '已准入').length;
    const cbsViolations = contractors.reduce((s, r) => s + (Number(r.violationCount) || 0), 0);
    const cbsExpiring = contractors.filter(r => ['30天内到期', '已过期'].indexOf(r.expiryWarn) >= 0);

    // 作业票
    const permitRunning = permits.filter(r => ['已批准', '作业中'].indexOf(r.status) >= 0).length;
    const permitExpiring = permits.filter(r => ['24小时内到期', '已超期'].indexOf(r.state) >= 0);

    // 疑虑
    const cnTotal = concerns.length;
    const cnClosed = concerns.filter(r => r.status === '已关闭').length;
    const cnConverted = concerns.filter(r => r.status === '已转隐患').length;
    const cnOpen = concernsAll.filter(r => ['已关闭', '已转隐患'].indexOf(r.status) < 0).length;
    const cnOverdue = concernsAll.filter(r => r.overdue).length;
    const cnUnreplied = concernsAll.filter(r => ['已关闭', '已转隐患'].indexOf(r.status) < 0 && !r.replyDate).length;
    const cnHigh = concerns.filter(r => r.severity === '高').length;

    // 设备
    const eqActive = equips.filter(r => ['已报废', '停用'].indexOf(r.status) < 0);
    const eqByCat = {};
    equips.forEach(r => {
      const k = r.category || '其他类';
      eqByCat[k] = (eqByCat[k] || 0) + 1;
    });
    const eqExpiring = eqActive.filter(r => ['30天内到期', '已过期'].indexOf(r.expiryWarn) >= 0);
    const eqExpired = eqActive.filter(r => r.expiryWarn === '已过期');
    const eqSpecial = eqActive.filter(r => r.category === '特种设备类').length;

    // 趋势
    const trendStart = start || new Date(todayD.getFullYear(), 0, 1);
    const endM = end || todayD;
    const months = [];
    let y = trendStart.getFullYear(), m = trendStart.getMonth();
    while ((y < endM.getFullYear() || (y === endM.getFullYear() && m <= endM.getMonth()))
           && months.length < 24) {
      months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
      m++;
      if (m > 11) { m = 0; y++; }
    }
    const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const hzFoundM = {}, hzClosedM = {}, incM = {};
    hazards.forEach(r => {
      const d = parseDate(r.foundDate);
      if (d) hzFoundM[monthKey(d)] = (hzFoundM[monthKey(d)] || 0) + 1;
    });
    hazards.forEach(r => {
      if (r.status !== '已关闭') return;
      const cd = parseDate(r.checkDate) || parseDate(r.rectifyDate);
      if (cd) hzClosedM[monthKey(cd)] = (hzClosedM[monthKey(cd)] || 0) + 1;
    });
    incidents.forEach(r => {
      const d = parseDate(r.occurDate);
      if (d) incM[monthKey(d)] = (incM[monthKey(d)] || 0) + 1;
    });

    // 提醒
    const overdueList = hazardsAll
      .filter(r => r.status !== '已关闭' && r.overdue)
      .sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || '')))
      .slice(0, 20);

    const counter = (arr, k, limit) => {
      const c = {};
      arr.forEach(r => {
        const v = r[k] || '未填写';
        c[v] = (c[v] || 0) + 1;
      });
      return Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, limit || 20)
        .map(name => ({ name, value: c[name] }));
    };

    const brief = (rec, keys) => {
      const o = { id: rec.id || '' };
      keys.forEach(k => { o[k] = rec[k]; });
      return o;
    };

    return {
      range: {
        from: start ? fmt(start) : '',
        to: end ? fmt(end) : '',
        dept: dept || '',
      },
      kpi: {
        hazardTotal: hzTotal,
        hazardClosed: hzClosed,
        hazardCloseRate: hzTotal ? Math.round(hzClosed * 1000 / hzTotal) / 10 : null,
        hazardOnTimeRate: hzClosed ? Math.round(closedOnTime * 1000 / hzClosed) / 10 : null,
        hazardOverdue: hzOverdue,
        hazardMajor: hzMajor,
        riskTotal: risks.length,
        riskMajor: riskMajor,
        incidentTotal: incidents.length,
        incidentLossDays: Math.round(incLossDays * 10) / 10,
        incidentLossMoney: Math.round(incLossMoney * 100) / 100,
        incidentMedical: Math.round(incMedical * 100) / 100,
        incidentPersons: incPersons,
        incidentFirstAid: incByLevel1['急救箱事件'] || 0,
        incidentMedicalCase: incByLevel1['医疗处置事件'] || 0,
        incidentAttempt: incByLevel1['未遂事件'] || 0,
        incidentGeneral: incByLevel1['一般事件'] || 0,
        incidentAccident: incByLevel1['一般事故'] || 0,
        trainingTotal: trainings.length,
        trainingDone: trDone,
        trainingRate: trainings.length ? Math.round(trDone * 1000 / trainings.length) / 10 : null,
        trainingPeople: Math.round(trPeople),
        certWarn: certWarn.length,
        certExpired: certExpired.length,
        fireOverdue: fireOverdue.length,
        fireTotal: fires.length,
        drillTotal: drills.length,
        contractorActive: cbsActive,
        contractorViolations: Math.round(cbsViolations),
        permitRunning: permitRunning,
        permitExpiring: permitExpiring.length,
        equipmentTotal: equips.length,
        equipmentActive: eqActive.length,
        equipmentSpecial: eqSpecial,
        equipmentExpiring: eqExpiring.length,
        equipmentExpired: eqExpired.length,
        concernTotal: cnTotal,
        concernOpen: cnOpen,
        concernClosed: cnClosed,
        concernConverted: cnConverted,
        concernOverdue: cnOverdue,
        concernUnreplied: cnUnreplied,
        concernHigh: cnHigh,
      },
      hazardByCategory: counter(hazards, 'category'),
      hazardByLevel: counter(hazards, 'level'),
      hazardByDept: counter(hazards, 'dept', 12),
      riskByLevel: ['重大风险', '较大风险', '一般风险', '低风险', '未评级']
        .map(lv => ({ name: lv, value: riskCounter[lv] || 0 })),
      incidentByType: counter(incidents, 'type'),
      incidentByLevel1: [
        { name: '急救箱事件', value: incByLevel1['急救箱事件'] || 0 },
        { name: '医疗处置事件', value: incByLevel1['医疗处置事件'] || 0 },
        { name: '未遂事件', value: incByLevel1['未遂事件'] || 0 },
        { name: '一般事件', value: incByLevel1['一般事件'] || 0 },
        { name: '一般事故', value: incByLevel1['一般事故'] || 0 },
      ],
      concernByCategory: counter(concerns, 'category'),
      concernByStatus: ['待核实', '核实中', '待答复', '已关闭', '已转隐患']
        .map(s => ({ name: s, value: concerns.filter(r => r.status === s).length })),
      equipmentByCategory: ['特种设备类', '表阀类', '其他类']
        .map(g => ({ name: g, value: eqByCat[g] || 0 })),
      equipmentByType: counter(equips, 'type', 12),
      trend: {
        months,
        hazardFound: months.map(k => hzFoundM[k] || 0),
        hazardClosed: months.map(k => hzClosedM[k] || 0),
        incidents: months.map(k => incM[k] || 0),
      },
      alerts: {
        hazardOverdue: overdueList.map(r => brief(r, ['title', 'dept', 'deadline', 'level'])),
        concernPending: concernsAll
          .filter(r => ['已关闭', '已转隐患'].indexOf(r.status) < 0)
          .sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || '')))
          .slice(0, 20)
          .map(r => brief(r, ['title', 'dept', 'deadline', 'status', 'severity', 'overdue'])),
        certExpiring: certWarn.sort((a, b) => (a.daysLeft || 0) - (b.daysLeft || 0)).slice(0, 20)
          .map(r => brief(r, ['personName', 'certType', 'expireDate', 'daysLeft'])),
        fireOverdue: fireOverdue.slice(0, 20).map(r => brief(r, ['name', 'location', 'nextCheckDate'])),
        contractorExpiring: cbsExpiring.slice(0, 20).map(r => brief(r, ['name', 'expireDate', 'expiryWarn'])),
        permitExpiring: permitExpiring.slice(0, 20).map(r => brief(r, ['id', 'type', 'contractor', 'endTime', 'state'])),
        equipmentExpiring: eqExpiring
          .sort((a, b) => String(a.inspectExpire || '').localeCompare(String(b.inspectExpire || '')))
          .slice(0, 20)
          .map(r => brief(r, ['id', 'name', 'type', 'location', 'inspectExpire', 'expiryWarn'])),
      },
      generatedAt: nowStr(),
    };
  }

  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------- 导入导出

  function exportAll() {
    return {
      schema: SCHEMA,
      data: DATA,
      meta: {
        exportedAt: nowStr(),
        total: Object.keys(DATA).reduce((s, k) => s + DATA[k].length, 0),
      },
    };
  }

  function importAll(obj) {
    if (!obj || !obj.data) throw new Error('文件格式不正确');
    const newData = {};
    (SCHEMA.collections || []).forEach(c => {
      newData[c.key] = Array.isArray(obj.data[c.key]) ? obj.data[c.key] : [];
    });
    DATA = newData;
    save();
    return Object.keys(DATA).reduce((s, k) => s + DATA[k].length, 0);
  }

  function resetToBundle() {
    const bundle = global.__EHS_BUNDLE__;
    if (!bundle) throw new Error('没有可用的初始数据');
    DATA = clone(bundle.data || {});
    save();
    return Object.keys(DATA).reduce((s, k) => s + DATA[k].length, 0);
  }

  function clearAll() {
    const keys = Object.keys(DATA);
    keys.forEach(k => { DATA[k] = []; });
    save();
  }

  // ---------------------------------------------------------------- 对外接口

  const API = {
    init() {
      load();
      return true;
    },
    getSchema() {
      return SCHEMA;
    },
    getMeta() {
      const total = Object.keys(DATA).reduce((s, k) => s + DATA[k].length, 0);
      return { total, counts: countAll(), bundleMeta: (global.__EHS_BUNDLE__ || {}).meta || {} };
    },
    list: listItems,
    get: getItem,
    all: allItems,
    create: createItem,
    update: updateItem,
    remove: deleteItem,
    transition,
    counts: countAll,
    dashboard: buildDashboard,
    exportAll,
    importAll,
    resetToBundle,
    clearAll,
    save,
    isDirty() { return dirty; },
  };

  global.LocalAPI = API;
})(window);
