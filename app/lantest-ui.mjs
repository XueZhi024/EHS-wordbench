/* 局域网只读模式的前端验证：用 CDP 模拟远程访问。
 *
 * 做法：启动服务时用 --lan 开启局域网模式，然后通过 CDP 的
 * Network.setExtraHTTPHeaders 把请求来源伪装成外部 IP 是不行的
 * （来源 IP 由 TCP 决定），所以这里改为直接测试前端在收到
 * readonly=true 时的界面表现——通过覆盖 fetch 的 /api/session 响应实现。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const PORT = process.argv[2] || '8811';
const APP_PORT = process.argv[3] || '8810';
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach(h => h(msg));
      }
    });
  }
  send(method, params = {}, timeout = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, timeout);
    });
  }
  waitFor(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待超时: ' + method)), timeout);
      const h = msg => {
        if (msg.method === method) {
          clearTimeout(t);
          this.handlers = this.handlers.filter(x => x !== h);
          resolve(msg.params);
        }
      };
      this.handlers.push(h);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面异常');
    }
    return r.result.value;
  }
}

async function main() {
  if (!EDGE) { console.error('未找到浏览器'); process.exit(0); }
  console.log('='.repeat(66));
  console.log('局域网只读模式 — 前端验证');
  console.log('='.repeat(66));

  const userDir = mkdtempSync(join(tmpdir(), 'dsh-lan-'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const errors = [];
    cdp.handlers.push(msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    // ---- 1. 本机模式：应可编辑
    console.log('\n[1] 本机模式（可编辑）');
    let loadP = cdp.waitFor('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: APP + '/' });
    await loadP;
    await sleep(1200);

    await check('本机模式显示「新增」按钮', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(900);
      const has = await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')]
        .some(b => b.textContent.includes('新增'))`);
      assert(has, '本机模式应有新增按钮');
    });

    await check('本机模式行操作含编辑与删除', async () => {
      const info = await cdp.eval(`(() => {
        const row = document.querySelector('table.grid tbody tr');
        if (!row) return { edit: false, del: false };
        const texts = [...row.querySelectorAll('button')].map(b => b.textContent);
        return { edit: texts.includes('编辑'), del: texts.includes('删除') };
      })()`);
      assert(info.edit && info.del, '本机模式应可编辑删除：' + JSON.stringify(info));
    });

    await check('本机模式无只读标记', async () => {
      const has = await cdp.eval(`document.body.textContent.includes('只读模式')`);
      assert(!has, '本机模式不应显示只读标记');
    });

    await check('看板有自动刷新开关', async () => {
      await cdp.eval(`location.hash = '#/dashboard'`);
      await sleep(1300);
      const has = await cdp.eval(`document.body.textContent.includes('自动刷新')`);
      assert(has, '看板应有自动刷新开关');
    });

    // ---- 2. 模拟远程只读：拦截 /api/session 返回 readonly
    console.log('\n[2] 远程只读模式（模拟）');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function () {
          const origFetch = window.fetch;
          window.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : input.url;
            const resp = await origFetch.apply(this, arguments);
            if (url.indexOf('/api/session') >= 0) {
              const data = await resp.clone().json();
              data.data.local = false;
              data.data.readonly = true;
              data.data.lan = true;
              data.data.client = '192.168.20.99';
              return new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            return resp;
          };
        })();
      `,
    });

    loadP = cdp.waitFor('Page.loadEventFired');
    await cdp.send('Page.reload', { ignoreCache: true });
    await loadP;
    await sleep(1500);

    await check('只读模式隐藏「新增」按钮', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1000);
      const has = await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')]
        .some(b => b.textContent.includes('新增'))`);
      assert(!has, '只读模式不应有新增按钮');
    });

    await check('只读模式显示「只读模式」徽标', async () => {
      const has = await cdp.eval(`document.body.textContent.includes('只读模式')`);
      assert(has, '应显示只读模式提示');
    });

    await check('只读模式隐藏导入按钮', async () => {
      const has = await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')]
        .some(b => b.textContent.includes('导入'))`);
      assert(!has, '只读模式不应有导入按钮');
    });

    await check('只读模式保留导出按钮', async () => {
      const has = await cdp.eval(`[...document.querySelectorAll('.toolbar .btn')]
        .some(b => b.textContent.includes('导出'))`);
      assert(has, '只读模式应保留导出');
    });

    await check('只读模式行操作只剩「详情」', async () => {
      const texts = await cdp.eval(`(() => {
        const row = document.querySelector('table.grid tbody tr');
        if (!row) return ['NO_ROW'];
        return [...row.querySelectorAll('button')].map(b => b.textContent);
      })()`);
      assert(texts.includes('详情'), '应有详情按钮');
      assert(!texts.includes('编辑'), '不应有编辑按钮');
      assert(!texts.includes('删除'), '不应有删除按钮');
      assert(!texts.some(t => t.includes('流转')), '不应有流转按钮');
    });

    await check('只读模式详情弹窗无编辑与流转按钮', async () => {
      await cdp.eval(`(() => {
        const row = document.querySelector('table.grid tbody tr');
        [...row.querySelectorAll('button')].find(b => b.textContent === '详情').click();
      })()`);
      await sleep(600);
      const texts = await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')]
        .map(b => b.textContent)`);
      assert(texts.includes('关闭'), '应有关闭按钮');
      assert(!texts.includes('编辑'), '详情不应有编辑按钮：' + texts.join(','));
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(300);
    });

    await check('只读模式隐藏备份按钮', async () => {
      const hidden = await cdp.eval(`(() => {
        const b = document.getElementById('btnBackup');
        return !b || b.style.display === 'none';
      })()`);
      assert(hidden, '只读模式应隐藏备份按钮');
    });

    await check('只读模式侧栏提示正确', async () => {
      const has = await cdp.eval(`(() => {
        const f = document.querySelector('.sidebar-foot');
        return f ? f.textContent.includes('在本机操作') : false;
      })()`);
      assert(has, '侧栏应有只读提示');
    });

    await check('只读模式看板正常渲染', async () => {
      await cdp.eval(`location.hash = '#/dashboard'`);
      await sleep(1500);
      const n = await cdp.eval('document.querySelectorAll(".kpi").length');
      assert(n >= 15, 'KPI 卡片数: ' + n);
    });

    await check('只读模式所有模块可访问', async () => {
      for (const key of ['hazards', 'risks', 'equipments', 'permits']) {
        await cdp.eval(`location.hash = '#/${key}'`);
        await sleep(700);
        const ok = await cdp.eval(`!!document.querySelector('.card')`);
        assert(ok, `${key} 页面未渲染`);
      }
    });

    await check('只读模式无前端报错', async () => {
      const real = errors.filter(e => !/status of 40[03]/.test(e));
      assert(real.length === 0, real.slice(0, 2).join(' | '));
    });

    // 截图
    await cdp.eval(`location.hash = '#/dashboard'`);
    await sleep(1400);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-readonly.png'), Buffer.from(shot.data, 'base64'));

    await cdp.eval(`location.hash = '#/hazards'`);
    await sleep(1200);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-readonly-list.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n已保存只读模式截图');

  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    proc.kill();
    await sleep(600);
    try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(66));
  console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  fails.forEach(([n, m]) => console.log(`  失败：${n} -> ${m}`));
  console.log('='.repeat(66));
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
      if (Date.now() - start > timeout) return reject(new Error('等待浏览器超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

main().catch(e => { console.error('测试失败:', e); process.exit(1); });
