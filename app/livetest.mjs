/* 验证线上 GitHub Pages 是否真正可用 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const PORT = '8870';
const URL = 'https://xuezhi024.github.io/EHS-wordbench/';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
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
  send(method, params = {}, timeout = 25000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时: ' + method)); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  waitForLoad(timeout = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('页面加载超时')), timeout);
      const h = msg => {
        if (msg.method === 'Page.loadEventFired') {
          clearTimeout(t);
          this.handlers = this.handlers.filter(x => x !== h);
          resolve();
        }
      };
      this.handlers.push(h);
    });
  }
}

async function main() {
  if (!EDGE) { console.error('未找到浏览器'); process.exit(0); }
  console.log('='.repeat(70));
  console.log('线上验证：' + URL);
  console.log('='.repeat(70));

  const userDir = mkdtempSync(join(tmpdir(), 'ehs-live-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    const target = await waitForTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const errors = [];
    const failedReqs = [];
    cdp.handlers.push(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
      if (m.method === 'Network.loadingFailed') {
        failedReqs.push(m.params.errorText + ' ' + (m.params.requestId || ''));
      }
      if (m.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    console.log('\n[1] 页面加载');
    const loadP = cdp.waitForLoad();
    await cdp.send('Page.navigate', { url: URL });
    await loadP;
    await sleep(3000);

    await check('页面标题正确', async () => {
      const t = await cdp.eval('document.title');
      assert(t.includes('安全管理数据工作台'), '标题: ' + t);
    });

    await check('数据包已加载', async () => {
      const info = await cdp.eval(`(() => {
        const b = window.__EHS_BUNDLE__;
        return b ? { total: b.meta.total, cols: b.schema.collections.length } : null;
      })()`);
      assert(info, '数据包未加载');
      assert(info.total > 0, '数据为空');
      assert(info.cols === 11, '集合数: ' + info.cols);
      console.log(`       ${info.total} 条数据, ${info.cols} 个集合`);
    });

    await check('运行模式为静态', async () => {
      const info = await cdp.eval(`(() => ({
        hasLocalAPI: !!window.LocalAPI,
        hasXLSX: !!window.XLSX,
        hasBiz: !!window.Biz,
      }))()`);
      assert(info.hasLocalAPI, '缺少 LocalAPI');
      assert(info.hasXLSX, '缺少 XLSX 模块');
      assert(info.hasBiz, '缺少 Biz 模块');
    });

    console.log('\n[2] 界面渲染');
    await check('侧边栏 12 个导航项', async () => {
      const n = await cdp.eval('document.querySelectorAll(".nav a").length');
      assert(n === 12, '导航数: ' + n);
    });

    await check('看板 KPI 已渲染', async () => {
      const n = await cdp.eval('document.querySelectorAll(".kpi").length');
      assert(n >= 15, 'KPI 数: ' + n);
    });

    await check('图表已绘制', async () => {
      const n = await cdp.eval(`(() => {
        let painted = 0;
        [...document.querySelectorAll('canvas')].forEach(c => {
          try {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < d.length; i += 400) if (d[i] > 0) { painted++; break; }
          } catch (e) { /* ignore */ }
        });
        return painted;
      })()`);
      assert(n >= 3, '已绘制图表: ' + n);
    });

    await check('显示「数据存于本浏览器」', async () => {
      const has = await cdp.eval(`document.body.textContent.includes('数据存于本浏览器')`);
      assert(has, '缺少静态模式标记');
    });

    console.log('\n[3] 各模块可访问');
    for (const [key, label] of [
      ['hazards', '隐患排查治理'], ['risks', '风险分级管控'],
      ['concerns', '安全疑虑'], ['incidents', '事故事件管理'],
      ['equipments', '设备管理'], ['permits', '作业许可票'],
    ]) {
      await check(`「${label}」页面正常`, async () => {
        await cdp.eval(`location.hash = '#/${key}'`);
        await sleep(900);
        const info = await cdp.eval(`(() => ({
          title: document.getElementById('pageTitle').textContent,
          hasCard: !!document.querySelector('.card'),
          hasErr: document.body.textContent.includes('无法连接') ||
                  document.body.textContent.includes('服务器内部错误'),
        }))()`);
        assert(info.title === label, '标题: ' + info.title);
        assert(info.hasCard, '缺少内容');
        assert(!info.hasErr, '页面报错');
      });
    }

    console.log('\n[4] 写入功能');
    await check('新增记录成功', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1000);
      await cdp.eval(`(() => {
        [...document.querySelectorAll('.toolbar .btn')].find(x => x.textContent.includes('新增')).click();
      })()`);
      await sleep(600);
      await cdp.eval(`(() => {
        const set = (id, v) => {
          const n = document.getElementById('f_' + id);
          if (!n) return;
          n.value = v;
          n.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('title', '线上验证-测试记录');
        set('category', '电气安全');
        set('level', '一般隐患');
        set('source', '日常巡检');
        set('foundDate', new Date().toISOString().slice(0,10));
        set('dept', '生产部');
        set('responsible', '验证员');
        set('deadline', new Date(Date.now() + 15*86400000).toISOString().slice(0,10));
      })()`);
      await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '保存').click()`);
      await sleep(1800);
      const closed = await cdp.eval('!document.querySelector(".modal")');
      assert(closed, '弹窗未关闭');
    });

    await check('数据已存入 localStorage', async () => {
      const found = await cdp.eval(`(() => {
        const raw = localStorage.getItem('ehs_workbench_data_v1');
        if (!raw) return false;
        const d = JSON.parse(raw);
        return (d.data.hazards || []).some(h => h.title === '线上验证-测试记录');
      })()`);
      assert(found, '未持久化');
    });

    await check('刷新后数据仍在', async () => {
      const loadP2 = cdp.waitForLoad();
      await cdp.send('Page.reload');
      await loadP2;
      await sleep(2500);
      const found = await cdp.eval(`(() => {
        const raw = localStorage.getItem('ehs_workbench_data_v1');
        if (!raw) return false;
        const d = JSON.parse(raw);
        return (d.data.hazards || []).some(h => h.title === '线上验证-测试记录');
      })()`);
      assert(found, '刷新后丢失');
    });

    console.log('\n[5] 数据管理');
    await check('「数据管理」按钮存在', async () => {
      const info = await cdp.eval(`(() => {
        const b = document.getElementById('btnDataInfo');
        return { exists: !!b, text: b ? b.textContent.trim() : '' };
      })()`);
      assert(info.exists, '缺少按钮');
      assert(info.text === '数据管理', '文字: ' + info.text);
    });

    await check('数据管理面板可打开', async () => {
      await cdp.eval(`document.getElementById('btnDataInfo').click()`);
      await sleep(800);
      const info = await cdp.eval(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return { open: false };
        const t = m.textContent;
        return {
          open: true,
          hasExport: t.includes('导出全部数据'),
          hasReset: t.includes('恢复初始数据'),
        };
      })()`);
      assert(info.open, '未打开');
      assert(info.hasExport && info.hasReset, '按钮不全');
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(400);
    });

    console.log('\n[6] Excel 与报表');
    await check('XLSX 能生成文件', async () => {
      const info = await cdp.eval(`(() => {
        const b = window.XLSX.build([{ name: 'T', rows: [['a','b'],['1','2']] }]);
        return { size: b.length, isZip: b[0] === 0x50 && b[1] === 0x4B };
      })()`);
      assert(info.isZip, '不是有效 xlsx');
      console.log(`       生成 ${info.size} 字节`);
    });

    await check('HTML 报表能生成', async () => {
      const info = await cdp.eval(`(async () => {
        const L = window.LocalAPI;
        const d = await L.dashboard('', '', '');
        const html = window.Biz.buildReport(d, L.getSchema(), k => L.all(k));
        return {
          len: html.length,
          isHtml: html.indexOf('<!DOCTYPE html>') === 0,
          svg: (html.match(/<svg/g) || []).length,
          tables: (html.match(/<table/g) || []).length,
        };
      })()`);
      assert(info.isHtml, '不是 HTML');
      assert(info.svg >= 6, '图表: ' + info.svg);
      assert(info.tables >= 11, '表格: ' + info.tables);
      console.log(`       ${Math.round(info.len/1024)} KB, ${info.svg} 图表, ${info.tables} 表格`);
    });

    console.log('\n[7] 清理与检查');
    await check('删除测试数据', async () => {
      const n = await cdp.eval(`(() => {
        const L = window.LocalAPI;
        let n = 0;
        L.all('hazards').forEach(h => {
          if (String(h.title||'').indexOf('线上验证') >= 0) { L.remove('hazards', h.id); n++; }
        });
        return n;
      })()`);
      assert(n >= 1, '未删除');
    });

    await check('无脚本报错', async () => {
      const real = errors.filter(e => !/status of 40[0-9]/.test(e));
      assert(real.length === 0, real.slice(0, 2).join(' | '));
    });

    await check('无资源加载失败', async () => {
      assert(failedReqs.length === 0, failedReqs.slice(0, 3).join(' | '));
    });

    // 截图
    await cdp.eval(`location.hash = '#/dashboard'`);
    await sleep(2000);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.cwd(), 'docs', 'screenshot-live.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n已保存 docs/screenshot-live.png');

  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    proc.kill();
    await sleep(500);
    try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  fails.forEach(([n, m]) => console.log(`  失败：${n} -> ${m}`));
  console.log('='.repeat(70));
  process.exit(fail === 0 ? 0 : 1);
}

function waitForTarget(timeout = 25000) {
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
