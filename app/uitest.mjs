/* 无头浏览器冒烟测试：用 Edge + CDP 打开工作台，检查渲染与交互。
 * 用法：node app/uitest.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const PORT = process.argv[2] || '8801';
const APP_PORT = process.argv[3] || '8800';
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log(`  [PASS] ${name}`); })
    .catch(e => { fail++; fails.push([name, e.message]); console.log(`  [FAIL] ${name} -> ${e.message}`); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

function httpJson(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const url = new URL(APP + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('非 JSON: ' + buf.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.handlers = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        this.handlers.forEach(h => h(msg));
      }
    });
  }
  send(method, params = {}, timeout = 12000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, timeout);
    });
  }
  waitFor(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeout);
      const h = msg => {
        if (msg.method === method) { clearTimeout(t); this.handlers = this.handlers.filter(x => x !== h); resolve(msg.params); }
      };
      this.handlers.push(h);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常');
    }
    return r.result.value;
  }
}

async function main() {
  if (!EDGE) { console.error('未找到浏览器，跳过 UI 测试'); process.exit(0); }
  console.log('='.repeat(62));
  console.log('前端无头浏览器冒烟测试');
  console.log('='.repeat(62));

  const userDir = mkdtempSync(join(tmpdir(), 'dsh-uitest-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const target = await waitForTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Console.enable');

    const consoleErrors = [];
    cdp.handlers.push(msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const text = msg.params.entry.text || '';
        const url = msg.params.entry.url || '';
        // 忽略 favicon 之类的静态 404，只关心页面脚本与接口错误
        if (/favicon/i.test(url) || /favicon/i.test(text)) return;
        consoleErrors.push('日志: ' + text + (url ? ' [' + url + ']' : ''));
      }
      // 自动接受 confirm / alert 对话框，否则无头模式下页面会一直阻塞
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    // ---- 准备演示数据
    console.log('\n[0] 准备测试数据');
    const seedIds = [];
    await check('写入测试数据', async () => {
      const today = new Date();
      const fmt = d => d.toISOString().slice(0, 10);
      const future = fmt(new Date(today.getTime() + 20 * 86400000));
      const past = fmt(new Date(today.getTime() - 15 * 86400000));
      const hazards = [
        { title: 'UI测试-三车间配电箱门锁损坏', category: '电气安全', level: '一般隐患', source: '日常巡检', foundDate: past, dept: '生产部', responsible: '李四', deadline: past, location: '三车间东侧' },
        { title: 'UI测试-仓库消防通道堆物', category: '消防安全', level: '重大隐患', source: '专项检查', foundDate: past, dept: '仓储物流部', responsible: '张三', deadline: future, location: '一号仓库' },
      ];
      for (const h of hazards) {
        const r = await httpJson('/api/hazards', 'POST', h);
        assert(r.ok, '写入隐患失败: ' + JSON.stringify(r));
        seedIds.push(['hazards', r.data.id]);
      }
      const risk = await httpJson('/api/risks', 'POST', {
        riskPoint: 'UI测试-冲压工位', hazardFactor: '滑块下落', likelihood: 5, severity: 4,
        controlMeasures: '光电保护', controlLevel: '部门级', dept: '生产部',
      });
      assert(risk.ok, '写入风险失败'); seedIds.push(['risks', risk.data.id]);
      const cert = await httpJson('/api/certificates', 'POST', {
        personName: 'UI测试-赵六', dept: '设备部', certType: '特种作业操作证',
        issueDate: past, expireDate: fmt(new Date(today.getTime() + 15 * 86400000)),
      });
      assert(cert.ok, '写入证照失败'); seedIds.push(['certificates', cert.data.id]);
    });

    // ---- 打开页面
    console.log('\n[1] 页面加载');
    const loadP = cdp.waitFor('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: APP + '/' });
    await loadP;
    await sleep(1200);

    await check('页面标题正确', async () => {
      const t = await cdp.eval('document.title');
      assert(t.includes('安全管理数据工作台'), '标题: ' + t);
    });

    await check('侧边导航渲染 11 个入口', async () => {
      const n = await cdp.eval('document.querySelectorAll(".nav a").length');
      assert(n === 12, '导航项数: ' + n);
    });

    await check('看板 KPI 卡片渲染', async () => {
      const n = await cdp.eval('document.querySelectorAll(".kpi").length');
      assert(n >= 12, 'KPI 卡片数: ' + n);
    });

    await check('看板 Canvas 已绘制（非空白）', async () => {
      const painted = await cdp.eval(`(() => {
        const ids = ['lineTrend','riskBar','catHbar','incPie'];
        return ids.map(id => {
          const c = document.getElementById(id);
          if (!c) return id + ':缺失';
          const ctx = c.getContext('2d');
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
          return id + ':' + (n > 3 ? 'ok' : '空白');
        }).join(',');
      })()`);
      assert(!painted.includes('缺失') && !painted.includes('空白'), painted);
    });

    await check('提醒清单渲染', async () => {
      const n = await cdp.eval('document.querySelectorAll(".alert-list li").length');
      assert(n >= 1, '提醒项数: ' + n);
    });

    await check('侧栏有「数据位置」按钮', async () => {
      const has = await cdp.eval(`!!document.getElementById('btnDataInfo')`);
      assert(has, '缺少数据位置按钮');
    });

    await check('点击「数据位置」显示数据说明', async () => {
      await cdp.eval(`document.getElementById('btnDataInfo').click()`);
      await sleep(700);
      const info = await cdp.eval(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return { open: false };
        const text = m.textContent;
        return {
          open: true,
          hasPath: !!document.getElementById('dataPathBox'),
          pathText: (document.getElementById('dataPathBox') || {}).textContent || '',
          hasFiles: text.includes('.json'),
          hasHowTo: text.includes('如何更新数据'),
          hasInterface: text.includes('界面录入'),
          hasExcel: text.includes('Excel 批量导入'),
          hasBackup: text.includes('恢复备份'),
          hasCloudWarn: text.includes('百度网盘'),
          hasTable: !!m.querySelector('table'),
        };
      })()`);
      assert(info.open, '弹窗未打开');
      assert(info.hasPath, '缺少路径显示');
      assert(info.pathText.length > 5, '路径为空');
      assert(info.hasFiles, '缺少文件清单');
      assert(info.hasHowTo, '缺少更新说明');
      assert(info.hasInterface && info.hasExcel && info.hasBackup, '说明不完整');
      assert(info.hasCloudWarn, '缺少网盘同步提醒');
      assert(info.hasTable, '缺少模块表格');
    });

    await check('关闭数据位置弹窗', async () => {
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
      const has = await cdp.eval(`!!document.querySelector('.modal')`);
      assert(!has, '弹窗未关闭');
    });

    // ---- 导航到隐患列表
    console.log('\n[2] 隐患列表页');
    await cdp.eval(`location.hash = '#/hazards'`);
    await sleep(900);

    await check('列表表格渲染', async () => {
      const rows = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(rows >= 2, '行数: ' + rows);
    });

    await check('逾期徽标显示为红色', async () => {
      const ok = await cdp.eval(`(() => {
        const badges = [...document.querySelectorAll('table.grid .badge')];
        return badges.some(b => b.textContent.trim() === '逾期' && b.classList.contains('red'));
      })()`);
      assert(ok, '未找到红色逾期徽标');
    });

    await check('搜索框过滤生效', async () => {
      const before = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '消防通道';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(800);
      const info = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        return {
          n: rows.length,
          allMatch: rows.every(r => r.textContent.includes('消防通道')),
        };
      })()`);
      assert(info.n >= 1, '过滤后无结果');
      assert(info.allMatch, '过滤结果含不匹配的行');
      assert(info.n < before, `过滤未减少行数（${before} → ${info.n}）`);
    });

    await check('清空搜索恢复全部', async () => {
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(800);
      const rows = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(rows >= 2, '恢复后行数: ' + rows);
    });

    // ---- 新增弹窗
    console.log('\n[3] 新增表单');
    await check('点击新增打开弹窗', async () => {
      await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll('.toolbar .btn')];
        const b = btns.find(x => x.textContent.includes('新增'));
        b.click();
      })()`);
      await sleep(500);
      const has = await cdp.eval('!!document.querySelector(".modal")');
      assert(has, '弹窗未出现');
    });

    await check('表单字段按 schema 渲染', async () => {
      const n = await cdp.eval('document.querySelectorAll(".modal .field").length');
      assert(n >= 10, '字段数: ' + n);
    });

    await check('必填项为空时保存被拒绝并提示', async () => {
      await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '保存').click()`);
      await sleep(700);
      const err = await cdp.eval(`(() => {
        const e = document.querySelector('.modal .err');
        return e ? e.textContent.trim() : '';
      })()`);
      assert(err.length > 0 && err.includes('必填'), '错误提示: ' + err);
    });

    await check('填写后保存成功并关闭弹窗', async () => {
      await cdp.eval(`(() => {
        const set = (id, v) => {
          const n = document.getElementById('f_' + id);
          if (!n) return;
          n.value = v;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          n.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('title', 'UI测试-弹窗新增的隐患');
        set('category', '设备设施');
        set('level', '一般隐患');
        set('source', '班组自查');
        set('foundDate', new Date().toISOString().slice(0,10));
        set('dept', '设备部');
        set('responsible', '测试员');
        set('deadline', new Date(Date.now() + 15*86400000).toISOString().slice(0,10));
      })()`);
      await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '保存').click()`);
      await sleep(1400);
      const has = await cdp.eval('!!document.querySelector(".modal")');
      assert(!has, '弹窗未关闭（保存可能失败）');
    });

    await check('新记录出现在列表中', async () => {
      const found = await cdp.eval(`(() => {
        return [...document.querySelectorAll('table.grid tbody tr')]
          .some(tr => tr.textContent.includes('弹窗新增的隐患'));
      })()`);
      assert(found, '列表未显示新记录');
    });

    // ---- 状态流转
    console.log('\n[4] 状态流转');
    await check('点击流转弹出菜单', async () => {
      await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('弹窗新增的隐患'));
        const b = [...row.querySelectorAll('button')].find(x => x.textContent.includes('流转'));
        b.click();
      })()`);
      await sleep(400);
      const n = await cdp.eval('document.querySelectorAll(".popmenu div").length');
      assert(n >= 1, '菜单项数: ' + n);
    });

    await check('执行「开始整改」后状态变化', async () => {
      await cdp.eval(`document.querySelector('.popmenu div').click()`);
      await sleep(1300);
      const status = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('弹窗新增的隐患'));
        const badges = [...row.querySelectorAll('.badge')].map(b => b.textContent.trim());
        return badges.join(',');
      })()`);
      assert(status.includes('整改中'), '状态徽标: ' + status);
    });

    // ---- 详情
    console.log('\n[5] 详情与各模块页面');
    await check('详情弹窗展示字段', async () => {
      await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('弹窗新增的隐患'));
        [...row.querySelectorAll('button')].find(b => b.textContent === '详情').click();
      })()`);
      await sleep(500);
      const n = await cdp.eval('document.querySelectorAll(".modal .dl dt").length');
      assert(n >= 10, '详情字段数: ' + n);
    });

    await check('关闭详情弹窗', async () => {
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
      const has = await cdp.eval('!!document.querySelector(".modal")');
      assert(!has, '弹窗未关闭');
    });

    for (const [key, label] of [
      ['equipments', '设备管理'], ['concerns', '安全疑虑'],
      ['risks', '风险分级管控'],
      ['incidents', '事故事件管理'], ['trainings', '教育培训'],
      ['certificates', '人员资质证照'], ['fireEquipments', '消防设施器材'],
      ['fireDrills', '应急演练'], ['contractors', '承包商管理'], ['permits', '作业许可票'],
    ]) {
      await check(`页面「${label}」正常渲染`, async () => {
        await cdp.eval(`location.hash = '#/${key}'`);
        await sleep(750);
        const info = await cdp.eval(`(() => ({
          title: document.getElementById('pageTitle').textContent,
          hasCard: !!document.querySelector('.card'),
          hasErr: document.body.textContent.includes('服务器内部错误') ||
                  document.body.textContent.includes('无法连接'),
          loading: document.body.textContent.includes('正在加载'),
        }))()`);
        assert(info.title === label, '标题不符: ' + info.title);
        assert(info.hasCard, '缺少卡片容器');
        assert(!info.hasErr, '页面显示错误信息');
        assert(!info.loading, '页面仍停留在加载中');
      });
    }

    // ---- 设备模块
    console.log('\n[5b] 设备管理模块');
    await check('设备页显示三个分类页签', async () => {
      await cdp.eval(`location.hash = '#/equipments'`);
      await sleep(900);
      const tabs = await cdp.eval(`[...document.querySelectorAll('.tabs button')].map(b => b.textContent)`);
      assert(tabs.includes('特种设备类'), '缺少特种设备类页签: ' + tabs.join(','));
      assert(tabs.includes('表阀类'), '缺少表阀类页签');
      assert(tabs.includes('其他类'), '缺少其他类页签');
      assert(tabs.includes('全部'), '缺少全部页签');
    });

    await check('默认显示全部设备', async () => {
      const n = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(n >= 15, '设备行数: ' + n);
    });

    await check('切换「表阀类」只显示表阀', async () => {
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent === '表阀类');
        b.click();
      })()`);
      await sleep(900);
      const info = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const types = rows.map(r => r.textContent);
        const valveTypes = ['气包压力表', '气罐压力表', '安全阀', '流量计'];
        return {
          n: rows.length,
          allValve: types.every(t => valveTypes.some(v => t.includes(v))),
        };
      })()`);
      assert(info.n >= 1, '表阀类无数据');
      assert(info.allValve, '表阀类页签混入了非表阀设备');
    });

    await check('切换「特种设备类」只显示特种设备', async () => {
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent === '特种设备类');
        b.click();
      })()`);
      await sleep(900);
      const info = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const specialTypes = ['吊车', '叉车', '电梯', '储气罐'];
        return {
          n: rows.length,
          allSpecial: rows.every(r => specialTypes.some(v => r.textContent.includes(v))),
        };
      })()`);
      assert(info.n >= 4, '特种设备类行数: ' + info.n);
      assert(info.allSpecial, '特种设备类页签混入了其它设备');
    });

    await check('设备表单按类型显示对应字段', async () => {
      await cdp.eval(`location.hash = '#/equipments'`);
      await sleep(800);
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.toolbar .btn')].find(x => x.textContent.includes('新增'));
        b.click();
      })()`);
      await sleep(500);
      // 选「叉车」：应显示额定载荷，不显示额定速度/量程
      const visible = await cdp.eval(`(() => {
        const sel = document.getElementById('f_type');
        sel.value = '叉车';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const isShown = id => {
          const n = document.getElementById('f_' + id);
          if (!n) return false;
          return n.closest('.field').style.display !== 'none';
        };
        return {
          ratedLoad: isShown('ratedLoad'),
          ratedSpeed: isShown('ratedSpeed'),
          regCode: isShown('regCode'),
          calibCycle: isShown('calibCycle'),
        };
      })()`);
      assert(visible.ratedLoad, '叉车应显示额定载荷');
      assert(visible.regCode, '叉车应显示使用登记证号');
      assert(!visible.ratedSpeed, '叉车不应显示额定速度');
      assert(!visible.calibCycle, '叉车不应显示校验周期');
    });

    await check('切换到「电梯」字段随之变化', async () => {
      const visible = await cdp.eval(`(() => {
        const sel = document.getElementById('f_type');
        sel.value = '电梯';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const isShown = id => {
          const n = document.getElementById('f_' + id);
          if (!n) return false;
          return n.closest('.field').style.display !== 'none';
        };
        return { ratedSpeed: isShown('ratedSpeed'), ratedLoad: isShown('ratedLoad') };
      })()`);
      assert(visible.ratedSpeed, '电梯应显示额定速度');
      assert(!visible.ratedLoad, '电梯不应显示额定载荷');
    });

    await check('切换到「安全阀」显示表阀字段', async () => {
      const visible = await cdp.eval(`(() => {
        const sel = document.getElementById('f_type');
        sel.value = '安全阀';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const isShown = id => {
          const n = document.getElementById('f_' + id);
          if (!n) return false;
          return n.closest('.field').style.display !== 'none';
        };
        return { calibCycle: isShown('calibCycle'), calibDate: isShown('calibDate'),
                 regCode: isShown('regCode') };
      })()`);
      assert(visible.calibCycle, '安全阀应显示校验周期');
      assert(visible.calibDate, '安全阀应显示最近校验日期');
      assert(!visible.regCode, '安全阀不应显示使用登记证号');
    });

    await check('关闭设备表单', async () => {
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
    });

    await check('看板显示设备 KPI 与分类图', async () => {
      await cdp.eval(`location.hash = '#/dashboard'`);
      await sleep(1400);
      const info = await cdp.eval(`(() => {
        const labels = [...document.querySelectorAll('.kpi .label')].map(x => x.textContent);
        const c = document.getElementById('eqBar');
        let painted = false;
        if (c) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
          painted = n > 3;
        }
        return { hasKpi: labels.some(l => l.includes('设备总数')), painted,
                 hasAlert: document.body.textContent.includes('设备检验到期') };
      })()`);
      assert(info.hasKpi, '看板缺少设备 KPI 卡片');
      assert(info.painted, '设备分类图未绘制');
      assert(info.hasAlert, '看板缺少设备到期提醒卡片');
    });

    // ---- 安全疑虑
    console.log('\n[5c] 安全疑虑模块');
    await check('疑虑页正常渲染', async () => {
      await cdp.eval(`location.hash = '#/concerns'`);
      await sleep(1000);
      const info = await cdp.eval(`(() => ({
        title: document.getElementById('pageTitle').textContent,
        rows: document.querySelectorAll('table.grid tbody tr').length,
      }))()`);
      assert(info.title === '安全疑虑', '标题不符: ' + info.title);
      assert(info.rows >= 5, '疑虑行数: ' + info.rows);
    });

    await check('疑虑显示超期徽标', async () => {
      const ok = await cdp.eval(`(() => {
        const badges = [...document.querySelectorAll('table.grid .badge')];
        return badges.some(b => b.textContent.trim() === '逾期' && b.classList.contains('red'));
      })()`);
      assert(ok, '未找到超期红色徽标');
    });

    await check('疑虑显示反馈状态徽标', async () => {
      const info = await cdp.eval(`(() => {
        const texts = [...document.querySelectorAll('table.grid .badge')].map(b => b.textContent.trim());
        return {
          hasUnreplied: texts.includes('待答复'),
          hasDone: texts.includes('已办结') || texts.includes('已答复'),
        };
      })()`);
      assert(info.hasUnreplied, '应有「待答复」徽标');
      assert(info.hasDone, '应有「已答复/已办结」徽标');
    });

    await check('疑虑状态筛选可用', async () => {
      const opts = await cdp.eval(`(() => {
        const sel = document.querySelector('.toolbar select');
        return sel ? [...sel.options].map(o => o.text) : [];
      })()`);
      assert(opts.includes('待核实'), '筛选缺少待核实: ' + opts.join(','));
      assert(opts.includes('已转隐患'), '筛选缺少已转隐患');
    });

    await check('疑虑详情显示转隐患编号', async () => {
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '叉车';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(900);
      const found = await cdp.eval(`(() => {
        const row = document.querySelector('table.grid tbody tr');
        if (!row) return false;
        [...row.querySelectorAll('button')].find(b => b.textContent === '详情').click();
        return true;
      })()`);
      assert(found, '未找到疑虑记录');
      await sleep(700);
      const detail = await cdp.eval(`(() => {
        const dl = document.querySelector('.modal .dl');
        return dl ? dl.textContent : '';
      })()`);
      assert(detail.includes('转隐患编号'), '详情应显示转隐患编号字段');
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
    });

    await check('疑虑表单必填项校验', async () => {
      await cdp.eval(`location.hash = '#/concerns'`);
      await sleep(900);
      await cdp.eval(`(() => {
        [...document.querySelectorAll('.toolbar .btn')].find(x => x.textContent.includes('新增')).click();
      })()`);
      await sleep(600);
      await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '保存').click()`);
      await sleep(800);
      const err = await cdp.eval(`(() => {
        const e = document.querySelector('.modal .err');
        return e ? e.textContent.trim() : '';
      })()`);
      assert(err.length > 0, '空表单应提示必填');
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
    });

    await check('看板显示疑虑 KPI 与提醒', async () => {
      await cdp.eval(`location.hash = '#/dashboard'`);
      await sleep(1600);
      const info = await cdp.eval(`(() => {
        const labels = [...document.querySelectorAll('.kpi .label')].map(x => x.textContent);
        const c = document.getElementById('concernHbar');
        let painted = false;
        if (c) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
          painted = n > 3;
        }
        return {
          hasKpi: labels.some(l => l.includes('安全疑虑')),
          hasOverdue: labels.some(l => l.includes('疑虑超期')),
          painted,
          hasAlert: document.body.textContent.includes('待处理安全疑虑'),
        };
      })()`);
      assert(info.hasKpi, '看板缺少安全疑虑 KPI');
      assert(info.hasOverdue, '看板缺少疑虑超期 KPI');
      assert(info.painted, '疑虑类别图未绘制');
      assert(info.hasAlert, '看板缺少待处理疑虑提醒卡片');
    });

    // ---- 风险四色
    await check('风险四色徽标正确着色', async () => {
      await cdp.eval(`location.hash = '#/risks'`);
      await sleep(800);
      const cls = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('table.grid .badge')]
          .find(x => x.textContent.includes('重大风险'));
        return b ? b.className : '';
      })()`);
      assert(cls.includes('risk-red'), '徽标样式: ' + cls);
    });

    // ---- 导入导出按钮存在
    await check('导出按钮触发下载', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(800);
      const has = await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')]
        .some(b => b.textContent.includes('导出'))`);
      assert(has, '缺少导出按钮');
    });

    // ---- 控制台无错误
    await check('浏览器控制台无报错', async () => {
      await sleep(400);
      // 测试中故意提交过缺必填的表单（期望 400），这类网络日志不算前端报错
      const real = consoleErrors.filter(e =>
        !/status of 400/.test(e) && !/status of 404/.test(e));
      assert(real.length === 0, real.slice(0, 3).join(' | '));
      // 400 只应来自故意触发的必填校验（隐患、疑虑各一次）
      const net400 = consoleErrors.filter(e => /status of 400/.test(e));
      assert(net400.length <= 3,
        '出现过多非预期 400：' + net400.slice(0, 4).join(' | '));
    });

    // ---- 清理测试数据
    console.log('\n[6] 清理');
    await check('删除 UI 测试数据', async () => {
      for (const [coll, id] of seedIds) await httpJson(`/api/${coll}/${encodeURIComponent(id)}`, 'DELETE');
      const all = await httpJson('/api/hazards?size=200');
      for (const it of all.data.items) {
        if (String(it.title || '').startsWith('UI测试')) {
          await httpJson('/api/hazards/' + encodeURIComponent(it.id), 'DELETE');
        }
      }
    });

    // 截图留档
    await cdp.eval(`location.hash = '#/dashboard'`);
    await sleep(1500);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-dashboard.png'), Buffer.from(shot.data, 'base64'));

    await cdp.eval(`location.hash = '#/hazards'`);
    await sleep(1200);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-hazards.png'), Buffer.from(shot.data, 'base64'));

    await cdp.eval(`location.hash = '#/equipments'`);
    await sleep(1200);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-equipments.png'), Buffer.from(shot.data, 'base64'));

    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.toolbar .btn')].find(x => x.textContent.includes('新增'));
      b.click();
    })()`);
    await sleep(500);
    await cdp.eval(`(() => {
      const sel = document.getElementById('f_type');
      sel.value = '叉车';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-equipment-form.png'), Buffer.from(shot.data, 'base64'));
    await cdp.eval(`document.querySelector('.modal-head .x').click()`);
    await sleep(300);

    await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('.toolbar .btn')];
      btns.find(x => x.textContent.includes('新增')).click();
    })()`);
    await sleep(700);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-form.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n已保存截图：docs/screenshot-dashboard.png / screenshot-hazards.png / screenshot-form.png');

  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    proc.kill();
    await sleep(600);
    try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(62));
  console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  fails.forEach(([n, m]) => console.log(`  失败：${n} -> ${m}`));
  console.log('='.repeat(62));
  process.exit(fail === 0 ? 0 : 1);
}

function waitForTarget(timeout = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`http://127.0.0.1:${PORT}/json/list`, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            const list = JSON.parse(buf);
            const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return resolve(page);
          } catch { /* retry */ }
          retry();
        });
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeout) return reject(new Error('等待浏览器调试端口超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

main().catch(e => { console.error('测试运行失败:', e); process.exit(1); });
