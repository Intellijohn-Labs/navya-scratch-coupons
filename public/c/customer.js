(() => {
  const code = decodeURIComponent(location.pathname.split('/').pop() || '').toUpperCase();
  const tokenKey = 'navya-claim-' + code;
  const $ = s => document.querySelector(s);
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const fmtCode = c => c ? c.slice(0, 4) + '-' + c.slice(4) : '';
  const fmtDate = d => d ? new Date(d.replace(' ', 'T') + (d.length > 10 ? 'Z' : '')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const bind = (k, v) => document.querySelectorAll(`[data-bind="${k}"]`).forEach(el => { el.textContent = v; });

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function status(ico, title, text, who) {
    $('#stIco').textContent = ico;
    $('#stTitle').textContent = title;
    $('#stText').textContent = text;
    const w = $('#stWho');
    w.hidden = !who;
    if (who) w.innerHTML = who;
    show('s-status');
  }

  // Mix a #rrggbb colour towards white (amount > 0) or black (amount < 0).
  function shade(hex, amount) {
    const n = parseInt(String(hex || '#F47216').slice(1), 16);
    const t = amount < 0 ? 0 : 255, p = Math.abs(amount);
    const ch = sh => Math.round(((n >> sh) & 255) + (t - ((n >> sh) & 255)) * p);
    return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
  }

  let brand = { name: 'our shop' };
  function applyBrand(b) {
    if (!b) return;
    brand = b;
    document.title = `${b.name} · Genuine Draw`;
    const root = document.documentElement.style;   // body theme classes still override for the other designs
    root.setProperty('--accent', b.color);
    root.setProperty('--accent-2', shade(b.color, 0.3));
    root.setProperty('--orange', b.color);
    root.setProperty('--brown', b.color2);
    root.setProperty('--choco', shade(b.color2, -0.45));
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = b.color;
    if (b.logo) { $('#brandLogo').src = b.logo; $('#brandLogo').alt = b.name; $('#brandLogo').hidden = false; $('#favicon').href = b.logo; }
    else { $('#brandName').textContent = b.name; $('#brandName').hidden = false; }
    $('#brandTagline').textContent = b.tagline || '';
    $('#footAddress').textContent = [b.name, b.address].filter(Boolean).join(' · ');
    $('#footLine').textContent = b.footer || '';
    $('#areas').innerHTML = (b.areas || []).map(a => `<option>${esc(a)}</option>`).join('');
    if (b.areas && b.areas[0]) $('[name=area]').placeholder = b.areas[0];
    if (b.maps_url) { $('#mapsLink').href = b.maps_url; $('#mapsLink').hidden = false; }
    if (b.website) { $('#siteLink').href = b.website; $('#siteLink').hidden = false; }
    bind('shopName', b.name);
    bind('terms', b.terms || '');
  }

  async function load() {
    let data;
    try {
      const r = await fetch('/api/c/' + encodeURIComponent(code), { headers: { 'x-claim-token': store.get(tokenKey) || '' } });
      data = await r.json();
    } catch {
      return status('📶', 'No connection', 'Please check your internet and scan again.');
    }
    applyBrand(data.brand);
    if (data.campaign) {
      document.body.className = 'theme-' + data.campaign.theme;
      bind('headline', data.campaign.headline);
      bind('subline', data.campaign.subline);
    }
    bind('code', fmtCode(data.code));

    switch (data.state) {
      case 'invalid': return status('🔍', 'Coupon not found', 'This QR code is not a valid coupon. Please check and scan again.');
      case 'paused': return status('⏸️', 'This offer is paused', `${brand.name}'s Scratch & Win is taking a short break. Please keep your coupon and try again later.`);
      case 'void': return status('🚫', 'Coupon cancelled', 'This coupon is no longer active. Please ask our staff for a new one.');
      case 'expired': return status('⏰', 'This coupon has expired', `The offer ended on ${fmtDate(data.campaign.expires_on)}. Watch out for our next sweet surprise!`);
      case 'mine': return showReward(data.reward, false);
      case 'claimed': return status('🎁', 'Already claimed', 'This coupon has already been scratched. Each coupon can be used only once.',
        `Claimed by <b>${esc(data.claimed_by)}</b> (${esc(data.phone)})<br>on ${esc(fmtDate(data.claimed_at))}` + (data.gift ? `<br>Reward: <b>${esc(data.gift.name)}</b>` : ''));
      default: show('s-form');
    }
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------------------------------------------- form
  const form = $('#claimForm');
  form.phone.addEventListener('input', e => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 10);
    e.target.value = d.length > 5 ? d.slice(0, 5) + ' ' + d.slice(5) : d;
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#formErr');
    err.textContent = '';
    const body = {
      name: form.name.value.trim(),
      phone: form.phone.value.replace(/\D/g, ''),
      area: form.area.value.trim(),
      dob: form.dob.value,
      consent: form.consent.checked,
    };
    if (body.name.length < 2) { err.textContent = 'Please enter your name.'; return form.name.focus(); }
    if (!/^[6-9]\d{9}$/.test(body.phone)) { err.textContent = 'Please enter a valid 10-digit mobile number.'; return form.phone.focus(); }
    const btn = form.querySelector('.cta');
    btn.disabled = true;
    btn.firstElementChild.textContent = 'Wrapping your gift…';
    try {
      const r = await fetch(`/api/c/${encodeURIComponent(code)}/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'Something went wrong');
      store.set(tokenKey, out.token);
      showReward(out.reward, true);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.firstElementChild.textContent = 'Unlock my scratch card';
    }
  });

  // ---------------------------------------------------- reward / scratch
  function showReward(rw, fresh) {
    const first = (rw.name || '').split(' ')[0];
    bind('firstName', first || 'there');
    bind('commaName', first ? ', ' + first : '');
    const isWin = rw.gift.kind === 'prize';

    const imgBox = $('.reveal-img'), img = rw.gift.image || '';
    if (img && !img.startsWith('emoji:')) { $('#giftImg').src = img; imgBox.classList.remove('emoji'); }
    else { imgBox.innerHTML = `<span class="emoji-pic">${esc(img ? img.slice(6) : isWin ? '🎁' : '🧁')}</span>`; imgBox.classList.add('emoji'); }
    $('#revealLabel').textContent = isWin ? (rw.gift.bumper ? '★ Bumper prize ★' : 'You won') : 'Oh no!';
    $('#giftName').textContent = rw.gift.name;

    $('#winBlock').hidden = !isWin;
    $('#loseBlock').hidden = isWin;
    if (isWin) {
      $('#resGift').textContent = rw.gift.name;
      $('#resDesc').textContent = rw.gift.description || '';
      $('#resCode').textContent = rw.reward_code;
      $('#resValid').textContent = rw.status === 'redeemed'
        ? `✔ Redeemed on ${fmtDate(rw.redeemed_at)}`
        : rw.reward_expires ? `Valid till ${fmtDate(rw.reward_expires)}` : '';
      $('#resQr').src = '/qr.svg?d=' + encodeURIComponent('REWARD:' + rw.reward_code);
    } else {
      $('#loseDesc').textContent = rw.gift.description || `Thank you for choosing ${brand.name}. Keep collecting coupons for more sweet surprises!`;
    }
    const msg = isWin
      ? `I just won *${rw.gift.name}* in ${brand.name}'s Scratch & Win! 🎉🍰 Pick up a coupon at ${brand.name} and try your luck too.`
      : `I just played ${brand.name}'s Scratch & Win! 🍰 Pick up a coupon at ${brand.name} and try your luck.`;
    $('#waShare').href = 'https://wa.me/?text=' + encodeURIComponent(msg);

    show('s-scratch');
    if (fresh) requestAnimationFrame(() => setupFoil(isWin, rw.gift.bumper));
    else finishReveal(isWin, false);
  }

  function finishReveal(isWin, celebrate) {
    const foil = $('#foil');
    foil.classList.add('gone');
    $('#finger').classList.add('hide');
    $('#revealAll').hidden = true;
    $('#scratchHint').textContent = isWin ? 'Here is your sweet reward 🎉' : 'Thanks for playing!';
    $('#result').hidden = false;
    if (celebrate) {
      $('#scratchCard').classList.add('won');
      if (navigator.vibrate) navigator.vibrate(isWin ? [60, 40, 120] : 40);
      if (isWin && window.confetti) {
        const colors = [brand.color || '#F47216', '#F6C24A', brand.color2 || '#963B1F', '#FFFFFF', '#E9567B'];
        confetti({ particleCount: 140, spread: 80, origin: { y: .45 }, colors });
        setTimeout(() => confetti({ particleCount: 70, angle: 60, spread: 60, origin: { x: 0, y: .7 }, colors }), 250);
        setTimeout(() => confetti({ particleCount: 70, angle: 120, spread: 60, origin: { x: 1, y: .7 }, colors }), 400);
      }
      setTimeout(() => $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' }), 900);
    }
  }

  function setupFoil(isWin, bumper) {
    const canvas = $('#foil');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Gold foil blending into the merchant's brand colour
    const c = brand.color || '#F47216';
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#FFC768'); g.addColorStop(.35, shade(c, 0.35)); g.addColorStop(.6, c); g.addColorStop(1, shade(c, -0.15));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // diagonal sheen
    const sh = ctx.createLinearGradient(0, H, W, 0);
    sh.addColorStop(.3, 'rgba(255,255,255,0)'); sh.addColorStop(.5, 'rgba(255,255,255,.35)'); sh.addColorStop(.7, 'rgba(255,255,255,0)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H);
    // repeating merchant-name watermark
    const mark = String(brand.name || 'Scratch').split(' ')[0].toUpperCase().slice(0, 12);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 7);
    ctx.font = '800 15px "Albert Sans", sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.textAlign = 'center';
    const gap = Math.max(90, ctx.measureText(mark).width + 30);
    for (let y = -H; y < H; y += 30) for (let x = -W; x < W; x += gap) ctx.fillText(mark, x + (y / 30 % 2 ? gap / 2 : 0), y);
    ctx.restore();
    // sparkles
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 26; i++) { ctx.beginPath(); ctx.arc(Math.random() * W, Math.random() * H, Math.random() * 1.8 + .4, 0, 7); ctx.fill(); }
    // center medallion
    ctx.beginPath(); ctx.arc(W / 2, H / 2 - 14, 46, 0, 7);
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.setLineDash([4, 5]); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '42px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.fillText('🎁', W / 2, H / 2 - 12);
    ctx.font = '900 21px "Albert Sans", sans-serif'; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(120,40,0,.45)'; ctx.shadowBlur = 6;
    ctx.fillText('SCRATCH HERE', W / 2, H / 2 + 58);
    ctx.font = '600 13px "Albert Sans", sans-serif'; ctx.shadowBlur = 3;
    ctx.fillText('to reveal your gift', W / 2, H / 2 + 80);
    ctx.shadowBlur = 0;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(32, W * 0.14);

    let drawing = false, last = null, strokes = 0, done = false;
    const pos = e => {
      const r = canvas.getBoundingClientRect(), t = e.touches ? e.touches[0] || e.changedTouches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const start = e => {
      if (done) return;
      drawing = true; last = pos(e);
      if (e.pointerId != null && canvas.setPointerCapture) try { canvas.setPointerCapture(e.pointerId); } catch {}
      $('#finger').classList.add('hide'); scratch(e);
    };
    const scratch = e => {
      if (!drawing || done) return;
      if (e.cancelable && e.touches) e.preventDefault(); // stop the page scrolling while scratching (old iOS)
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x + .1, p.y + .1); ctx.stroke();
      last = p;
      if (++strokes % 8 === 0) check();
    };
    const end = () => { drawing = false; check(); };
    function check() {
      if (done) return;
      let data;
      try { data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; }
      catch { if (strokes > 40) { done = true; finishReveal(isWin, true); } return; }
      let clear = 0, total = 0;
      for (let i = 3; i < data.length; i += 4 * 24) { total++; if (data[i] < 40) clear++; }
      if (clear / total > 0.48) { done = true; finishReveal(isWin, true); }
    }
    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', start);
      canvas.addEventListener('pointermove', scratch);
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
    } else { // older iOS / Android browsers without Pointer Events
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', scratch, { passive: false });
      canvas.addEventListener('touchend', end);
      canvas.addEventListener('mousedown', start);
      window.addEventListener('mousemove', scratch);
      window.addEventListener('mouseup', end);
    }

    // If the phone is rotated before scratching starts, redraw the foil at the new size.
    let lastW = W;
    window.addEventListener('resize', function onResize() {
      const w = canvas.getBoundingClientRect().width;
      if (done || strokes > 0) return window.removeEventListener('resize', onResize);
      if (Math.abs(w - lastW) > 4) { lastW = w; window.removeEventListener('resize', onResize); canvas.replaceWith(canvas.cloneNode()); setupFoil(isWin, bumper); }
    });

    // Fallback for anyone who can't scratch
    setTimeout(() => { if (!done) $('#revealAll').hidden = false; }, 8000);
    $('#revealAll').onclick = () => { if (!done) { done = true; finishReveal(isWin, true); } };
  }

  load();
})();
