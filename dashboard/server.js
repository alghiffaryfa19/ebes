'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsx');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..'));
const PUBLIC = path.join(__dirname, 'public');

// "23/11/2026 20.34.36" -> epoch ms
function parseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[.:](\d{1,2})(?:[.:](\d{1,2}))?)?/.exec((s || '').trim());
  if (!m) return 0;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

const FIELDS = ['Id', 'Nama', 'KodeRegistrasi', 'Universitas', 'CostItem', 'CostItemId', 'TglPengajuan',
  'Status', 'IdStatus', 'RequestDetail', 'RequestAmountIDR', 'ApprovedAmount', 'ApprovedDate',
  'Verifikator', 'Catatan', 'NoSPP', 'PICAssignEmail', 'AwalPeriode', 'AkhirPeriode'];

let cache = { sig: '', payload: null };

function listFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => {
      const st = fs.statSync(path.join(DATA_DIR, f));
      return { file: f, mtime: st.mtimeMs, size: st.size };
    });
}

function buildData() {
  const files = listFiles();
  const sig = JSON.stringify(files);
  if (cache.sig === sig && cache.payload) return cache.payload;

  const errors = [];
  const groups = new Map(); // key: nama|costitem -> list of records
  const costItems = new Map(); // name -> id (for ordering)
  const people = new Map(); // nama -> info

  for (const f of files) {
    let rows;
    try { rows = readXlsx(path.join(DATA_DIR, f.file)); }
    catch (e) { errors.push(`${f.file}: ${e.message}`); continue; }
    for (const r of rows) {
      const nama = (r.Nama || '').trim();
      const ci = (r.CostItem || '').trim();
      if (!nama || !ci) continue;
      const rec = { source: f.file, ts: parseDate(r.TglPengajuan) };
      for (const k of FIELDS) rec[k] = r[k] ?? '';
      const key = nama.toUpperCase() + '|' + ci;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
      if (!costItems.has(ci)) costItems.set(ci, +r.CostItemId || 999);
      const pk = nama.toUpperCase();
      if (!people.has(pk)) people.set(pk, { nama, universitas: r.Universitas || '', kode: r.KodeRegistrasi || '', sources: new Set() });
      people.get(pk).sources.add(f.file);
    }
  }

  const rows = {};
  for (const [key, list] of groups) {
    list.sort((a, b) => b.ts - a.ts);
    const [pk, ci] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    if (!rows[pk]) rows[pk] = {};
    rows[pk][ci] = { latest: list[0], history: list };
  }

  const payload = {
    generatedAt: Date.now(),
    files,
    errors,
    costItems: [...costItems.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map((e) => e[0]),
    people: [...people.entries()]
      .map(([pk, p]) => ({ key: pk, nama: p.nama, universitas: p.universitas, kode: p.kode, sources: [...p.sources], items: rows[pk] || {} }))
      .sort((a, b) => a.nama.localeCompare(b.nama)),
  };
  payload.version = sig;
  cache = { sig, payload };
  return payload;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function startServer(port = PORT) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/data') {
      try {
        const data = buildData();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: JSON.stringify(listFiles()) }));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '');
    let file = path.join(DATA_DIR, rel);
    if (!file.startsWith(DATA_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(PUBLIC, rel);
    }
    if ((!file.startsWith(DATA_DIR) && !file.startsWith(PUBLIC)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} sedang dipakai. Mencoba port ${+port + 1}...`);
      startServer(+port + 1);
    } else {
      console.error(err);
    }
  });

  srv.listen(port, () => {
    console.log(`Dashboard berjalan di http://localhost:${port}`);
    console.log(`Membaca file .xlsx dari: ${DATA_DIR}`);
  });
}

if (require.main === module || require.main?.filename === path.join(DATA_DIR, 'server.js')) {
  startServer();
}

module.exports = { buildData, listFiles, startServer };

