// Shared by the print sheet, the admin preview and the bakery admin.

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

// Renders one printable coupon in the bakery's branding.
window.renderCoupon = function ({ code, serial, theme, headline, subline, expires_on, baseUrl, treat, brand = {} }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const url = `${baseUrl}/c/${code}`;
  const color = brand.color || '#F47216';
  const fg = theme === 'chocolate' ? '3A1A0E' : theme === 'festive' ? '6E0619' : shade(brand.color2 || '#963B1F', -0.55).slice(1);
  // "orange" is the bakery's own brand colours; the other two designs keep their fixed palettes.
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
