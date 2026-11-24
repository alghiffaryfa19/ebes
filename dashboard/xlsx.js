// Minimal, dependency-free XLSX reader (zip + sheet XML parser).
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function unzip(buf) {
  // Locate End Of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Bukan file ZIP/XLSX yang valid');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
  }
  return files;
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

// Strip namespace prefixes (x:row -> row) to simplify parsing
const stripNs = (xml) => xml.replace(/<(\/?)[A-Za-z0-9_]+:/g, '<$1');

function textOf(fragment) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out += decode(m[1]);
  return out;
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(path) {
  const files = unzip(fs.readFileSync(path));
  const get = (name) => (files[name] ? stripNs(files[name]().toString('utf8')) : null);

  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ss))) shared.push(textOf(m[1]));
  }

  // First sheet
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (!files[sheetPath]) sheetPath = Object.keys(files).find((f) => /^xl\/worksheets\/[^/]+\.xml$/.test(f));
  const xml = get(sheetPath);
  if (!xml) throw new Error('Sheet tidak ditemukan');

  const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const row = [];
    const body = rm[1] || '';
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, idx = 0;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const r = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (r) idx = colIndex(r[1]);
      const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      let v = '';
      if (t === 'inlineStr') v = textOf(inner);
      else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        v = vm ? decode(vm[1]) : '';
        if (t === 's') v = shared[+v] ?? '';
      }
      row[idx] = v;
      idx++;
    }
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => (h || '').trim());
  return rows.slice(1).filter((r) => r.some((c) => c !== undefined && c !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
}

module.exports = { readXlsx };

