// Postgres storage on Neon. Connection string comes from DATABASE_URL
// (pulled into .env.local by `neon link`, and set on Vercel).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
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

// ---------- platform settings (cached briefly per instance) ----------
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

// ---------- passwords (scrypt, salted) ----------
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const randomPassword = () => crypto.randomBytes(9).toString('base64url');

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
async function createBatch({ tenantId, campaignId = null, name, headline, subline, theme, expires_on, count, sample = 0 }, client) {
  const run = async c => {
    const { id } = await one(`INSERT INTO batches(tenant_id, campaign_id, name, headline, subline, theme, expires_on, count, sample)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [tenantId, campaignId, name, headline, subline, theme, expires_on || null, count, sample], c);
    let pending = Array.from({ length: count }, (_, i) => i + 1);
    while (pending.length) {
      const codes = pending.map(() => randomCode(8));
      const done = await q(`INSERT INTO coupons(tenant_id, code, batch_id, serial)
        SELECT $4, code, $2, serial FROM unnest($1::text[], $3::int[]) AS t(code, serial)
        ON CONFLICT (code) DO NOTHING RETURNING serial`, [codes, id, pending, tenantId], c);
      const ok = new Set(done.map(r => r.serial));
      pending = pending.filter(s => !ok.has(s));
    }
    return id;
  };
  return client ? run(client) : tx(run);
}

// ---------- bakeries (tenants) ----------
// Starter gifts for a new bakery — neutral icons, so nothing depends on another bakery's photos.
async function addStarterGifts(tenantId, bakeryName, client = pool) {
  const gifts = [
    ['Free Pastry', 'One pastry of your choice — on the house!', 'emoji:🍰', 'prize', 15, 50, 15],
    ['Cookie Box', 'A box of freshly baked cookies.', 'emoji:🍪', 'prize', 15, 50, 15],
    ['10% Off Your Next Bill', 'Flat 10% off on your next purchase.', 'emoji:🎟️', 'prize', 20, null, 30],
    ['Better luck next time', `Thank you for choosing ${bakeryName}! Keep scanning — more sweet surprises are coming.`, '', 'lose', 30, null, 0],
  ];
  for (const g of gifts) {
    await q(`INSERT INTO gifts(tenant_id, name, description, image, kind, weight, stock_total, valid_days)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, ...g], client);
  }
}

// ---------- tamper-evident activity log ----------
// JSON with sorted keys, so the same details always hash the same way (JSONB reorders keys).
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const GENESIS = '0'.repeat(64);
function auditHash(prev, r) {
  return crypto.createHash('sha256').update([prev, r.created_at, r.tenant_id ?? '', r.actor_type, r.actor_id ?? '', r.actor_name,
    r.action, r.entity, r.entity_id, canonical(r.details)].join('|')).digest('hex');
}
// Appends one entry. Pass the transaction client when inside one, so the entry commits (or rolls back) with the change.
async function audit(entry, client) {
  const write = async c => {
    await c.query('SELECT pg_advisory_xact_lock(7777)'); // one writer at a time keeps the chain linear
    const last = await one('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1', [], c);
    const r = {
      tenant_id: entry.tenantId ?? null,
      actor_type: entry.actor?.type || 'system',
      actor_id: entry.actor?.id ?? null,
      actor_name: String(entry.actor?.name || '').slice(0, 120),
      action: entry.action,
      entity: entry.entity || '',
      entity_id: String(entry.entityId ?? ''),
      details: entry.details || {},
      created_at: utcNow(),
    };
    const prev = last ? last.hash : GENESIS;
    await q(`INSERT INTO audit_log(tenant_id, actor_type, actor_id, actor_name, action, entity, entity_id, details, ip, created_at, prev_hash, hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.tenant_id, r.actor_type, r.actor_id, r.actor_name, r.action, r.entity, r.entity_id, JSON.stringify(r.details),
      String(entry.ip || '').slice(0, 60), r.created_at, prev, auditHash(prev, r)], c);
  };
  return client ? write(client) : tx(write);
}
// Re-computes every hash from the start. Any edited, inserted or deleted row breaks the chain.
async function verifyAudit() {
  let prev = GENESIS, checked = 0;
  for (let after = 0; ;) {
    const rows = await q('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT 2000', [after]);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prev_hash !== prev || auditHash(prev, r) !== r.hash) return { ok: false, checked, broken_at: r.id };
      prev = r.hash; checked++; after = r.id;
    }
  }
  return { ok: true, checked, last_hash: prev };
}

// ---------- schema, upgrades and first-run setup (once per database, safe under concurrency) ----------
async function migrateSingleBakery(c) {
  // Data from before multi-bakery support becomes the first bakery: Navya Bakers.
  const orphan = await one(`SELECT
      (SELECT COUNT(*) FROM gifts WHERE tenant_id IS NULL) + (SELECT COUNT(*) FROM batches WHERE tenant_id IS NULL)
      + (SELECT COUNT(*) FROM coupons WHERE tenant_id IS NULL) AS n`, [], c);
  if (orphan.n) {
    const s = Object.fromEntries((await q('SELECT key, value FROM settings', [], c)).map(r => [r.key, r.value]));
    let t = await one("SELECT id FROM tenants WHERE slug = 'navya'", [], c);
    if (!t) {
      t = await one(`INSERT INTO tenants(slug, name, tagline, logo, color, color2, address, maps_url, website, whatsapp, footer,
          areas, terms, public_url, one_per_phone, password_hash)
        VALUES('navya', $1, $2, '/img/navya-logo.svg', '#F47216', '#963B1F', 'Central Junction, Angamaly',
          'https://maps.google.com/?q=Navya+Bakers+Central+Junction+Angamaly', 'https://navyabakers.com', $3,
          'Since 1984 · 100% natural colours & flavours', 'Angamaly, Kalady, Aluva, Perumbavoor, Chalakudy, Kochi, Thrissur',
          $4, $5, $6, $7) RETURNING id`,
      [s.shop_name || 'Navya Bakers', s.tagline || 'The Tempting Taste', s.whatsapp || '', s.terms || '', s.public_url || '',
        s.one_per_phone === '1' ? 1 : 0, await hashPassword(s.admin_password || randomPassword())], c);
    }
    for (const table of ['gifts', 'batches']) await q(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id IS NULL`, [t.id], c);
    await q('UPDATE coupons c SET tenant_id = b.tenant_id FROM batches b WHERE b.id = c.batch_id AND c.tenant_id IS NULL', [], c);
    console.log('  Upgraded to multi-bakery: existing data now belongs to bakery "navya".');
  }
  // Single-bakery settings now live on the bakery row.
  await q(`DELETE FROM settings WHERE key IN ('admin_password','shop_name','tagline','whatsapp','terms','public_url','one_per_phone','seeded')`, [], c);
  // From now on every row must belong to a bakery.
  for (const table of ['gifts', 'batches', 'coupons']) await q(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`, [], c);
}

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(1984)'); // only one instance migrates at a time
    await c.query(schema);
    await migrateSingleBakery(c);
    // Batches made before campaigns existed each become their own Instant Win campaign.
    for (const b of await q('SELECT id, tenant_id, name, expires_on, created_at FROM batches WHERE campaign_id IS NULL', [], c)) {
      const camp = await one(`INSERT INTO campaigns(tenant_id, name, type, starts_on, ends_on) VALUES($1, $2, 'instant', $3, $4) RETURNING id`,
        [b.tenant_id, b.name, b.created_at.slice(0, 10), b.expires_on], c);
      await q('UPDATE batches SET campaign_id = $1 WHERE id = $2', [camp.id, b.id], c);
    }
    // Every merchant has at least one outlet.
    await q(`INSERT INTO outlets(tenant_id, name, address, maps_url)
      SELECT t.id, 'Main shop', t.address, t.maps_url FROM tenants t
      WHERE NOT EXISTS (SELECT 1 FROM outlets o WHERE o.tenant_id = t.id)`, [], c);
    if (!await one("SELECT 1 FROM settings WHERE key = 'session_secret'", [], c)) {
      await setSetting('session_secret', crypto.randomBytes(32).toString('hex'), c);
    }
    if (!await one("SELECT 1 FROM settings WHERE key = 'super_password_hash'", [], c)) {
      const pw = process.env.SUPER_ADMIN_PASSWORD || randomPassword();
      await setSetting('super_password_hash', await hashPassword(pw), c);
      if (!process.env.SUPER_ADMIN_PASSWORD) console.log(`\n  Super admin password (first run): ${pw}\n  Change it on the Super Admin page, or set SUPER_ADMIN_PASSWORD before the first start.\n`);
    }
  });
  cache = null;
}

let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = init().catch(e => { readyPromise = null; throw e; });
  return readyPromise;
}

module.exports = {
  pool, q, one, tx, ready, getSetting, setSetting, createBatch, addStarterGifts, randomCode, utcNow, daysFromNow,
  hashPassword, verifyPassword, randomPassword, audit, verifyAudit,
};
