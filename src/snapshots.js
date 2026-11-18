'use strict';
/**
 * Camera snapshots (flagged "proof" pictures and random checks).
 * The pictures are kept as small JPEG files on the server's disk (not in the database, which has little room),
 * in SNAPSHOT_DIR (default: a "snapshots" folder next to the app folder, so deploys don't touch it).
 * The database keeps one row per picture. If the disk can't be written, the picture goes into the row instead.
 * Deleted when the exam or class is archived, and 30 days after the exam closes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const DIR = () => process.env.SNAPSHOT_DIR || path.resolve(__dirname, '..', '..', 'snapshots');
const KEEP_DAYS = 30;
const fileOf = (name) => path.join(DIR(), path.basename(String(name)));

/** Saves one picture; returns the new row's id. */
async function save(attemptId, event, kind, bytes) {
  const id = crypto.randomUUID();
  let file = null;
  try {
    await fs.promises.mkdir(DIR(), { recursive: true });
    await fs.promises.writeFile(fileOf(id + '.jpg'), bytes);
    file = id + '.jpg';
  } catch (e) {
    console.error('Snapshot not written to disk, keeping it in the database:', e.message);
  }
  await db.query('INSERT INTO attempt_snapshots (id, attempt_id, event, kind, mime, bytes, data, file) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, attemptId, event, kind, 'image/jpeg', bytes.length, file ? null : bytes, file]);
  return id;
}

/** The picture's bytes, or null when it is gone. */
async function read(row) {
  if (row.data) return Buffer.from(row.data);
  if (!row.file) return null;
  try { return await fs.promises.readFile(fileOf(row.file)); } catch (e) { return null; }
}

async function unlinkAll(rows) {
  await Promise.all(rows.filter((r) => r.file).map((r) => fs.promises.unlink(fileOf(r.file)).catch(() => {})));
  return rows.length;
}

/** Permanently deletes the snapshots of these exams (e.g. when they are archived). Returns how many were deleted. */
async function purgeExams(examIds) {
  if (!examIds.length) return 0;
  const rows = await db.many(`DELETE FROM attempt_snapshots s USING attempts a
      WHERE a.id = s.attempt_id AND a.exam_id = ANY($1::uuid[]) RETURNING s.file`, [examIds]);
  return unlinkAll(rows);
}

/** How many snapshots these exams have (shown before archiving). */
async function countExams(examIds) {
  if (!examIds.length) return 0;
  return (await db.one(`SELECT count(*)::int AS n FROM attempt_snapshots s JOIN attempts a ON a.id = s.attempt_id
      WHERE a.exam_id = ANY($1::uuid[])`, [examIds])).n;
}

/**
 * Removes snapshots 30 days after the exam closed (or 30 days after they were taken, for exams with no closing time),
 * and picture files whose row is gone (deleted exams, students or teachers). Runs at most twice a day, when a teacher
 * opens the exam list, so it never wakes the database by itself.
 */
let lastCleanup = 0;
function maybeCleanup() {
  if (Date.now() - lastCleanup < 12 * 3600 * 1000) return;
  lastCleanup = Date.now();
  cleanup().catch((e) => console.error('Snapshot clean-up failed:', e.message));
}
async function cleanup() {
  const old = await db.many(`DELETE FROM attempt_snapshots s USING attempts a, exams x
      WHERE a.id = s.attempt_id AND x.id = a.exam_id
        AND COALESCE(x.end_at, s.at) < now() - ($1 || ' days')::interval RETURNING s.file`, [String(KEEP_DAYS)]);
  await unlinkAll(old);
  let names = [];
  try { names = (await fs.promises.readdir(DIR())).filter((n) => /^[0-9a-f-]{36}\.jpg$/.test(n)); } catch (e) { return; }
  for (let i = 0; i < names.length; i += 1000) {
    const chunk = names.slice(i, i + 1000);
    const known = new Set((await db.many('SELECT file FROM attempt_snapshots WHERE file = ANY($1::text[])', [chunk])).map((r) => r.file));
    for (const n of chunk) {
      if (known.has(n)) continue;
      const st = await fs.promises.stat(fileOf(n)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600 * 1000) await fs.promises.unlink(fileOf(n)).catch(() => {});
    }
  }
}

module.exports = { save, read, purgeExams, countExams, maybeCleanup, cleanup, KEEP_DAYS, DIR };
