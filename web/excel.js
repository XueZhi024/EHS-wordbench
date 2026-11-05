/* 安全管理数据工作台 — 纯前端 Excel 处理
 *
 * 不依赖任何外部库，手写 XLSX（OOXML）读写：
 *   - 导出：生成标准 .xlsx（ZIP + XML），Excel/WPS 可直接打开
 *   - 导入：解析 .xlsx 的 XML，提取单元格文本
 *
 * XLSX 本质是一个 ZIP 包，包含：
 *   [Content_Types].xml
 *   _rels/.rels
 *   xl/workbook.xml
 *   xl/_rels/workbook.xml.rels
 *   xl/worksheets/sheet1.xml
 *   xl/sharedStrings.xml（可选，用于共享字符串）
 */
(function (global) {
  'use strict';

  // ================================================================ ZIP 写入

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  /** 构建一个最小的 ZIP 文件（存储模式，不压缩）。 */
  function buildZip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    files.forEach(f => {
      const nameBytes = strToBytes(f.name);
      const dataBytes = typeof f.data === 'string' ? strToBytes(f.data) : f.data;
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      // 本地文件头
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);   // 签名
      dv.setUint16(4, 20, true);           // 版本
      dv.setUint16(6, 0x0800, true);       // 标志（UTF-8）
      dv.setUint16(8, 0, true);            // 压缩方法：0 = 存储
      dv.setUint16(10, 0, true);           // 修改时间
      dv.setUint16(12, 0, true);           // 修改日期
      dv.setUint32(14, crc, true);         // CRC32
      dv.setUint32(18, size, true);        // 压缩后大小
      dv.setUint32(22, size, true);        // 原始大小
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local);
      chunks.push(dataBytes);

      // 中央目录项
      const cd = new Uint8Array(46 + nameBytes.length);
      const dv2 = new DataView(cd.buffer);
      dv2.setUint32(0, 0x02014b50, true);
      dv2.setUint16(4, 20, true);
      dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0x0800, true);
      dv2.setUint16(10, 0, true);
      dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0, true);
      dv2.setUint32(16, crc, true);
      dv2.setUint32(20, size, true);
      dv2.setUint32(24, size, true);
      dv2.setUint16(28, nameBytes.length, true);
      dv2.setUint16(30, 0, true);
      dv2.setUint16(32, 0, true);
      dv2.setUint16(34, 0, true);
      dv2.setUint16(36, 0, true);
      dv2.setUint32(38, 0, true);
      dv2.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + size;
    });

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const dv3 = new DataView(end.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(8, files.length, true);
    dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, centralSize, true);
    dv3.setUint32(16, offset, true);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach(c => { out.set(c, pos); pos += c.length; });
    central.forEach(c => { out.set(c, pos); pos += c.length; });
    out.set(end, pos);
    return out;
  }

  // ================================================================ ZIP 读取

  /** 解析 ZIP，返回 { name -> Uint8Array }。支持存储与 deflate。 */
  async function readZip(bytes) {
    const files = {};
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 找中央目录结束记录
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件');

    const count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);

    for (let n = 0; n < count; n++) {
      if (dv.getUint32(cdOffset, true) !== 0x02014b50) break;
      const method = dv.getUint16(cdOffset + 10, true);
      const compSize = dv.getUint32(cdOffset + 20, true);
      const nameLen = dv.getUint16(cdOffset + 28, true);
      const extraLen = dv.getUint16(cdOffset + 30, true);
      const commentLen = dv.getUint16(cdOffset + 32, true);
      const localOffset = dv.getUint32(cdOffset + 42, true);
      const nameBytes = bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen);
      const name = new TextDecoder('utf-8').decode(nameBytes);

      // 本地头
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 0) {
        files[name] = raw;
      } else if (method === 8) {
        try {
          files[name] = await inflateRaw(raw);
        } catch (e) {
          files[name] = new Uint8Array(0);
        }
      }
      cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /** 用浏览器内置的 DecompressionStream 解压 deflate。 */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ================================================================ XLSX 写入

  function xmlEscape(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // 移除 XML 非法控制字符
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(idx) {
    let s = '';
    let n = idx + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /**
   * 生成 xlsx。
   * @param {Array} sheets [{ name, rows: [[cell, ...], ...], colWidths?: [number] }]
   * @returns {Uint8Array}
   */
  function buildXlsx(sheets) {
    const shared = [];
    const sharedIndex = new Map();

    function si(text) {
      const t = String(text);
      if (sharedIndex.has(t)) return sharedIndex.get(t);
      const idx = shared.length;
      shared.push(t);
      sharedIndex.set(t, idx);
      return idx;
    }

    // 各工作表 XML
    const sheetXmls = sheets.map((sheet, si_) => {
      const rows = sheet.rows || [];
      const parts = [];
      parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
      parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');

      // 列宽
      if (sheet.colWidths && sheet.colWidths.length) {
        parts.push('<cols>');
        sheet.colWidths.forEach((w, i) => {
          parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
        });
        parts.push('</cols>');
      }

      parts.push('<sheetData>');
      rows.forEach((row, r) => {
        const rowNum = r + 1;
        parts.push(`<row r="${rowNum}">`);
        (row || []).forEach((cell, c) => {
          if (cell === null || cell === undefined || cell === '') return;
          const ref = `${colName(c)}${rowNum}`;
          const isNum = typeof cell === 'number' && isFinite(cell);
          if (isNum) {
            parts.push(`<c r="${ref}"><v>${cell}</v></c>`);
          } else {
            const idx = si(cell);
            parts.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
          }
        });
        parts.push('</row>');
      });
      parts.push('</sheetData></worksheet>');
      return parts.join('');
    });

    // 共享字符串
    const sharedXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
      shared.map(t => `<si><t xml:space="preserve">${xmlEscape(t)}</t></si>`).join('') +
      '</sst>';

    // workbook.xml
    const sheetsXml = sheets.map((s, i) =>
      `<sheet name="${xmlEscape(s.name || ('Sheet' + (i + 1)))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    ).join('');
    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheetsXml}</sheets></workbook>`;

    // workbook.xml.rels
    const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      ).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>';

    // Content types
    const ctXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      ).join('') +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>';

    // 根 rels
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', data: ctXml },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: relsXml },
      { name: 'xl/sharedStrings.xml', data: sharedXml },
    ];
    sheetXmls.forEach((xml, i) => {
      files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml });
    });

    return buildZip(files);
  }

  // ================================================================ XLSX 读取

  /** 解析 xlsx，返回 [{ name, rows: [[string, ...]] }] */
  async function readXlsx(bytes) {
    const files = await readZip(bytes);
    const dec = new TextDecoder('utf-8');

    // 共享字符串
    let shared = [];
    if (files['xl/sharedStrings.xml']) {
      const xml = dec.decode(files['xl/sharedStrings.xml']);
      shared = parseSharedStrings(xml);
    }

    // 工作表列表
    const sheetEntries = [];
    const wbXml = files['xl/workbook.xml'] ? dec.decode(files['xl/workbook.xml']) : '';
    const relsXml = files['xl/_rels/workbook.xml.rels']
      ? dec.decode(files['xl/_rels/workbook.xml.rels']) : '';

    // 从 workbook.xml 取 sheet 名和 rId
    const sheetRe = /<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?\/?>/g;
    let m;
    const relMap = {};
    const relRe = /<Relationship\s[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/?>/g;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      relMap[rm[1]] = rm[2];
    }

    while ((m = sheetRe.exec(wbXml)) !== null) {
      const name = decodeXmlEntities(m[1]);
      const target = relMap[m[2]] || '';
      const path = target.startsWith('/') ? target.slice(1)
        : 'xl/' + target.replace(/^\.\//, '');
      sheetEntries.push({ name, path });
    }

    // 如果没解析到，退回按序号
    if (!sheetEntries.length) {
      Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
        .sort().forEach((k, i) => sheetEntries.push({ name: 'Sheet' + (i + 1), path: k }));
    }

    const result = [];
    for (const entry of sheetEntries) {
      const raw = files[entry.path];
      if (!raw) continue;
      const xml = dec.decode(raw);
      result.push({ name: entry.name, rows: parseSheet(xml, shared) });
    }
    return result;
  }

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&amp;/g, '&');
  }

  function parseSharedStrings(xml) {
    const out = [];
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const inner = m[1];
      // 可能是 <t>text</t> 或多个 <r><t>..</t></r>
      let text = '';
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(inner)) !== null) text += decodeXmlEntities(tm[1]);
      out.push(text);
    }
    return out;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const rowNum = parseInt(rm[1], 10);
      const cells = [];
      const cellRe = /<c\s([^>]*)>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rm[2])) !== null) {
        const attrs = cm[1] || cm[3] || '';
        const inner = cm[2] || '';
        const refM = /r="([A-Z]+)(\d+)"/.exec(attrs);
        const colIdx = refM ? colToIdx(refM[1]) : cells.length;
        const typeM = /t="([^"]*)"/.exec(attrs);
        const type = typeM ? typeM[1] : 'n';

        let value = '';
        if (type === 's') {
          const vm = /<v>(\d+)<\/v>/.exec(inner);
          if (vm) value = shared[parseInt(vm[1], 10)] || '';
        } else if (type === 'inlineStr') {
          const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          if (tm) value = decodeXmlEntities(tm[1]);
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (vm) value = decodeXmlEntities(vm[1]);
        }
        while (cells.length < colIdx) cells.push('');
        cells[colIdx] = value;
      }
      while (rows.length < rowNum - 1) rows.push([]);
      rows[rowNum - 1] = cells;
    }
    return rows;
  }

  function colToIdx(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  // ================================================================ 下载

  function downloadBytes(bytes, filename, mime) {
    const blob = new Blob([bytes], {
      type: mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  global.XLSX = {
    build: buildXlsx,
    read: readXlsx,
    download: downloadBytes,
    readZip,
    buildZip,
  };
})(window);
