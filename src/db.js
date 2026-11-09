// Database access. Uses PostgreSQL when DATABASE_URL is set (production),
// otherwise an embedded PostgreSQL (PGlite) stored in ./data — handy for trying
// the site on your own computer and for the tests.
const fs = require('fs');
const path = require('path');

let impl = null;

async function connect(options = {}) {
  const url = options.databaseUrl !== undefined ? options.databaseUrl : process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: url, ssl, max: Number(process.env.DB_POOL_SIZE || 5) });
    impl = {
      kind: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (sql, params) => client.query(sql, params) });
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = options.dataDir === undefined ? path.join(__dirname, '..', 'data', 'pglite') : options.dataDir;
    if (dir) fs.mkdirSync(path.dirname(dir), { recursive: true });
    const lite = dir ? new PGlite(dir) : new PGlite(); // no dir = in memory (tests)
    await lite.waitReady;
    // PGlite runs one statement at a time; queue so transactions don't interleave
    let chain = Promise.resolve();
    const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
    impl = {
      kind: 'pglite',
      query: (sql, params) => serial(() => lite.query(sql, params)),
      tx: (fn) => serial(() => lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) }))),
      close: () => lite.close(),
    };
  }
  await migrate();
  return impl;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Run statement by statement (PGlite and pg both accept this)
  const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const st of statements) await impl.query(st);
}

const db = {
  connect,
  query: (sql, params) => impl.query(sql, params || []),
  one: async (sql, params) => (await impl.query(sql, params || [])).rows[0] || null,
  many: async (sql, params) => (await impl.query(sql, params || [])).rows,
  /** Runs fn({ query }) in a transaction. */
  tx: (fn) => impl.tx(fn),
  close: () => impl && impl.close(),
  get kind() { return impl && impl.kind; },
};

module.exports = db;
