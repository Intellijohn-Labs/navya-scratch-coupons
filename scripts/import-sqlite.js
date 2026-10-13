// One-time copy of the old local SQLite data (data/navya.db) into Neon Postgres.
// Keeps every id and coupon code, so coupons that were already printed keep working.
//   npm run db:import-sqlite            (refuses if Neon already has data)
//   npm run db:import-sqlite -- --force (wipes Neon's tables first)
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { pool, q, tx } = require('../db');

const file = path.join(__dirname, '..', 'data', 'navya.db');
const force = process.argv.includes('--force');

(async () => {
  if (!fs.existsSync(file)) throw new Error(`No SQLite file at ${file}`);
  const lite = new DatabaseSync(file, { readOnly: true });
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

  const counts = await tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock(1984)');
    await t.query(schema);
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM gifts', [], t);
    if (n && !force) throw new Error('Neon already has data. Re-run with --force to replace it.');
    await t.query('TRUNCATE coupons, batches, gifts, settings RESTART IDENTITY CASCADE');

    const copy = async (table, cols) => {
      const rows = lite.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
      for (const r of rows) {
        const vals = cols.map(c => (r[c] === '' && /(_on|_at|expires|dob)$/.test(c)) ? null : r[c]);
        await q(`INSERT INTO ${table}(${cols.join(', ')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(', ')})`, vals, t);
      }
      if (cols.includes('id')) await t.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1))`);
      return rows.length;
    };

    return {
      settings: await copy('settings', ['key', 'value']),
      gifts: await copy('gifts', ['id', 'name', 'description', 'image', 'kind', 'weight', 'stock_total', 'stock_used', 'valid_days', 'bumper', 'active', 'created_at']),
      batches: await copy('batches', ['id', 'name', 'headline', 'subline', 'theme', 'expires_on', 'count', 'sample', 'created_at']),
      coupons: await copy('coupons', ['id', 'code', 'batch_id', 'serial', 'status', 'scans', 'first_scan_at', 'gift_id', 'gift_name', 'gift_kind',
        'reward_code', 'reward_expires', 'claim_token', 'customer_name', 'phone', 'area', 'dob', 'occasion', 'consent', 'device', 'ip',
        'claimed_at', 'redeemed_at', 'redeemed_note']),
    };
  });
  console.log('Imported into Neon:', counts);
})()
  .catch(e => { console.error('Import failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
