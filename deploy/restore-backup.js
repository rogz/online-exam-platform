#!/usr/bin/env node
// Restores a nightly backup (backup-….jsonl.gz from ~/exam-wizard/backups or Admin → Site settings) into an EMPTY
// PostgreSQL database. The site's tables are created first, then the rows are copied in.
//
//   DATABASE_URL='postgres://…/new_empty_db' node deploy/restore-backup.js ~/exam-wizard/backups/backup-2026-11-18T18-00-00.jsonl.gz
//
// Then point the site at that database (DATABASE_URL in ~/exam-wizard/.env) and restart it:
//   sudo systemctl restart exam-wizard
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const backup = require(path.join(__dirname, '..', 'src', 'backup'));

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: DATABASE_URL=… node deploy/restore-backup.js <backup file> [--force]'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL to the EMPTY database to restore into.'); process.exit(1); }
  await db.connect();
  const users = await db.one('SELECT count(*)::int AS n FROM users');
  if (users.n > 0 && !process.argv.includes('--force')) {
    console.error('That database is not empty (' + users.n + ' users). Use a new, empty database (or add --force to merge).');
    process.exit(1);
  }
  const r = await backup.restore(file, (sql, p) => db.query(sql, p));
  console.log('Restored ' + r.rows + ' rows.' + (r.failedCount ? ' ' + r.failedCount + ' rows could not be restored, e.g.:\n  ' + r.failed.join('\n  ') : ''));
  await db.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
