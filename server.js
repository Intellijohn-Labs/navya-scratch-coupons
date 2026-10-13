const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { q, one, tx, ready, getSetting, setSetting, createBatch, randomCode, utcNow } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '6mb' }));

// Express 4 doesn't catch rejected promises — route them to the error handler.
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- helpers
const today = () => new Date().toISOString().slice(0, 10);

// Prefer the home/office Wi-Fi address (192.168.x, 10.x, 172.16-31.x) over VPN ranges like Tailscale's 100.x.
function lanIp() {
  const all = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map(i => ({ ...i, name })))
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'));
  const rank = i => (/wi-?fi|wlan|wireless/i.test(i.name) ? 0 : /^(eth|en)/i.test(i.name) && !/vEthernet/i.test(i.name) ? 1 : 2) * 10
    + (/^192\.168\./.test(i.address) ? 0 : /^10\./.test(i.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 2 : 9);
  return (all.sort((x, y) => rank(x) - rank(y))[0] || {}).address || 'localhost';
}

// The URL printed inside each QR. Settings win; otherwise use the request host,
// swapping localhost for the LAN IP so phones on the same Wi-Fi can open it.
async function publicUrl(req, ignoreSetting = false) {
  const set = ignoreSetting ? '' : (await getSetting('public_url')).trim().replace(/\/+$/, '');
  if (set) return set;
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/.test(host)) return `http://${lanIp()}:${host.split(':').pop()}`;
  return `${req.protocol}://${host}`;
}

async function sign(v) {
  // SESSION_SECRET env keeps logins valid across serverless instances; otherwise use the one stored in the DB.
  const secret = process.env.SESSION_SECRET || await getSetting('session_secret');
  return crypto.createHmac('sha256', secret).update(v).digest('hex');
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
async function isAdmin(req) {
  const c = cookies(req).nv_admin;
  if (!c) return false;
  const [exp, mac] = c.split('.');
  return !!mac && Number(exp) > Date.now() && mac === await sign(exp);
}

function maskName(n = '') {
  return n.split(' ').map(w => w.length <= 2 ? w : w[0] + '•'.repeat(Math.min(w.length - 2, 4)) + w.slice(-1)).join(' ');
}
const maskPhone = p => p ? p.slice(0, 2) + '••••••' + p.slice(-2) : '';

function giftPublic(g) {
  return g && { id: g.id, name: g.name, description: g.description, image: g.image, kind: g.kind, bumper: !!g.bumper };
}

function rewardPayload(c, gift) {
  return {
    code: c.code,
    name: c.customer_name,
    gift: giftPublic(gift) || { name: c.gift_name, kind: c.gift_kind, description: '', image: '' },
    reward_code: c.reward_code,
    reward_expires: c.reward_expires,
    claimed_at: c.claimed_at,
    redeemed_at: c.redeemed_at,
    status: c.status,
  };
}

// Weighted random among active gifts that still have stock. Rows are locked so two
// simultaneous claims can't both take the last unit of a prize.
async function pickGift(client) {
  const pool = await q(`SELECT * FROM gifts WHERE active = 1 AND weight > 0
    AND (stock_total IS NULL OR stock_used < stock_total) ORDER BY id FOR UPDATE`, [], client);
  if (!pool.length) return null;
  const total = pool.reduce((s, g) => s + g.weight, 0);
  let r = crypto.randomInt(total);
  for (const g of pool) { if (r < g.weight) return g; r -= g.weight; }
  return pool[pool.length - 1];
}

// Simple in-memory throttle for claim attempts per IP (per server instance).
const hits = new Map();
function throttle(ip, limit = 12, windowMs = 10 * 60000) {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(ip, arr);
  return arr.length > limit;
}

// ---------------------------------------------------------------- QR images (no database needed)
app.get('/qr.svg', a(async (req, res) => {
  const d = String(req.query.d || '').slice(0, 300);
  if (!d) return res.status(400).end();
  const svg = await QRCode.toString(d, {
    type: 'svg', errorCorrectionLevel: 'M', margin: Number(req.query.m ?? 1),
    color: { dark: '#' + String(req.query.fg || '2B140B').replace(/[^0-9a-f]/gi, ''), light: '#0000' },
  });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
}));

// Every API call waits for the schema/seed check (runs once per server instance).
app.use('/api', a(async (req, res, next) => { await ready(); next(); }));

// ---------------------------------------------------------------- public (customer) API
app.get('/api/brand', a(async (req, res) => {
  res.json({ shop_name: await getSetting('shop_name'), tagline: await getSetting('tagline'), terms: await getSetting('terms'), whatsapp: await getSetting('whatsapp') });
}));

app.get('/api/c/:code', a(async (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = await one(`UPDATE coupons SET scans = scans + 1, first_scan_at = COALESCE(first_scan_at, $2)
    WHERE code = $1 RETURNING *`, [code, utcNow()]);
  if (!c) return res.json({ state: 'invalid' });
  const batch = await one('SELECT * FROM batches WHERE id = $1', [c.batch_id]);
  const base = { code: c.code, serial: c.serial, campaign: { name: batch.name, headline: batch.headline, subline: batch.subline, theme: batch.theme, expires_on: batch.expires_on } };
  if (c.status === 'void') return res.json({ ...base, state: 'void' });
  if (c.status === 'new') {
    if (batch.expires_on && batch.expires_on < today()) return res.json({ ...base, state: 'expired' });
    return res.json({ ...base, state: 'new' });
  }
  const token = String(req.get('x-claim-token') || '');
  if (token && c.claim_token && token === c.claim_token) {
    const gift = c.gift_id ? await one('SELECT * FROM gifts WHERE id = $1', [c.gift_id]) : null;
    return res.json({ ...base, state: 'mine', reward: rewardPayload(c, gift) });
  }
  res.json({ ...base, state: 'claimed', claimed_by: maskName(c.customer_name), phone: maskPhone(c.phone), claimed_at: c.claimed_at, gift: c.gift_kind === 'prize' ? { name: c.gift_name } : null });
}));

app.post('/api/c/:code/claim', a(async (req, res) => {
  if (throttle(req.ip)) throw fail(429, 'Too many attempts. Please try again in a few minutes.');
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
  const area = String(req.body.area || '').trim().slice(0, 60);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dob || '') ? req.body.dob : null;
  const occasion = String(req.body.occasion || '').slice(0, 40);
  if (name.length < 2) throw fail(400, 'Please enter your name.');
  if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Please enter a valid 10-digit mobile number.');
  const onePerPhone = (await getSetting('one_per_phone')) === '1';

  const out = await tx(async t => {
    const c = await one('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code], t);
    if (!c) throw fail(404, 'This coupon is not valid.');
    if (c.status !== 'new') throw fail(409, 'This coupon has already been claimed.');
    const batch = await one('SELECT * FROM batches WHERE id = $1', [c.batch_id], t);
    if (batch.expires_on && batch.expires_on < today()) throw fail(410, 'Sorry, this coupon has expired.');
    if (onePerPhone) {
      const used = await one("SELECT 1 FROM coupons WHERE phone = $1 AND batch_id = $2 AND status IN ('claimed','redeemed')", [phone, c.batch_id], t);
      if (used) throw fail(409, 'This mobile number has already played in this campaign. Share the coupon with a friend!');
    }
    const gift = await pickGift(t);
    const kind = gift ? gift.kind : 'lose';
    let reward = null;
    if (kind === 'prize') {
      do { reward = 'NB' + randomCode(6); } while (await one('SELECT 1 FROM coupons WHERE reward_code = $1', [reward], t));
    }
    const expires = kind === 'prize' ? new Date(Date.now() + gift.valid_days * 86400000).toISOString().slice(0, 10) : null;
    const token = crypto.randomBytes(16).toString('hex');
    const fresh = await one(`UPDATE coupons SET status='claimed', gift_id=$1, gift_name=$2, gift_kind=$3, reward_code=$4, reward_expires=$5,
      claim_token=$6, customer_name=$7, phone=$8, area=$9, dob=$10, occasion=$11, consent=$12, device=$13, ip=$14, claimed_at=$15
      WHERE id=$16 RETURNING *`,
    [gift ? gift.id : null, gift ? gift.name : 'Better luck next time', kind, reward, expires, token,
      name, phone, area, dob, occasion, req.body.consent ? 1 : 0, String(req.get('user-agent') || '').slice(0, 200), req.ip, utcNow(), c.id], t);
    if (gift) await q('UPDATE gifts SET stock_used = stock_used + 1 WHERE id = $1', [gift.id], t);
    return { token, reward: rewardPayload(fresh, gift) };
  });
  res.json(out);
}));

// ---------------------------------------------------------------- admin API
app.post('/api/admin/login', a(async (req, res) => {
  if (String(req.body.password || '') !== await getSetting('admin_password')) throw fail(401, 'Wrong password');
  const exp = String(Date.now() + 7 * 86400000);
  res.set('Set-Cookie', `nv_admin=${exp}.${await sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}));
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'nv_admin=; Path=/; Max-Age=0').json({ ok: true });
});
app.get('/api/admin/me', a(async (req, res) => res.json({ admin: await isAdmin(req) })));

app.use('/api/admin', a(async (req, res, next) => {
  if (await isAdmin(req)) return next();
  throw fail(401, 'Please log in');
}));

app.get('/api/admin/dashboard', a(async (req, res) => {
  const [kpi, days, gifts, recent, areas] = await Promise.all([
    one(`SELECT
        COUNT(*) AS printed,
        COUNT(*) FILTER (WHERE scans > 0) AS scanned,
        COUNT(*) FILTER (WHERE status IN ('claimed','redeemed')) AS claimed,
        COUNT(*) FILTER (WHERE status = 'redeemed') AS redeemed,
        COUNT(*) FILTER (WHERE status IN ('claimed','redeemed') AND gift_kind = 'prize') AS winners,
        COUNT(DISTINCT phone) AS customers,
        COUNT(*) FILTER (WHERE consent = 1) AS optins
      FROM coupons WHERE status <> 'void'`),
    q(`SELECT to_char(claimed_at, 'YYYY-MM-DD') AS d, COUNT(*) AS n FROM coupons
      WHERE claimed_at >= (current_date - 13) GROUP BY 1`),
    q('SELECT id, name, image, kind, stock_total, stock_used, weight, active, bumper FROM gifts ORDER BY kind, id'),
    q(`SELECT code, customer_name, phone, area, gift_name, gift_kind, status, claimed_at FROM coupons
      WHERE claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 8`),
    q(`SELECT COALESCE(NULLIF(area,''),'Not given') AS area, COUNT(*) AS n FROM coupons
      WHERE claimed_at IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 6`),
  ]);
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ d, n: (days.find(x => x.d === d) || {}).n || 0 });
  }
  res.json({ kpi, series, gifts, recent, areas });
}));

// Gifts
const giftFields = b => ({
  name: String(b.name || '').trim().slice(0, 80),
  description: String(b.description || '').trim().slice(0, 240),
  image: String(b.image || '').slice(0, 2_500_000),
  kind: b.kind === 'lose' ? 'lose' : 'prize',
  weight: Math.max(0, Math.min(1000, parseInt(b.weight, 10) || 0)),
  stock_total: b.stock_total === '' || b.stock_total == null ? null : Math.max(0, parseInt(b.stock_total, 10) || 0),
  valid_days: Math.max(0, Math.min(365, parseInt(b.valid_days, 10) || 0)),
  bumper: b.bumper ? 1 : 0,
  active: b.active === false || b.active === 0 ? 0 : 1,
});
const giftParams = f => [f.name, f.description, f.image, f.kind, f.weight, f.stock_total, f.valid_days, f.bumper, f.active];
app.get('/api/admin/gifts', a(async (req, res) => {
  res.json(await q(`SELECT g.*, (SELECT COUNT(*) FROM coupons c WHERE c.gift_id = g.id AND c.status = 'redeemed') AS redeemed
    FROM gifts g ORDER BY g.kind = 'lose', g.id`));
}));
app.post('/api/admin/gifts', a(async (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) throw fail(400, 'Gift name is required');
  const { id } = await one(`INSERT INTO gifts(name, description, image, kind, weight, stock_total, valid_days, bumper, active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, giftParams(f));
  res.json({ id });
}));
app.put('/api/admin/gifts/:id', a(async (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) throw fail(400, 'Gift name is required');
  await q(`UPDATE gifts SET name=$1, description=$2, image=$3, kind=$4, weight=$5, stock_total=$6, valid_days=$7, bumper=$8, active=$9
    WHERE id=$10`, [...giftParams(f), parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));
app.delete('/api/admin/gifts/:id', a(async (req, res) => {
  await q('DELETE FROM gifts WHERE id = $1', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// Batches (print runs)
app.get('/api/admin/batches', a(async (req, res) => {
  res.json(await q(`SELECT b.*,
      COUNT(c.id) FILTER (WHERE c.scans > 0) AS scanned,
      COUNT(c.id) FILTER (WHERE c.status IN ('claimed','redeemed')) AS claimed,
      COUNT(c.id) FILTER (WHERE c.status = 'redeemed') AS redeemed,
      COUNT(c.id) FILTER (WHERE c.status = 'void') AS voided
    FROM batches b LEFT JOIN coupons c ON c.batch_id = b.id GROUP BY b.id ORDER BY b.id DESC`));
}));
app.post('/api/admin/batches', a(async (req, res) => {
  const count = parseInt(req.body.count, 10);
  if (!(count >= 1 && count <= 1000)) throw fail(400, 'Number of coupons must be between 1 and 1000');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'Campaign name is required');
  const id = await createBatch({
    name,
    headline: String(req.body.headline || 'Scratch & Win').slice(0, 40),
    subline: String(req.body.subline || 'A sweet surprise is waiting for you!').slice(0, 80),
    theme: ['orange', 'chocolate', 'festive'].includes(req.body.theme) ? req.body.theme : 'orange',
    expires_on: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null,
    count,
  });
  res.json({ id });
}));
app.get('/api/admin/batches/:id', a(async (req, res) => {
  const batch = await one('SELECT * FROM batches WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!batch) throw fail(404, 'Not found');
  const coupons = await q(`SELECT id, code, serial, status, scans, customer_name, phone, gift_name, gift_kind, claimed_at, redeemed_at
    FROM coupons WHERE batch_id = $1 ORDER BY serial`, [batch.id]);
  res.json({ batch, coupons, public_url: await publicUrl(req) });
}));
app.post('/api/admin/batches/:id/void-unused', a(async (req, res) => {
  const r = await q("UPDATE coupons SET status='void' WHERE batch_id = $1 AND status = 'new' RETURNING id", [parseInt(req.params.id, 10)]);
  res.json({ voided: r.length });
}));
app.delete('/api/admin/batches/:id', a(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { n } = await one("SELECT COUNT(*) AS n FROM coupons WHERE batch_id = $1 AND status IN ('claimed','redeemed')", [id]);
  if (n) throw fail(409, 'This batch has claimed coupons. Void the unused ones instead.');
  await q('DELETE FROM batches WHERE id = $1', [id]);
  res.json({ ok: true });
}));
app.post('/api/admin/coupons/:id/void', a(async (req, res) => {
  await q("UPDATE coupons SET status='void' WHERE id = $1 AND status = 'new'", [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// Customers / leads
function customerRows(search) {
  const like = `%${search || ''}%`;
  return q(`SELECT c.id, c.code, c.customer_name, c.phone, c.area, c.dob, c.occasion, c.consent, c.gift_name, c.gift_kind,
      c.reward_code, c.reward_expires, c.status, c.claimed_at, c.redeemed_at, b.name AS campaign
    FROM coupons c JOIN batches b ON b.id = c.batch_id
    WHERE c.claimed_at IS NOT NULL AND (c.customer_name ILIKE $1 OR c.phone ILIKE $1 OR c.area ILIKE $1
      OR c.code ILIKE $1 OR COALESCE(c.reward_code,'') ILIKE $1)
    ORDER BY c.claimed_at DESC`, [like]);
}
app.get('/api/admin/customers', a(async (req, res) => res.json(await customerRows(req.query.q))));
app.get('/api/admin/customers.csv', a(async (req, res) => {
  const rows = await customerRows('');
  const cols = ['claimed_at', 'customer_name', 'phone', 'area', 'dob', 'occasion', 'consent', 'campaign', 'code', 'gift_name', 'reward_code', 'reward_expires', 'status', 'redeemed_at'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
  res.set('Content-Disposition', `attachment; filename="navya-customers-${today()}.csv"`).type('text/csv').send('﻿' + csv);
}));

// Counter: look up a reward / coupon code and redeem it
app.get('/api/admin/lookup/:code', a(async (req, res) => {
  let code = String(req.params.code).toUpperCase().trim();
  const m = code.match(/\/C\/([A-Z0-9]+)/); if (m) code = m[1];
  code = code.replace(/^NAVYA-REWARD:/, '').replace(/[^A-Z0-9]/g, '');
  const c = await one(`SELECT c.*, b.name AS campaign, g.image AS gift_image FROM coupons c
    JOIN batches b ON b.id = c.batch_id LEFT JOIN gifts g ON g.id = c.gift_id
    WHERE c.reward_code = $1 OR c.code = $1`, [code]);
  if (!c) throw fail(404, 'No coupon or reward found for ' + code);
  res.json({ ...c, claim_token: undefined, gift_image: c.gift_image || '', expired: !!(c.reward_expires && c.reward_expires < today()) });
}));
app.post('/api/admin/redeem/:id', a(async (req, res) => {
  // Single conditional UPDATE: two counters pressing "redeem" at once can't both succeed.
  const done = await one(`UPDATE coupons SET status='redeemed', redeemed_at=$2, redeemed_note=$3
    WHERE id=$1 AND status='claimed' AND gift_kind='prize' RETURNING id`,
  [parseInt(req.params.id, 10), utcNow(), String(req.body.note || '').slice(0, 120)]);
  if (done) return res.json({ ok: true });
  const c = await one('SELECT status, redeemed_at FROM coupons WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!c) throw fail(404, 'Not found');
  if (c.status === 'redeemed') throw fail(409, 'Already redeemed on ' + c.redeemed_at);
  throw fail(400, 'Nothing to redeem on this coupon');
}));

// Settings
const SETTING_KEYS = ['shop_name', 'tagline', 'public_url', 'whatsapp', 'one_per_phone', 'terms'];
app.get('/api/admin/settings', a(async (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = await getSetting(k);
  out.detected_url = await publicUrl(req, true);
  out.has_sample = !!(await one('SELECT 1 FROM batches WHERE sample = 1 LIMIT 1'));
  res.json(out);
}));
app.put('/api/admin/settings', a(async (req, res) => {
  if (req.body.new_password && String(req.body.new_password).length < 6) throw fail(400, 'Password must be at least 6 characters');
  for (const k of SETTING_KEYS) if (k in req.body) await setSetting(k, String(req.body[k]).slice(0, 500));
  if (req.body.new_password) await setSetting('admin_password', String(req.body.new_password));
  res.json({ ok: true });
}));
app.post('/api/admin/clear-sample', a(async (req, res) => {
  await tx(async t => {
    await q(`UPDATE gifts g SET stock_used = GREATEST(0, g.stock_used - s.n)
      FROM (SELECT c.gift_id, COUNT(*) AS n FROM coupons c JOIN batches b ON b.id = c.batch_id
            WHERE b.sample = 1 AND c.gift_id IS NOT NULL GROUP BY c.gift_id) s
      WHERE g.id = s.gift_id`, [], t);
    await q('DELETE FROM batches WHERE sample = 1', [], t);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- pages
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
app.get('/admin/print/:id', (req, res) => res.sendFile(path.join(pub, 'admin', 'print.html')));
app.get('/c/:code', (req, res) => res.sendFile(path.join(pub, 'c', 'index.html')));

// Errors: known ones (fail()) go to the user as-is; anything else is logged and hidden.
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
});

module.exports = app;

// Run a normal server locally / on a VPS; on Vercel the app is imported by api/index.js instead.
if (require.main === module) {
  ready().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  Navya Scratch Coupons running (database: Neon Postgres)`);
      console.log(`  Admin:  http://localhost:${PORT}/admin`);
      console.log(`  Phones on the same Wi-Fi: http://${lanIp()}:${PORT}\n`);
    });
  }).catch(e => { console.error('Could not connect to the database:', e.message); process.exit(1); });
}
