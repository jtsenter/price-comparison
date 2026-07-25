// Self-check for docs/xlsx.js - the hand-rolled .xlsx writer.
//
// A corrupt workbook fails at the worst moment (in Excel, after the download),
// so this asserts the ZIP container and the sheet XML are structurally right,
// then writes a real file to /tmp that scripts/xlsx_verify.py opens with
// Python's own zipfile - an INDEPENDENT parser, so a bug in our writer can't
// hide behind a matching bug in our reader.
//
// Run: node scripts/xlsx_selfcheck.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildXlsx, excelSerial, colRef } = require('../docs/xlsx.js');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

// ── column refs ──────────────────────────────────────────────────────────────
eq(colRef(0), 'A', 'col 0 = A');
eq(colRef(25), 'Z', 'col 25 = Z');
eq(colRef(26), 'AA', 'col 26 = AA');
eq(colRef(27), 'AB', 'col 27 = AB');
eq(colRef(51), 'AZ', 'col 51 = AZ');
eq(colRef(52), 'BA', 'col 52 = BA');

// ── Excel date serial ────────────────────────────────────────────────────────
// The 1899-12-30 origin matches Excel exactly for every date from 1900-03-01
// on. Before that it reads one HIGHER than Excel, because Excel believes
// 1900-02-29 existed and so shifts its own numbering for Jan/Feb 1900 only.
// Not worth emulating a 40-year-old bug for dates no grocery export contains -
// asserted here so the discrepancy is a documented boundary, not a surprise.
eq(Math.floor(excelSerial(new Date(1900, 2, 1))), 61, '1900-03-01 -> 61 (agrees with Excel)');
eq(Math.floor(excelSerial(new Date(2000, 0, 1))), 36526, '2000-01-01 -> 36526 (agrees with Excel)');
eq(Math.floor(excelSerial(new Date(1900, 0, 1))), 2, '1900-01-01 -> 2 (Excel says 1: its leap bug, pre-1900-03 only)');
eq(Math.floor(excelSerial(new Date(2026, 6, 25))), 46228, '2026-07-25 serial');
const noon = excelSerial(new Date(2026, 6, 25, 12, 0, 0));
ok(Math.abs((noon - Math.floor(noon)) - 0.5) < 1e-9, 'midday = .5 fraction');

// ── build a workbook that exercises every cell type + nasty text ─────────────
const headers = ['Date', 'Time', 'Product', 'Previous price', 'New price', 'Store'];
const d = new Date(2026, 6, 22, 10, 20, 35);
const rows = [
  [{ t: 'd', v: d }, { t: 'time', v: d }, 'Baby Mum-Mum Rusks', { t: 'money', v: 3.85 }, { t: 'money', v: 2.85 }, 'Woolworths'],
  // XML-hostile characters must survive as text, not break the sheet
  [{ t: 'd', v: d }, { t: 'time', v: d }, 'Ben & Jerry\'s <"Half Baked"> 458ml', { t: 'money', v: 12 }, { t: 'money', v: 10.5 }, 'Coles'],
  // control char (would make Excel call the file corrupt if escaped naively)
  [{ t: 'd', v: d }, { t: 'time', v: d }, 'WeirdName', { t: 'money', v: 1 }, { t: 'money', v: 2 }, 'Coles'],
];
const buf = buildXlsx(headers, rows, { sheetName: 'Price changes', colWidths: [11, 8, 46, 14, 12, 13] });

ok(Buffer.isBuffer(buf), 'node build returns a Buffer');
ok(buf.length > 800, 'workbook has real content');
eq(buf.readUInt32LE(0), 0x04034b50, 'starts with a ZIP local-file header');
eq(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'ends with EOCD');
eq(buf.readUInt16LE(buf.length - 22 + 10), 6, 'EOCD declares 6 parts');

const s = buf.toString('latin1');
for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
  ok(s.includes(part), `contains part ${part}`);
}
ok(s.includes('<autoFilter'), 'autofilter present');
ok(s.includes('state="frozen"'), 'header row frozen');
ok(s.includes('name="Price changes"'), 'sheet name applied');
ok(s.includes('Ben &amp; Jerry&apos;s &lt;&quot;Half Baked&quot;&gt;'), 'XML-hostile text escaped');
ok(s.includes('Weird') && !s.includes('Weird'), 'control char stripped, not emitted raw');
ok(!s.includes('<t xml:space="preserve"></t>'), 'no empty inline strings emitted');
// money/date cells must be NUMBERS (<v>), never inline strings - the whole point
ok(/<c r="D2" s="4"><v>3\.85<\/v><\/c>/.test(s), 'price written as a number cell, money-styled');
ok(/<c r="A2" s="2"><v>/.test(s), 'date written as a number cell, date-styled');
ok(/<c r="C2"[^>]*t="inlineStr"/.test(s), 'product written as an inline string');

// Empty/missing cells must not produce malformed XML
const buf2 = buildXlsx(['A', 'B'], [['x', null], [undefined, 0]], {});
ok(buf2.length > 400, 'workbook with empty cells still builds');
ok(buf2.toString('latin1').includes('<v>0</v>'), 'zero is written, not treated as blank');

// Byte-for-byte determinism (fixed DOS timestamp) - a moving mtime would make
// every export differ and quietly defeat any future diffing.
ok(Buffer.compare(buildXlsx(headers, rows, { sheetName: 'Price changes' }),
                  buildXlsx(headers, rows, { sheetName: 'Price changes' })) === 0, 'output is deterministic');

const out = path.join(os.tmpdir(), 'pw_xlsx_selfcheck.xlsx');
fs.writeFileSync(out, buf);
ok(fs.statSync(out).size === buf.length, 'file written to ' + out);

console.log(`xlsx_selfcheck: all ${n} cases passed`);
console.log(`wrote ${out} - verify with: python scripts/xlsx_verify.py`);
