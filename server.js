const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db, getSetting, setSetting, tx, createBatch, randomCode } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '6mb' }));

// ---------------------------------------------------------------- helpers
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);

// Prefer the home/office Wi-Fi address (192.168.x, 10.x, 172.16-31.x) over VPN ranges like Tailscale's 100.x.
function lanIp() {
  const all = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map(i => ({ ...i, name })))
    .filter(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'));
  const rank = i => (/wi-?fi|wlan|wireless/i.test(i.name) ? 0 : /^(eth|en)/i.test(i.name) && !/vEthernet/i.test(i.name) ? 1 : 2) * 10
    + (/^192\.168\./.test(i.address) ? 0 : /^10\./.test(i.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 2 : 9);
  return (all.sort((a, b) => rank(a) - rank(b))[0] || {}).address || 'localhost';
}

// The URL printed inside each QR. Settings win; otherwise use the request host,
// swapping localhost for the LAN IP so phones on the same Wi-Fi can open it.
function publicUrl(req, ignoreSetting = false) {
  const set = ignoreSetting ? '' : getSetting('public_url').trim().replace(/\/+$/, '');
  if (set) return set;
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/.test(host)) return `http://${lanIp()}:${host.split(':').pop()}`;
  return `${req.protocol}://${host}`;
}

function sign(v) {
  // SESSION_SECRET env keeps logins valid across serverless instances (Vercel).
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || getSetting('session_secret')).update(v).digest('hex');
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
function isAdmin(req) {
  const c = cookies(req).nv_admin;
  if (!c) return false;
  const [exp, mac] = c.split('.');
  return mac && mac === sign(exp) && Number(exp) > Date.now();
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Please log in' });
}

function maskName(n = '') {
  return n.split(' ').map(w => w.length <= 2 ? w : w[0] + '•'.repeat(Math.min(w.length - 2, 4)) + w.slice(-1)).join(' ');
}
const maskPhone = p => p ? p.slice(0, 2) + '••••••' + p.slice(-2) : '';

function giftPublic(g) {
  return g && { id: g.id, name: g.name, description: g.description, image: g.image, kind: g.kind, bumper: !!g.bumper };
}

function couponView(c) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(c.batch_id);
  return { batch, gift: c.gift_id ? db.prepare('SELECT * FROM gifts WHERE id = ?').get(c.gift_id) : null };
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

// Weighted random among active gifts that still have stock.
function pickGift() {
  const pool = db.prepare(`SELECT * FROM gifts WHERE active = 1 AND weight > 0
    AND (stock_total IS NULL OR stock_used < stock_total)`).all();
  if (!pool.length) return null;
  const total = pool.reduce((s, g) => s + g.weight, 0);
  let r = crypto.randomInt(total);
  for (const g of pool) { if (r < g.weight) return g; r -= g.weight; }
  return pool[pool.length - 1];
}

// Simple in-memory throttle for claim attempts per IP.
const hits = new Map();
function throttle(ip, limit = 12, windowMs = 10 * 60000) {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(ip, arr);
  return arr.length > limit;
}

// ---------------------------------------------------------------- QR images
app.get('/qr.svg', async (req, res) => {
  const d = String(req.query.d || '').slice(0, 300);
  if (!d) return res.status(400).end();
  const svg = await QRCode.toString(d, {
    type: 'svg', errorCorrectionLevel: 'M', margin: Number(req.query.m ?? 1),
    color: { dark: '#' + String(req.query.fg || '2B140B').replace(/[^0-9a-f]/gi, ''), light: '#0000' },
  });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

// ---------------------------------------------------------------- public (customer) API
app.get('/api/brand', (req, res) => {
  res.json({ shop_name: getSetting('shop_name'), tagline: getSetting('tagline'), terms: getSetting('terms'), whatsapp: getSetting('whatsapp') });
});

app.get('/api/c/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  if (!c) return res.json({ state: 'invalid' });
  db.prepare('UPDATE coupons SET scans = scans + 1, first_scan_at = COALESCE(first_scan_at, ?) WHERE id = ?').run(now(), c.id);
  const { batch, gift } = couponView(c);
  const base = { code: c.code, serial: c.serial, campaign: { name: batch.name, headline: batch.headline, subline: batch.subline, theme: batch.theme, expires_on: batch.expires_on } };
  if (c.status === 'void') return res.json({ ...base, state: 'void' });
  if (c.status === 'new') {
    if (batch.expires_on && batch.expires_on < today()) return res.json({ ...base, state: 'expired' });
    return res.json({ ...base, state: 'new' });
  }
  const token = String(req.get('x-claim-token') || '');
  if (token && c.claim_token && token === c.claim_token) return res.json({ ...base, state: 'mine', reward: rewardPayload(c, gift) });
  res.json({ ...base, state: 'claimed', claimed_by: maskName(c.customer_name), phone: maskPhone(c.phone), claimed_at: c.claimed_at, gift: c.gift_kind === 'prize' ? { name: c.gift_name } : null });
});

app.post('/api/c/:code/claim', (req, res) => {
  if (throttle(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
  const area = String(req.body.area || '').trim().slice(0, 60);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dob || '') ? req.body.dob : null;
  const occasion = String(req.body.occasion || '').slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });

  try {
    const out = tx(() => {
      const c = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
      if (!c) throw Object.assign(new Error('This coupon is not valid.'), { status: 404 });
      if (c.status !== 'new') throw Object.assign(new Error('This coupon has already been claimed.'), { status: 409 });
      const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(c.batch_id);
      if (batch.expires_on && batch.expires_on < today()) throw Object.assign(new Error('Sorry, this coupon has expired.'), { status: 410 });
      if (getSetting('one_per_phone') === '1') {
        const used = db.prepare("SELECT 1 FROM coupons WHERE phone = ? AND batch_id = ? AND status IN ('claimed','redeemed')").get(phone, c.batch_id);
        if (used) throw Object.assign(new Error('This mobile number has already played in this campaign. Share the coupon with a friend!'), { status: 409 });
      }
      const gift = pickGift();
      const kind = gift ? gift.kind : 'lose';
      let reward = null;
      if (kind === 'prize') {
        do { reward = 'NB' + randomCode(6); } while (db.prepare('SELECT 1 FROM coupons WHERE reward_code = ?').get(reward));
      }
      const expires = kind === 'prize' ? new Date(Date.now() + gift.valid_days * 86400000).toISOString().slice(0, 10) : null;
      const token = crypto.randomBytes(16).toString('hex');
      db.prepare(`UPDATE coupons SET status='claimed', gift_id=?, gift_name=?, gift_kind=?, reward_code=?, reward_expires=?,
        claim_token=?, customer_name=?, phone=?, area=?, dob=?, occasion=?, consent=?, device=?, ip=?, claimed_at=? WHERE id=?`)
        .run(gift ? gift.id : null, gift ? gift.name : 'Better luck next time', kind, reward, expires, token,
          name, phone, area, dob, occasion, req.body.consent ? 1 : 0, String(req.get('user-agent') || '').slice(0, 200), req.ip, now(), c.id);
      if (gift) db.prepare('UPDATE gifts SET stock_used = stock_used + 1 WHERE id = ?').run(gift.id);
      const fresh = db.prepare('SELECT * FROM coupons WHERE id = ?').get(c.id);
      return { token, reward: rewardPayload(fresh, gift) };
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
    if (!e.status) console.error(e);
  }
});

// ---------------------------------------------------------------- admin API
app.post('/api/admin/login', (req, res) => {
  if (String(req.body.password || '') !== getSetting('admin_password')) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const exp = String(Date.now() + 7 * 86400000);
  res.set('Set-Cookie', `nv_admin=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'nv_admin=; Path=/; Max-Age=0').json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.use('/api/admin', requireAdmin);

app.get('/api/admin/dashboard', (req, res) => {
  const k = db.prepare(`SELECT
      COUNT(*) AS printed,
      SUM(CASE WHEN scans > 0 THEN 1 ELSE 0 END) AS scanned,
      SUM(CASE WHEN status IN ('claimed','redeemed') THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
      SUM(CASE WHEN status IN ('claimed','redeemed') AND gift_kind = 'prize' THEN 1 ELSE 0 END) AS winners,
      COUNT(DISTINCT phone) AS customers,
      SUM(CASE WHEN consent = 1 THEN 1 ELSE 0 END) AS optins
    FROM coupons WHERE status != 'void'`).get();
  const days = db.prepare(`SELECT substr(claimed_at,1,10) AS d, COUNT(*) AS n FROM coupons
    WHERE claimed_at >= date('now','-13 days') GROUP BY d`).all();
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ d, n: (days.find(x => x.d === d) || {}).n || 0 });
  }
  const gifts = db.prepare('SELECT id, name, image, kind, stock_total, stock_used, weight, active, bumper FROM gifts ORDER BY kind, id').all();
  const recent = db.prepare(`SELECT code, customer_name, phone, area, gift_name, gift_kind, status, claimed_at FROM coupons
    WHERE claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 8`).all();
  const areas = db.prepare(`SELECT COALESCE(NULLIF(area,''),'Not given') AS area, COUNT(*) AS n FROM coupons
    WHERE claimed_at IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 6`).all();
  res.json({ kpi: k, series, gifts, recent, areas });
});

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
app.get('/api/admin/gifts', (req, res) => {
  res.json(db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM coupons c WHERE c.gift_id = g.id AND c.status = 'redeemed') AS redeemed
    FROM gifts g ORDER BY g.kind = 'lose', g.id`).all());
});
app.post('/api/admin/gifts', (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Gift name is required' });
  const info = db.prepare(`INSERT INTO gifts(name, description, image, kind, weight, stock_total, valid_days, bumper, active)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(f.name, f.description, f.image, f.kind, f.weight, f.stock_total, f.valid_days, f.bumper, f.active);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put('/api/admin/gifts/:id', (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Gift name is required' });
  db.prepare(`UPDATE gifts SET name=?, description=?, image=?, kind=?, weight=?, stock_total=?, valid_days=?, bumper=?, active=? WHERE id=?`)
    .run(f.name, f.description, f.image, f.kind, f.weight, f.stock_total, f.valid_days, f.bumper, f.active, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/gifts/:id', (req, res) => {
  db.prepare('DELETE FROM gifts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Batches (print runs)
app.get('/api/admin/batches', (req, res) => {
  res.json(db.prepare(`SELECT b.*,
      SUM(CASE WHEN c.scans > 0 THEN 1 ELSE 0 END) AS scanned,
      SUM(CASE WHEN c.status IN ('claimed','redeemed') THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN c.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
      SUM(CASE WHEN c.status = 'void' THEN 1 ELSE 0 END) AS voided
    FROM batches b LEFT JOIN coupons c ON c.batch_id = b.id GROUP BY b.id ORDER BY b.id DESC`).all());
});
app.post('/api/admin/batches', (req, res) => {
  const count = parseInt(req.body.count, 10);
  if (!(count >= 1 && count <= 1000)) return res.status(400).json({ error: 'Number of coupons must be between 1 and 1000' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });
  const id = createBatch({
    name,
    headline: String(req.body.headline || 'Scratch & Win').slice(0, 40),
    subline: String(req.body.subline || 'A sweet surprise is waiting for you!').slice(0, 80),
    theme: ['orange', 'chocolate', 'festive'].includes(req.body.theme) ? req.body.theme : 'orange',
    expires_on: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null,
    count,
  });
  res.json({ id });
});
app.get('/api/admin/batches/:id', (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });
  const coupons = db.prepare(`SELECT id, code, serial, status, scans, customer_name, phone, gift_name, gift_kind, claimed_at, redeemed_at
    FROM coupons WHERE batch_id = ? ORDER BY serial`).all(batch.id);
  res.json({ batch, coupons, public_url: publicUrl(req) });
});
app.post('/api/admin/batches/:id/void-unused', (req, res) => {
  const r = db.prepare("UPDATE coupons SET status='void' WHERE batch_id = ? AND status = 'new'").run(req.params.id);
  res.json({ voided: Number(r.changes) });
});
app.delete('/api/admin/batches/:id', (req, res) => {
  const used = db.prepare("SELECT COUNT(*) AS n FROM coupons WHERE batch_id = ? AND status IN ('claimed','redeemed')").get(req.params.id).n;
  if (used) return res.status(409).json({ error: 'This batch has claimed coupons. Void the unused ones instead.' });
  db.prepare('DELETE FROM batches WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/coupons/:id/void', (req, res) => {
  db.prepare("UPDATE coupons SET status='void' WHERE id = ? AND status = 'new'").run(req.params.id);
  res.json({ ok: true });
});

// Customers / leads
function customerRows(q) {
  const like = `%${q || ''}%`;
  return db.prepare(`SELECT c.id, c.code, c.customer_name, c.phone, c.area, c.dob, c.occasion, c.consent, c.gift_name, c.gift_kind,
      c.reward_code, c.reward_expires, c.status, c.claimed_at, c.redeemed_at, b.name AS campaign
    FROM coupons c JOIN batches b ON b.id = c.batch_id
    WHERE c.claimed_at IS NOT NULL AND (c.customer_name LIKE ? OR c.phone LIKE ? OR c.area LIKE ? OR c.code LIKE ? OR IFNULL(c.reward_code,'') LIKE ?)
    ORDER BY c.claimed_at DESC`).all(like, like, like, like, like);
}
app.get('/api/admin/customers', (req, res) => res.json(customerRows(req.query.q)));
app.get('/api/admin/customers.csv', (req, res) => {
  const rows = customerRows('');
  const cols = ['claimed_at', 'customer_name', 'phone', 'area', 'dob', 'occasion', 'consent', 'campaign', 'code', 'gift_name', 'reward_code', 'reward_expires', 'status', 'redeemed_at'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
  res.set('Content-Disposition', `attachment; filename="navya-customers-${today()}.csv"`).type('text/csv').send('﻿' + csv);
});

// Counter: look up a reward / coupon code and redeem it
app.get('/api/admin/lookup/:code', (req, res) => {
  let code = String(req.params.code).toUpperCase().trim();
  const m = code.match(/\/C\/([A-Z0-9]+)/); if (m) code = m[1];
  code = code.replace(/^NAVYA-REWARD:/, '').replace(/[^A-Z0-9]/g, '');
  const c = db.prepare('SELECT c.*, b.name AS campaign FROM coupons c JOIN batches b ON b.id = c.batch_id WHERE c.reward_code = ? OR c.code = ?').get(code, code);
  if (!c) return res.status(404).json({ error: 'No coupon or reward found for ' + code });
  const gift = c.gift_id ? db.prepare('SELECT * FROM gifts WHERE id = ?').get(c.gift_id) : null;
  res.json({ ...c, claim_token: undefined, gift_image: gift ? gift.image : '', expired: !!(c.reward_expires && c.reward_expires < today()) });
});
app.post('/api/admin/redeem/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status === 'redeemed') return res.status(409).json({ error: 'Already redeemed on ' + c.redeemed_at });
  if (c.status !== 'claimed' || c.gift_kind !== 'prize') return res.status(400).json({ error: 'Nothing to redeem on this coupon' });
  db.prepare("UPDATE coupons SET status='redeemed', redeemed_at=?, redeemed_note=? WHERE id=?").run(now(), String(req.body.note || '').slice(0, 120), c.id);
  res.json({ ok: true });
});

// Settings
const SETTING_KEYS = ['shop_name', 'tagline', 'public_url', 'whatsapp', 'one_per_phone', 'terms'];
app.get('/api/admin/settings', (req, res) => {
  const out = Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)]));
  out.detected_url = publicUrl(req, true);
  out.has_sample = !!db.prepare('SELECT 1 FROM batches WHERE sample = 1').get();
  res.json(out);
});
app.put('/api/admin/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (k in req.body) setSetting(k, String(req.body[k]).slice(0, 500));
  if (req.body.new_password) {
    if (String(req.body.new_password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    setSetting('admin_password', String(req.body.new_password));
  }
  res.json({ ok: true });
});
app.post('/api/admin/clear-sample', (req, res) => {
  tx(() => {
    const ids = db.prepare('SELECT id FROM batches WHERE sample = 1').all().map(r => r.id);
    for (const id of ids) {
      for (const r of db.prepare('SELECT gift_id, COUNT(*) AS n FROM coupons WHERE batch_id = ? AND gift_id IS NOT NULL GROUP BY gift_id').all(id)) {
        db.prepare('UPDATE gifts SET stock_used = MAX(0, stock_used - ?) WHERE id = ?').run(r.n, r.gift_id);
      }
      db.prepare('DELETE FROM batches WHERE id = ?').run(id);
    }
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- pages
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
app.get('/admin/print/:id', (req, res) => res.sendFile(path.join(pub, 'admin', 'print.html')));
app.get('/c/:code', (req, res) => res.sendFile(path.join(pub, 'c', 'index.html')));

module.exports = app;

// Run a normal server locally / on a VPS; on Vercel the app is imported by api/index.js instead.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Navya Scratch Coupons running`);
    console.log(`  Admin:  http://localhost:${PORT}/admin`);
    console.log(`  Phones on the same Wi-Fi: http://${lanIp()}:${PORT}\n`);
  });
}
