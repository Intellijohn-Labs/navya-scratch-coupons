// Sets the Super Admin password from the SUPER_ADMIN_PASSWORD environment variable
// (e.g. in .env.local) and signs out every existing Super Admin session.
// Use it the first time, or to recover access:  npm run super:password
const { pool, ready, setSetting, getSetting, hashPassword } = require('../db');

(async () => {
  const pw = process.env.SUPER_ADMIN_PASSWORD || '';
  if (pw.length < 10) throw new Error('Set SUPER_ADMIN_PASSWORD (at least 10 characters) in .env.local first.');
  await ready();
  await setSetting('super_password_hash', await hashPassword(pw));
  await setSetting('super_session_version', String((parseInt(await getSetting('super_session_version', '1'), 10) || 1) + 1));
  console.log('Super Admin password updated. Sign in at /super');
})()
  .catch(e => { console.error('Failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
