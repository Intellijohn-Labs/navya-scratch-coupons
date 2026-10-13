// Creates the tables (and the demo data on a brand-new database), then prints a summary.
//   npm run db:setup
const { pool, q, ready } = require('../db');

(async () => {
  await ready();
  const rows = await q(`SELECT 'gifts' AS t, COUNT(*) AS n FROM gifts UNION ALL
    SELECT 'batches', COUNT(*) FROM batches UNION ALL SELECT 'coupons', COUNT(*) FROM coupons UNION ALL
    SELECT 'customers', COUNT(DISTINCT phone) FROM coupons WHERE phone IS NOT NULL`);
  console.log('Neon database ready:', Object.fromEntries(rows.map(r => [r.t, r.n])));
})()
  .catch(e => { console.error('Setup failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
