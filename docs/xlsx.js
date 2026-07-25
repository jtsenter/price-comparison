// Minimal .xlsx writer - one sheet, no dependencies, no build step.
//
// Why hand-rolled: the alternative was a ~500KB CDN library (breaks the offline
// service-worker shell and adds a third-party script to a page that holds a
// GitHub token), or CSV (Excel guesses types on import - Australian d/m/y dates
// get read as US m/d/y and prices land as text, which is exactly what you can't
// have when the file exists to be pivoted).
//
// An .xlsx is a ZIP of XML parts. We write the ZIP with the STORE method (no
// compression) so there's no deflate to implement - the files are small and
// Excel does not care. Strings are inline (t="inlineStr") so there's no
// sharedStrings table to maintain.
//
// Exposed as buildXlsx(...) on window (browser) and module.exports (node, for
// scripts/xlsx_selfcheck.js). Verified against Python's zipfile/openpyxl.

(function (root) {
  'use strict';

  const enc = new TextEncoder();

  // ── CRC32 (ZIP requires it per entry) ──────────────────────────────────────
  let _tbl = null;
  function crc32(bytes) {
    if (!_tbl) {
      _tbl = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _tbl[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ _tbl[(c ^ bytes[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }

  const xmlEsc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // XML 1.0 forbids most control chars outright - a stray one makes Excel
    // declare the whole workbook corrupt, so strip rather than escape.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Excel's day-zero is 1899-12-30 (its deliberate 1900-leap-year bug). Built
  // from LOCAL parts so the sheet shows the same wall-clock time the page does.
  function excelSerial(d) {
    const days = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 25569;
    const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
    return days + frac;
  }

  // A1-style column ref: 0->A, 25->Z, 26->AA
  function colRef(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
  }

  // Style indices must match the cellXfs order in STYLES below.
  const S = { plain: 0, header: 1, date: 2, time: 3, money: 4 };

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="165" formatCode="hh:mm"/>
<numFmt numFmtId="166" formatCode="&quot;$&quot;#,##0.00"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // One cell. `v` may be {t:'d'|'n'|'money'|'time', v:…} or a plain string/number.
  function cell(ref, val, styleOverride) {
    if (val == null || val === '') return '';
    let style = styleOverride != null ? styleOverride : S.plain;
    let num = null, text = null;
    if (val instanceof Date) { num = excelSerial(val); style = styleOverride != null ? styleOverride : S.date; }
    else if (typeof val === 'object' && val.t) {
      if (val.t === 'd') { num = excelSerial(val.v); style = S.date; }
      else if (val.t === 'time') { const s = excelSerial(val.v); num = s - Math.floor(s); style = S.time; }
      else if (val.t === 'money') { num = val.v; style = S.money; }
      else if (val.t === 'n') { num = val.v; }
      else text = String(val.v);
    }
    else if (typeof val === 'number' && isFinite(val)) num = val;
    else text = String(val);

    if (num != null && isFinite(num)) return `<c r="${ref}" s="${style}"><v>${num}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
  }

  /**
   * Build a single-sheet workbook.
   * @param {string[]} headers  column headings (row 1, bold, frozen + autofiltered)
   * @param {Array<Array>} rows each cell: string | number | Date | {t,v}
   * @param {object} [opts]     {sheetName, colWidths:number[]}
   * @returns {Blob|Buffer}     Blob in a browser, Buffer in node
   */
  function buildXlsx(headers, rows, opts) {
    opts = opts || {};
    const sheetName = (opts.sheetName || 'Sheet1').replace(/[\\\/\?\*\[\]:]/g, '').slice(0, 31) || 'Sheet1';
    const nCols = headers.length;
    const lastCol = colRef(nCols - 1);
    const lastRow = rows.length + 1;

    const cols = (opts.colWidths || []).length
      ? `<cols>${(opts.colWidths || []).map((w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';

    let sheetRows = `<row r="1">${headers.map((h, i) => cell(colRef(i) + '1', String(h), S.header)).join('')}</row>`;
    for (let r = 0; r < rows.length; r++) {
      const rn = r + 2;
      sheetRows += `<row r="${rn}">${rows[r].map((v, i) => cell(colRef(i) + rn, v)).join('')}</row>`;
    }

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}<sheetData>${sheetRows}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;

    const parts = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
      ['xl/styles.xml', STYLES],
      ['xl/worksheets/sheet1.xml', sheet],
    ];

    return zipStore(parts.map(([name, xml]) => [name, enc.encode(xml)]));
  }

  // ── ZIP (STORE, no compression) ────────────────────────────────────────────
  function zipStore(files) {
    const chunks = [], central = [];
    let offset = 0;
    // Fixed DOS timestamp: the archive's own mtime is meaningless here and a
    // moving one would make byte-identical exports differ (breaks the selfcheck).
    const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

    for (const [name, data] of files) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);      // UTF-8 filenames
      lv.setUint16(8, 0, true);           // method 0 = store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const all = [...chunks, ...central, eocd];
    const total = all.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }

    // Order matters: modern node exposes a global Blob, so sniffing Blob first
    // handed node a Blob instead of a Buffer (caught by xlsx_selfcheck). Decide
    // on the ENVIRONMENT (is there a document?), not on which globals exist.
    const inBrowser = typeof document !== 'undefined';
    if (!inBrowser && typeof Buffer !== 'undefined') return Buffer.from(out);
    if (typeof Blob !== 'undefined') {
      return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    return out;
  }

  root.buildXlsx = buildXlsx;
  root.xlsxCell = { S, excelSerial, colRef };
  if (typeof module !== 'undefined' && module.exports) module.exports = { buildXlsx, excelSerial, colRef };
})(typeof window !== 'undefined' ? window : globalThis);
