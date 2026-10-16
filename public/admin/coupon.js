// Shared by the print sheet, the merchant admin and the Super Admin.

// Mix a #rrggbb colour towards white (amount > 0) or black (amount < 0).
window.shade = function (hex, amount) {
  const n = parseInt(String(hex || '#F47216').slice(1), 16);
  const t = amount < 0 ? 0 : 255, p = Math.abs(amount);
  const ch = s => Math.round(((n >> s) & 255) + (t - ((n >> s) & 255)) * p);
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
};

// Gift/treat pictures are a URL, a data: URI, or "emoji:🎂".
window.giftPic = function (image, fallback = '🎁') {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!image) return `<span class="emoji-pic">${fallback}</span>`;
  if (image.startsWith('emoji:')) return `<span class="emoji-pic">${esc(image.slice(6))}</span>`;
  return `<img src="${esc(image)}" alt="">`;
};

// Renders one printable coupon in the merchant's branding.
window.renderCoupon = function ({ code, serial, theme, headline, subline, expires_on, baseUrl, treat, brand = {} }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const url = `${baseUrl}/c/${code}`;
  const color = brand.color || '#F47216';
  const fg = theme === 'chocolate' ? '3A1A0E' : theme === 'festive' ? '6E0619' : shade(brand.color2 || '#963B1F', -0.55).slice(1);
  // "orange" is the merchant's own brand colours; the other two designs keep their fixed palettes.
  const vars = theme === 'orange' ? `--c1:${shade(color, 0.25)};--c2:${color};--c3:${shade(color, -0.3)};--stub-ink:${shade(brand.color2 || '#963B1F', -0.35)};` : '';
  const exp = expires_on ? new Date(expires_on + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const words = String(headline || 'Scratch & Win').split(' ');
  const kicker = theme === 'festive' ? 'Festive surprise' : theme === 'chocolate' ? 'Exclusive treat' : 'Lucky coupon';
  const logo = brand.logo
    ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">`
    : `<b class="cp-name">${esc(brand.name || 'Scratch & Win')}</b>`;
  return `
  <div class="coupon theme-${esc(theme)}" style="${vars}">
    <div class="cp-main">
      <div class="cp-top"><div class="cp-logo">${logo}</div></div>
      <div class="cp-head">
        <div class="cp-kicker">★ ${esc(kicker)} ★</div>
        <div class="cp-title">${words.length > 1 ? esc(words.slice(0, -1).join(' ')) + '<br>' + esc(words.slice(-1)[0]) : esc(words[0])}</div>
        <div class="cp-sub">${esc(subline)}</div>
      </div>
      <div class="cp-steps"><span><b>1</b>Scan</span><span><b>2</b>Scratch</span><span><b>3</b>Win</span></div>
      <div class="cp-foot"><span class="cp-tag">${esc(brand.tagline || '')}</span><span>${exp ? 'Valid till ' + esc(exp) : ''}</span></div>
      <div class="cp-treat">${giftPic(treat)}</div>
    </div>
    <div class="cp-stub">
      <span class="cp-notch t"></span><span class="cp-notch b"></span>
      <div class="cp-scan">Scan me</div>
      <div class="cp-qr"><img src="/qr.svg?m=0&fg=${fg}&d=${encodeURIComponent(url)}" alt="QR"></div>
      <div class="cp-code">${esc(code.slice(0, 4))}-${esc(code.slice(4))}</div>
      <div class="cp-serial">No. ${String(serial).padStart(4, '0')} · T&amp;C apply</div>
      <div class="cp-hand">Scratch online · win instantly</div>
    </div>
  </div>`;
};

// Plain-language text for activity-log entries (merchant and Super Admin pages).
window.ACTIVITY = {
  'auth.login': ['🔑', 'Signed in'],
  'gift.created': ['🎁', 'Added a gift'], 'gift.updated': ['🎁', 'Changed a gift'], 'gift.deleted': ['🗑️', 'Deleted a gift'],
  'batch.created': ['🎟️', 'Created a coupon batch'], 'batch.voided_unused': ['🚫', 'Voided unused coupons'],
  'batch.deleted': ['🗑️', 'Deleted a coupon batch'], 'coupon.voided': ['🚫', 'Voided a coupon'],
  'coupon.claimed': ['✨', 'Customer scratched a coupon'], 'coupon.redeemed': ['✅', 'Gift handed over'],
  'settings.updated': ['⚙️', 'Changed settings'], 'password.changed': ['🔒', 'Changed own password'],
  'customers.exported': ['⬇️', 'Downloaded the customer list'], 'demo.cleared': ['🧹', 'Removed demo data'],
  'outlet.created': ['🏪', 'Added an outlet'], 'outlet.updated': ['🏪', 'Changed an outlet'], 'outlet.deleted': ['🗑️', 'Deleted an outlet'],
  'staff.created': ['👤', 'Added a staff login'], 'staff.updated': ['👤', 'Changed a staff login'],
  'staff.disabled': ['⛔', 'Switched off a staff login'], 'staff.enabled': ['👤', 'Switched on a staff login'],
  'staff.password_reset': ['🔒', 'Reset a staff password'], 'staff.deleted': ['🗑️', 'Deleted a staff login'],
  'merchant.created': ['🏬', 'Merchant created'], 'merchant.updated': ['🏬', 'Merchant details changed'],
  'merchant.suspended': ['⏸️', 'Merchant suspended'], 'merchant.activated': ['▶️', 'Merchant re-activated'],
  'merchant.password_reset': ['🔒', 'Merchant password reset'], 'merchant.opened_by_super': ['👀', 'Super Admin opened this account'],
  'merchant.deleted': ['🗑️', 'Merchant deleted'], 'super.login': ['🔑', 'Super Admin signed in'],
  'super.password_changed': ['🔒', 'Super Admin password changed'],
  'coupon.entered': ['🎟️', 'Customer entered a Lucky Draw'],
  'draw.sealed': ['🔒', 'Sealed the draw entries'], 'draw.completed': ['🏆', 'Lucky draw winners picked'],
  'draw.prize_forfeited': ['⏭️', 'Forfeited a draw prize'], 'draw.backup_promoted': ['🎁', 'Backup winner got the prize'],
  'campaign.created': ['🎯', 'Created a campaign'], 'campaign.updated': ['🎯', 'Changed a campaign'], 'campaign.deleted': ['🗑️', 'Deleted a campaign'],
  'campaign.paused': ['⏸️', 'Paused a campaign'], 'campaign.resumed': ['▶️', 'Resumed a campaign'],
  'report.exported': ['⬇️', 'Downloaded a report'],
  'complaint.created': ['📣', 'Customer raised a complaint'], 'complaint.replied': ['💬', 'Replied to a complaint'],
  'complaint.status': ['📋', 'Changed a complaint status'], 'complaint.escalated': ['🚨', 'Complaint sent to Genuine Draw team'],
  'merchant.registered': ['📝', 'Merchant signed up'], 'merchant.approved': ['✅', 'Merchant approved'], 'merchant.rejected': ['⛔', 'Merchant not approved'],
};
window.activityRow = function (e, { showMerchant = false } = {}) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const [icon, label] = ACTIVITY[e.action] || ['•', e.action];
  const who = { owner: 'Owner', manager: 'Manager', counter: 'Counter', super: 'Super Admin', customer: 'Customer', system: 'System' }[e.actor_type] || e.actor_type;
  const d = e.details || {};
  const bits = Object.entries(d).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${esc(k.replace(/_/g, ' '))}: <b>${esc(Array.isArray(v) ? v.join(', ') : v)}</b>`);
  if (e.entity === 'coupon' && e.entity_id) bits.unshift(`coupon: <b>${esc(e.entity_id.slice(0, 4) + '-' + e.entity_id.slice(4))}</b>`);
  const when = new Date(e.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `<div class="act-row">
    <div class="act-ico">${icon}</div>
    <div class="act-main">
      <div><b>${esc(label)}</b>${showMerchant && e.tenant_name ? ` <span class="pill new">${esc(e.tenant_name)}</span>` : ''}</div>
      <small>${esc(who)}${e.actor_name && e.actor_type !== 'super' ? ' · ' + esc(e.actor_name) : ''} · ${esc(when)}</small>
      ${bits.length ? `<div class="act-details">${bits.join(' · ')}</div>` : ''}
    </div>
    <div class="act-id">#${e.id}</div>
  </div>`;
};

// Complaint ticket header + conversation, shared by the merchant admin and Super Admin.
window.COMPLAINT_STATUS = { open: ['claimed', 'Open'], in_progress: ['bumper', 'In progress'], resolved: ['redeemed', 'Resolved'], rejected: ['off', 'Closed'] };
window.COMPLAINT_CAT = { not_received: 'Did not get coupon / reward', prize_not_given: 'Prize not given', result_dispute: 'Problem with the result', invalid_coupon: 'Coupon invalid or used', other: 'Something else' };
window.complaintThread = k => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtCode = c => c ? (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c) : '';
  const fmtTime = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const fmtPhone = p => p ? p.slice(0, 5) + ' ' + p.slice(5) : '';
  const C_STATUS = window.COMPLAINT_STATUS, C_CAT = window.COMPLAINT_CAT;
  return `
    <div class="ticket-head">
      <div><span class="pill ${C_STATUS[k.status][0]}">${C_STATUS[k.status][1]}</span> ${k.escalated ? '<span class="pill void">With Genuine Draw team</span>' : ''}</div>
      <div class="meta"><span>🎫 <b>${esc(k.ticket_no)}</b></span><span>${esc(C_CAT[k.category] || k.category)}</span>${k.shop ? `<span>🏬 ${esc(k.shop)}</span>` : ''}</div>
      <div class="meta">${k.coupon_code ? `<span>Coupon <b>${esc(fmtCode(k.coupon_code))}</b></span>` : ''}${k.campaign ? `<span>${esc(k.campaign)}</span>` : ''}${k.outlet ? `<span>📍 ${esc(k.outlet)}</span>` : ''}${k.incident_at ? `<span>🕒 ${fmtTime(k.incident_at)}</span>` : ''}</div>
      <div class="meta"><span>👤 ${esc(k.customer_name || 'Customer')} · ${esc(fmtPhone(k.phone))}</span><span>Raised ${fmtTime(k.created_at)}</span></div>
      ${k.escalation_reason ? `<p class="hint">Escalated: ${esc(k.escalation_reason)}</p>` : ''}
    </div>
    ${k.photo ? `<img class="ticket-photo" src="${esc(k.photo)}" alt="Photo from customer">` : ''}
    <div class="thread">${k.messages.map(msg => `<div class="msg ${msg.author_type}"><small>${esc(msg.author_name || msg.author_type)} · ${fmtTime(msg.created_at)}</small><div>${esc(msg.body)}</div></div>`).join('')}</div>`;
};

// A styled replacement for the browser's confirm() / prompt(). Resolves true/false, or the typed text (null if cancelled) when `input` is set.
window.askConfirm = function ({ title, text = '', note = '', ok = 'Delete', cancel = 'Cancel', tone = 'danger', icon, input, placeholder = '' } = {}) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = icon || (tone === 'danger' ? '🗑️' : '❓');
  return new Promise(resolve => {
    const prev = document.activeElement;
    const root = document.createElement('div');
    root.className = 'ask-back';
    root.innerHTML = `<div class="ask ${tone}" role="alertdialog" aria-modal="true" aria-labelledby="askT">
      <div class="ask-ico">${ico}</div>
      <h3 id="askT">${esc(title)}</h3>
      ${String(text).split('\n\n').filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}
      ${note ? `<div class="ask-note">💡 ${esc(note)}</div>` : ''}
      ${input ? `<textarea class="input ask-input" rows="3" maxlength="500" placeholder="${esc(placeholder)}"></textarea>` : ''}
      <div class="ask-btns"><button type="button" class="btn" data-a="no">${esc(cancel)}</button><button type="button" class="btn ${tone === 'danger' ? 'ask-danger' : 'primary'}" data-a="yes">${esc(ok)}</button></div>
    </div>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('in'));
    const field = root.querySelector('.ask-input');
    (field || root.querySelector('[data-a="yes"]')).focus();
    const done = yes => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('in'); root.classList.add('out');
      setTimeout(() => root.remove(), 180);
      if (prev && prev.focus) prev.focus();
      resolve(input ? (yes ? field.value.trim() : null) : yes);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !(field && e.shiftKey)) { if (e.target.tagName !== 'BUTTON' || e.target.dataset.a === 'yes') { e.preventDefault(); done(true); } }
    };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', e => { if (e.target === root) done(false); });
    root.querySelector('[data-a="no"]').onclick = () => done(false);
    root.querySelector('[data-a="yes"]').onclick = () => done(true);
  });
};
