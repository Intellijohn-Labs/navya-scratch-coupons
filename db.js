// Postgres storage on Neon. Connection string comes from DATABASE_URL
// (pulled into .env.local by `neon link`, and set on Vercel).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// Return values in the same shapes the rest of the app (and the browser) expects.
types.setTypeParser(20, v => parseInt(v, 10));      // bigint (COUNT) -> number
types.setTypeParser(1700, v => parseFloat(v));      // numeric (SUM)  -> number
types.setTypeParser(1082, v => v);                  // date           -> 'YYYY-MM-DD'
types.setTypeParser(1114, v => v.slice(0, 19));     // timestamp (UTC)-> 'YYYY-MM-DD HH:MM:SS'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Run `neon link` (writes .env.local) or set it in your environment.');
}
const pool = new Pool({
  // Neon requires TLS; spell out verify-full (what pg already does) to silence pg's sslmode warning.
  connectionString: process.env.DATABASE_URL.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full'),
  max: process.env.VERCEL ? 3 : 8,
  idleTimeoutMillis: 10_000,
});

const q = async (sql, params = [], client = pool) => (await client.query(sql, params)).rows;
const one = async (sql, params = [], client = pool) => (await q(sql, params, client))[0];

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- settings (cached briefly per instance) ----------
let cache = null, cacheAt = 0;
async function allSettings() {
  if (!cache || Date.now() - cacheAt > 5000) {
    cache = Object.fromEntries((await q('SELECT key, value FROM settings')).map(r => [r.key, r.value]));
    cacheAt = Date.now();
  }
  return cache;
}
async function getSetting(key, fallback = '') {
  const s = await allSettings();
  return key in s ? s[key] : fallback;
}
async function setSetting(key, value, client = pool) {
  await q('INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)], client);
  cache = null;
}

// ---------- codes & batches ----------
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[bytes[i] % CHARS.length];
  return s;
}

const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Inserts all coupons in one round trip; regenerates the (very rare) codes that collide.
async function createBatch({ name, headline, subline, theme, expires_on, count, sample = 0 }, client) {
  const run = async c => {
    const { id } = await one(`INSERT INTO batches(name, headline, subline, theme, expires_on, count, sample)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [name, headline, subline, theme, expires_on || null, count, sample], c);
    let pending = Array.from({ length: count }, (_, i) => i + 1);
    while (pending.length) {
      const codes = pending.map(() => randomCode(8));
      const done = await q(`INSERT INTO coupons(code, batch_id, serial)
        SELECT code, $2, serial FROM unnest($1::text[], $3::int[]) AS t(code, serial)
        ON CONFLICT (code) DO NOTHING RETURNING serial`, [codes, id, pending], c);
      const ok = new Set(done.map(r => r.serial));
      pending = pending.filter(s => !ok.has(s));
    }
    return id;
  };
  return client ? run(client) : tx(run);
}

// ---------- schema + first-run seed (once per database, safe under concurrency) ----------
async function seed(c) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const defaults = {
    session_secret: crypto.randomBytes(32).toString('hex'),
    admin_password: pw,
    shop_name: 'Navya Bakers',
    tagline: 'The Tempting Taste',
    public_url: '',
    whatsapp: '919400197802',
    one_per_phone: '0',
    terms: 'One coupon per customer visit. Reward valid at Navya Bake Shop outlets till the date shown. Not exchangeable for cash.',
  };
  for (const [k, v] of Object.entries(defaults)) await setSetting(k, v, c);
  if (!process.env.ADMIN_PASSWORD) console.log(`\n  First run — admin password: ${pw}\n  (change it in Settings, or set ADMIN_PASSWORD before the first start)\n`);

  const gifts = [
    ['Celebration Cake (1 kg)', 'Our signature red velvet celebration cake — on the house!', '/img/cake.webp', 'prize', 1, 3, 30, 1],
    ['Choco-Chip Cookie Box', 'A box of freshly baked choco-chip cookies.', '/img/cookies.webp', 'prize', 14, 60, 15, 0],
    ['Caramel Pudding', 'Silky caramel pudding, made with 100% natural flavours.', '/img/desserts.webp', 'prize', 12, 50, 15, 0],
    ['Free Savoury Combo', 'Crunchy savouries combo pack — perfect for tea time.', '/img/savouries.webp', 'prize', 14, 80, 15, 0],
    ['Fresh Bread Loaf', 'A fresh wholewheat bread loaf from our ovens.', '/img/bread.webp', 'prize', 16, 100, 7, 0],
    ['15% Off Your Next Bill', 'Flat 15% off on your next purchase above ₹300.', '/img/snacks.webp', 'prize', 18, null, 30, 0],
    ['Better luck next time', 'Thank you for choosing Navya! Keep scanning — more sweet surprises are coming.', '', 'lose', 25, null, 0, 0],
  ];
  const giftRows = [];
  for (const g of gifts) {
    giftRows.push(await one(`INSERT INTO gifts(name, description, image, kind, weight, stock_total, valid_days, bumper)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, g, c));
  }

  // Demo campaign: coupons to print + a few already-claimed ones so the dashboard has life.
  const batchId = await createBatch({
    name: 'Festive Sweet Scratch', headline: 'Scratch & Win', subline: 'A sweet surprise is waiting for you!',
    theme: 'orange', expires_on: daysFromNow(60), count: 24, sample: 1,
  }, c);
  const sample = [
    ['Anjali Menon', '9847012345', 'Angamaly', 1], ['Rahul Varghese', '9895123456', 'Kalady', 2],
    ['Fathima Rasheed', '9446234567', 'Aluva', 0], ['Joseph Thomas', '9744345678', 'Angamaly', 3],
    ['Sneha Nair', '9961456789', 'Perumbavoor', 4], ['Arjun Das', '9037567890', 'Chalakudy', 6],
    ['Meera Joseph', '9567678901', 'Angamaly', 5], ['Nikhil Paul', '8089789012', 'Kalady', 1],
    ['Divya Krishnan', '9633890123', 'Aluva', 2],
  ];
  const coupons = await q('SELECT id FROM coupons WHERE batch_id = $1 ORDER BY serial LIMIT $2', [batchId, sample.length], c);
  const iso = d => d.toISOString().replace('T', ' ').slice(0, 19);
  for (const [i, [name, phone, area, giftIdx]] of sample.entries()) {
    const gift = giftRows[giftIdx];
    const at = new Date(Date.now() - (i * 26 + 3) * 3600000);
    const win = gift.kind === 'prize';
    const redeemed = i % 3 === 0 && win ? iso(new Date(at.getTime() + 20 * 3600000)) : null;
    await q(`UPDATE coupons SET status=$1, scans=$2, first_scan_at=$3, gift_id=$4, gift_name=$5, gift_kind=$6,
      reward_code=$7, reward_expires=$8, claim_token=$9, customer_name=$10, phone=$11, area=$12, consent=1,
      claimed_at=$3, redeemed_at=$13 WHERE id=$14`,
      [redeemed ? 'redeemed' : 'claimed', 1 + (i % 2), iso(at), gift.id, gift.name, gift.kind,
        win ? 'NB' + randomCode(6) : null,
        win ? new Date(at.getTime() + gift.valid_days * 86400000).toISOString().slice(0, 10) : null,
        crypto.randomBytes(16).toString('hex'), name, phone, area, redeemed, coupons[i].id], c);
    await q('UPDATE gifts SET stock_used = stock_used + 1 WHERE id = $1', [gift.id], c);
  }
  await setSetting('seeded', '1', c);
}

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(1984)'); // only one instance migrates/seeds at a time
    await c.query(schema);
    const seeded = await one("SELECT 1 FROM settings WHERE key = 'seeded'", [], c);
    if (!seeded) await seed(c);
  });
  cache = null;
}

let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = init().catch(e => { readyPromise = null; throw e; });
  return readyPromise;
}

module.exports = { pool, q, one, tx, ready, getSetting, setSetting, createBatch, randomCode, utcNow, daysFromNow };
