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

// ---------- addresses ----------
// genuinedraw.in → Super Admin; <merchant>.genuinedraw.in → that merchant's admin and customer pages.
// Any other host (the old vercel.app address, localhost) keeps working as before, with every page available.
const BASE = (process.env.PLATFORM_DOMAIN || 'genuinedraw.in').toLowerCase();
const RESERVED = new Set(['www', 'admin', 'api', 'app', 'mail', 'email', 'super', 'static', 'assets', 'cdn', 'help', 'support',
  'blog', 'docs', 'status', 'dev', 'test', 'staging', 'demo', 'm', 'ns1', 'ns2', 'smtp', 'ftp', 'verify', 'winners', 'draw', 'secure']);
function siteOf(req) {
  const host = String(req.hostname || '').toLowerCase();
  if (host === BASE) return { kind: 'platform' };
  if (host.endsWith('.' + BASE)) {
    const sub = host.slice(0, -(BASE.length + 1));
    return !sub.includes('.') && !RESERVED.has(sub) ? { kind: 'merchant', slug: sub } : { kind: 'unknown' };
  }
  return { kind: 'legacy' };
}
const onPlatformDomain = req => siteOf(req).kind !== 'legacy';
const platformBase = req => onPlatformDomain(req) ? `https://${BASE}` : `${req.protocol}://${req.get('host')}`;

// The URL printed inside each QR. The merchant's own setting wins; on the Genuine Draw domain it is the merchant's
// subdomain; otherwise the request host, swapping localhost for the LAN IP so phones on the same Wi-Fi can open it.
function publicUrl(req, tenant, ignoreSetting = false) {
  const set = ignoreSetting ? '' : String(tenant?.public_url || '').trim().replace(/\/+$/, '');
  if (set) return set;
  if (tenant && onPlatformDomain(req)) return `https://${tenant.slug}.${BASE}`;
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
// Host-only by default. The Super Admin cookie is shared with merchant subdomains (so "Open as merchant" can
// check it there): pass shared=true for that.
const cookie = (req, name, value, maxAge, shared = false) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}${shared && onPlatformDomain(req) ? '; Domain=.' + BASE : ''}`;
// The merchant's own admin address (its subdomain on the Genuine Draw domain).
const adminUrl = (req, t) => (onPlatformDomain(req) ? `https://${t.slug}.${BASE}` : `${req.protocol}://${req.get('host')}`) + '/admin';

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
        if (RESERVED.has(v)) throw fail(400, `"${v}" is reserved. Please choose another username.`);
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
// Campaign facts the customer page needs (prizes only for Lucky Draws).
async function campaignView(batch, client, lock = false) {
  const camp = batch.campaign_id ? await one(`SELECT * FROM campaigns WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [batch.campaign_id], client) : null;
  if (camp && camp.type === 'draw') camp._draw = await one('SELECT id, status FROM draws WHERE campaign_id = $1', [camp.id], client) || null;
  const prizes = camp && camp.type === 'draw'
    ? await q('SELECT rank, name, description, image, quantity FROM campaign_prizes WHERE campaign_id = $1 ORDER BY rank, id', [camp.id], client) : [];
  return {
    camp,
    view: {
      name: camp ? camp.name : batch.name, type: camp ? camp.type : 'instant', headline: batch.headline, subline: batch.subline,
      theme: batch.theme, expires_on: batch.expires_on, starts_on: camp?.starts_on || null, ends_on: camp?.ends_on || null,
      draw_on: camp?.draw_on || null, description: camp?.description || '', terms: camp?.terms || '', status: camp?.status || 'active', prizes,
      draw_id: camp?._draw?.id || null, draw_status: camp?._draw?.status || null,
    },
  };
}
// Why a coupon can't be played right now (or null if it can).
function campaignBlock(batch, camp) {
  const d = today();
  if (batch.expires_on && batch.expires_on < d) return ['expired', 'Sorry, this coupon has expired.'];
  if (!camp) return null;
  if (camp.status === 'paused') return ['campaign_paused', 'This campaign is paused right now. Please try again later.'];
  if (camp.status === 'drawn') return ['campaign_ended', 'The draw for this campaign has already taken place.'];
  if (camp._draw) return ['campaign_ended', 'Entries for this draw are closed. The draw is being run now.'];
  if (camp.starts_on && camp.starts_on > d) return ['not_started', `This campaign starts on ${camp.starts_on}.`];
  if (camp.ends_on && camp.ends_on < d) return ['campaign_ended', 'This campaign has ended.'];
  return null;
}

app.get('/api/c/:code', a(async (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = await one(`UPDATE coupons SET scans = scans + 1, first_scan_at = COALESCE(first_scan_at, $2)
    WHERE code = $1 RETURNING *`, [code, utcNow()]);
  if (!c) return res.json({ state: 'invalid' });
  const [batch, tenant] = await Promise.all([
    one('SELECT * FROM batches WHERE id = $1', [c.batch_id]),
    one('SELECT * FROM tenants WHERE id = $1', [c.tenant_id]),
  ]);
  const site = siteOf(req);
  if (site.kind === 'merchant' && site.slug !== tenant.slug) return res.json({ state: 'moved', url: `${publicUrl(req, tenant)}/c/${c.code}` });
  const { camp, view } = await campaignView(batch);
  const base = { code: c.code, serial: c.serial, brand: brandOf(tenant), campaign: view, help_url: `${platformBase(req)}/my?coupon=${c.code}` };
  const token = String(req.get('x-claim-token') || '');
  if (c.status !== 'new' && c.status !== 'void' && token && c.claim_token && token === c.claim_token) {
    const gift = c.gift_id ? await one('SELECT * FROM gifts WHERE id = $1', [c.gift_id]) : null;
    return res.json({ ...base, state: 'mine', reward: rewardPayload(c, gift) });
  }
  if (!isActive(tenant)) return res.json({ ...base, state: 'paused' });
  if (c.status === 'void') return res.json({ ...base, state: 'void' });
  if (c.status === 'new') {
    const block = campaignBlock(batch, camp);
    if (block) return res.json({ ...base, state: block[0] === 'expired' ? 'expired' : block[0], message: block[1] });
    return res.json({ ...base, state: 'new' });
  }
  res.json({ ...base, state: 'claimed', claimed_by: maskName(c.customer_name), phone: maskPhone(c.phone), claimed_at: c.claimed_at,
    gift: c.gift_kind === 'prize' ? { name: c.gift_name } : c.gift_kind === 'entry' ? { name: 'Lucky draw entry' } : null });
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
    const site = siteOf(req);
    if (site.kind === 'merchant' && site.slug !== tenant.slug) throw fail(404, 'This coupon is not valid.');
    if (!isActive(tenant)) throw fail(403, 'This offer is paused right now. Please try again later.');
    if (c.status !== 'new') throw fail(409, 'This coupon has already been claimed.');
    const batch = await one('SELECT * FROM batches WHERE id = $1', [c.batch_id], t);
    const { camp } = await campaignView(batch, t, true);
    const block = campaignBlock(batch, camp);
    if (block) throw fail(410, block[1]);
    if (tenant.one_per_phone) {
      const used = await one(`SELECT 1 FROM coupons c2 JOIN batches b2 ON b2.id = c2.batch_id
        WHERE c2.phone = $1 AND c2.status IN ('claimed','redeemed') AND (b2.id = $2 OR (b2.campaign_id IS NOT NULL AND b2.campaign_id = $3))`,
      [phone, c.batch_id, batch.campaign_id], t);
      if (used) throw fail(409, 'This mobile number has already played in this campaign. Share the coupon with a friend!');
    }
    const isDraw = camp && camp.type === 'draw';
    // Instant Win: pick a gift now. Lucky Draw: record an entry; winners are drawn later.
    const gift = isDraw ? null : await pickGift(c.tenant_id, t);
    const kind = isDraw ? 'entry' : gift ? gift.kind : 'lose';
    let reward = null;
    if (kind === 'prize') {
      do { reward = 'NB' + randomCode(6); } while (await one('SELECT 1 FROM coupons WHERE reward_code = $1', [reward], t));
    }
    const expires = kind === 'prize' ? new Date(Date.now() + gift.valid_days * 86400000).toISOString().slice(0, 10) : null;
    const token = crypto.randomBytes(16).toString('hex');
    const fresh = await one(`UPDATE coupons SET status='claimed', gift_id=$1, gift_name=$2, gift_kind=$3, reward_code=$4, reward_expires=$5,
      claim_token=$6, customer_name=$7, phone=$8, area=$9, dob=$10, occasion=$11, consent=$12, device=$13, ip=$14, claimed_at=$15, draw_entry=$17
      WHERE id=$16 RETURNING *`,
    [gift ? gift.id : null, isDraw ? 'Lucky draw entry' : gift ? gift.name : 'Better luck next time', kind, reward, expires, token,
      name, phone, area, dob, occasion, req.body.consent ? 1 : 0, String(req.get('user-agent') || '').slice(0, 200), req.ip, utcNow(), c.id, isDraw ? 1 : 0], t);
    if (gift) await q('UPDATE gifts SET stock_used = stock_used + 1 WHERE id = $1', [gift.id], t);
    await audit({ tenantId: c.tenant_id, actor: { type: 'customer', name: maskName(name) }, action: isDraw ? 'coupon.entered' : 'coupon.claimed', entity: 'coupon', entityId: c.code,
      details: { gift: fresh.gift_name, kind, reward_code: reward, phone: maskPhone(phone), batch_id: c.batch_id, campaign_id: batch.campaign_id }, ip: req.ip }, t);
    return { token, reward: rewardPayload(fresh, gift) };
  });
  res.json(out);
}));

// ---------------------------------------------------------------- WhatsApp notifications
// Approved WhatsApp templates sent through WAAU (Meta Cloud API format). Needs WAAU_PHONE_NUMBER_ID and
// WAAU_ACCESS_TOKEN. Without them nothing is sent; locally the customer login code is shown on screen instead.
const WA = {
  phoneId: process.env.WAAU_PHONE_NUMBER_ID || '',
  token: process.env.WAAU_ACCESS_TOKEN || '',
  api: (process.env.WAAU_API_URL || 'https://crmapi.waau.in/api/meta').replace(/\/$/, ''),
  version: process.env.WAAU_API_VERSION || 'v19.0',
  lang: process.env.WAAU_TEMPLATE_LANG || 'en',
};
const WA_ON = !!(WA.phoneId && WA.token);
const OTP_ON_SCREEN = !WA_ON && (process.env.OTP_DEV_MODE === '1' || !process.env.VERCEL);
const cleanPhone = v => String(v || '').replace(/\D/g, '').slice(-10);
// Meta rejects template values with line breaks, tabs or long runs of spaces.
const waText = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || '-';
async function sendTemplate(phone, name, params = [], { code } = {}) {
  const to = cleanPhone(phone);
  if (!WA_ON || !/^[6-9]\d{9}$/.test(to)) return false;
  const components = [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: waText(p) })) }];
  if (code) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });   // "Copy code" button
  const body = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '91' + to, type: 'template',
    template: { name, language: { policy: 'deterministic', code: WA.lang }, components } });
  for (const url of [`${WA.api}/${WA.version}/${WA.phoneId}/messages`, `${WA.api}/${WA.phoneId}/messages`]) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${WA.token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
      if (r.ok) return true;
      console.error(`WhatsApp ${name} to ..${to.slice(-4)} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
      if (r.status !== 404) return false;
    } catch (e) { console.error(`WhatsApp ${name} failed: ${e.message}`); }
  }
  return false;
}
const host = req => onPlatformDomain(req) ? BASE : String(req.get('host') || BASE);
const superPhone = () => process.env.SUPER_WHATSAPP || '';

// ---------------------------------------------------------------- Phase 1: merchant self sign-up
app.post('/api/register', a(async (req, res) => {
  const k = siteOf(req).kind;
  if (k === 'merchant' || k === 'unknown') throw fail(404, 'Not found');
  if (throttle('register:' + req.ip, 5, 60 * 60000)) throw fail(429, 'Too many sign-ups from this network. Please try again later.');
  const b = req.body || {};
  const fields = cleanTenant({ name: b.name, slug: b.username, address: b.address }, ['name', 'slug', 'address']);
  const owner = String(b.owner_name || '').trim().slice(0, 80);
  const phone = cleanPhone(b.phone);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(b.password || '');
  if (owner.length < 2) throw fail(400, "Please enter the owner's name");
  if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Please enter a valid 10-digit mobile number');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Please enter a valid email address');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  if (!b.agree) throw fail(400, 'Please accept the terms to continue');
  if (!await usernameFree(fields.slug)) throw fail(409, 'That username is already taken');
  const extra = {
    owner_name: owner, contact_name: owner, contact_phone: phone, whatsapp: phone, email,
    gst_number: String(b.gst_number || '').trim().toUpperCase().slice(0, 20),
    business_type: String(b.business_type || '').trim().slice(0, 40),
    status: 'pending', signup_source: 'self',
    terms: `One coupon per customer visit. Reward valid at ${fields.name} till the date shown. Not exchangeable for cash.`,
  };
  const all = { ...fields, ...extra };
  const id = await tx(async c => {
    const keys = Object.keys(all);
    let row;
    try {
      row = await one(`INSERT INTO tenants(${keys.join(', ')}, password_hash) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(', ')}, $${keys.length + 1}) RETURNING id`,
        [...keys.map(x => all[x]), await hashPassword(password)], c);
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'That username is already taken');
      throw e;
    }
    await q("INSERT INTO outlets(tenant_id, name, address) VALUES($1, 'Main shop', $2)", [row.id, fields.address || ''], c);
    await addStarterGifts(row.id, fields.name, c);
    await audit({ tenantId: row.id, actor: { type: 'owner', name: owner }, action: 'merchant.registered', entity: 'merchant', entityId: row.id,
      details: { name: fields.name, username: fields.slug, business_type: extra.business_type, phone: maskPhone(phone) }, ip: req.ip }, c);
    return row.id;
  });
  await Promise.all([
    sendTemplate(phone, 'gd_registration_received', [owner.split(' ')[0], fields.name, `${fields.slug}.${BASE}`]),
    sendTemplate(superPhone(), 'gd_new_signup_alert', [fields.name, fields.slug, owner, phone]),
  ]);
  res.json({ ok: true, username: fields.slug, admin_url: adminUrl(req, fields) });
}));
app.get('/api/register/check', a(async (req, res) => {
  const u = String(req.query.username || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(u)) return res.json({ ok: false, error: '2–40 characters: lowercase letters, numbers and dashes' });
  if (RESERVED.has(u)) return res.json({ ok: false, error: 'That name is reserved' });
  res.json(await usernameFree(u) ? { ok: true, url: `${u}.${BASE}` } : { ok: false, error: 'Already taken' });
}));

// ---------------------------------------------------------------- Phase 2: public verification
// Anyone can check a coupon or reward code. Nothing personal is shown and the scan count isn't touched.
app.get('/api/verify/:code', a(async (req, res) => {
  if (throttle('verify:' + req.ip, 60)) throw fail(429, 'Too many checks. Please wait a few minutes.');
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = await one('SELECT * FROM coupons WHERE code = $1 OR reward_code = $1', [code]);
  if (!c) return res.json({ found: false });
  const [batch, tenant] = await Promise.all([
    one('SELECT * FROM batches WHERE id = $1', [c.batch_id]),
    one('SELECT * FROM tenants WHERE id = $1', [c.tenant_id]),
  ]);
  const { camp, view } = await campaignView(batch);
  const block = c.status === 'new' ? campaignBlock(batch, camp) : null;
  const entry = await one(`SELECT hash, created_at FROM audit_log WHERE entity = 'coupon' AND entity_id = $1
    AND action IN ('coupon.claimed','coupon.entered') ORDER BY id LIMIT 1`, [c.code]);
  const redeemedAt = c.status === 'redeemed' ? c.redeemed_at : null;
  res.json({
    found: true, code: c.code, serial: c.serial, matched: code === c.code ? 'coupon' : 'reward',
    status: c.status === 'new' ? (block ? block[0] : 'unused') : c.status,
    status_note: block ? block[1] : '',
    shop: { name: tenant.name, logo: tenant.logo, color: tenant.color, verified: isActive(tenant) },
    campaign: { name: view.name, type: view.type, starts_on: view.starts_on, ends_on: view.ends_on, draw_on: view.draw_on, prizes: view.prizes, draw_id: view.draw_status === 'drawn' ? view.draw_id : null },
    claimed_at: c.claimed_at, claimed_by: maskName(c.customer_name || ''), phone: maskPhone(c.phone || ''),
    result: c.gift_kind === 'entry' ? (camp && camp.status === 'drawn' ? 'Lucky draw entry: not a winner this time' : 'Lucky draw entry') : c.gift_kind === 'prize' ? c.gift_name : c.gift_kind === 'lose' ? 'No prize this time' : null,
    reward_expires: c.gift_kind === 'prize' ? c.reward_expires : null, redeemed_at: redeemedAt,
    record: entry ? { hash: entry.hash, at: entry.created_at } : null,
  });
}));
// Shops a customer can pick when complaining without a coupon.
app.get('/api/public/shops', a(async (req, res) => {
  res.json(await q("SELECT slug, name FROM tenants WHERE status = 'active' ORDER BY name"));
}));

// ---------------------------------------------------------------- Phase 2: customer portal (WhatsApp OTP)
const otpHash = async (phone, code) => crypto.createHmac('sha256', await secret()).update(`${phone}:${code}`).digest('hex');
async function customerOf(req) {
  const p = await readToken(cookies(req).nv_cust);
  return p && p.cp ? p.cp : null;
}
app.post('/api/my/otp', a(async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Please enter a valid 10-digit mobile number');
  if (throttle('otp:' + req.ip, 10, 60 * 60000) || throttle('otp-phone:' + phone, 4, 30 * 60000)) throw fail(429, 'Too many codes requested. Please wait a while and try again.');
  if (!WA_ON && !OTP_ON_SCREEN) throw fail(503, 'WhatsApp login is being set up. Please try again soon, or contact the shop directly.');
  const code = String(crypto.randomInt(100000, 1000000));
  await q('UPDATE otp_codes SET used = 1 WHERE phone = $1 AND used = 0', [phone]);
  await q('INSERT INTO otp_codes(phone, code_hash, expires_at) VALUES($1, $2, $3)',
    [phone, await otpHash(phone, code), new Date(Date.now() + 10 * 60000).toISOString().replace('T', ' ').slice(0, 19)]);
  if (WA_ON) {
    const sent = await sendTemplate(phone, 'gd_login_code', [code], { code });
    if (!sent) throw fail(502, 'Could not send the WhatsApp message. Please try again.');
    return res.json({ ok: true });
  }
  res.json({ ok: true, dev_code: code });
}));
app.post('/api/my/login', a(async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (throttle('otp-login:' + req.ip, 30)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
  const row = await one(`SELECT * FROM otp_codes WHERE phone = $1 AND used = 0 AND expires_at > $2 ORDER BY id DESC LIMIT 1`, [phone, utcNow()]);
  if (!row) throw fail(400, 'This code has expired. Please ask for a new one.');
  if (row.attempts >= 5) throw fail(429, 'Too many wrong codes. Please ask for a new one.');
  if (row.code_hash !== await otpHash(phone, code)) {
    await q('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw fail(400, 'That code is not right. Please check and try again.');
  }
  await q('UPDATE otp_codes SET used = 1 WHERE id = $1', [row.id]);
  res.set('Set-Cookie', cookie(req, 'nv_cust', await makeToken({ cp: phone, exp: Date.now() + 30 * 86400000 }), 30 * 86400));
  res.json({ ok: true });
}));
app.post('/api/my/logout', (req, res) => res.set('Set-Cookie', 'nv_cust=; Path=/; Max-Age=0').json({ ok: true }));
app.get('/api/my/me', a(async (req, res) => {
  const phone = await customerOf(req);
  if (!phone) return res.json({ customer: false, otp_on_screen: OTP_ON_SCREEN, otp_available: WA_ON || OTP_ON_SCREEN });
  const n = await one('SELECT customer_name FROM coupons WHERE phone = $1 AND customer_name IS NOT NULL ORDER BY claimed_at DESC LIMIT 1', [phone]);
  res.json({ customer: true, phone, name: n ? n.customer_name : '' });
}));
app.use('/api/my', a(async (req, res, next) => {
  req.customer = await customerOf(req);
  if (!req.customer) throw fail(401, 'Please log in');
  next();
}));
app.get('/api/my/coupons', a(async (req, res) => {
  const rows = await q(`SELECT c.code, c.status, c.gift_name, c.gift_kind, c.reward_code, c.reward_expires, c.claimed_at, c.redeemed_at,
      t.name AS shop, t.slug, t.logo, t.color, cp.name AS campaign, cp.type AS campaign_type, cp.draw_on, o.name AS outlet
    FROM coupons c JOIN tenants t ON t.id = c.tenant_id JOIN batches b ON b.id = c.batch_id
    LEFT JOIN campaigns cp ON cp.id = b.campaign_id LEFT JOIN outlets o ON o.id = b.outlet_id
    WHERE c.phone = $1 AND c.status IN ('claimed','redeemed') ORDER BY c.claimed_at DESC LIMIT 200`, [req.customer]);
  res.json(rows);
}));

// ---------- complaints (shared) ----------
const CATEGORIES = {
  not_received: 'Did not get my coupon / reward', prize_not_given: 'Shop did not give the prize', result_dispute: 'Problem with the result',
  invalid_coupon: 'Coupon shows as invalid or used', other: 'Something else',
};
const COMPLAINT_STATUS = ['open', 'in_progress', 'resolved', 'rejected'];
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', rejected: 'Closed' };
// Tickets nobody has resolved within a day go to the Super Admin. Runs whenever complaint lists are opened.
async function escalateOverdue() {
  const due = await q(`UPDATE complaints SET escalated = 1, escalated_at = $1, escalation_reason = 'Not resolved within 24 hours'
    WHERE escalated = 0 AND status IN ('open','in_progress') AND created_at < $2 RETURNING id, ticket_no, tenant_id`,
  [utcNow(), new Date(Date.now() - 24 * 3600000).toISOString().replace('T', ' ').slice(0, 19)]);
  for (const c of due) {
    await q("INSERT INTO complaint_messages(complaint_id, author_type, author_name, body) VALUES($1, 'system', $2, $3)",
      [c.id, PLATFORM, 'Not resolved within 24 hours, so this ticket has been sent to the Genuine Draw team.']);
    await audit({ tenantId: c.tenant_id, actor: { type: 'system', name: PLATFORM }, action: 'complaint.escalated', entity: 'complaint', entityId: c.ticket_no, details: { reason: 'overdue' } });
  }
  for (const c of due) {
    const t = await one('SELECT name FROM tenants WHERE id = $1', [c.tenant_id]);
    await sendTemplate(superPhone(), 'gd_complaint_escalated', [c.ticket_no, t ? t.name : PLATFORM, 'Not resolved within 24 hours']);
  }
}
async function complaintDetail(where, params) {
  const c = await one(`SELECT k.*, t.name AS shop, t.slug, o.name AS outlet, cp.name AS campaign
    FROM complaints k LEFT JOIN tenants t ON t.id = k.tenant_id LEFT JOIN outlets o ON o.id = k.outlet_id
    LEFT JOIN coupons cc ON cc.id = k.coupon_id LEFT JOIN batches b ON b.id = cc.batch_id LEFT JOIN campaigns cp ON cp.id = b.campaign_id
    WHERE ${where}`, params);
  if (!c) throw fail(404, 'Ticket not found');
  c.messages = await q('SELECT author_type, author_name, body, created_at FROM complaint_messages WHERE complaint_id = $1 ORDER BY id', [c.id]);
  c.category_label = CATEGORIES[c.category];
  return c;
}
const complaintList = (where, params) => q(`SELECT k.id, k.ticket_no, k.category, k.status, k.escalated, k.coupon_code, k.customer_name, k.phone,
    k.created_at, k.updated_at, t.name AS shop, o.name AS outlet,
    (SELECT body FROM complaint_messages m WHERE m.complaint_id = k.id ORDER BY m.id DESC LIMIT 1) AS last_message
  FROM complaints k LEFT JOIN tenants t ON t.id = k.tenant_id LEFT JOIN outlets o ON o.id = k.outlet_id
  WHERE ${where} ORDER BY (k.status IN ('open','in_progress')) DESC, k.escalated DESC, k.updated_at DESC LIMIT 300`, params);
// A reply from the shop or the Genuine Draw team, optionally changing the status.
async function replyToComplaint(req, c, who, body, status) {
  body = String(body || '').trim().slice(0, 2000);
  if (status && !COMPLAINT_STATUS.includes(status)) throw fail(400, 'Unknown status');
  if (!body && !status) throw fail(400, 'Please write a reply');
  await tx(async t => {
    if (body) await q('INSERT INTO complaint_messages(complaint_id, author_type, author_name, body) VALUES($1,$2,$3,$4)', [c.id, who.type, who.name, body], t);
    const next = status || (c.status === 'open' ? 'in_progress' : c.status);
    await q(`UPDATE complaints SET status = $2, updated_at = $3::timestamp, resolved_at = CASE WHEN $2 IN ('resolved','rejected') THEN $3::timestamp ELSE NULL END WHERE id = $1`,
      [c.id, next, utcNow()], t);
    await audit({ tenantId: c.tenant_id, actor: who.actor, action: next !== c.status ? 'complaint.status' : 'complaint.replied', entity: 'complaint', entityId: c.ticket_no,
      details: { from: c.status, to: next, by: who.type }, ip: req.ip }, t);
  });
  const st = status && status !== c.status ? ` Status: ${STATUS_LABEL[status]}.` : '';
  await sendTemplate(c.phone, 'gd_complaint_update', [c.ticket_no, c.shop || PLATFORM, body || 'The status of your ticket has changed', STATUS_LABEL[status || (c.status === 'open' ? 'in_progress' : c.status)]]);
}

app.get('/api/my/complaints', a(async (req, res) => {
  await escalateOverdue();
  res.json(await complaintList('k.phone = $1', [req.customer]));
}));
app.get('/api/my/complaints/:ticket', a(async (req, res) => {
  res.json(await complaintDetail('k.ticket_no = $1 AND k.phone = $2', [String(req.params.ticket).toUpperCase(), req.customer]));
}));
app.post('/api/my/complaints', a(async (req, res) => {
  if (throttle('complaint:' + req.customer, 6, 60 * 60000)) throw fail(429, 'You have raised several complaints just now. Please wait a while.');
  const b = req.body || {};
  const category = CATEGORIES[b.category] ? b.category : null;
  if (!category) throw fail(400, 'Please choose what went wrong');
  const description = String(b.description || '').trim().slice(0, 2000);
  if (description.length < 10) throw fail(400, 'Please describe the problem in a few words (at least 10 characters)');
  const photo = String(b.photo || '');
  if (photo && (!/^data:image\/(png|jpe?g|webp);base64,/.test(photo) || photo.length > 3_000_000)) throw fail(400, 'The photo must be a PNG, JPG or WebP under 2 MB');
  const name = String(b.name || '').trim().slice(0, 60);
  const incident = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(b.incident_at || '') ? String(b.incident_at).replace('T', ' ') : null;
  // The coupon (if any) decides the shop, outlet and time; otherwise the customer picks the shop.
  const code = String(b.coupon_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let coupon = null, tenant = null;
  if (code) {
    coupon = await one('SELECT c.*, b.outlet_id AS batch_outlet FROM coupons c JOIN batches b ON b.id = c.batch_id WHERE c.code = $1 OR c.reward_code = $1', [code]);
    if (!coupon) throw fail(400, "We couldn't find that coupon code. Check it, or leave it empty and choose the shop.");
    tenant = await one('SELECT * FROM tenants WHERE id = $1', [coupon.tenant_id]);
  } else {
    tenant = await one("SELECT * FROM tenants WHERE slug = $1 AND status IN ('active','suspended')", [String(b.shop || '').toLowerCase()]);
    if (!tenant) throw fail(400, 'Please enter the coupon code, or choose the shop');
  }
  const out = await tx(async t => {
    let ticket;
    do { ticket = 'GD-' + randomCode(6); } while (await one('SELECT 1 FROM complaints WHERE ticket_no = $1', [ticket], t));
    const row = await one(`INSERT INTO complaints(ticket_no, tenant_id, coupon_id, coupon_code, outlet_id, phone, customer_name, category, description, photo, incident_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ticket, tenant.id, coupon ? coupon.id : null, coupon ? coupon.code : '', coupon ? (coupon.redeemed_outlet_id || coupon.batch_outlet) : null,
      req.customer, name || (coupon && coupon.phone === req.customer ? coupon.customer_name : '') || '', category, description, photo,
      incident || (coupon ? coupon.claimed_at : null)], t);
    await q("INSERT INTO complaint_messages(complaint_id, author_type, author_name, body) VALUES($1, 'customer', $2, $3)", [row.id, name || 'Customer', description], t);
    await audit({ tenantId: tenant.id, actor: { type: 'customer', name: maskPhone(req.customer) }, action: 'complaint.created', entity: 'complaint', entityId: ticket,
      details: { category, coupon: coupon ? coupon.code : null }, ip: req.ip }, t);
    return { ticket };
  });
  await Promise.all([
    sendTemplate(req.customer, 'gd_complaint_received', [out.ticket, tenant.name, `${host(req)}/my`]),
    sendTemplate(tenant.whatsapp || tenant.contact_phone, 'gd_complaint_new', [out.ticket, CATEGORIES[category], adminUrl(req, tenant).replace(/^https?:\/\//, '')]),
  ]);
  res.json(out);
}));
app.post('/api/my/complaints/:ticket/messages', a(async (req, res) => {
  const c = await complaintDetail('k.ticket_no = $1 AND k.phone = $2', [String(req.params.ticket).toUpperCase(), req.customer]);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!body) throw fail(400, 'Please write a message');
  await q("INSERT INTO complaint_messages(complaint_id, author_type, author_name, body) VALUES($1, 'customer', $2, $3)", [c.id, c.customer_name || 'Customer', body]);
  // A customer writing back re-opens a closed ticket.
  await q(`UPDATE complaints SET updated_at = $2, status = CASE WHEN status IN ('resolved','rejected') THEN 'open' ELSE status END, resolved_at = NULL WHERE id = $1`, [c.id, utcNow()]);
  res.json({ ok: true });
}));
app.post('/api/my/complaints/:ticket/escalate', a(async (req, res) => {
  const c = await complaintDetail('k.ticket_no = $1 AND k.phone = $2', [String(req.params.ticket).toUpperCase(), req.customer]);
  if (c.escalated) throw fail(409, `This ticket is already with the ${PLATFORM} team.`);
  const reason = String(req.body.reason || '').trim().slice(0, 500) || 'Customer asked for help from the platform';
  await tx(async t => {
    await q('UPDATE complaints SET escalated = 1, escalated_at = $2, escalation_reason = $3, updated_at = $2, status = CASE WHEN status IN (\'resolved\',\'rejected\') THEN \'open\' ELSE status END WHERE id = $1',
      [c.id, utcNow(), reason], t);
    await q("INSERT INTO complaint_messages(complaint_id, author_type, author_name, body) VALUES($1, 'system', $2, $3)",
      [c.id, PLATFORM, `The customer asked the ${PLATFORM} team to step in: ${reason}`], t);
    await audit({ tenantId: c.tenant_id, actor: { type: 'customer', name: maskPhone(req.customer) }, action: 'complaint.escalated', entity: 'complaint', entityId: c.ticket_no, details: { reason }, ip: req.ip }, t);
  });
  await sendTemplate(superPhone(), 'gd_complaint_escalated', [c.ticket_no, c.shop || PLATFORM, reason]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Phase 3: provably fair Lucky Draw
// 1. Seal: the full entry list is frozen, its SHA-256 fingerprint is recorded in the tamper-evident log, and a
//    drand round about 90 seconds in the future is chosen. Nobody (us included) can know that round's number yet.
// 2. Draw: once the round is published, seed = sha256(fingerprint + ':' + drand randomness), and winners are
//    picked from the list by a fixed rule anyone can re-run (see runPicks and /draw/:id).
const DRAND = { genesis: 1595431050, period: 30, chain: '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce',
  mirrors: ['https://drand.cloudflare.com', 'https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'] };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const drandRoundAt = ms => Math.floor((ms / 1000 - DRAND.genesis) / DRAND.period) + 1;
const drandRoundTime = r => (DRAND.genesis + (Number(r) - 1) * DRAND.period) * 1000;
async function drandRound(round) {
  for (const m of DRAND.mirrors) {
    try {
      const r = await fetch(`${m}/public/${round}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.round === round && /^[0-9a-f]{64}$/.test(j.randomness)) return { ...j, url: `${m}/public/${round}` };
    } catch { /* try the next mirror */ }
  }
  return null;
}
// The published entry list: one line per entry, "CODE,PERSON", sorted by code. PERSON is a private tag for the
// mobile number, so anyone can see which entries belong to the same person without learning the number.
async function entryList(campaignId, client) {
  const rows = await q(`SELECT c.code, c.phone FROM coupons c JOIN batches b ON b.id = c.batch_id
    WHERE b.campaign_id = $1 AND c.draw_entry = 1 AND c.status IN ('claimed','redeemed') ORDER BY c.code`, [campaignId], client);
  const key = await secret();
  return rows.map(r => `${r.code},${crypto.createHmac('sha256', key).update(`${campaignId}:${r.phone}`).digest('hex').slice(0, 12)}`);
}
// Prize slots in drawing order: rank 1 first, each repeated by its quantity.
const prizeSlots = prizes => prizes.flatMap(p => Array.from({ length: p.quantity }, () => p));
// Pick k takes sha256(seed + ':' + k) as a number, modulo the entries left in the pool, and removes that entry.
// One prize per person: an entry whose person was already picked is set aside and the next pick is made.
function runPicks(lines, seed, need) {
  const pool = lines.map(l => { const [code, tag] = l.split(','); return { code, tag }; });
  const seen = new Set(), picks = [];
  for (let k = 0; picks.filter(p => !p.skipped).length < need && pool.length; k++) {
    const idx = Number(BigInt('0x' + sha256(`${seed}:${k}`)) % BigInt(pool.length));
    const [e] = pool.splice(idx, 1);
    if (seen.has(e.tag)) picks.push({ k, code: e.code, skipped: true });
    else { seen.add(e.tag); picks.push({ k, code: e.code }); }
  }
  return picks;
}
async function newRewardCode(t) {
  let r;
  do { r = 'GD' + randomCode(6); } while (await one('SELECT 1 FROM coupons WHERE reward_code = $1', [r], t));
  return r;
}
const daysAhead = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const tellWinner = (c, prize, shop) => sendTemplate(c.phone, 'gd_draw_winner',
  [String(c.customer_name || '').split(' ')[0] || 'there', c.code.slice(0, 4) + '-' + c.code.slice(4), prize, shop]);

// Finish a sealed draw once its drand round is out. Safe to call from any request: the row lock makes it run once.
async function finalizeDraw(drawId) {
  const d0 = await one('SELECT id, status, beacon_round FROM draws WHERE id = $1', [drawId]);
  if (!d0 || d0.status !== 'sealed' || Date.now() < drandRoundTime(d0.beacon_round) + 1500) return;
  const beacon = await drandRound(Number(d0.beacon_round));
  if (!beacon) return;
  const done = await tx(async t => {
    const d = await one('SELECT * FROM draws WHERE id = $1 FOR UPDATE', [drawId], t);
    if (d.status !== 'sealed') return null;
    const camp = await one('SELECT * FROM campaigns WHERE id = $1', [d.campaign_id], t);
    const slots = prizeSlots(await q('SELECT * FROM campaign_prizes WHERE campaign_id = $1 ORDER BY rank, id', [d.campaign_id], t));
    const seed = sha256(`${d.entries_hash}:${beacon.randomness}`);
    const picks = runPicks(d.entries_list.split('\n'), seed, slots.length + camp.backups);
    const chosen = picks.filter(p => !p.skipped);
    const expires = daysAhead(camp.claim_days), winners = [];
    for (let i = 0; i < chosen.length; i++) {
      const c = await one('SELECT * FROM coupons WHERE code = $1', [chosen[i].code], t);
      const prize = slots[i];
      if (prize) {
        await q(`UPDATE coupons SET gift_kind = 'prize', gift_name = $2, reward_code = $3, reward_expires = $4 WHERE id = $1`,
          [c.id, prize.name, await newRewardCode(t), expires], t);
        winners.push({ c, prize: prize.name });
      }
      await q(`INSERT INTO draw_winners(draw_id, campaign_id, tenant_id, pick_no, backup, prize_id, prize_rank, prize_name, coupon_id, coupon_code, status, status_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [d.id, d.campaign_id, d.tenant_id, i + 1, prize ? 0 : 1, prize ? prize.id : null, prize ? prize.rank : null, prize ? prize.name : null,
        c.id, c.code, prize ? 'won' : 'standby', utcNow()], t);
    }
    await q(`UPDATE draws SET status = 'drawn', beacon_randomness = $2, beacon_signature = $3, beacon_url = $4, seed = $5, picks = $6, drawn_at = $7 WHERE id = $1`,
      [d.id, beacon.randomness, beacon.signature, beacon.url, seed, JSON.stringify(picks), utcNow()], t);
    await q("UPDATE campaigns SET status = 'drawn' WHERE id = $1", [d.campaign_id], t);
    await audit({ tenantId: d.tenant_id, actor: { type: 'system', name: PLATFORM }, action: 'draw.completed', entity: 'campaign', entityId: d.campaign_id,
      details: { campaign: camp.name, entries: d.entries_count, entries_hash: d.entries_hash, drand_round: Number(d.beacon_round), randomness: beacon.randomness, seed,
        winners: winners.map(w => `${w.prize}: ${w.c.code}`), backups: chosen.slice(slots.length).map(p => p.code) } }, t);
    return { winners, shop: (await one('SELECT name FROM tenants WHERE id = $1', [d.tenant_id], t)).name };
  });
  if (done) for (const w of done.winners) await tellWinner(w.c, w.prize, done.shop);
}

// Everything the public page needs. Names and numbers are masked; the merchant's own view gets them in full.
async function drawDetail(d, full = false) {
  const [camp, tenant, prizes, rows] = await Promise.all([
    one('SELECT * FROM campaigns WHERE id = $1', [d.campaign_id]),
    one('SELECT name, slug, logo, color FROM tenants WHERE id = $1', [d.tenant_id]),
    q('SELECT rank, name, description, quantity FROM campaign_prizes WHERE campaign_id = $1 ORDER BY rank, id', [d.campaign_id]),
    q(`SELECT w.*, c.customer_name, c.phone, c.area, c.status AS coupon_status, c.reward_code, c.reward_expires, c.redeemed_at
       FROM draw_winners w LEFT JOIN coupons c ON c.id = w.coupon_id WHERE w.draw_id = $1 ORDER BY w.pick_no, w.id`, [d.id]),
  ]);
  const round = Number(d.beacon_round);
  return {
    id: d.id, status: d.status, campaign: { id: camp.id, name: camp.name, description: camp.description, terms: camp.terms, ends_on: camp.ends_on, draw_on: camp.draw_on, claim_days: camp.claim_days, backups: camp.backups },
    shop: tenant, prizes,
    entries_count: d.entries_count, entries_hash: d.entries_hash, sealed_at: d.sealed_at, drawn_at: d.drawn_at,
    beacon: { source: 'drand (League of Entropy)', chain: DRAND.chain, round, round_time: new Date(drandRoundTime(round)).toISOString(),
      randomness: d.beacon_randomness, signature: d.beacon_signature, url: d.beacon_url || `${DRAND.mirrors[0]}/public/${round}` },
    seed: d.seed, picks: d.picks || [],
    winners: rows.map(w => ({
      id: w.id, pick_no: w.pick_no, backup: !!w.backup, prize_rank: w.prize_rank, prize_name: w.prize_name, code: w.coupon_code, status: w.status, replaces_id: w.replaces_id,
      name: full ? w.customer_name : maskName(w.customer_name || ''), phone: full ? w.phone : maskPhone(w.phone || ''), area: w.area || '',
      ...(full ? { reward_code: w.reward_code, reward_expires: w.reward_expires, coupon_status: w.coupon_status, redeemed_at: w.redeemed_at, status_at: w.status_at } : { collected: w.coupon_status === 'redeemed' }),
    })),
  };
}

// Public: the live draw page, its proof, and the frozen entry list.
app.get('/api/draws/:id', a(async (req, res) => {
  const id = int(req.params.id);
  await finalizeDraw(id);
  const d = await one('SELECT * FROM draws WHERE id = $1', [id]);
  if (!d) throw fail(404, 'Draw not found');
  res.json({ ...(await drawDetail(d)), now: new Date().toISOString() });
}));
app.get('/api/draws/:id/entries.txt', a(async (req, res) => {
  const d = await one('SELECT entries_list, campaign_id FROM draws WHERE id = $1', [int(req.params.id)]);
  if (!d) throw fail(404, 'Draw not found');
  res.set('Content-Type', 'text/plain; charset=utf-8').set('Content-Disposition', `inline; filename="draw-${req.params.id}-entries.txt"`).send(d.entries_list);
}));
app.get('/api/winners', a(async (req, res) => {
  res.json(await q(`SELECT d.id, d.drawn_at, d.entries_count, cp.name AS campaign, t.name AS shop, t.logo, t.color,
      (SELECT string_agg(w.prize_name, ', ' ORDER BY w.pick_no) FROM draw_winners w WHERE w.draw_id = d.id AND w.status = 'won') AS prizes,
      (SELECT COUNT(*) FROM draw_winners w WHERE w.draw_id = d.id AND w.status = 'won') AS winners
    FROM draws d JOIN campaigns cp ON cp.id = d.campaign_id JOIN tenants t ON t.id = d.tenant_id
    WHERE d.status = 'drawn' AND t.status = 'active' ORDER BY d.drawn_at DESC LIMIT 60`));
}));

// ---------------------------------------------------------------- merchant admin API
// A session is the merchant owner, one of its staff (manager / counter), or the Super Admin looking in.
async function currentSession(req) {
  const site = siteOf(req);
  if (site.kind === 'platform' || site.kind === 'unknown') return null;   // merchant pages live on merchant subdomains
  const p = await readToken(cookies(req).nv_admin);
  if (!p || !p.t) return null;
  const t = await one('SELECT * FROM tenants WHERE id = $1', [p.t]);
  if (!t || t.session_version !== p.v) return null;
  if (site.kind === 'merchant' && site.slug !== t.slug) return null;
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

// Branding for the login page of a merchant subdomain.
app.get('/api/shop', a(async (req, res) => {
  const site = siteOf(req);
  if (site.kind === 'platform') return res.json({ platform: true });
  if (site.kind !== 'merchant') return res.json({ exists: site.kind === 'legacy' });
  const t = await one('SELECT * FROM tenants WHERE slug = $1', [site.slug]);
  res.json(t ? { exists: true, active: isActive(t), name: t.name, logo: t.logo, color: t.color, slug: t.slug } : { exists: false });
}));
// "Find my shop": a merchant (or staff) username → that shop's admin address.
app.get('/api/find-shop', a(async (req, res) => {
  if (throttle('find:' + req.ip, 30)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
  const u = String(req.query.username || '').trim().toLowerCase();
  const t = await one(`SELECT t.* FROM tenants t WHERE t.slug = $1
    UNION SELECT t.* FROM tenants t JOIN staff s ON s.tenant_id = t.id WHERE s.username = $1 LIMIT 1`, [u]);
  if (!t) throw fail(404, 'No shop found for that username');
  res.json({ url: adminUrl(req, t), name: t.name });
}));

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
  const site = siteOf(req);
  if (site.kind === 'platform') throw fail(400, 'Please sign in at your shop address, e.g. yourshop.' + BASE);
  if (site.kind === 'merchant' && t && t.slug !== site.slug) t = null;   // only this shop's owner and staff
  if (!t || !await verifyPassword(password, (st || t).password_hash)) throw fail(401, 'Wrong username or password');
  if (st && !st.active) throw fail(403, 'This login has been switched off. Please ask your shop owner.');
  if (t.status === 'pending') throw fail(403, `Your registration is waiting for approval by the ${PLATFORM} team. We'll message you on WhatsApp once it's approved.`);
  if (t.status === 'rejected') throw fail(403, `Your registration was not approved${t.reject_reason ? ': ' + t.reject_reason : '.'} Please contact ${PLATFORM}.`);
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
    , cp.name AS campaign_name, cp.type AS campaign_type
    FROM batches b LEFT JOIN coupons c ON c.batch_id = b.id LEFT JOIN outlets o ON o.id = b.outlet_id LEFT JOIN campaigns cp ON cp.id = b.campaign_id
    WHERE b.tenant_id = $1 AND ($2::int IS NULL OR b.campaign_id = $2) GROUP BY b.id, o.name, cp.name, cp.type ORDER BY b.id DESC`,
  [T(req), req.query.campaign_id ? int(req.query.campaign_id) : null]));
}));
app.post('/api/admin/batches', a(async (req, res) => {
  const count = int(req.body.count);
  if (!(count >= 1 && count <= 1000)) throw fail(400, 'Number of coupons must be between 1 and 1000');
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'Batch name is required');
  const outlet = await outletOf(req, req.body.outlet_id);
  const campaign = req.body.campaign_id ? await campaignOf(req, req.body.campaign_id) : null;
  if (campaign && campaign.status === 'drawn') throw fail(409, 'The draw for this campaign has already taken place.');
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
    // Without a chosen campaign, the batch gets its own Instant Win campaign (how batches worked before campaigns).
    fields.campaignId = campaign ? campaign.id : (await one(`INSERT INTO campaigns(tenant_id, name, type, starts_on, ends_on)
      VALUES($1, $2, 'instant', $3, $4) RETURNING id`, [T(req), name, today(), fields.expires_on], t)).id;
    const id = await createBatch(fields, t);
    if (outlet) await q('UPDATE batches SET outlet_id = $2 WHERE id = $1', [id, outlet.id], t);
    await log(req, 'batch.created', 'batch', id, { name, count, campaign: campaign ? campaign.name : name, outlet: outlet ? outlet.name : null, expires_on: fields.expires_on }, t);
    return id;
  });
  res.json({ id });
}));
app.get('/api/admin/batches/:id', a(async (req, res) => {
  const batch = await one(`SELECT b.*, o.name AS outlet_name, cp.name AS campaign_name, cp.type AS campaign_type, cp.draw_on
    FROM batches b LEFT JOIN outlets o ON o.id = b.outlet_id LEFT JOIN campaigns cp ON cp.id = b.campaign_id
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
      c.reward_code, c.reward_expires, c.status, c.claimed_at, c.redeemed_at, COALESCE(cp.name, b.name) AS campaign, b.name AS batch, o.name AS outlet, ro.name AS redeemed_outlet
    FROM coupons c JOIN batches b ON b.id = c.batch_id LEFT JOIN campaigns cp ON cp.id = b.campaign_id
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

app.delete('/api/admin/outlets/:id', a(async (req, res) => {
  const id = int(req.params.id);
  await tx(async t => {
    const o = await one('SELECT * FROM outlets WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, T(req)], t);
    if (!o) throw fail(404, 'Outlet not found');
    const { n } = await one('SELECT COUNT(*) AS n FROM outlets WHERE tenant_id = $1', [T(req)], t);
    if (n <= 1) throw fail(409, 'You need at least one outlet. Edit this one instead.');
    const staff = await q("SELECT name FROM staff WHERE outlet_id = $1 AND role = 'counter'", [id], t);
    if (staff.length) throw fail(409, `Move these counter logins to another outlet first (Team page): ${staff.map(x => x.name).join(', ')}`);
    // Past coupons and redemptions stay; they just no longer point at this outlet.
    await q('DELETE FROM outlets WHERE id = $1', [id], t);
    await log(req, 'outlet.deleted', 'outlet', id, { name: o.name, address: o.address }, t);
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

// Campaigns: Instant Win (scratch and win now) or Lucky Draw (entries now, winners drawn later)
const dateOr = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
function campaignFields(b) {
  const f = {
    name: String(b.name || '').trim().slice(0, 80),
    type: b.type === 'draw' ? 'draw' : 'instant',
    description: String(b.description || '').trim().slice(0, 500),
    terms: String(b.terms || '').trim().slice(0, 2000),
    starts_on: dateOr(b.starts_on), ends_on: dateOr(b.ends_on), draw_on: dateOr(b.draw_on),
    status: b.status === 'paused' ? 'paused' : 'active',
    claim_days: Math.max(1, Math.min(365, int(b.claim_days) || 30)),
    backups: Math.max(0, Math.min(20, b.backups === '' || b.backups == null ? 3 : int(b.backups))),
  };
  if (!f.name) throw fail(400, 'Campaign name is required');
  if (f.starts_on && f.ends_on && f.ends_on < f.starts_on) throw fail(400, 'The end date must be on or after the start date');
  if (f.type === 'draw') {
    if (!f.ends_on) throw fail(400, 'A Lucky Draw needs an end date (the last day to enter)');
    if (!f.draw_on) throw fail(400, 'A Lucky Draw needs a draw date');
    if (f.draw_on < f.ends_on) throw fail(400, 'The draw date must be on or after the end date');
  } else f.draw_on = null;
  return f;
}
const prizeFields = list => (Array.isArray(list) ? list : []).slice(0, 50).map((p, i) => ({
  rank: Math.max(1, Math.min(99, int(p.rank) || i + 1)),
  name: String(p.name || '').trim().slice(0, 80),
  description: String(p.description || '').trim().slice(0, 240),
  image: String(p.image || '').slice(0, 1_500_000),
  quantity: Math.max(1, Math.min(10000, int(p.quantity) || 1)),
})).filter(p => p.name);
async function campaignOf(req, id, client) {
  const c = await one('SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2', [int(id), T(req)], client);
  if (!c) throw fail(404, 'Campaign not found');
  return c;
}
const CAMPAIGN_STATS = `SELECT cp.*,
    COUNT(DISTINCT b.id) AS batches, COUNT(c.id) FILTER (WHERE c.status <> 'void') AS printed,
    COUNT(c.id) FILTER (WHERE c.scans > 0) AS scanned,
    COUNT(c.id) FILTER (WHERE c.status IN ('claimed','redeemed')) AS claimed,
    COUNT(c.id) FILTER (WHERE c.draw_entry = 1) AS entries,
    COUNT(c.id) FILTER (WHERE c.status IN ('claimed','redeemed') AND c.gift_kind = 'prize') AS winners,
    COUNT(c.id) FILTER (WHERE c.status = 'redeemed') AS redeemed,
    COUNT(DISTINCT c.phone) AS customers
  FROM campaigns cp LEFT JOIN batches b ON b.campaign_id = cp.id LEFT JOIN coupons c ON c.batch_id = b.id`;
const withDraws = async rows => {
  const ds = rows.length ? await q('SELECT id, campaign_id, status FROM draws WHERE campaign_id = ANY($1)', [rows.map(r => r.id)]) : [];
  for (const r of rows) { const d = ds.find(x => x.campaign_id === r.id); r.draw_id = d ? d.id : null; r.draw_status = d ? d.status : null; }
  return rows;
};
app.get('/api/admin/campaigns', a(async (req, res) => {
  const rows = await q(`${CAMPAIGN_STATS} WHERE cp.tenant_id = $1 GROUP BY cp.id ORDER BY cp.status = 'active' DESC, cp.id DESC`, [T(req)]);
  const prizes = await q(`SELECT p.* FROM campaign_prizes p JOIN campaigns cp ON cp.id = p.campaign_id WHERE cp.tenant_id = $1 ORDER BY p.rank, p.id`, [T(req)]);
  for (const r of rows) r.prizes = prizes.filter(p => p.campaign_id === r.id);
  res.json(await withDraws(rows));
}));
app.get('/api/admin/campaigns/:id', a(async (req, res) => {
  const c = await one(`${CAMPAIGN_STATS} WHERE cp.id = $1 AND cp.tenant_id = $2 GROUP BY cp.id`, [int(req.params.id), T(req)]);
  if (!c) throw fail(404, 'Campaign not found');
  c.prizes = await q('SELECT * FROM campaign_prizes WHERE campaign_id = $1 ORDER BY rank, id', [c.id]);
  c.batches = await q(`SELECT b.id, b.name, b.count, b.created_at, o.name AS outlet_name FROM batches b LEFT JOIN outlets o ON o.id = b.outlet_id
    WHERE b.campaign_id = $1 ORDER BY b.id DESC`, [c.id]);
  res.json(c);
}));
async function savePrizes(campaignId, prizes, client) {
  await q('DELETE FROM campaign_prizes WHERE campaign_id = $1', [campaignId], client);
  for (const p of prizes) {
    await q('INSERT INTO campaign_prizes(campaign_id, rank, name, description, image, quantity) VALUES($1,$2,$3,$4,$5,$6)',
      [campaignId, p.rank, p.name, p.description, p.image, p.quantity], client);
  }
}
app.post('/api/admin/campaigns', a(async (req, res) => {
  const f = campaignFields(req.body);
  const prizes = prizeFields(req.body.prizes);
  if (f.type === 'draw' && !prizes.length) throw fail(400, 'Add at least one prize for the Lucky Draw');
  const id = await tx(async t => {
    const { id } = await one(`INSERT INTO campaigns(tenant_id, name, type, description, terms, starts_on, ends_on, draw_on, status, claim_days, backups)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [T(req), f.name, f.type, f.description, f.terms, f.starts_on, f.ends_on, f.draw_on, f.status, f.claim_days, f.backups], t);
    await savePrizes(id, prizes, t);
    await log(req, 'campaign.created', 'campaign', id, { ...f, prizes: prizes.map(p => `${p.rank}. ${p.name} ×${p.quantity}`) }, t);
    return id;
  });
  res.json({ id });
}));
app.put('/api/admin/campaigns/:id', a(async (req, res) => {
  const before = await campaignOf(req, req.params.id);
  if (before.status === 'drawn') throw fail(409, 'The draw has taken place, so this campaign can no longer be changed.');
  if (await one('SELECT 1 FROM draws WHERE campaign_id = $1', [before.id])) throw fail(409, 'The draw has started, so this campaign can no longer be changed.');
  const f = campaignFields({ ...before, ...req.body });
  const { played } = await one(`SELECT COUNT(*) AS played FROM coupons c JOIN batches b ON b.id = c.batch_id
    WHERE b.campaign_id = $1 AND c.status IN ('claimed','redeemed')`, [before.id]);
  // Once customers have played, the rules they played under are fixed (prizes can still be added to).
  if (played && f.type !== before.type) throw fail(409, 'Customers have already played this campaign, so its type cannot change.');
  if (played && before.type === 'draw' && f.draw_on !== before.draw_on && f.draw_on < (before.draw_on || '')) throw fail(409, 'The draw date can only be moved later once customers have entered.');
  const prizes = 'prizes' in req.body ? prizeFields(req.body.prizes) : null;
  if (f.type === 'draw' && prizes && !prizes.length) throw fail(400, 'Add at least one prize for the Lucky Draw');
  await tx(async t => {
    await q(`UPDATE campaigns SET name=$3, type=$4, description=$5, terms=$6, starts_on=$7, ends_on=$8, draw_on=$9, status=$10, claim_days=$11, backups=$12 WHERE id=$1 AND tenant_id=$2`,
      [before.id, T(req), f.name, f.type, f.description, f.terms, f.starts_on, f.ends_on, f.draw_on, f.status, f.claim_days, f.backups], t);
    if (prizes) await savePrizes(before.id, prizes, t);
    const changed = Object.fromEntries(Object.keys(f).filter(k => String(f[k] ?? '') !== String(before[k] ?? '')).map(k => [k, f[k]]));
    if (prizes) changed.prizes = prizes.map(p => `${p.rank}. ${p.name} ×${p.quantity}`);
    const action = f.status !== before.status ? (f.status === 'paused' ? 'campaign.paused' : 'campaign.resumed') : 'campaign.updated';
    await log(req, action, 'campaign', before.id, { name: f.name, ...changed }, t);
  });
  res.json({ ok: true });
}));
app.delete('/api/admin/campaigns/:id', a(async (req, res) => {
  const c = await campaignOf(req, req.params.id);
  const { n } = await one(`SELECT COUNT(*) AS n FROM coupons x JOIN batches b ON b.id = x.batch_id WHERE b.campaign_id = $1 AND x.status IN ('claimed','redeemed')`, [c.id]);
  if (n) throw fail(409, 'Customers have played this campaign, so it is kept for the record. Pause it instead.');
  await tx(async t => {
    await q('DELETE FROM campaigns WHERE id = $1', [c.id], t);   // its unused batches and coupons go with it
    await log(req, 'campaign.deleted', 'campaign', c.id, { name: c.name, type: c.type }, t);
  });
  res.json({ ok: true });
}));

// Lucky Draw: seal and run (owner, or the Super Admin looking in), see the winners, hand a forfeited prize to a backup.
const ownerOnly = req => { if (!['owner', 'super'].includes(req.actor.type)) throw fail(403, 'Only the shop owner can run the draw.'); };
app.post('/api/admin/campaigns/:id/draw', a(async (req, res) => {
  ownerOnly(req);
  const camp = await campaignOf(req, req.params.id);
  if (camp.type !== 'draw') throw fail(400, 'This is not a Lucky Draw campaign.');
  const existing = await one('SELECT id, status FROM draws WHERE campaign_id = $1', [camp.id]);
  if (existing) return res.json(existing);
  const d = today();
  if (!(d >= camp.draw_on || (camp.ends_on && camp.ends_on < d))) throw fail(409, `Entries are open until ${camp.ends_on}. You can run the draw from ${camp.draw_on}.`);
  const prizes = await q('SELECT 1 FROM campaign_prizes WHERE campaign_id = $1', [camp.id]);
  if (!prizes.length) throw fail(400, 'Add at least one prize before running the draw.');
  let id;
  try {
    id = await tx(async t => {
      await q('SELECT id FROM campaigns WHERE id = $1 FOR UPDATE', [camp.id], t);   // no new entries while the list is frozen
      const lines = await entryList(camp.id, t);
      if (!lines.length) throw fail(409, 'There are no entries in this draw yet.');
      const text = lines.join('\n'), hash = sha256(text), round = drandRoundAt(Date.now()) + 3;
      const row = await one(`INSERT INTO draws(campaign_id, tenant_id, status, entries_count, entries_hash, entries_list, beacon_round, run_by, sealed_at)
        VALUES($1,$2,'sealed',$3,$4,$5,$6,$7,$8) RETURNING id`, [camp.id, T(req), lines.length, hash, text, round, `${req.actor.name} (${req.actor.type})`, utcNow()], t);
      await log(req, 'draw.sealed', 'campaign', camp.id, { campaign: camp.name, entries: lines.length, entries_hash: hash,
        drand_round: round, drand_time: new Date(drandRoundTime(round)).toISOString() }, t);
      return row.id;
    });
  } catch (e) {
    if (e.code === '23505') return res.json(await one('SELECT id, status FROM draws WHERE campaign_id = $1', [camp.id]));
    throw e;
  }
  res.json({ id, status: 'sealed' });
}));
app.get('/api/admin/campaigns/:id/draw', a(async (req, res) => {
  const camp = await campaignOf(req, req.params.id);
  const d0 = await one('SELECT id FROM draws WHERE campaign_id = $1', [camp.id]);
  if (!d0) return res.json({ status: 'none' });
  await finalizeDraw(d0.id);
  res.json({ ...(await drawDetail(await one('SELECT * FROM draws WHERE id = $1', [d0.id]), true)), public_url: `${platformBase(req)}/draw/${d0.id}` });
}));
// A winner who doesn't collect in time (or is disqualified) loses the prize; the next backup gets it.
app.post('/api/admin/draw-winners/:id/forfeit', a(async (req, res) => {
  ownerOnly(req);
  const reason = String(req.body.reason || '').trim().slice(0, 200) || 'Not collected in time';
  const out = await tx(async t => {
    const w = await one("SELECT * FROM draw_winners WHERE id = $1 AND tenant_id = $2 AND status = 'won' FOR UPDATE", [int(req.params.id), T(req)], t);
    if (!w) throw fail(404, 'Winner not found');
    const c = await one('SELECT * FROM coupons WHERE id = $1 FOR UPDATE', [w.coupon_id], t);
    if (c && c.status === 'redeemed') throw fail(409, 'This prize has already been handed over.');
    await q("UPDATE draw_winners SET status = 'forfeited', status_at = $2 WHERE id = $1", [w.id, utcNow()], t);
    if (c) await q("UPDATE coupons SET status = 'void' WHERE id = $1", [c.id], t);
    await log(req, 'draw.prize_forfeited', 'coupon', w.coupon_code, { prize: w.prize_name, reason }, t);
    const b = await one("SELECT * FROM draw_winners WHERE draw_id = $1 AND status = 'standby' ORDER BY pick_no LIMIT 1 FOR UPDATE", [w.draw_id], t);
    if (!b) return { promoted: null };
    const camp = await one('SELECT claim_days FROM campaigns WHERE id = $1', [w.campaign_id], t);
    const bc = await one('SELECT * FROM coupons WHERE id = $1 FOR UPDATE', [b.coupon_id], t);
    await q(`UPDATE coupons SET gift_kind = 'prize', gift_name = $2, reward_code = $3, reward_expires = $4 WHERE id = $1`,
      [bc.id, w.prize_name, await newRewardCode(t), daysAhead(camp.claim_days)], t);
    await q(`UPDATE draw_winners SET status = 'won', prize_id = $2, prize_rank = $3, prize_name = $4, replaces_id = $5, status_at = $6 WHERE id = $1`,
      [b.id, w.prize_id, w.prize_rank, w.prize_name, w.id, utcNow()], t);
    await log(req, 'draw.backup_promoted', 'coupon', b.coupon_code, { prize: w.prize_name, replaces: w.coupon_code, backup_no: b.pick_no }, t);
    return { promoted: bc.code, coupon: bc, prize: w.prize_name };
  });
  if (out.coupon) await tellWinner(out.coupon, out.prize, req.tenant.name);
  res.json({ ok: true, promoted: out.promoted });
}));

// Reports: per campaign and per outlet for a date range, plus a CSV of every play in it.
function reportRange(query) {
  const from = dateOr(query.from) || '2000-01-01';
  const to = dateOr(query.to) || '2999-12-31';
  return { from, to, toEx: new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10) };
}
app.get('/api/admin/reports', a(async (req, res) => {
  const { from, to, toEx } = reportRange(req.query);
  const camp = req.query.campaign_id ? int(req.query.campaign_id) : null;
  const P = [T(req), from, toEx, camp];
  const inRange = col => `${col} >= $2 AND ${col} < $3`;
  const base = `FROM coupons c JOIN batches b ON b.id = c.batch_id WHERE c.tenant_id = $1 AND ($4::int IS NULL OR b.campaign_id = $4)`;
  const [totals, campaigns, outlets, days, gifts] = await Promise.all([
    one(`SELECT COUNT(*) FILTER (WHERE ${inRange('b.created_at')} AND c.status <> 'void') AS printed,
        COUNT(*) FILTER (WHERE ${inRange('c.first_scan_at')}) AS scanned,
        COUNT(*) FILTER (WHERE ${inRange('c.claimed_at')}) AS claimed,
        COUNT(*) FILTER (WHERE ${inRange('c.claimed_at')} AND c.gift_kind = 'prize') AS winners,
        COUNT(*) FILTER (WHERE ${inRange('c.claimed_at')} AND c.draw_entry = 1) AS entries,
        COUNT(*) FILTER (WHERE c.status = 'redeemed' AND ${inRange('c.redeemed_at')}) AS redeemed,
        COUNT(DISTINCT c.phone) FILTER (WHERE ${inRange('c.claimed_at')}) AS customers,
        COUNT(DISTINCT c.phone) FILTER (WHERE ${inRange('c.claimed_at')} AND c.consent = 1) AS optins ${base}`, P),
    q(`SELECT cp.id, cp.name, cp.type, cp.status, cp.starts_on, cp.ends_on, cp.draw_on,
        COUNT(c.id) FILTER (WHERE ${inRange('b.created_at')} AND c.status <> 'void') AS printed,
        COUNT(c.id) FILTER (WHERE ${inRange('c.first_scan_at')}) AS scanned,
        COUNT(c.id) FILTER (WHERE ${inRange('c.claimed_at')}) AS claimed,
        COUNT(c.id) FILTER (WHERE ${inRange('c.claimed_at')} AND c.gift_kind = 'prize') AS winners,
        COUNT(c.id) FILTER (WHERE ${inRange('c.claimed_at')} AND c.draw_entry = 1) AS entries,
        COUNT(c.id) FILTER (WHERE c.status = 'redeemed' AND ${inRange('c.redeemed_at')}) AS redeemed,
        COUNT(DISTINCT c.phone) FILTER (WHERE ${inRange('c.claimed_at')}) AS customers
      FROM campaigns cp LEFT JOIN batches b ON b.campaign_id = cp.id LEFT JOIN coupons c ON c.batch_id = b.id
      WHERE cp.tenant_id = $1 AND ($4::int IS NULL OR cp.id = $4) GROUP BY cp.id ORDER BY cp.id DESC`, P),
    q(`SELECT o.id, o.name,
        COALESCE(i.issued, 0) AS issued, COALESCE(i.claimed, 0) AS claimed, COALESCE(i.winners, 0) AS winners, COALESCE(r.redeemed, 0) AS redeemed
      FROM outlets o
      LEFT JOIN (SELECT b.outlet_id, COUNT(*) FILTER (WHERE ${inRange('b.created_at')} AND c.status <> 'void') AS issued,
                   COUNT(*) FILTER (WHERE ${inRange('c.claimed_at')}) AS claimed,
                   COUNT(*) FILTER (WHERE ${inRange('c.claimed_at')} AND c.gift_kind = 'prize') AS winners
                 ${base} GROUP BY b.outlet_id) i ON i.outlet_id = o.id
      LEFT JOIN (SELECT c.redeemed_outlet_id, COUNT(*) AS redeemed ${base} AND c.status = 'redeemed' AND ${inRange('c.redeemed_at')}
                 GROUP BY c.redeemed_outlet_id) r ON r.redeemed_outlet_id = o.id
      WHERE o.tenant_id = $1 ORDER BY o.id`, P),
    q(`SELECT to_char(c.claimed_at, 'YYYY-MM-DD') AS d, COUNT(*) AS claimed,
        COUNT(*) FILTER (WHERE c.status = 'redeemed') AS redeemed ${base} AND ${inRange('c.claimed_at')} GROUP BY 1 ORDER BY 1`, P),
    q(`SELECT c.gift_name AS name, c.gift_kind AS kind, COUNT(*) AS n, COUNT(*) FILTER (WHERE c.status = 'redeemed') AS redeemed
      ${base} AND ${inRange('c.claimed_at')} GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`, P),
  ]);
  // Coupons printed for "All outlets" (and redemptions not tied to an outlet) get their own row, so the table adds up.
  const none = await one(`SELECT COUNT(*) FILTER (WHERE b.outlet_id IS NULL AND ${inRange('b.created_at')} AND c.status <> 'void') AS issued,
      COUNT(*) FILTER (WHERE b.outlet_id IS NULL AND ${inRange('c.claimed_at')}) AS claimed,
      COUNT(*) FILTER (WHERE b.outlet_id IS NULL AND ${inRange('c.claimed_at')} AND c.gift_kind = 'prize') AS winners,
      COUNT(*) FILTER (WHERE c.status = 'redeemed' AND c.redeemed_outlet_id IS NULL AND ${inRange('c.redeemed_at')}) AS redeemed ${base}`, P);
  if (none.issued || none.claimed || none.redeemed) outlets.push({ id: null, name: 'All outlets (not assigned)', ...none });
  res.json({ from, to, totals, campaigns, outlets, days, gifts });
}));
app.get('/api/admin/reports.csv', a(async (req, res) => {
  const { from, to, toEx } = reportRange(req.query);
  const camp = req.query.campaign_id ? int(req.query.campaign_id) : null;
  const rows = await q(`SELECT c.claimed_at, c.code, cp.name AS campaign, cp.type, o.name AS outlet, c.customer_name, c.phone, c.area,
      c.gift_name, c.gift_kind, c.reward_code, c.status, c.redeemed_at, ro.name AS redeemed_at_outlet, c.consent
    FROM coupons c JOIN batches b ON b.id = c.batch_id LEFT JOIN campaigns cp ON cp.id = b.campaign_id
    LEFT JOIN outlets o ON o.id = b.outlet_id LEFT JOIN outlets ro ON ro.id = c.redeemed_outlet_id
    WHERE c.tenant_id = $1 AND c.claimed_at >= $2 AND c.claimed_at < $3 AND ($4::int IS NULL OR b.campaign_id = $4)
    ORDER BY c.claimed_at`, [T(req), from, toEx, camp]);
  const cols = ['claimed_at', 'code', 'campaign', 'type', 'outlet', 'customer_name', 'phone', 'area', 'gift_name', 'gift_kind', 'reward_code', 'status', 'redeemed_at', 'redeemed_at_outlet', 'consent'];
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  await log(req, 'report.exported', 'report', '', { from, to, campaign_id: camp, rows: rows.length });
  res.set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="report-${req.tenant.slug}-${from}-to-${to}.csv"`)
    .send('﻿' + [cols.join(','), ...rows.map(r => cols.map(k => esc(r[k])).join(','))].join('\n'));
}));

// Complaints raised by customers about this merchant
app.get('/api/admin/complaints', a(async (req, res) => {
  await escalateOverdue();
  const st = COMPLAINT_STATUS.includes(req.query.status) ? req.query.status : null;
  res.json(await complaintList('k.tenant_id = $1 AND ($2::text IS NULL OR k.status = $2)', [T(req), st]));
}));
app.get('/api/admin/complaints/:id', a(async (req, res) => {
  res.json(await complaintDetail('k.id = $1 AND k.tenant_id = $2', [int(req.params.id), T(req)]));
}));
app.post('/api/admin/complaints/:id/reply', a(async (req, res) => {
  const c = await complaintDetail('k.id = $1 AND k.tenant_id = $2', [int(req.params.id), T(req)]);
  await replyToComplaint(req, c, { type: 'merchant', name: req.tenant.name, actor: req.actor }, req.body.body, req.body.status);
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

app.use('/api/super', (req, res, next) => {
  const k = siteOf(req).kind;
  if (k === 'merchant' || k === 'unknown') return res.status(404).json({ error: 'Not found' });
  next();
});
async function isSuper(req) {
  const p = await readToken(cookies(req).nv_super);
  return !!(p && p.s && String(p.v) === await getSetting('super_session_version', '1'));
}
app.post('/api/super/login', a(async (req, res) => {
  if (throttle('super:' + req.ip, 10)) throw fail(429, 'Too many attempts. Please wait a few minutes.');
  if (!await verifyPassword(String(req.body.password || ''), await getSetting('super_password_hash'))) throw fail(401, 'Wrong password');
  const v = await getSetting('super_session_version', '1');
  await slog(req, null, 'super.login', 'platform', '');
  res.set('Set-Cookie', cookie(req, 'nv_super', await makeToken({ s: 1, v, exp: Date.now() + 12 * 3600000 }), 12 * 3600, true));
  res.json({ ok: true });
}));
app.post('/api/super/logout', (req, res) => {
  res.set('Set-Cookie', [cookie(req, 'nv_super', '', 0, true), 'nv_super=; Path=/; Max-Age=0', 'nv_admin=; Path=/; Max-Age=0']).json({ ok: true });
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
    WHERE t.status IN ('active','suspended') ORDER BY t.created_at DESC`);
  for (const t of tenants) { t.active = isActive(t); t.admin_url = adminUrl(req, t); }
  await escalateOverdue();
  const counts = await one(`SELECT (SELECT COUNT(*) FROM tenants WHERE status = 'pending') AS pending,
    (SELECT COUNT(*) FROM complaints WHERE escalated = 1 AND status IN ('open','in_progress')) AS escalated,
    (SELECT COUNT(*) FROM complaints WHERE status IN ('open','in_progress')) AS open_complaints`);
  res.json({ tenants, today: today(), counts });
}));
app.get('/api/super/tenants/:id', a(async (req, res) => {
  const t = await one('SELECT * FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  delete t.password_hash;
  res.json({ ...t, admin_url: adminUrl(req, t) });
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
  res.json({ id, password, admin_url: adminUrl(req, fields) });
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
  const t = await one('SELECT slug FROM tenants WHERE id = $1', [int(req.params.id)]);
  res.json({ password, admin_url: adminUrl(req, t) });
}));
app.post('/api/super/tenants/:id/impersonate', a(async (req, res) => {
  const t = await one('SELECT id, session_version FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  t.slug = (await one('SELECT slug FROM tenants WHERE id = $1', [t.id])).slug;
  await slog(req, t.id, 'merchant.opened_by_super', 'merchant', t.id);
  if (onPlatformDomain(req)) {
    const enter = await makeToken({ enter: 1, t: t.id, v: t.session_version, exp: Date.now() + 2 * 60000 });
    return res.json({ ok: true, url: `${adminUrl(req, t)}/enter?token=${encodeURIComponent(enter)}` });
  }
  res.set('Set-Cookie', cookie(req, 'nv_admin', await makeToken({ t: t.id, v: t.session_version, imp: 1, exp: Date.now() + 2 * 3600000 }), 2 * 3600));
  res.json({ ok: true, url: '/admin' });
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
  res.set('Set-Cookie', cookie(req, 'nv_super', await makeToken({ s: 1, v, exp: Date.now() + 12 * 3600000 }), 12 * 3600, true));
  res.json({ ok: true });
}));

// Merchant sign-ups waiting for approval
app.get('/api/super/approvals', a(async (req, res) => {
  const cols = `id, slug, name, logo, owner_name, contact_phone, email, gst_number, business_type, address, status, reject_reason, created_at, decided_at`;
  const [pending, decided] = await Promise.all([
    q(`SELECT ${cols} FROM tenants WHERE status = 'pending' ORDER BY created_at`),
    q(`SELECT ${cols} FROM tenants WHERE signup_source = 'self' AND status <> 'pending' ORDER BY decided_at DESC NULLS LAST LIMIT 30`),
  ]);
  for (const t of [...pending, ...decided]) t.admin_url = adminUrl(req, t);
  res.json({ pending, decided });
}));
app.post('/api/super/tenants/:id/approve', a(async (req, res) => {
  const t = await one('SELECT * FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  if (t.status !== 'pending' && t.status !== 'rejected') throw fail(409, 'This merchant is not waiting for approval');
  const plan = dateOr(req.body.plan_expires_on);
  const max = req.body.max_coupons === '' || req.body.max_coupons == null ? null : Math.max(0, int(req.body.max_coupons));
  await tx(async c => {
    await q(`UPDATE tenants SET status = 'active', decided_at = $2, reject_reason = '', plan_expires_on = $3, max_coupons = $4 WHERE id = $1`,
      [t.id, utcNow(), plan, max], c);
    await slog(req, t.id, 'merchant.approved', 'merchant', t.id, { name: t.name, username: t.slug, plan_expires_on: plan, max_coupons: max }, c);
  });
  await sendTemplate(t.contact_phone, 'gd_registration_status', [(t.owner_name || t.contact_name || t.name).split(' ')[0], t.name]);
  res.json({ ok: true, admin_url: adminUrl(req, t) });
}));
app.post('/api/super/tenants/:id/reject', a(async (req, res) => {
  const t = await one('SELECT * FROM tenants WHERE id = $1', [int(req.params.id)]);
  if (!t) throw fail(404, 'Merchant not found');
  if (t.status !== 'pending') throw fail(409, 'This merchant is not waiting for approval');
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (reason.length < 3) throw fail(400, 'Please give a reason (the merchant will see it)');
  await tx(async c => {
    await q(`UPDATE tenants SET status = 'rejected', decided_at = $2, reject_reason = $3, session_version = session_version + 1 WHERE id = $1`, [t.id, utcNow(), reason], c);
    await slog(req, t.id, 'merchant.rejected', 'merchant', t.id, { name: t.name, username: t.slug, reason }, c);
  });
  await sendTemplate(t.contact_phone, 'gd_merchant_rejected', [(t.owner_name || t.contact_name || t.name).split(' ')[0], t.name, reason]);
  res.json({ ok: true });
}));

// Complaints across every merchant
app.get('/api/super/complaints', a(async (req, res) => {
  await escalateOverdue();
  const f = req.query.filter;
  const where = f === 'all' ? 'TRUE' : f === 'open' ? "k.status IN ('open','in_progress')" : "k.escalated = 1 AND k.status IN ('open','in_progress')";
  res.json(await complaintList(where, []));
}));
app.get('/api/super/complaints/:id', a(async (req, res) => res.json(await complaintDetail('k.id = $1', [int(req.params.id)]))));
app.post('/api/super/complaints/:id/reply', a(async (req, res) => {
  const c = await complaintDetail('k.id = $1', [int(req.params.id)]);
  await replyToComplaint(req, c, { type: 'super', name: `${PLATFORM} team`, actor: SUPER }, req.body.body, req.body.status);
  if (req.body.body) {
    const t = await one('SELECT * FROM tenants WHERE id = $1', [c.tenant_id]);
    if (t) await sendTemplate(t.whatsapp || t.contact_phone, 'gd_complaint_update', [c.ticket_no, `${PLATFORM} team`, req.body.body, STATUS_LABEL[req.body.status || c.status] || 'In progress']);
  }
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
// Address-aware pages come first; express.static would otherwise answer /admin and /super on its own.
const pub = path.join(__dirname, 'public');
// genuinedraw.in opens the landing page; a merchant's own address opens its admin.
app.get('/', (req, res) => siteOf(req).kind === 'platform' ? res.sendFile(path.join(pub, 'home.html')) : res.redirect('/admin'));
app.get('/home', (req, res) => res.sendFile(path.join(pub, 'home.html')));
app.get(['/terms', '/privacy'], (req, res) => res.sendFile(path.join(pub, req.path.slice(1) + '.html')));
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, siteOf(req).kind === 'platform' ? 'find-shop.html' : 'admin/index.html')));
// Super Admin "Open as merchant" lands here on the merchant's subdomain.
app.get('/admin/enter', a(async (req, res) => {
  const p = await readToken(req.query.token);
  const s = await readToken(cookies(req).nv_super);
  const t = p && p.enter ? await one('SELECT id, slug, session_version FROM tenants WHERE id = $1', [p.t]) : null;
  const site = siteOf(req);
  if (!t || !s || String(s.v) !== await getSetting('super_session_version', '1') || (site.kind === 'merchant' && site.slug !== t.slug)) {
    return res.status(403).send('This link has expired. Please use "Open as merchant" again from Super Admin.');
  }
  res.set('Set-Cookie', cookie(req, 'nv_admin', await makeToken({ t: t.id, v: t.session_version, imp: 1, exp: Date.now() + 2 * 3600000 }), 2 * 3600));
  res.redirect('/admin');
}));
app.get('/admin/print/:id', (req, res) => res.sendFile(path.join(pub, 'admin', 'print.html')));
app.get(['/super', '/super/'], (req, res) => {
  const k = siteOf(req).kind;
  if (k === 'merchant' || k === 'unknown') return res.redirect(`https://${BASE}/super`);
  res.sendFile(path.join(pub, 'super', 'index.html'));
});
app.get('/c/:code([A-Za-z0-9-]+)', (req, res) => res.sendFile(path.join(pub, 'c', 'index.html')));
const platformPage = file => (req, res) => {
  const k = siteOf(req).kind;
  if (k === 'merchant' || k === 'unknown') return res.redirect(`https://${BASE}${req.originalUrl}`);
  res.sendFile(path.join(pub, file));
};
app.get('/register', platformPage('register.html'));
app.get(['/verify', '/verify/:code'], platformPage('verify.html'));
app.get('/my', platformPage('my.html'));
app.get('/draw/:id', platformPage('draw.html'));
app.get('/winners', platformPage('winners.html'));
app.use(express.static(pub, { extensions: ['html'], maxAge: 0 }));

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
