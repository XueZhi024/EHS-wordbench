/* 静态模式测试：直接用 file:// 打开 web/index.html，验证纯前端能工作。
 * 用法：node app/statictest.mjs [port]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const PORT = process.argv[2] || '8855';
const ROOT = process.cwd();
const INDEX = resolve(ROOT, 'web', 'index.html');

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
  send(method, params = {}, timeout = 20000) {
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
}

async function main() {
  if (!EDGE) { console.error('未找到浏览器'); process.exit(0); }
  if (!existsSync(INDEX)) { console.error('找不到 index.html'); process.exit(1); }

  console.log('='.repeat(70));
  console.log('静态模式测试（模拟 GitHub Pages，file:// 直接打开）');
  console.log('='.repeat(70));

  const userDir = mkdtempSync(join(tmpdir(), 'ehs-static-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const errors = [];
    cdp.handlers.push(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
      if (m.method === 'Page.javascriptDialogOpening') {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });

    const url = pathToFileURL(INDEX).href;
    const loadP = cdp.waitForLoad();
    await cdp.send('Page.navigate', { url });
    await loadP;
    await sleep(2000);

    console.log('\n[1] 模式检测');
    await check('检测到静态模式', async () => {
      const mode = await cdp.eval('window.RUN_MODE || (typeof RUN_MODE !== "undefined" ? RUN_MODE : "unknown")');
      // RUN_MODE 在闭包里，改从页面标记判断
      const hasBundle = await cdp.eval('!!window.__EHS_BUNDLE__');
      const hasLocal = await cdp.eval('!!window.LocalAPI');
      assert(hasBundle, '未加载数据包');
      assert(hasLocal, '未加载本地数据层');
    });

    await check('bundle 数据已加载', async () => {
      const info = await cdp.eval(`(() => {
        const b = window.__EHS_BUNDLE__;
        return { total: b.meta.total, collections: b.schema.collections.length };
      })()`);
      assert(info.total > 0, '数据为空');
      assert(info.collections === 10, '集合数: ' + info.collections);
      console.log(`       数据包: ${info.total} 条, ${info.collections} 个集合`);
    });

    console.log('\n[2] 页面渲染');
    await check('侧边栏渲染完整', async () => {
      const n = await cdp.eval('document.querySelectorAll(".nav a").length');
      assert(n === 11, '导航项数: ' + n);
    });

    await check('看板 KPI 渲染', async () => {
      const n = await cdp.eval('document.querySelectorAll(".kpi").length');
      assert(n >= 15, 'KPI 数: ' + n);
    });

    await check('图表已绘制', async () => {
      const info = await cdp.eval(`(() => {
        const svgs = [...document.querySelectorAll('svg.chart')];
        const canvases = [...document.querySelectorAll('canvas')];
        let painted = 0;
        canvases.forEach(c => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 400) if (d[i] > 0) { painted++; break; }
        });
        return { svg: svgs.length, canvas: canvases.length, painted };
      })()`);
      assert(info.painted >= 3, '已绘制图表数: ' + info.painted);
    });

    await check('看板数据来自本地', async () => {
      const k = await cdp.eval(`(() => {
        const els = [...document.querySelectorAll('.kpi .value')];
        return els.slice(0, 4).map(e => e.textContent.trim());
      })()`);
      assert(k.length >= 4, 'KPI 值为空');
      console.log(`       前4个KPI: ${k.join(' | ')}`);
    });

    console.log('\n[3] 列表页');
    await check('隐患列表有数据', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1200);
      const rows = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(rows >= 10, '行数: ' + rows);
    });

    await check('疑虑列表有数据', async () => {
      await cdp.eval(`location.hash = '#/concerns'`);
      await sleep(1200);
      const rows = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(rows >= 5, '行数: ' + rows);
    });

    await check('事故列表有数据', async () => {
      await cdp.eval(`location.hash = '#/incidents'`);
      await sleep(1200);
      const info = await cdp.eval(`(() => {
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        const hasLevel = document.body.textContent.includes('急救箱事件') ||
                         document.body.textContent.includes('医疗处置事件') ||
                         document.body.textContent.includes('未遂事件');
        return { rows, hasLevel };
      })()`);
      assert(info.rows >= 10, '行数: ' + info.rows);
      assert(info.hasLevel, '未显示事件大类');
    });

    console.log('\n[4] 搜索筛选');
    await check('搜索能过滤', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1000);
      const before = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '配电';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(900);
      const after = await cdp.eval('document.querySelectorAll("table.grid tbody tr").length');
      assert(after >= 1 && after < before, `过滤异常: ${before} → ${after}`);
    });

    console.log('\n[5] 新增记录（写 localStorage）');
    await check('新增隐患成功', async () => {
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
        set('title', '静态测试-新增的隐患');
        set('category', '电气安全');
        set('level', '一般隐患');
        set('source', '日常巡检');
        set('foundDate', new Date().toISOString().slice(0,10));
        set('dept', '生产部');
        set('responsible', '测试员');
        set('deadline', new Date(Date.now() + 15*86400000).toISOString().slice(0,10));
      })()`);
      await cdp.eval(`[...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent === '保存').click()`);
      await sleep(1500);
      const closed = await cdp.eval('!document.querySelector(".modal")');
      assert(closed, '弹窗未关闭，保存可能失败');
    });

    await check('新记录出现在列表', async () => {
      // 新增后列表回到第1页，但按日期排序时新记录可能不在首页
      // 用搜索精确定位更可靠
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '静态测试-新增的隐患';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(1000);
      const found = await cdp.eval(`(() => {
        return [...document.querySelectorAll('table.grid tbody tr')]
          .some(tr => tr.textContent.includes('静态测试-新增的隐患'));
      })()`);
      assert(found, '搜索后仍未找到新记录');
      // 清空搜索
      await cdp.eval(`(() => {
        const inp = document.querySelector('.toolbar input[type=search]');
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(800);
    });

    await check('数据已写入 localStorage', async () => {
      const info = await cdp.eval(`(() => {
        const raw = localStorage.getItem('ehs_workbench_data_v1');
        if (!raw) return { ok: false };
        const d = JSON.parse(raw);
        const found = (d.data.hazards || []).some(h => h.title === '静态测试-新增的隐患');
        return { ok: true, found, total: Object.values(d.data).reduce((s, a) => s + a.length, 0) };
      })()`);
      assert(info.ok, 'localStorage 无数据');
      assert(info.found, '新记录未持久化');
      console.log(`       已持久化 ${info.total} 条`);
    });

    await check('刷新后数据仍在', async () => {
      const loadP2 = cdp.waitForLoad();
      await cdp.send('Page.reload');
      await loadP2;
      await sleep(2000);
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1200);
      const found = await cdp.eval(`(() => {
        return [...document.querySelectorAll('table.grid tbody tr')]
          .some(tr => tr.textContent.includes('静态测试-新增的隐患'));
      })()`);
      assert(found, '刷新后数据丢失');
    });

    console.log('\n[6] 数据管理面板');
    await check('「数据管理」按钮存在', async () => {
      const info = await cdp.eval(`(() => {
        const b = document.getElementById('btnDataInfo');
        return { exists: !!b, text: b ? b.textContent.trim() : '' };
      })()`);
      assert(info.exists, '缺少按钮');
      assert(info.text === '数据管理', '按钮文字: ' + info.text);
    });

    await check('数据管理面板能打开', async () => {
      await cdp.eval(`document.getElementById('btnDataInfo').click()`);
      await sleep(700);
      const info = await cdp.eval(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return { open: false };
        const t = m.textContent;
        return {
          open: true,
          hasExport: t.includes('导出全部数据'),
          hasImport: t.includes('导入数据'),
          hasReset: t.includes('恢复初始数据'),
          hasClear: t.includes('清空所有数据'),
          hasStorage: t.includes('localStorage'),
        };
      })()`);
      assert(info.open, '面板未打开');
      assert(info.hasExport && info.hasImport && info.hasReset && info.hasClear, '按钮不全');
      assert(info.hasStorage, '缺少存储说明');
    });

    await check('关闭面板', async () => {
      await cdp.eval(`document.querySelector('.modal-head .x').click()`);
      await sleep(400);
    });

    console.log('\n[6b] Excel 功能');
    await check('XLSX 模块已加载', async () => {
      const info = await cdp.eval(`(() => ({
        hasXLSX: !!window.XLSX,
        hasBuild: !!(window.XLSX && window.XLSX.build),
        hasRead: !!(window.XLSX && window.XLSX.read),
        hasBiz: !!window.Biz,
      }))()`);
      assert(info.hasXLSX, 'XLSX 未加载');
      assert(info.hasBuild && info.hasRead, 'XLSX 方法缺失');
      assert(info.hasBiz, 'Biz 未加载');
    });

    await check('能生成有效 xlsx 字节', async () => {
      const info = await cdp.eval(`(async () => {
        const bytes = window.XLSX.build([{
          name: '测试',
          rows: [['编号', '名称'], ['A-001', '测试项']],
        }]);
        // xlsx 是 zip，开头应为 PK
        const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;
        return { size: bytes.length, isZip };
      })()`);
      assert(info.isZip, '不是有效的 ZIP/xlsx');
      assert(info.size > 300, '文件过小: ' + info.size);
      console.log(`       生成 ${info.size} 字节`);
    });

    await check('能读回自己生成的 xlsx', async () => {
      const info = await cdp.eval(`(async () => {
        const bytes = window.XLSX.build([{
          name: '测试',
          rows: [['编号', '名称'], ['A-001', '测试项'], ['A-002', '第二项']],
        }]);
        const sheets = await window.XLSX.read(bytes);
        return {
          count: sheets.length,
          name: sheets[0] ? sheets[0].name : '',
          rows: sheets[0] ? sheets[0].rows : [],
        };
      })()`);
      assert(info.count >= 1, '未读到工作表');
      assert(info.rows.length === 3, '行数: ' + info.rows.length);
      assert(info.rows[0][0] === '编号', '表头错误: ' + info.rows[0][0]);
      assert(info.rows[1][1] === '测试项', '数据错误: ' + info.rows[1][1]);
      console.log(`       读回 ${info.rows.length} 行`);
    });

    await check('导入能按编号 upsert', async () => {
      const info = await cdp.eval(`(async () => {
        const L = window.LocalAPI;
        const coll = L.getSchema().collections.find(c => c.key === 'hazards');
        const t = new Date().toISOString().slice(0, 10);
        const fut = new Date(Date.now() + 15*86400000).toISOString().slice(0, 10);
        // 提供全部必填字段
        const bytes = window.XLSX.build([{
          name: '隐患',
          rows: [
            ['编号', '隐患描述', '隐患类别', '隐患等级', '发现来源',
             '发现日期', '责任部门', '整改责任人', '整改期限'],
            ['', 'Excel导入测试-新增记录', '电气安全', '一般隐患', '日常巡检',
             t, '生产部', '测试员', fut],
          ],
        }]);
        const file = new File([bytes], 'test.xlsx',
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const before = L.all('hazards').length;
        const r = await window.Biz.importCollection(file, 'hazards', coll, L);
        const after = L.all('hazards').length;
        return { before, after, inserted: r.inserted, skipped: r.skipped,
                 errors: r.errors.slice(0, 2) };
      })()`);
      assert(info.inserted === 1, '应新增1条，实际: ' + JSON.stringify(info));
      assert(info.after === info.before + 1, '数量未增加');
      console.log(`       ${info.before} → ${info.after} 条`);
    });

    await check('导入缺少必填项会被拒绝', async () => {
      const info = await cdp.eval(`(async () => {
        const L = window.LocalAPI;
        const coll = L.getSchema().collections.find(c => c.key === 'hazards');
        // 只给两列，缺必填
        const bytes = window.XLSX.build([{
          name: '隐患',
          rows: [['编号', '隐患描述'], ['', '缺必填的测试']],
        }]);
        const file = new File([bytes], 'bad.xlsx',
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const r = await window.Biz.importCollection(file, 'hazards', coll, L);
        return { inserted: r.inserted, skipped: r.skipped, hasError: r.errors.length > 0 };
      })()`);
      assert(info.inserted === 0, '缺必填不应新增');
      assert(info.skipped === 1, '应跳过1条');
      assert(info.hasError, '应有错误提示');
    });

    await check('导入数据可查询到', async () => {
      const found = await cdp.eval(`(() => {
        return window.LocalAPI.all('hazards')
          .some(h => String(h.title || '').indexOf('Excel导入测试') >= 0);
      })()`);
      assert(found, '导入的记录查不到');
    });

    await check('导出集合能生成 xlsx', async () => {
      const info = await cdp.eval(`(() => {
        const L = window.LocalAPI;
        const coll = L.getSchema().collections.find(c => c.key === 'hazards');
        const items = L.all('hazards').slice(0, 3);
        // 直接调 build 验证不抛错（download 会触发下载，这里只测构建）
        const fields = (coll.fields || []).filter(f => f.type !== 'computed');
        const rows = [fields.map(f => f.label)];
        items.forEach(it => rows.push(fields.map(f => {
          const v = it[f.key];
          return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
        })));
        const bytes = window.XLSX.build([{ name: '隐患', rows }]);
        return { size: bytes.length, isZip: bytes[0] === 0x50 };
      })()`);
      assert(info.isZip, '不是 xlsx');
      assert(info.size > 500, '文件过小');
      console.log(`       导出 ${info.size} 字节`);
    });

    console.log('\n[6c] HTML 报表');
    await check('报表生成函数可用', async () => {
      const has = await cdp.eval('!!(window.Biz && window.Biz.buildReport)');
      assert(has, '缺少 buildReport');
    });

    await check('报表包含完整结构', async () => {
      const info = await cdp.eval(`(async () => {
        const L = window.LocalAPI;
        const d = await L.dashboard('', '', '');
        const html = window.Biz.buildReport(d, L.getSchema(), k => L.all(k));
        return {
          len: html.length,
          isHtml: html.indexOf('<!DOCTYPE html>') === 0,
          hasTitle: html.includes('安全管理数据报表'),
          hasKpi: html.includes('核心指标'),
          hasCharts: html.includes('数据分析'),
          hasAlerts: html.includes('待办提醒'),
          hasTables: html.includes('台账明细'),
          svgCount: (html.match(/<svg/g) || []).length,
          tableCount: (html.match(/<table/g) || []).length,
          noExternal: !/<script[^>]+src=["']https?:/.test(html) &&
                       !/<link[^>]+href=["']https?:/.test(html),
        };
      })()`);
      assert(info.isHtml, '不是完整 HTML');
      assert(info.hasTitle && info.hasKpi && info.hasCharts, '结构不全');
      assert(info.hasAlerts && info.hasTables, '缺少提醒或台账');
      assert(info.svgCount >= 6, '图表数: ' + info.svgCount);
      assert(info.tableCount >= 10, '表格数: ' + info.tableCount);
      assert(info.noExternal, '存在外部资源依赖');
      console.log(`       ${Math.round(info.len/1024)} KB, ${info.svgCount} 图表, ${info.tableCount} 表格`);
    });

    console.log('\n[6d] 清理 Excel 测试数据');
    await check('删除导入的测试记录', async () => {
      const n = await cdp.eval(`(() => {
        const L = window.LocalAPI;
        let n = 0;
        L.all('hazards').forEach(h => {
          if (String(h.title || '').indexOf('Excel导入测试') >= 0) {
            L.remove('hazards', h.id);
            n++;
          }
        });
        return n;
      })()`);
      assert(n >= 1, '未删除记录');
      console.log(`       删除 ${n} 条`);
    });

    console.log('\n[7] 状态流转');
    await check('流转菜单可用', async () => {
      await cdp.eval(`location.hash = '#/hazards'`);
      await sleep(1200);
      const ok = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('静态测试-新增的隐患'));
        if (!row) return false;
        const btn = [...row.querySelectorAll('button')].find(b => b.textContent.includes('流转'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assert(ok, '未找到流转按钮');
      await sleep(500);
      const n = await cdp.eval('document.querySelectorAll(".popmenu div").length');
      assert(n >= 1, '菜单项: ' + n);
    });

    await check('执行流转后状态变化', async () => {
      await cdp.eval(`document.querySelector('.popmenu div').click()`);
      await sleep(1500);
      const status = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('静态测试-新增的隐患'));
        if (!row) return '';
        return [...row.querySelectorAll('.badge')].map(b => b.textContent.trim()).join(',');
      })()`);
      assert(status.includes('整改中'), '状态: ' + status);
    });

    console.log('\n[8] 清理与检查');
    await check('删除测试数据', async () => {
      await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('table.grid tbody tr')];
        const row = rows.find(r => r.textContent.includes('静态测试-新增的隐患'));
        if (!row) return;
        [...row.querySelectorAll('button')].find(b => b.textContent === '删除').click();
      })()`);
      await sleep(800);
      const gone = await cdp.eval(`(() => {
        return ![...document.querySelectorAll('table.grid tbody tr')]
          .some(tr => tr.textContent.includes('静态测试-新增的隐患'));
      })()`);
      assert(gone, '删除失败');
    });

    await check('无前端报错', async () => {
      const real = errors.filter(e =>
        !/status of 40[0-9]/.test(e) && !/Failed to load resource/.test(e));
      assert(real.length === 0, real.slice(0, 2).join(' | '));
    });

    // 截图
    await cdp.eval(`location.hash = '#/dashboard'`);
    await sleep(2000);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'docs', 'screenshot-static.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n已保存 docs/screenshot-static.png');

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

// 给 CDP 加一个等待加载的辅助
CDP.prototype.waitForLoad = function (timeout = 20000) {
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
};

main().catch(e => { console.error('测试失败:', e); process.exit(1); });
