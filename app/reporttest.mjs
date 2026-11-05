/* 验证导出的 HTML 报表：用无头浏览器打开，检查结构与截图。
 * 用法：node app/reporttest.mjs <html文件路径> [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const FILE = process.argv[2];
const PORT = process.argv[3] || '8831';

if (!FILE || !existsSync(FILE)) {
  console.error('找不到报表文件:', FILE);
  process.exit(1);
}

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
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) this.handlers.forEach(h => h(m));
    });
  }
  send(method, params = {}, timeout = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时: ' + method)); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function main() {
  if (!EDGE) { console.error('未找到浏览器'); process.exit(0); }
  const url = pathToFileURL(resolve(FILE)).href;
  const sizeKb = (statSync(FILE).size / 1024).toFixed(1);

  console.log('='.repeat(66));
  console.log(`HTML 报表验证　文件 ${sizeKb} KB`);
  console.log('='.repeat(66));

  const userDir = mkdtempSync(join(tmpdir(), 'dsh-report-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const target = await waitForTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    const errors = [];
    cdp.handlers.push(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });

    const loadP = new Promise(r => {
      const h = m => { if (m.method === 'Page.loadEventFired') { r(); } };
      cdp.handlers.push(h);
      setTimeout(r, 8000);
    });
    await cdp.send('Page.navigate', { url });
    await loadP;
    await sleep(1200);

    console.log('\n[1] 文档结构');
    await check('页面标题正确', async () => {
      const t = await cdp.eval('document.title');
      assert(t.includes('安全管理数据报表'), '标题: ' + t);
    });
    await check('包含 KPI 卡片', async () => {
      const n = await cdp.eval('document.querySelectorAll(".kpi").length');
      assert(n >= 15, 'KPI 数量: ' + n);
    });
    await check('包含 6 个图表', async () => {
      const n = await cdp.eval('document.querySelectorAll("svg.chart").length');
      assert(n >= 6, '图表数量: ' + n);
    });
    await check('图表实际绘制了图形元素', async () => {
      const info = await cdp.eval(`(() => {
        const svgs = [...document.querySelectorAll('svg.chart')];
        return svgs.map(s => s.querySelectorAll('rect,path,polyline,circle,text').length);
      })()`);
      const empty = info.filter(n => n < 3);
      assert(empty.length === 0, '有图表未绘制内容: ' + JSON.stringify(info));
    });
    await check('包含全部台账表格', async () => {
      const n = await cdp.eval('document.querySelectorAll("table").length');
      assert(n >= 11, '表格数量: ' + n);
    });
    await check('表格有数据行', async () => {
      const info = await cdp.eval(`(() => {
        return [...document.querySelectorAll('table')].map(t => t.querySelectorAll('tbody tr').length);
      })()`);
      const total = info.reduce((a, b) => a + b, 0);
      assert(total >= 100, '数据行总数: ' + total);
      assert(info.filter(n => n === 0).length === 0, '存在空表格');
    });
    await check('包含待办提醒', async () => {
      const n = await cdp.eval('document.querySelectorAll(".alerts li").length');
      assert(n >= 1, '提醒项数: ' + n);
    });
    await check('状态徽标有颜色', async () => {
      const info = await cdp.eval(`(() => {
        const badges = [...document.querySelectorAll('.b')];
        return {
          total: badges.length,
          colored: badges.filter(b => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
        };
      })()`);
      assert(info.total > 50, '徽标数量: ' + info.total);
      assert(info.colored === info.total, `有 ${info.total - info.colored} 个徽标没上色`);
    });
    await check('无外部资源依赖（完全离线）', async () => {
      const info = await cdp.eval(`(() => {
        const links = [...document.querySelectorAll('link[href],script[src]')]
          .map(e => e.href || e.src)
          .filter(u => u && !u.startsWith('data:') && !u.startsWith('file:'));
        return { count: links.length, list: links.slice(0, 3) };
      })()`);
      assert(info.count === 0, '存在外部资源: ' + JSON.stringify(info.list));
    });
    await check('页面无脚本报错', async () => {
      assert(errors.length === 0, errors.slice(0, 2).join(' | '));
    });
    await check('内容完整渲染（高度足够）', async () => {
      const h = await cdp.eval('document.body.scrollHeight');
      assert(h > 4000, '页面高度: ' + h);
    });

    console.log('\n[2] 截图');
    await cdp.eval('window.scrollTo(0,0)');
    await sleep(400);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outDir = process.cwd();
    writeFileSync(join(outDir, 'docs', 'report-top.png'), Buffer.from(shot.data, 'base64'));
    console.log('  已保存 docs/report-top.png（顶部）');

    // 完整长图
    const fullH = await cdp.eval('document.body.scrollHeight');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: Math.min(fullH, 12000), deviceScaleFactor: 1, mobile: false,
    });
    await sleep(600);
    shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    writeFileSync(join(outDir, 'docs', 'report-full.png'), Buffer.from(shot.data, 'base64'));
    console.log('  已保存 docs/report-full.png（完整长图）');

  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    proc.kill();
    await sleep(500);
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
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          try {
            const list = JSON.parse(b);
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

main().catch(e => { console.error('验证失败:', e); process.exit(1); });
