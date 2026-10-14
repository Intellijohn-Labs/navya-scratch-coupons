const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const {
  q, one, tx, ready, getSetting, setSetting, createBatch, addStarterGifts, randomCode, utcNow,
  hashPassword, verifyPassword, randomPassword, audit, verifyAudit,
} = require('./db');

const PLATFORM = 'Genuine Draw';

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '6mb' }));

// Express 4 doesn't catch rejected promises — route them to the error handler.
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const int = v => parseInt(v, 10) || 0;

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

// The URL printed inside each QR. The bakery's own setting wins; otherwise use the request host,
// swapping localhost for the LAN IP so phones on the same Wi-Fi can open it.
function publicUrl(req, tenant, ignoreSetting = false) {
  const set = ignoreSetting ? '' : String(tenant?.public_url || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const host = req.get('host') || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/.test(host)) return `http://${lanIp()}:${host.split(':').pop()}`;
  return `${req.protocol}://${host}`;
}

// ---------- signed session cookies ----------
async function secret() { return process.env.SESSION_SECRET || getSetting('session_secret'); }
async function makeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
}
async function readToken(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
}
const cookie = (req, name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

// ---------- bakeries ----------
const isActive = t => t.status === 'active' && (!t.plan_expires_on || t.plan_expires_on >= today());
const mapsUrl = t => t.maps_url || (t.address ? `https://maps.google.com/?q=${encodeURIComponent(`${t.name} ${t.address}`)}` : '');
const brandOf = t => ({
  slug: t.slug, name: t.name, tagline: t.tagline, logo: t.logo, color: t.color, color2: t.color2,
  address: t.address, maps_url: mapsUrl(t), website: t.website, whatsapp: t.whatsapp, footer: t.footer,
  areas: t.areas.split(',').map(s => s.trim()).filter(Boolean), terms: t.terms,
});

// Fields a bakery may edit about itself; the super admin can edit these plus the account fields.
const PROFILE_FIELDS = ['name', 'tagline', 'logo', 'color', 'color2', 'address', 'maps_url', 'website', 'whatsapp', 'footer', 'areas', 'terms', 'public_url', 'one_per_phone'];
const ACCOUNT_FIELDS = ['slug', 'status', 'plan_expires_on', 'max_coupons', 'contact_name', 'contact_phone', 'notes'];
function cleanTenant(body, fields) {
  const out = {};
  for (const f of fields) {
    if (!(f in body)) continue;
    let v = body[f];
    switch (f) {
      case 'logo': v = String(v || '').slice(0, 800_000); break;
      case 'color': case 'color2':
        if (!/^#[0-9a-f]{6}$/i.test(v || '')) throw fail(400, 'Colours must look like #F47216');
        break;
      case 'one_per_phone': v = v === true || v === 1 || v === '1' ? 1 : 0; break;
      case 'slug':
        v = String(v || '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(v)) throw fail(400, 'Username: 2–40 characters, lowercase letters, numbers and dashes only');
        break;
      case 'status': if (!['active', 'suspended'].includes(v)) throw fail(400, 'Unknown status'); break;
      case 'plan_expires_on': v = /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null; break;
      case 'max_coupons': v = v === '' || v == null ? null : Math.max(0, int(v)); break;
      case 'name':
        v = String(v || '').trim().slice(0, 80);
        if (!v) throw fail(400, 'Bakery name is required');
        break;
      default: v = String(v ?? '').trim().slice(0, f === 'terms' || f === 'notes' ? 1000 : 300);
    }
    out[f] = v;
  }
  return out;
}
async function updateTenant(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  try {
    await q(`UPDATE tenants SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map(k => fields[k])]);
  } catch (e) {
    if (e.code === '23505') throw fail(409, 'That username is already taken');
    throw e;
  }
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

// Weighted random among the bakery's active gifts that still have stock. Rows are locked so two
// simultaneous claims can't both take the last unit of a prize.
async function pickGift(tenantId, client) {
  const pool = await q(`SELECT * FROM gifts WHERE tenant_id = $1 AND active = 1 AND weight > 0
    AND (stock_total IS NULL OR stock_used < stock_total) ORDER BY id FOR UPDATE`, [tenantId], client);
  if (!pool.length) return null;
  const total = pool.reduce((s, g) => s + g.weight, 0);
  let r = crypto.randomInt(total);
  for (const g of pool) { if (r < g.weight) return g; r -= g.weight; }
  return pool[pool.length - 1];
}

// Simple in-memory throttle (per server instance).
const hits = new Map();
function throttle(key, limit, windowMs = 10 * 60000) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
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

// Every API call waits for the schema/upgrade check (runs once per server instance).
app.use('/api', a(async (req, res, next) => { await ready(); next(); }));

// ---------------------------------------------------------------- public (customer) API
app.get('/api/c/:code', a(async (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = await one(`UPDATE coupons SET scans = scans + 1, first_scan_at = COALESCE(first_scan_at, $2)
    WHERE code = $1 RETURNING *`, [code, utcNow()]);
  if (!c) return res.json({ state: 'invalid' });
  const [batch, tenant] = await Promise.all([
    one('SELECT * FROM batches WHERE id = $1', [c.batch_id]),
    one('SELECT * FROM tenants WHERE id = $1', [c.tenant_id]),
  ]);
  const base = {
    code: c.code, serial: c.serial, brand: brandOf(tenant),
    campaign: { name: batch.name, headline: batch.headline, subline: batch.subline, theme: batch.theme, expires_on: batch.expires_on },
  };
  const token = String(req.get('x-claim-token') || '');
  if (c.status !== 'new' && c.status !== 'void' && token && c.claim_token && token === c.claim_token) {
    const gift = c.gift_id ? await one('SELECT * FROM gifts WHERE id = $1', [c.gift_id]) : null;
    return res.json({ ...base, state: 'mine', reward: rewardPayload(c, gift) });
  }
  if (!isActive(tenant)) return res.json({ ...base, state: 'paused' });
  if (c.status === 'void') return res.json({ ...base, state: 'void' });
  if (c.status === 'new') {
    if (batch.expires_on && batch.expires_on < today()) return res.json({ ...base, state: 'expired' });
    return res.json({ ...base, state: 'new' });
  }
  res.json({ ...base, state: 'claimed', claimed_by: maskName(c.customer_name), phone: maskPhone(c.phone), claimed_at: c.claimed_at, gift: c.gift_kind === 'prize' ? { name: c.gift_name } : null });
}));

app.post('/api/c/:code/claim', a(async (req, res) => {
  if (throttle('claim:' + req.ip, 12)) throw fail(429, 'Too many attempts. Please try again in a few minutes.');
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
  const area = String(req.body.area || '').trim().slice(0, 60);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(req.body.dob || '') ? req.body.dob : null;
  const occasion = String(req.body.occasion || '').slice(0, 40);
  if (name.length < 2) throw fail(400, 'Please enter your name.');
  if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Please enter a valid 10-digit mobile number.');

  const out = await tx(async t => {
    const c = await one('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code], t);
    if (!c) throw fail(404, 'This coupon is not valid.');
    const tenant = await one('SELECT * FROM tenants WHERE id = $1', [c.tenant_id], t);
    if (!isActive(tenant)) throw fail(403, 'This offer is paused right now. Please try again later.');
    if (c.status !== 'new') throw fail(409, 'This coupon has already been claimed.');
    const batch = await one('SELECT * FROM batches WHERE id = $1', [c.batch_id], t);
    if (batch.expires_on && batch.expires_on < today()) throw fail(410, 'Sorry, this coupon has expired.');
    if (tenant.one_per_phone) {
      const used = await one("SELECT 1 FROM coupons WHERE phone = $1 AND batch_id = $2 AND status IN ('claimed','redeemed')", [phone, c.batch_id], t);
      if (used) throw fail(409, 'This mobile number has already played in this campaign. Share the coupon with a friend!');
    }
    const gift = await pickGift(c.tenant_id, t);
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
    await audit({ tenantId: c.tenant_id, actor: { type: 'customer', name: maskName(name) }, action: 'coupon.claimed', entity: 'coupon', entityId: c.code,
      details: { gift: fresh.gift_name, kind, reward_code: reward, phone: maskPhone(phone), batch_id: c.batch_id }, ip: req.ip }, t);
    return { token, reward: rewardPayload(fresh, gift) };
  });
  res.json(out);
}));

// ---------------------------------------------------------------- merchant admin API
// A session is the merchant owner, one of its staff (manager / counter), or the Super Admin looking in.
async function currentSession(req) {
  const p = await readToken(cookies(req).nv_admin);
  if (!p || !p.t) return null;
  const t = await one('SELECT * FROM tenants WHERE id = $1', [p.t]);
  if (!t || t.session_version !== p.v) return null;
  if (p.imp) {                                       // impersonation needs a live super-admin session too
    const s = await readToken(cookies(req).nv_super);
    if (!s || String(s.v) !== await getSetting('super_session_version', '1')) return null;
    return { tenant: t, actor: { type: 'super', id: null, name: 'Super Admin', impersonating: true } };
  }
  if (!isActive(t)) return null;
  if (p.st) {
    const st = await one('SELECT * FROM staff WHERE id = $1 AND tenant_id = $2', [p.st, t.id]);
    if (!st || !st.active || st.session_version !== p.sv) return null;
    return { tenant: t, actor: { type: st.role, id: st.id, name: st.name, username: st.username, outlet_id: st.outlet_id } };
  }
  return { tenant: t, actor: { type: 'owner', id: t.id, name: t.name, username: t.slug } };
}
const log = (req, action, entity, entityId, details = {}, client) =>
  audit({ tenantId: req.tenant?.id ?? null, actor: req.actor, action, entity, entityId, details, ip: req.ip }, client);

app.post('/api/admin/login', a(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (throttle('login:' + req.ip, 20) || throttle('login-user:' + username, 10)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
  const password = String(req.body.password || '');
  // Owners log in with the merchant username; staff with their own username.
  let t = await one('SELECT * FROM tenants WHERE slug = $1', [username]);
  let st = null;
  if (!t) {
    st = await one('SELECT * FROM staff WHERE username = $1', [username]);
    if (st) t = await one('SELECT * FROM tenants WHERE id = $1', [st.tenant_id]);
  }
  if (!t || !await verifyPassword(password, (st || t).password_hash)) throw fail(401, 'Wrong username or password');
  if (st && !st.active) throw fail(403, 'This login has been switched off. Please ask your shop owner.');
  if (t.status !== 'active') throw fail(403, `This account is paused. Please contact ${PLATFORM}.`);
  if (!isActive(t)) throw fail(403, `Your plan has expired. Please contact ${PLATFORM} to renew.`);
  const payload = { t: t.id, v: t.session_version, exp: Date.now() + 7 * 86400000 };
  if (st) Object.assign(payload, { st: st.id, sv: st.session_version });
  await q(`UPDATE ${st ? 'staff' : 'tenants'} SET last_login_at = $2 WHERE id = $1`, [(st || t).id, utcNow()]);
  req.tenant = t;
  req.actor = st ? { type: st.role, id: st.id, name: st.name } : { type: 'owner', id: t.id, name: t.name };
  await log(req, 'auth.login', st ? 'staff' : 'merchant', (st || t).id);
  res.set('Set-Cookie', cookie(req, 'nv_admin', await makeToken(payload), 7 * 86400));
  res.json({ ok: true });
}));
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'nv_admin=; Path=/; Max-Age=0').json({ ok: true });
});
app.get('/api/admin/me', a(async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.json({ admin: false });
  const outlet = s.actor.outlet_id ? await one('SELECT id, name FROM outlets WHERE id = $1', [s.actor.outlet_id]) : null;
  res.json({
    admin: true, impersonated: !!s.actor.impersonating, role: s.actor.type === 'super' ? 'owner' : s.actor.type,
    user: { name: s.actor.name, username: s.actor.username || '', outlet },
    tenant: { ...brandOf(s.tenant), status: s.tenant.status, plan_expires_on: s.tenant.plan_expires_on },
  });
}));

// What each role may do. Owners (and the Super Admin looking in) may do everything.
function allowed(role, method, path) {
  if (role === 'owner' || role === 'super') return true;
  if (role === 'counter') {
    return (method === 'GET' && (/^\/lookup\//.test(path) || path === '/outlets'))
      || (method === 'POST' && /^\/redeem\//.test(path))
      || (method === 'PUT' && path === '/password');
  }
  if (role === 'manager') {
    if (path.startsWith('/staff') || path.startsWith('/activity') || path === '/clear-sample') return false;
    if (path.startsWith('/outlets') && method !== 'GET') return false;
    if (path === '/settings' && method !== 'GET') return false;
    return true;
  }
  return false;
}
app.use('/api/admin', a(async (req, res, next) => {
  const s = await currentSession(req);
  if (!s) throw fail(401, 'Please log in');
  req.tenant = s.tenant;
  req.actor = s.actor;
  if (!allowed(s.actor.type, req.method, req.path)) throw fail(403, 'Your login does not have access to this. Please ask your shop owner.');
  next();
}));
const T = req => req.tenant.id;
const outletOf = async (req, id) => {
  if (id === '' || id == null) return null;
  const o = await one('SELECT * FROM outlets WHERE id = $1 AND tenant_id = $2', [int(id), T(req)]);
  if (!o) throw fail(400, 'Unknown outlet');
  return o;
};

app.get('/api/admin/dashboard', a(async (req, res) => {
  const [kpi, days, gifts, recent, areas, outlets] = await Promise.all([
    one(`SELECT
        COUNT(*) AS printed,
        COUNT(*) FILTER (WHERE scans > 0) AS scanned,
        COUNT(*) FILTER (WHERE status IN ('claimed','redeemed')) AS claimed,
        COUNT(*) FILTER (WHERE status = 'redeemed') AS redeemed,
        COUNT(*) FILTER (WHERE status IN ('claimed','redeemed') AND gift_kind = 'prize') AS winners,
        COUNT(DISTINCT phone) AS customers,
        COUNT(*) FILTER (WHERE consent = 1) AS optins
      FROM coupons WHERE tenant_id = $1 AND status <> 'void'`, [T(req)]),
    q(`SELECT to_char(claimed_at, 'YYYY-MM-DD') AS d, COUNT(*) AS n FROM coupons
      WHERE tenant_id = $1 AND claimed_at >= (current_date - 13) GROUP BY 1`, [T(req)]),
    q('SELECT id, name, image, kind, stock_total, stock_used, weight, active, bumper FROM gifts WHERE tenant_id = $1 ORDER BY kind, id', [T(req)]),
    q(`SELECT code, customer_name, phone, area, gift_name, gift_kind, status, claimed_at FROM coupons
      WHERE tenant_id = $1 AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 8`, [T(req)]),
    q(`SELECT COALESCE(NULLIF(area,''),'Not given') AS area, COUNT(*) AS n FROM coupons
      WHERE tenant_id = $1 AND claimed_at IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 6`, [T(req)]),
    outletStats(T(req)),
  ]);
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ d, n: (days.find(x => x.d === d) || {}).n || 0 });
  }
  res.json({ kpi, series, gifts, recent, areas, outlets });
}));

// Per-outlet numbers: coupons handed out there (batch outlet) and gifts redeemed there.
function outletStats(tenantId) {
  return q(`SELECT o.id, o.name, o.address, o.phone, o.maps_url, o.active,
      COALESCE(i.issued, 0) AS issued, COALESCE(i.claimed, 0) AS claimed, COALESCE(r.redeemed, 0) AS redeemed
    FROM outlets o
    LEFT JOIN (SELECT b.outlet_id, COUNT(c.id) AS issued, COUNT(c.id) FILTER (WHERE c.status IN ('claimed','redeemed')) AS claimed
               FROM batches b JOIN coupons c ON c.batch_id = b.id WHERE b.tenant_id = $1 AND c.status <> 'void' GROUP BY b.outlet_id) i ON i.outlet_id = o.id
    LEFT JOIN (SELECT redeemed_outlet_id, COUNT(*) AS redeemed FROM coupons WHERE tenant_id = $1 AND status = 'redeemed' GROUP BY redeemed_outlet_id) r ON r.redeemed_outlet_id = o.id
    WHERE o.tenant_id = $1 ORDER BY o.active DESC, o.id`, [tenantId]);
}

// Gifts
const giftFields = b => ({
  name: String(b.name || '').trim().slice(0, 80),
  description: String(b.description || '').trim().slice(0, 240),
  image: String(b.image || '').slice(0, 2_500_000),
  kind: b.kind === 'lose' ? 'lose' : 'prize',
  weight: Math.max(0, Math.min(1000, int(b.weight))),
  stock_total: b.stock_total === '' || b.stock_total == null ? null : Math.max(0, int(b.stock_total)),
  valid_days: Math.max(0, Math.min(365, int(b.valid_days))),
  bumper: b.bumper ? 1 : 0,
  active: b.active === false || b.active === 0 ? 0 : 1,
});
const giftParams = f => [f.name, f.description, f.image, f.kind, f.weight, f.stock_total, f.valid_days, f.bumper, f.active];
const giftLog = f => ({ name: f.name, kind: f.kind, weight: f.weight, stock_total: f.stock_total, valid_days: f.valid_days, active: f.active, bumper: f.bumper });
app.get('/api/admin/gifts', a(async (req, res) => {
  res.json(await q(`SELECT g.*, (SELECT COUNT(*) FROM coupons c WHERE c.gift_id = g.id AND c.status = 'redeemed') AS redeemed
    FROM gifts g WHERE g.tenant_id = $1 ORDER BY g.kind = 'lose', g.id`, [T(req)]));
}));
app.post('/api/admin/gifts', a(async (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) throw fail(400, 'Gift name is required');
  const id = await tx(async t => {
    const { id } = await one(`INSERT INTO gifts(name, description, image, kind, weight, stock_total, valid_days, bumper, active, tenant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...giftParams(f), T(req)], t);
    await log(req, 'gift.created', 'gift', id, giftLog(f), t);
    return id;
  });
  res.json({ id });
}));
app.put('/api/admin/gifts/:id', a(async (req, res) => {
  const f = giftFields(req.body);
  if (!f.name) throw fail(400, 'Gift name is required');
  await tx(async t => {
    const r = await q(`UPDATE gifts SET name=$1, description=$2, image=$3, kind=$4, weight=$5, stock_total=$6, valid_days=$7, bumper=$8, active=$9
      WHERE id=$10 AND tenant_id=$11 RETURNING id`, [...giftParams(f), int(req.params.id), T(req)], t);
    if (!r.length) throw fail(404, 'Gift not found');
    await log(req, 'gift.updated', 'gift', int(req.params.id), giftLog(f), t);
  });
  res.json({ ok: true });
}));
app.delete('/api/admin/gifts/:id', a(async (req, res) => {
  await tx(async t => {
    const g = await one('DELETE FROM gifts WHERE id = $1 AND tenant_id = $2 RETURNING name', [int(req.params.id), T(req)], t);
    if (g) await log(req, 'gift.deleted', 'gift', int(req.params.id), { name: g.name }, t);
  });
  res.json({ ok: true });
}));

// Batches (print runs)
app.get('/api/admin/batches', a(async (req, res) => {
  res.json(await q(`SELECT b.*, o.name AS outlet_name,
      COUNT(c.id) FILTER (WHERE c.scans > 0) AS scanned,
      COUNT(c.id) FILTER (WHERE c.status IN ('claimed','redeemed')) AS claimed,
      COUNT(c.id) FILTER (WHERE c.status = 'redeemed') AS redeemed,
      COUNT(c.id) FILTER (WHERE c.status = 'void') AS voided
    FROM batches b LEFT JOIN coupons c ON c.batch_id = b.id LEFT JOIN outlets o ON o.id = b.outlet_id
    WHERE b.tenant_id = $1 GROUP BY b.id, o.name ORDER BY b.id DESC`, [T(req)]));
}));
app.post('/api/admin/batches', a(async (req, res) => {
  const count = int(req.body.count);
  if (!(count >= 1 && count <= 1000)) throw fail(400, 'Number of coupons must be between 1 and 1000');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'Campaign name is required');
  const outlet = await outletOf(req, req.body.outlet_id);
  if (req.tenant.max_coupons != null) {
    const { used } = await one('SELECT COALESCE(SUM(count), 0) AS used FROM batches WHERE tenant_id = $1', [T(req)]);
    const left = req.tenant.max_coupons - used;
    if (count > left) throw fail(403, left > 0 ? `Your plan allows ${left} more coupon${left === 1 ? '' : 's'}. Contact ${PLATFORM} to raise the limit.` : `You have used all the coupons in your plan. Contact ${PLATFORM} to raise the limit.`);
  }
  const fields = {
    tenantId: T(req),
    name,
    headline: String(req.body.headline || 'Scratch & Win').slice(0, 40),
    subline: String(req.body.subline || 'A sweet surprise is waiting for you!').slice(0, 80),
    theme: ['orange', 'chocolate', 'festive'].includes(req.body.theme) ? req.body.theme : 'orange',
    expires_on: /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null,
    count,
  };
  const id = await tx(async t => {
    const id = await createBatch(fields, t);
    if (outlet) await q('UPDATE batches SET outlet_id = $2 WHERE id = $1', [id, outlet.id], t);
    await log(req, 'batch.created', 'batch', id, { name, count, outlet: outlet ? outlet.name : null, expires_on: fields.expires_on }, t);
    return id;
  });
  res.json({ id });
}));
app.get('/api/admin/batches/:id', a(async (req, res) => {
  const batch = await one(`SELECT b.*, o.name AS outlet_name FROM batches b LEFT JOIN outlets o ON o.id = b.outlet_id
    WHERE b.id = $1 AND b.tenant_id = $2`, [int(req.params.id), T(req)]);
  if (!batch) throw fail(404, 'Not found');
  const [coupons, treats] = await Promise.all([
    q(`SELECT id, code, serial, status, scans, customer_name, phone, gift_name, gift_kind, claimed_at, redeemed_at
      FROM coupons WHERE batch_id = $1 ORDER BY serial`, [batch.id]),
    q(`SELECT image FROM gifts WHERE tenant_id = $1 AND kind = 'prize' AND image <> '' ORDER BY bumper DESC, id`, [T(req)]),
  ]);
  res.json({ batch, coupons, public_url: publicUrl(req, req.tenant), brand: brandOf(req.tenant), treats: treats.map(t => t.image) });
}));
app.post('/api/admin/batches/:id/void-unused', a(async (req, res) => {
  const voided = await tx(async t => {
    const r = await q("UPDATE coupons SET status='void' WHERE batch_id = $1 AND tenant_id = $2 AND status = 'new' RETURNING id", [int(req.params.id), T(req)], t);
    if (r.length) await log(req, 'batch.voided_unused', 'batch', int(req.params.id), { coupons: r.length }, t);
    return r.length;
  });
  res.json({ voided });
}));
app.delete('/api/admin/batches/:id', a(async (req, res) => {
  const id = int(req.params.id);
  const { n } = await one("SELECT COUNT(*) AS n FROM coupons WHERE batch_id = $1 AND tenant_id = $2 AND status IN ('claimed','redeemed')", [id, T(req)]);
  if (n) throw fail(409, 'This batch has claimed coupons. Void the unused ones instead.');
  await tx(async t => {
    const b = await one('DELETE FROM batches WHERE id = $1 AND tenant_id = $2 RETURNING name, count', [id, T(req)], t);
    if (b) await log(req, 'batch.deleted', 'batch', id, { name: b.name, count: b.count }, t);
  });
  res.json({ ok: true });
}));
app.post('/api/admin/coupons/:id/void', a(async (req, res) => {
  await tx(async t => {
    const c = await one("UPDATE coupons SET status='void' WHERE id = $1 AND tenant_id = $2 AND status = 'new' RETURNING code", [int(req.params.id), T(req)], t);
    if (c) await log(req, 'coupon.voided', 'coupon', c.code, {}, t);
  });
  res.json({ ok: true });
}));

// Customers / leads
function customerRows(tenantId, search) {
  const like = `%${search || ''}%`;
  return q(`SELECT c.id, c.code, c.customer_name, c.phone, c.area, c.dob, c.occasion, c.consent, c.gift_name, c.gift_kind,
      c.reward_code, c.reward_expires, c.status, c.claimed_at, c.redeemed_at, b.name AS campaign, o.name AS outlet, ro.name AS redeemed_outlet
    FROM coupons c JOIN batches b ON b.id = c.batch_id
    LEFT JOIN outlets o ON o.id = b.outlet_id LEFT JOIN outlets ro ON ro.id = c.redeemed_outlet_id
    WHERE c.tenant_id = $2 AND c.claimed_at IS NOT NULL AND (c.customer_name ILIKE $1 OR c.phone ILIKE $1 OR c.area ILIKE $1
      OR c.code ILIKE $1 OR COALESCE(c.reward_code,'') ILIKE $1)
    ORDER BY c.claimed_at DESC`, [like, tenantId]);
}
app.get('/api/admin/customers', a(async (req, res) => res.json(await customerRows(T(req), req.query.q))));
app.get('/api/admin/customers.csv', a(async (req, res) => {
  const rows = await customerRows(T(req), '');
  const cols = ['claimed_at', 'customer_name', 'phone', 'area', 'dob', 'occasion', 'consent', 'campaign', 'outlet', 'code', 'gift_name', 'reward_code', 'reward_expires', 'status', 'redeemed_at', 'redeemed_outlet'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
  await log(req, 'customers.exported', 'merchant', T(req), { rows: rows.length });
  res.set('Content-Disposition', `attachment; filename="${req.tenant.slug}-customers-${today()}.csv"`).type('text/csv').send('﻿' + csv);
}));

// Counter: look up a reward / coupon code and redeem it
app.get('/api/admin/lookup/:code', a(async (req, res) => {
  let code = String(req.params.code).toUpperCase().trim();
  const m = code.match(/\/C\/([A-Z0-9]+)/); if (m) code = m[1];
  code = code.replace(/^NAVYA-REWARD:|^REWARD:/, '').replace(/[^A-Z0-9]/g, '');
  const c = await one(`SELECT c.*, b.name AS campaign, g.image AS gift_image, ro.name AS redeemed_outlet FROM coupons c
    JOIN batches b ON b.id = c.batch_id LEFT JOIN gifts g ON g.id = c.gift_id LEFT JOIN outlets ro ON ro.id = c.redeemed_outlet_id
    WHERE c.tenant_id = $2 AND (c.reward_code = $1 OR c.code = $1)`, [code, T(req)]);
  if (!c) throw fail(404, 'No coupon or reward found for ' + code);
  res.json({ ...c, claim_token: undefined, ip: undefined, device: undefined, gift_image: c.gift_image || '', expired: !!(c.reward_expires && c.reward_expires < today()) });
}));
app.post('/api/admin/redeem/:id', a(async (req, res) => {
  // Counter staff always redeem at their own outlet; owners/managers pick one.
  const outlet = req.actor.type === 'counter' && req.actor.outlet_id
    ? await one('SELECT * FROM outlets WHERE id = $1', [req.actor.outlet_id])
    : await outletOf(req, req.body.outlet_id);
  const by = `${req.actor.name} (${req.actor.type})`;
  const done = await tx(async t => {
    // Single conditional UPDATE: two counters pressing "redeem" at once can't both succeed.
    const c = await one(`UPDATE coupons SET status='redeemed', redeemed_at=$3, redeemed_note=$4, redeemed_outlet_id=$5, redeemed_by=$6
      WHERE id=$1 AND tenant_id=$2 AND status='claimed' AND gift_kind='prize' RETURNING code, gift_name, reward_code`,
    [int(req.params.id), T(req), utcNow(), String(req.body.note || '').slice(0, 120), outlet ? outlet.id : null, by], t);
    if (c) await log(req, 'coupon.redeemed', 'coupon', c.code, { gift: c.gift_name, reward_code: c.reward_code, outlet: outlet ? outlet.name : null }, t);
    return c;
  });
  if (done) return res.json({ ok: true });
  const c = await one('SELECT status, redeemed_at FROM coupons WHERE id = $1 AND tenant_id = $2', [int(req.params.id), T(req)]);
  if (!c) throw fail(404, 'Not found');
  if (c.status === 'redeemed') throw fail(409, 'Already redeemed on ' + c.redeemed_at);
  throw fail(400, 'Nothing to redeem on this coupon');
}));

// Settings: the merchant's own profile/branding, coupon rules and password
app.get('/api/admin/settings', a(async (req, res) => {
  const t = req.tenant;
  const out = Object.fromEntries(PROFILE_FIELDS.map(k => [k, t[k]]));
  const { used } = await one('SELECT COALESCE(SUM(count), 0) AS used FROM batches WHERE tenant_id = $1', [t.id]);
  Object.assign(out, {
    slug: t.slug, detected_url: publicUrl(req, t, true), plan_expires_on: t.plan_expires_on, max_coupons: t.max_coupons, coupons_used: used,
    has_sample: !!(await one('SELECT 1 FROM batches WHERE tenant_id = $1 AND sample = 1 LIMIT 1', [t.id])),
  });
  res.json(out);
}));
app.put('/api/admin/settings', a(async (req, res) => {
  const fields = cleanTenant(req.body, PROFILE_FIELDS);
  const changed = Object.keys(fields).filter(k => String(fields[k] ?? '') !== String(req.tenant[k] ?? ''));
  await updateTenant(T(req), fields);
  if (changed.length) await log(req, 'settings.updated', 'merchant', T(req), { changed: changed.map(k => k === 'logo' ? 'logo' : k) });
  res.json({ ok: true });
}));
// Everyone changes their own password (owner → the merchant login, staff → their own login).
app.put('/api/admin/password', a(async (req, res) => {
  if (req.actor.type === 'super') throw fail(403, 'Use the Super Admin page to reset this merchant\'s password.');
  const isStaff = req.actor.type === 'manager' || req.actor.type === 'counter';
  const row = isStaff ? await one('SELECT * FROM staff WHERE id = $1', [req.actor.id]) : req.tenant;
  if (!await verifyPassword(String(req.body.current || ''), row.password_hash)) throw fail(400, 'Current password is wrong');
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw fail(400, 'New password must be at least 8 characters');
  // Keep this session, end all others.
  const updated = await one(`UPDATE ${isStaff ? 'staff' : 'tenants'} SET password_hash = $2, session_version = session_version + 1
    WHERE id = $1 RETURNING session_version`, [row.id, await hashPassword(pw)]);
  const payload = isStaff
    ? { t: T(req), v: req.tenant.session_version, st: row.id, sv: updated.session_version, exp: Date.now() + 7 * 86400000 }
    : { t: T(req), v: updated.session_version, exp: Date.now() + 7 * 86400000 };
  await log(req, 'password.changed', isStaff ? 'staff' : 'merchant', row.id);
  res.set('Set-Cookie', cookie(req, 'nv_admin', await makeToken(payload), 7 * 86400));
  res.json({ ok: true });
}));
app.post('/api/admin/clear-sample', a(async (req, res) => {
  await tx(async t => {
    await q(`UPDATE gifts g SET stock_used = GREATEST(0, g.stock_used - s.n)
      FROM (SELECT c.gift_id, COUNT(*) AS n FROM coupons c JOIN batches b ON b.id = c.batch_id
            WHERE b.tenant_id = $1 AND b.sample = 1 AND c.gift_id IS NOT NULL GROUP BY c.gift_id) s
      WHERE g.id = s.gift_id`, [T(req)], t);
    await q('DELETE FROM batches WHERE tenant_id = $1 AND sample = 1', [T(req)], t);
    await log(req, 'demo.cleared', 'merchant', T(req), {}, t);
  });
  res.json({ ok: true });
}));

// Outlets (branches)
const outletFields = b => {
  const f = {
    name: String(b.name || '').trim().slice(0, 80),
    address: String(b.address || '').trim().slice(0, 200),
    phone: String(b.phone || '').trim().slice(0, 30),
    maps_url: String(b.maps_url || '').trim().slice(0, 300),
    active: b.active === false || b.active === 0 ? 0 : 1,
  };
  if (!f.name) throw fail(400, 'Outlet name is required');
  return f;
};
app.get('/api/admin/outlets', a(async (req, res) => res.json(await outletStats(T(req)))));
app.post('/api/admin/outlets', a(async (req, res) => {
  const f = outletFields(req.body);
  const id = await tx(async t => {
    const { id } = await one('INSERT INTO outlets(tenant_id, name, address, phone, maps_url, active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [T(req), f.name, f.address, f.phone, f.maps_url, f.active], t);
    await log(req, 'outlet.created', 'outlet', id, { name: f.name, address: f.address }, t);
    return id;
  });
  res.json({ id });
}));
app.put('/api/admin/outlets/:id', a(async (req, res) => {
  const f = outletFields(req.body);
  await tx(async t => {
    const r = await q('UPDATE outlets SET name=$3, address=$4, phone=$5, maps_url=$6, active=$7 WHERE id=$1 AND tenant_id=$2 RETURNING id',
      [int(req.params.id), T(req), f.name, f.address, f.phone, f.maps_url, f.active], t);
    if (!r.length) throw fail(404, 'Outlet not found');
    await log(req, 'outlet.updated', 'outlet', int(req.params.id), f, t);
  });
  res.json({ ok: true });
}));

// Team (staff logins) — owner only
async function usernameFree(username, exceptStaffId = 0) {
  const t = await one('SELECT 1 FROM tenants WHERE slug = $1', [username]);
  const s = await one('SELECT 1 FROM staff WHERE username = $1 AND id <> $2', [username, exceptStaffId]);
  return !t && !s;
}
const cleanUsername = v => {
  const u = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,39}$/.test(u)) throw fail(400, 'Username: 2–40 characters, lowercase letters, numbers, dots and dashes');
  return u;
};
app.get('/api/admin/staff', a(async (req, res) => {
  res.json(await q(`SELECT s.id, s.name, s.username, s.role, s.outlet_id, o.name AS outlet_name, s.active, s.last_login_at, s.created_at
    FROM staff s LEFT JOIN outlets o ON o.id = s.outlet_id WHERE s.tenant_id = $1 ORDER BY s.active DESC, s.id`, [T(req)]));
}));
app.post('/api/admin/staff', a(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) throw fail(400, 'Name is required');
  const username = cleanUsername(req.body.username);
  const role = req.body.role === 'manager' ? 'manager' : 'counter';
  const outlet = await outletOf(req, req.body.outlet_id);
  if (role === 'counter' && !outlet) throw fail(400, 'Choose the outlet this counter login works at');
  if (!await usernameFree(username)) throw fail(409, 'That username is already taken');
  const password = String(req.body.password || '') || randomPassword();
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  const id = await tx(async t => {
    const { id } = await one(`INSERT INTO staff(tenant_id, outlet_id, name, username, role, password_hash)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [T(req), outlet ? outlet.id : null, name, username, role, await hashPassword(password)], t);
    await log(req, 'staff.created', 'staff', id, { name, username, role, outlet: outlet ? outlet.name : null }, t);
    return id;
  });
  res.json({ id, password });
}));
app.put('/api/admin/staff/:id', a(async (req, res) => {
  const id = int(req.params.id);
  const st = await one('SELECT * FROM staff WHERE id = $1 AND tenant_id = $2', [id, T(req)]);
  if (!st) throw fail(404, 'Staff login not found');
  const name = String(req.body.name ?? st.name).trim().slice(0, 80) || st.name;
  const role = req.body.role ? (req.body.role === 'manager' ? 'manager' : 'counter') : st.role;
  const outlet = 'outlet_id' in req.body ? await outletOf(req, req.body.outlet_id) : (st.outlet_id ? { id: st.outlet_id } : null);
  if (role === 'counter' && !outlet) throw fail(400, 'Choose the outlet this counter login works at');
  const active = 'active' in req.body ? (req.body.active ? 1 : 0) : st.active;
  await tx(async t => {
    // Switching a login off (or changing what it can do) signs it out everywhere.
    const bump = active !== st.active || role !== st.role ? 1 : 0;
    await q('UPDATE staff SET name=$2, role=$3, outlet_id=$4, active=$5, session_version = session_version + $6 WHERE id = $1',
      [id, name, role, outlet ? outlet.id : null, active, bump], t);
    await log(req, active !== st.active ? (active ? 'staff.enabled' : 'staff.disabled') : 'staff.updated', 'staff', id,
      { name, username: st.username, role, outlet_id: outlet ? outlet.id : null }, t);
  });
  res.json({ ok: true });
}));
app.post('/api/admin/staff/:id/password', a(async (req, res) => {
  const password = String(req.body.password || '') || randomPassword();
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  await tx(async t => {
    const r = await one('UPDATE staff SET password_hash = $3, session_version = session_version + 1 WHERE id = $1 AND tenant_id = $2 RETURNING username',
      [int(req.params.id), T(req), await hashPassword(password)], t);
    if (!r) throw fail(404, 'Staff login not found');
    await log(req, 'staff.password_reset', 'staff', int(req.params.id), { username: r.username }, t);
  });
  res.json({ password });
}));
app.delete('/api/admin/staff/:id', a(async (req, res) => {
  await tx(async t => {
    const r = await one('DELETE FROM staff WHERE id = $1 AND tenant_id = $2 RETURNING username, name', [int(req.params.id), T(req)], t);
    if (r) await log(req, 'staff.deleted', 'staff', int(req.params.id), { username: r.username, name: r.name }, t);
  });
  res.json({ ok: true });
}));

// Activity log (this merchant's entries only)
app.get('/api/admin/activity', a(async (req, res) => {
  const before = int(req.query.before) || 2 ** 62;
  res.json(await q(`SELECT id, actor_type, actor_name, action, entity, entity_id, details, created_at FROM audit_log
    WHERE tenant_id = $1 AND id < $2 ORDER BY id DESC LIMIT 60`, [T(req), before]));
}));

// ---------------------------------------------------------------- super admin API (platform owner)
const SUPER = { type: 'super', id: null, name: 'Super Admin' };
const slog = (req, tenantId, action, entity, entityId, details = {}, client) =>
  audit({ tenantId, actor: SUPER, action, entity, entityId, details, ip: req.ip }, client);

async function isSuper(req) {
  const p = await readToken(cookies(req).nv_super);
  return !!(p && p.s && String(p.v) === await getSetting('super_session_version', '1'));
}
app.post('/api/super/login', a(async (req, res) => {
  if (throttle('super:' + req.ip, 10)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
  if (!await verifyPassword(String(req.body.password || ''), await getSetting('super_password_hash'))) throw fail(401, 'Wrong password');
  const v = await getSetting('super_session_version', '1');
  await slog(req, null, 'super.login', 'platform', '');
  res.set('Set-Cookie', cookie(req, 'nv_super', await makeToken({ s: 1, v, exp: Date.now() + 12 * 3600000 }), 12 * 3600));
  res.json({ ok: true });
}));
app.post('/api/super/logout', (req, res) => {
  res.set('Set-Cookie', ['nv_super=; Path=/; Max-Age=0', 'nv_admin=; Path=/; Max-Age=0']).json({ ok: true });
});
app.get('/api/super/me', a(async (req, res) => res.json({ super: await isSuper(req) })));

app.use('/api/super', a(async (req, res, next) => {
  if (!await isSuper(req)) throw fail(401, 'Please log in');
  next();
}));

app.get('/api/super/overview', a(async (req, res) => {
  const tenants = await q(`SELECT t.id, t.slug, t.name, t.logo, t.color, t.status, t.plan_expires_on, t.max_coupons,
      t.contact_name, t.contact_phone, t.last_login_at, t.created_at,
      COALESCE(s.printed, 0) AS printed, COALESCE(s.claimed, 0) AS claimed, COALESCE(s.redeemed, 0) AS redeemed,
      COALESCE(s.customers, 0) AS customers, COALESCE(s.claims_30d, 0) AS claims_30d, s.last_claim_at,
      (SELECT COUNT(*) FROM outlets o WHERE o.tenant_id = t.id AND o.active = 1) AS outlets,
      (SELECT COUNT(*) FROM staff st WHERE st.tenant_id = t.id AND st.active = 1) AS staff
    FROM tenants t LEFT JOIN (
      SELECT tenant_id, COUNT(*) AS printed,
        COUNT(*) FILTER (WHERE status IN ('claimed','redeemed')) AS claimed,
        COUNT(*) FILTER (WHERE status = 'redeemed') AS redeemed,
        COUNT(DISTINCT phone) AS customers,
        COUNT(*) FILTER (WHERE claimed_at >= (now() AT TIME ZONE 'utc') - interval '30 days') AS claims_30d,
        MAX(claimed_at) AS last_claim_at
      FROM coupons GROUP BY tenant_id) s ON s.tenant_id = t.id
    ORDER BY t.created_at DESC`);
  for (const t of tenants) t.active = isActive(t);
  res.json({ tenants, today: today() });
}));
app.get('/api/super/tenants/:id', a(async (req, res) => {
  const t = await one('SELECT * FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  delete t.password_hash;
  res.json(t);
}));
app.post('/api/super/tenants', a(async (req, res) => {
  const fields = cleanTenant(req.body, [...PROFILE_FIELDS, ...ACCOUNT_FIELDS]);
  if (!fields.slug) throw fail(400, 'Username is required');
  if (!fields.name) throw fail(400, 'Merchant name is required');
  if (await one('SELECT 1 FROM staff WHERE username = $1', [fields.slug])) throw fail(409, 'That username is already taken');
  const password = String(req.body.password || '') || randomPassword();
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  if (!fields.terms) fields.terms = `One coupon per customer visit. Reward valid at ${fields.name} till the date shown. Not exchangeable for cash.`;
  const id = await tx(async c => {
    const keys = Object.keys(fields);
    let row;
    try {
      row = await one(`INSERT INTO tenants(${keys.join(', ')}, password_hash) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(', ')}, $${keys.length + 1}) RETURNING id`,
        [...keys.map(k => fields[k]), await hashPassword(password)], c);
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'That username is already taken');
      throw e;
    }
    await q("INSERT INTO outlets(tenant_id, name, address) VALUES($1, 'Main shop', $2)", [row.id, fields.address || ''], c);
    if (req.body.starter_gifts !== false) await addStarterGifts(row.id, fields.name, c);
    await slog(req, row.id, 'merchant.created', 'merchant', row.id, { name: fields.name, username: fields.slug, max_coupons: fields.max_coupons ?? null, plan_expires_on: fields.plan_expires_on ?? null }, c);
    return row.id;
  });
  res.json({ id, password });
}));
app.put('/api/super/tenants/:id', a(async (req, res) => {
  const id = int(req.params.id);
  const before = await one('SELECT * FROM tenants WHERE id = $1', [id]);
  if (!before) throw fail(404, 'Merchant not found');
  const fields = cleanTenant(req.body, [...PROFILE_FIELDS, ...ACCOUNT_FIELDS]);
  if (fields.slug && fields.slug !== before.slug && await one('SELECT 1 FROM staff WHERE username = $1', [fields.slug])) throw fail(409, 'That username is already taken');
  await updateTenant(id, fields);
  // Pausing a merchant logs it (and its staff) out everywhere.
  if (fields.status === 'suspended' && before.status !== 'suspended') await q('UPDATE tenants SET session_version = session_version + 1 WHERE id = $1', [id]);
  const changed = Object.keys(fields).filter(k => String(fields[k] ?? '') !== String(before[k] ?? ''));
  if (changed.length) {
    const action = 'status' in fields && fields.status !== before.status ? `merchant.${fields.status === 'suspended' ? 'suspended' : 'activated'}` : 'merchant.updated';
    const details = Object.fromEntries(changed.map(k => [k, k === 'logo' ? '(new logo)' : fields[k]]));
    await slog(req, id, action, 'merchant', id, details);
  }
  res.json({ ok: true });
}));
app.post('/api/super/tenants/:id/password', a(async (req, res) => {
  const password = String(req.body.password || '') || randomPassword();
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  const r = await q('UPDATE tenants SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING id',
    [int(req.params.id), await hashPassword(password)]);
  if (!r.length) throw fail(404, 'Merchant not found');
  await slog(req, int(req.params.id), 'merchant.password_reset', 'merchant', int(req.params.id));
  res.json({ password });
}));
app.post('/api/super/tenants/:id/impersonate', a(async (req, res) => {
  const t = await one('SELECT id, session_version FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  await slog(req, t.id, 'merchant.opened_by_super', 'merchant', t.id);
  res.set('Set-Cookie', cookie(req, 'nv_admin', await makeToken({ t: t.id, v: t.session_version, imp: 1, exp: Date.now() + 2 * 3600000 }), 2 * 3600));
  res.json({ ok: true });
}));
app.delete('/api/super/tenants/:id', a(async (req, res) => {
  const t = await one('SELECT slug, name FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  if (String(req.body.confirm || '') !== t.slug) throw fail(400, `Type the username "${t.slug}" to confirm`);
  await tx(async c => {
    const { n } = await one('SELECT COUNT(*) AS n FROM coupons WHERE tenant_id = $1', [int(req.params.id)], c);
    await q('DELETE FROM tenants WHERE id = $1', [int(req.params.id)], c); // outlets, staff, gifts, batches, coupons go with it
    await slog(req, int(req.params.id), 'merchant.deleted', 'merchant', int(req.params.id), { name: t.name, username: t.slug, coupons: n }, c);
  });
  res.json({ ok: true });
}));
app.put('/api/super/password', a(async (req, res) => {
  if (!await verifyPassword(String(req.body.current || ''), await getSetting('super_password_hash'))) throw fail(400, 'Current password is wrong');
  const pw = String(req.body.password || '');
  if (pw.length < 10) throw fail(400, 'Super admin password must be at least 10 characters');
  const v = String(int(await getSetting('super_session_version', '1')) + 1);
  await setSetting('super_password_hash', await hashPassword(pw));
  await setSetting('super_session_version', v);
  await slog(req, null, 'super.password_changed', 'platform', '');
  res.set('Set-Cookie', cookie(req, 'nv_super', await makeToken({ s: 1, v, exp: Date.now() + 12 * 3600000 }), 12 * 3600));
  res.json({ ok: true });
}));

// Platform-wide activity log, and a full check that nobody has altered it.
app.get('/api/super/activity', a(async (req, res) => {
  const before = int(req.query.before) || 2 ** 62;
  const tenant = req.query.tenant ? int(req.query.tenant) : null;
  res.json(await q(`SELECT a.id, a.tenant_id, t.name AS tenant_name, a.actor_type, a.actor_name, a.action, a.entity, a.entity_id,
      a.details, a.ip, a.created_at, a.hash
    FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
    WHERE a.id < $1 AND ($2::int IS NULL OR a.tenant_id = $2) ORDER BY a.id DESC LIMIT 80`, [before, tenant]));
}));
app.get('/api/super/activity/verify', a(async (req, res) => res.json(await verifyAudit())));

// ---------------------------------------------------------------- pages
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
app.get('/admin/print/:id', (req, res) => res.sendFile(path.join(pub, 'admin', 'print.html')));
app.get('/super', (req, res) => res.sendFile(path.join(pub, 'super', 'index.html')));
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
      console.log(`\n  ${PLATFORM} running (database: Neon Postgres)`);
      console.log(`  Merchant admin: http://localhost:${PORT}/admin`);
      console.log(`  Super admin:  http://localhost:${PORT}/super`);
      console.log(`  Phones on the same Wi-Fi: http://${lanIp()}:${PORT}\n`);
    });
  }).catch(e => { console.error('Could not connect to the database:', e.message); process.exit(1); });
}
