// Renders one printable coupon. Shared by the print sheet and the admin preview.
window.renderCoupon = function ({ code, serial, theme, headline, subline, expires_on, baseUrl, treat }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const url = `${baseUrl}/c/${code}`;
  const fg = theme === 'chocolate' ? '3A1A0E' : theme === 'festive' ? '6E0619' : '2B140B';
  const exp = expires_on ? new Date(expires_on + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const words = String(headline || 'Scratch & Win').split(' ');
  const kicker = theme === 'festive' ? 'Festive surprise' : theme === 'chocolate' ? 'Exclusive treat' : 'Lucky coupon';
  return `
  <div class="coupon theme-${esc(theme)}">
    <div class="cp-main">
      <div class="cp-top">
        <div class="cp-logo"><img src="/img/navya-logo.svg" alt="Navya"></div>
      </div>
      <div class="cp-head">
        <div class="cp-kicker">★ ${esc(kicker)} ★</div>
        <div class="cp-title">${words.length > 1 ? esc(words.slice(0, -1).join(' ')) + '<br>' + esc(words.slice(-1)[0]) : esc(words[0])}</div>
        <div class="cp-sub">${esc(subline)}</div>
      </div>
      <div class="cp-steps"><span><b>1</b>Scan</span><span><b>2</b>Scratch</span><span><b>3</b>Win</span></div>
      <div class="cp-foot"><span class="cp-tag">The Tempting Taste</span><span>${exp ? 'Valid till ' + esc(exp) : ''}</span></div>
      <div class="cp-treat"><img src="${esc(treat || '/img/cake.webp')}" alt=""></div>
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
