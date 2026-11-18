'use strict';
/**
 * Nightly database backups, written by the site itself (no extra tools on the server).
 *
 * A backup is one gzip file of JSON lines: a header line, then {"t": table, "r": [rows]} lines, table by table in an
 * order that respects foreign keys. Tables are read in small batches, so a big table doesn't fill the memory.
 * Files go to BACKUP_DIR (default: a "backups" folder next to the app folder, i.e. ~/exam-wizard/backups); the newest
 * 14 are kept. Restore into an EMPTY database with:  node deploy/restore-backup.js <file>
 *
 * The nightly run starts at about 2 AM (site time zone) and needs nothing from the database until then, so it wakes
 * the database once a night.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');

const DIR = () => process.env.BACKUP_DIR || path.resolve(__dirname, '..', '..', 'backups');
const KEEP = 14;
const BATCH = 200;

async function tableInfo(q) {
  const tables = (await q(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
  const cols = (await q(`SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
  const fks = (await q(`SELECT tc.table_name AS child, ccu.table_name AS parent FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`)).rows;
  // parents first; a cycle (or a table pointing at itself) is broken by the restore's retry passes
  const order = [], seen = new Set(), busy = new Set();
  const visit = (t) => {
    if (seen.has(t) || busy.has(t)) return;
    busy.add(t);
    fks.filter((f) => f.child === t && f.parent !== t).forEach((f) => visit(f.parent));
    busy.delete(t); seen.add(t); order.push(t);
  };
  tables.forEach(visit);
  return order.map((t) => ({ name: t, columns: cols.filter((c) => c.t === t).map((c) => ({ name: c.c, type: c.d })) }));
}

const enc = (v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v);

/** Writes one backup file now; returns { file, bytes, rows }. */
async function backupNow() {
  await fs.promises.mkdir(DIR(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(DIR(), 'backup-' + stamp + '.jsonl.gz');
  const tmp = file + '.part';
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const write = (obj) => new Promise((resolve) => { if (gz.write(JSON.stringify(obj) + '\n')) resolve(); else gz.once('drain', resolve); });
  const q = (sql, p) => db.query(sql, p);
  const info = await tableInfo(q);
  await write({ backup: 'exam-wizard', version: 1, createdAt: new Date().toISOString(), tables: info });
  let rows = 0;
  for (const t of info) {
    const names = t.columns.map((c) => '"' + c.name + '"');
    for (let off = 0; ; off += BATCH) {
      const r = (await q(`SELECT ${names.join(', ')} FROM "${t.name}" ORDER BY 1 LIMIT ${BATCH} OFFSET ${off}`)).rows;
      if (!r.length) break;
      await write({ t: t.name, r: r.map((row) => t.columns.map((c) => enc(row[c.name]))) });
      rows += r.length;
      if (r.length < BATCH) break;
    }
  }
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.end(); });
  await fs.promises.rename(tmp, file);
  await prune();
  const bytes = (await fs.promises.stat(file)).size;
  return { file: path.basename(file), bytes, rows };
}

async function list() {
  let names = [];
  try { names = (await fs.promises.readdir(DIR())).filter((n) => /^backup-[\dT-]+\.jsonl\.gz$/.test(n)); } catch (e) { return []; }
  const out = [];
  for (const n of names.sort().reverse()) {
    const st = await fs.promises.stat(path.join(DIR(), n)).catch(() => null);
    if (st) out.push({ name: n, bytes: st.size, at: st.mtime.toISOString() });
  }
  return out;
}

async function prune() {
  const all = await list();
  for (const f of all.slice(KEEP)) await fs.promises.unlink(path.join(DIR(), f.name)).catch(() => {});
}

/** Full path of a backup file, or null (only plain backup names are accepted). */
function fileOf(name) {
  const n = path.basename(String(name || ''));
  return /^backup-[\dT-]+\.jsonl\.gz$/.test(n) ? path.join(DIR(), n) : null;
}

/** Puts a backup into an empty database. query(sql, params) runs on that database (its tables already created). */
async function restore(file, query) {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
  const head = JSON.parse(lines[0]);
  if (head.backup !== 'exam-wizard') throw new Error('This is not an Exam Wizard backup.');
  const types = {};
  head.tables.forEach((t) => { types[t.name] = t.columns; });
  const dec = (v, c) => (v && typeof v === 'object' && v.$b64 !== undefined ? Buffer.from(v.$b64, 'base64')
    : (c.type === 'json' || c.type === 'jsonb') && v !== null ? JSON.stringify(v) : v);
  let waiting = [];
  let done = 0;
  const insert = async (t, row) => {
    const cols = types[t];
    const sql = `INSERT INTO "${t}" (${cols.map((c) => '"' + c.name + '"').join(', ')}) VALUES (${cols.map((c, i) => '$' + (i + 1)).join(', ')}) ON CONFLICT DO NOTHING`;
    await query(sql, row.map((v, i) => dec(v, cols[i])));
  };
  for (const line of lines.slice(1)) {
    const { t, r } = JSON.parse(line);
    if (!types[t]) continue;
    for (const row of r) {
      try { await insert(t, row); done++; } catch (e) { waiting.push({ t, row, err: e.message }); }
    }
  }
  // rows that point at rows further down (e.g. a folder inside a folder) go in on a later pass
  for (let pass = 0; pass < 10 && waiting.length; pass++) {
    const again = [];
    for (const w of waiting) { try { await insert(w.t, w.row); done++; } catch (e) { again.push(Object.assign(w, { err: e.message })); } }
    if (again.length === waiting.length) { waiting = again; break; }
    waiting = again;
  }
  return { rows: done, failed: waiting.map((w) => w.t + ': ' + w.err).slice(0, 20), failedCount: waiting.length };
}

/** Nightly: about 2 AM in the site's time zone, once a day. Checks the clock every 15 minutes, without the database. */
function startNightly() {
  if (process.env.BACKUPS === 'off' || !process.env.DATABASE_URL) return;
  const tz = process.env.TIME_ZONE || 'Asia/Manila';
  let running = false;
  const check = async () => {
    if (running) return;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
      .formatToParts(new Date()).map((p) => [p.type, p.value]));
    if (Number(parts.hour) < 2 || Number(parts.hour) > 5) return;
    const today = parts.year + '-' + parts.month + '-' + parts.day;
    const last = (await list())[0];
    if (last && new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(last.at)) === today) return;
    running = true;
    try { const r = await backupNow(); console.log('Backup saved:', r.file, Math.round(r.bytes / 1024) + ' KB,', r.rows, 'rows'); }
    catch (e) { console.error('Backup failed:', e.message); }
    finally { running = false; }
  };
  setInterval(() => { check().catch(() => {}); }, 15 * 60 * 1000).unref();
}

module.exports = { backupNow, list, fileOf, restore, startNightly, DIR };
