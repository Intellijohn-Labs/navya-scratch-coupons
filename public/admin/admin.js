(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtCode = c => c ? (c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c) : '';
  const toDate = s => s ? new Date(s.length > 10 ? s.replace(' ', 'T') + 'Z' : s + 'T00:00:00') : null;
  const fmtDate = s => s ? toDate(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtTime = s => s ? toDate(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
  const ago = s => {
    const m = Math.round((Date.now() - toDate(s)) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  };
  const initials = n => (n || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const fmtPhone = p => p ? p.slice(0, 5) + ' ' + p.slice(5) : '';
  // Neutral icon presets for every merchant; Navya also keeps the product photos taken from its own website.
  const EMOJI_PRESETS = ['🎂', '🍰', '🧁', '🍪', '🍩', '🥐', '🍞', '🍮', '🥧', '🍫', '☕', '🎟️'].map(e => 'emoji:' + e);
  const PHOTO_PRESETS = ['/img/cake.webp', '/img/cookies.webp', '/img/desserts.webp', '/img/bread.webp', '/img/savouries.webp', '/img/snacks.webp'];
  let ME = { tenant: { name: '', color: '#F47216', color2: '#963B1F' } };
  const presets = () => ME.tenant.slug === 'navya' ? [...PHOTO_PRESETS, ...EMOJI_PRESETS] : EMOJI_PRESETS;
  const PALETTE = ['#F47216', '#963B1F', '#E9A92A', '#E9567B', '#2C9C8F', '#6B5BD6', '#3D8BD9', '#8BBE3A', '#C1A08E'];
  const WA_ICON = '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.4-.7-2.8-1.1-4.6-4-4.8-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.2Z"/></svg>';

  async function api(path, opts = {}) {
    const r = await fetch('/api/admin' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) { showLogin(); throw new Error('Please log in'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  function modal(html, { wide } = {}) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
    const back = root.firstElementChild;
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    function close() { root.innerHTML = ''; }
    return { el: back.firstElementChild, close };
  }

  // ---------------------------------------------------------------- auth
  async function showLogin() {
    $('#login').classList.remove('hidden'); $('#shell').classList.add('hidden');
    const shop = await (await fetch('/api/shop')).json().catch(() => ({}));
    const card = $('#loginForm');
    if (shop.exists === false) {
      card.querySelector('h1').textContent = 'No shop here';
      card.querySelector('p').innerHTML = 'There is no Genuine Draw shop at this address. Check the link you were given.';
      card.querySelectorAll('input, button').forEach(el => { el.hidden = true; });
    } else if (shop.name) {
      card.querySelector('h1').textContent = shop.name;
      card.querySelector('p').textContent = 'Shop admin · sign in to continue';
      if (shop.logo) { const img = card.querySelector('.login-icon'); img.src = shop.logo; img.classList.add('shop-logo'); }
    }
  }
  async function showShell() {
    ME = await (await fetch('/api/admin/me')).json();
    if (!ME.admin) return showLogin();
    applyBrand(ME.tenant);
    applyRole();
    const ban = $('#impBanner');
    ban.hidden = !ME.impersonated;
    ban.innerHTML = ME.impersonated ? `<span>👀 You are viewing <b>${esc(ME.tenant.name)}</b> as the Super Admin.</span><a href="/super">← Back to Super Admin</a>` : '';
    $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden'); route();
  }
  // Which pages each login can open (the server enforces the same rules).
  const ROLE_PAGES = {
    owner: ['dashboard', 'gifts', 'coupons', 'batch', 'customers', 'redeem', 'outlets', 'team', 'activity', 'settings'],
    manager: ['dashboard', 'gifts', 'coupons', 'batch', 'customers', 'redeem', 'outlets'],
    counter: ['redeem'],
  };
  const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', counter: 'Counter staff' };
  const canSee = page => (ROLE_PAGES[ME.role] || []).includes(page);
  function applyRole() {
    document.querySelectorAll('#nav a').forEach(a => { a.hidden = !canSee(a.dataset.r); });
    $('#sideRole').textContent = ME.impersonated ? 'Viewing as Super Admin'
      : `${ME.user.name} · ${ROLE_LABEL[ME.role]}${ME.user.outlet ? ' · ' + ME.user.outlet.name : ''}`;
    $('#myPw').hidden = !!ME.impersonated;
  }
  function applyBrand(t) {
    document.title = `${t.name} · Genuine Draw`;
    $('#sideTitle').textContent = t.name;
    $('#sideName').textContent = [t.name, t.address].filter(Boolean).join(' · ');
    if (t.logo) { $('#sideLogo').src = t.logo; $('#sideLogo').hidden = false; $('#sideInitial').textContent = ''; }
    else { $('#sideLogo').hidden = true; $('#sideInitial').textContent = initials(t.name); $('#sideInitial').style.background = t.color; }
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: e.target.username.value.trim(), password: e.target.password.value }) });
    if (r.ok) { e.target.reset(); showShell(); }
    else $('#loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Could not sign in';
  });
  $('#myPw').onclick = () => {
    const m = modal(`<h2>Change my password</h2>
      <p class="hint" style="margin:0">Signed in as <b>${esc(ME.user.username || ME.user.name)}</b>. Other devices will be signed out.</p>
      <input class="input" type="password" id="pwOld" placeholder="Current password" autocomplete="current-password" style="margin-top:16px">
      <input class="input" type="password" id="pwNew" placeholder="New password (min 8 characters)" autocomplete="new-password" style="margin-top:10px">
      <p class="err" id="pwErr" style="color:var(--red);font-weight:600;min-height:18px;margin:10px 0 0"></p>
      <div class="modal-foot"><button class="btn" id="pwCancel">Cancel</button><button class="btn primary" id="pwSave">Change password</button></div>`);
    $('#pwCancel', m.el).onclick = m.close;
    $('#pwSave', m.el).onclick = async () => {
      try { await api('/password', { method: 'PUT', body: { current: $('#pwOld', m.el).value, password: $('#pwNew', m.el).value } }); m.close(); toast('Password changed'); }
      catch (e) { $('#pwErr', m.el).textContent = e.message; }
    };
  };
  $('#logout').onclick = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    if (ME.impersonated) location.href = '/super'; else showLogin();
  };

  // ---------------------------------------------------------------- router
  let scanner = null;
  async function route() {
    if (scanner) { try { await scanner.stop(); } catch {} scanner = null; }
    if (!ME.role) return;                // not signed in yet
    let [name, arg] = (location.hash.slice(1) || '').split('/');
    if (!canSee(name)) name = ROLE_PAGES[ME.role][0];
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === (name === 'batch' ? 'coupons' : name)));
    const pages = { dashboard, gifts, coupons, batch, customers, redeem, outlets, team, activity, settings };
    view.innerHTML = '<div class="empty-state">Loading…</div>';
    try { await pages[name](arg); } catch (e) { if (e.message !== 'Please log in') view.innerHTML = `<div class="empty-state"><span>⚠️</span>${esc(e.message)}</div>`; }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- dashboard
  async function dashboard() {
    const d = await api('/dashboard');
    const k = d.kpi;
    const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    const max = Math.max(1, ...d.series.map(s => s.n));
    const W = 560, H = 190, bw = W / d.series.length;
    const bars = d.series.map((s, i) => {
      const h = Math.max(3, (s.n / max) * (H - 46));
      const x = i * bw + bw * .18, y = H - 22 - h;
      const day = toDate(s.d);
      return `<rect class="bar ${s.n ? '' : 'zero'}" x="${x}" y="${y}" width="${bw * .64}" height="${h}" rx="5"></rect>
        ${s.n ? `<text class="val" x="${x + bw * .32}" y="${y - 5}" text-anchor="middle">${s.n}</text>` : ''}
        <text x="${x + bw * .32}" y="${H - 6}" text-anchor="middle">${day.getDate()}/${day.getMonth() + 1}</text>`;
    }).join('');
    const prizes = d.gifts.filter(g => g.kind === 'prize');
    const hour = new Date().getHours();
    const areaMax = Math.max(1, ...d.areas.map(a => a.n));

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'} 👋</h1><p>Here's how your campaigns are doing.</p></div>
        <div style="display:flex;gap:10px"><a class="btn" href="#redeem">Redeem a reward</a><a class="btn primary" href="#coupons">+ Print coupons</a></div>
      </div>
      <div class="kpis">
        <div class="kpi hero"><span>Customers reached</span><b>${k.customers || 0}</b><small>${k.optins || 0} opted in for WhatsApp</small></div>
        <div class="kpi"><span>Coupons printed</span><b>${k.printed || 0}</b><small>across all batches</small></div>
        <div class="kpi"><span>Scanned</span><b>${k.scanned || 0}</b><small>${pct(k.scanned, k.printed)}% of printed</small></div>
        <div class="kpi"><span>Scratched</span><b>${k.claimed || 0}</b><small>${pct(k.claimed, k.scanned)}% of scans</small></div>
        <div class="kpi"><span>Winners</span><b>${k.winners || 0}</b><small>${pct(k.winners, k.claimed)}% win rate</small></div>
        <div class="kpi"><span>Redeemed at shop</span><b>${k.redeemed || 0}</b><small>${pct(k.redeemed, k.winners)}% of winners</small></div>
      </div>
      <div class="dash">
        <div class="stack">
          <div class="card"><h3>Scratches · last 14 days</h3><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg></div>
          <div class="card"><h3>Latest scratches <a href="#customers" style="font-size:13px">View all →</a></h3>
            ${d.recent.length ? d.recent.map(r => `
              <div class="feed-row">
                <div class="avatar">${esc(initials(r.customer_name))}</div>
                <div class="who"><b>${esc(r.customer_name)}</b><small>${esc(r.area || '—')} · ${ago(r.claimed_at)}</small></div>
                ${r.gift_kind === 'prize' ? `<span class="pill ${r.status}">🎁 ${esc(r.gift_name)}</span>` : '<span class="pill lose">No win</span>'}
              </div>`).join('') : '<div class="empty-state"><span>🎟️</span>No scratches yet — print a batch and hand them out!</div>'}
          </div>
        </div>
        <div class="stack">
          <div class="card"><h3>Gift stock <a href="#gifts" style="font-size:13px">Manage →</a></h3>
            ${prizes.map(g => {
              const left = g.stock_total == null ? null : g.stock_total - g.stock_used;
              const p = g.stock_total ? Math.round(left / g.stock_total * 100) : 100;
              return `<div class="stock-row">
                <div class="thumb">${giftPic(g.image)}</div>
                <div><b>${esc(g.name)}</b> ${g.bumper ? '<span class="pill bumper">Bumper</span>' : ''}${g.active ? '' : ' <span class="pill off">Paused</span>'}
                  <div class="bar-track"><div class="bar-fill ${p < 20 ? 'low' : ''}" style="width:${p}%"></div></div></div>
                <small style="color:var(--muted)">${left == null ? '∞ left' : `${left} / ${g.stock_total}`}</small>
              </div>`;
            }).join('')}
          </div>
          <div class="card"><h3>Where customers come from</h3>
            ${d.areas.length ? d.areas.map(a => `<div class="area-row"><span>${esc(a.area)}</span><div class="bar-track" style="margin:0"><div class="bar-fill" style="width:${a.n / areaMax * 100}%"></div></div><b>${a.n}</b></div>`).join('') : '<div class="empty-state">No data yet</div>'}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:18px"><h3>Outlets <a href="#outlets" style="font-size:13px">Manage →</a></h3>
        <div class="table-wrap" style="border:0"><table class="rtable">
          <thead><tr><th>Outlet</th><th>Coupons handed out</th><th>Scratched</th><th>Gifts redeemed here</th></tr></thead>
          <tbody>${d.outlets.map(o => `<tr>
            <td data-label="Outlet"><b>${esc(o.name)}</b>${o.active ? '' : ' <span class="pill off">Closed</span>'}<small>${esc(o.address)}</small></td>
            <td data-label="Handed out">${o.issued}</td>
            <td data-label="Scratched">${o.claimed}${o.issued ? ` <small style="display:inline">(${Math.round(o.claimed / o.issued * 100)}%)</small>` : ''}</td>
            <td data-label="Redeemed here">${o.redeemed}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">"Handed out" counts batches assigned to an outlet. Batches for all outlets aren't included.</p>
      </div>`;
  }

  // ---------------------------------------------------------------- gifts
  async function gifts() {
    const list = await api('/gifts');
    const live = list.filter(g => g.active && g.weight > 0 && (g.stock_total == null || g.stock_used < g.stock_total));
    const total = live.reduce((s, g) => s + g.weight, 0);
    const odds = g => live.includes(g) && total ? (g.weight / total * 100) : 0;
    const winChance = live.filter(g => g.kind === 'prize').reduce((s, g) => s + odds(g), 0);

    view.innerHTML = `
      <div class="page-head">
        <div><h1>Gifts</h1><p>Add the treats customers can win. Each scratch picks one at random, based on its chance.</p></div>
        <button class="btn primary" id="addGift">+ Add gift</button>
      </div>
      <div class="card">
        <h3>What a customer can win right now <span style="font-weight:600;color:var(--muted);font-size:13px">${Math.round(winChance)}% chance to win a gift</span></h3>
        <div class="odds-bar">${live.map((g, i) => `<span title="${esc(g.name)}" style="width:${odds(g)}%;background:${g.kind === 'lose' ? '#D9CFC7' : PALETTE[i % PALETTE.length]}"></span>`).join('')}</div>
        <div class="odds-legend">${live.map((g, i) => `<span><i style="background:${g.kind === 'lose' ? '#D9CFC7' : PALETTE[i % PALETTE.length]}"></i>${esc(g.name)} · ${odds(g).toFixed(1)}%</span>`).join('')}</div>
      </div>
      <div class="gifts">
        ${list.map(g => {
          const left = g.stock_total == null ? null : g.stock_total - g.stock_used;
          const out = left !== null && left <= 0;
          return `<div class="gift ${g.active && !out ? '' : 'inactive'}">
            <div class="gift-img">
              ${giftPic(g.image, g.kind === 'lose' ? '🧁' : '🎁')}
              <div class="tags">
                ${g.bumper ? '<span class="pill bumper">★ Bumper</span>' : ''}
                ${g.kind === 'lose' ? '<span class="pill lose">No-win card</span>' : ''}
                ${!g.active ? '<span class="pill off">Paused</span>' : ''}${out ? '<span class="pill void">Out of stock</span>' : ''}
              </div>
              <div class="odds">${odds(g).toFixed(1)}% chance</div>
            </div>
            <div class="gift-body">
              <h4>${esc(g.name)}</h4>
              <p>${esc(g.description)}</p>
              ${g.stock_total != null ? `<div class="bar-track"><div class="bar-fill ${left / g.stock_total < .2 ? 'low' : ''}" style="width:${Math.max(0, left / g.stock_total * 100)}%"></div></div>` : ''}
              <div class="gift-meta">
                <span>${g.kind === 'lose' ? `${g.stock_used} shown` : left == null ? `Unlimited · ${g.stock_used} won` : `${left} of ${g.stock_total} left`}</span>
                <span>${g.kind === 'prize' ? `Valid ${g.valid_days} days` : ''}${g.redeemed ? ` · ${g.redeemed} redeemed` : ''}</span>
              </div>
            </div>
            <div class="gift-actions">
              <button class="btn sm" data-edit="${g.id}">Edit</button>
              <button class="btn sm" data-toggle="${g.id}">${g.active ? 'Pause' : 'Resume'}</button>
              <button class="btn sm danger" data-del="${g.id}">Delete</button>
            </div>
          </div>`;
        }).join('')}
        <button class="add-tile" id="addTile"><div><span>＋</span>Add a new gift</div></button>
      </div>`;

    $('#addGift').onclick = $('#addTile').onclick = () => giftForm(null, list);
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => giftForm(list.find(g => g.id == b.dataset.edit), list));
    view.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const g = list.find(x => x.id == b.dataset.toggle);
      await api('/gifts/' + g.id, { method: 'PUT', body: { ...g, active: !g.active } });
      toast(g.active ? 'Gift paused' : 'Gift is live again'); gifts();
    });
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const g = list.find(x => x.id == b.dataset.del);
      if (!confirm(`Delete "${g.name}"? Customers who already won it keep their reward.`)) return;
      await api('/gifts/' + g.id, { method: 'DELETE' }); toast('Gift deleted'); gifts();
    });
  }

  function giftForm(g, all) {
    const f = g ? { ...g } : { name: '', description: '', image: presets()[0], kind: 'prize', weight: 10, stock_total: 50, valid_days: 15, bumper: 0, active: 1 };
    const othersWeight = all.filter(x => x.id !== f.id && x.active && x.weight > 0 && (x.stock_total == null || x.stock_used < x.stock_total)).reduce((s, x) => s + x.weight, 0);
    const m = modal(`
      <h2>${g ? 'Edit gift' : 'Add a gift'}</h2>
      <p class="hint" style="margin:0">This is what customers see when they scratch the card.</p>
      <label class="label">Type</label>
      <div class="seg" id="kind"><button type="button" data-k="prize">🎁 Prize</button><button type="button" data-k="lose">🧁 Better luck next time</button></div>
      <label class="label">Gift name</label>
      <input class="input" id="gName" maxlength="80" placeholder="e.g. Free Black Forest Pastry" value="${esc(f.name)}">
      <label class="label">Short description <i>(shown after scratching)</i></label>
      <textarea class="input" id="gDesc" maxlength="240" rows="2" placeholder="e.g. One slice of our classic black forest — on us!">${esc(f.description)}</textarea>
      <label class="label">Picture</label>
      <div class="img-pick" id="imgPick">
        <button type="button" class="opt" data-img="">🎁</button>
        ${presets().map(p => `<button type="button" class="opt" data-img="${esc(p)}">${giftPic(p)}</button>`).join('')}
        <label class="upload">Upload<br>photo<input type="file" accept="image/*" hidden id="gFile"></label>
        <span id="customImg"></span>
      </div>
      <label class="label">Chance of winning</label>
      <div class="range-row"><input type="range" id="gWeight" min="0" max="100" value="${f.weight}"><b id="gOdds"></b></div>
      <p class="hint" id="gOddsHint"></p>
      <div class="grid2" id="prizeFields">
        <div><label class="label">Stock available <i>(blank = unlimited)</i></label>
          <input class="input" id="gStock" type="number" min="0" placeholder="Unlimited" value="${f.stock_total ?? ''}">
          ${g && g.stock_used ? `<p class="hint">${g.stock_used} already won</p>` : ''}</div>
        <div><label class="label">Reward valid for <i>(days after winning)</i></label>
          <input class="input" id="gDays" type="number" min="0" max="365" value="${f.valid_days}"></div>
      </div>
      <label class="switch" id="bumperRow"><input type="checkbox" id="gBumper" ${f.bumper ? 'checked' : ''}> Mark as ★ Bumper prize (special celebration on reveal)</label>
      <label class="switch"><input type="checkbox" id="gActive" ${f.active ? 'checked' : ''}> Live — can be won right now</label>
      <p class="err" id="gErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>
      <div class="modal-foot"><button class="btn" id="gCancel">Cancel</button><button class="btn primary" id="gSave">${g ? 'Save changes' : 'Add gift'}</button></div>
    `);
    const el = m.el;
    const setKind = k => {
      f.kind = k;
      el.querySelectorAll('#kind button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
      $('#prizeFields', el).style.display = $('#bumperRow', el).style.display = k === 'prize' ? '' : 'none';
    };
    const setImg = src => {
      f.image = src;
      el.querySelectorAll('#imgPick .opt').forEach(b => b.classList.toggle('on', b.dataset.img === src));
      const custom = src && !presets().includes(src);
      $('#customImg', el).innerHTML = custom ? `<button type="button" class="opt on"><img src="${esc(src)}" alt=""></button>` : '';
    };
    const odds = () => {
      const w = +$('#gWeight', el).value;
      const p = w + othersWeight ? w / (w + othersWeight) * 100 : 0;
      $('#gOdds', el).textContent = p.toFixed(1) + '%';
      $('#gOddsHint', el).textContent = w === 0 ? 'Weight 0 — this gift will never be picked.' : `About ${Math.max(1, Math.round(p))} in every 100 scratches will get this (while in stock).`;
    };
    el.querySelectorAll('#kind button').forEach(b => b.onclick = () => setKind(b.dataset.k));
    el.querySelectorAll('#imgPick .opt').forEach(b => b.onclick = () => setImg(b.dataset.img));
    $('#gWeight', el).oninput = odds;
    $('#gFile', el).onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const img = new Image();
      img.onload = () => {
        const s = 480, c = document.createElement('canvas');
        const r = Math.max(s / img.width, s / img.height);
        c.width = c.height = s;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, (s - img.width * r) / 2, (s - img.height * r) / 2, img.width * r, img.height * r);
        setImg(c.toDataURL('image/jpeg', .82));
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    };
    setKind(f.kind); setImg(f.image || ''); odds();
    $('#gCancel', el).onclick = m.close;
    $('#gSave', el).onclick = async () => {
      const body = {
        name: $('#gName', el).value, description: $('#gDesc', el).value, image: f.image, kind: f.kind,
        weight: $('#gWeight', el).value, stock_total: f.kind === 'lose' ? '' : $('#gStock', el).value,
        valid_days: $('#gDays', el).value, bumper: f.kind === 'prize' && $('#gBumper', el).checked, active: $('#gActive', el).checked,
      };
      try {
        await api(g ? '/gifts/' + g.id : '/gifts', { method: g ? 'PUT' : 'POST', body });
        m.close(); toast(g ? 'Gift updated' : 'Gift added 🎁'); gifts();
      } catch (e) { $('#gErr', el).textContent = e.message; }
    };
    setTimeout(() => $('#gName', el).focus(), 50);
  }

  // ---------------------------------------------------------------- coupons / batches
  const THEMES = { orange: ['Brand colours', 'linear-gradient(135deg,#FF9F45,#F47216,#C24508)'], chocolate: ['Rich Chocolate', 'linear-gradient(135deg,#6B2E14,#2A1007)'], festive: ['Festive Red', 'linear-gradient(135deg,#D21F3C,#6E0619)'] };
  let baseUrlCache = '', treatCache = '';

  async function coupons() {
    const [list, s, gifts] = await Promise.all([api('/batches'), api('/settings'), api('/gifts')]);
    baseUrlCache = s.public_url || s.detected_url;
    const pic = gifts.find(g => g.kind === 'prize' && g.image);
    treatCache = pic ? pic.image : 'emoji:🎁';
    const c = ME.tenant.color || '#F47216';
    THEMES.orange[1] = `linear-gradient(135deg,${shade(c, 0.25)},${c},${shade(c, -0.3)})`;
    const used = list.reduce((n, b) => n + b.count, 0);
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Coupons &amp; Print</h1><p>Create a batch of unique QR coupons, print them, and hand them to customers.</p></div>
        <button class="btn primary" id="newBatch">+ New coupon batch</button>
      </div>
      ${s.max_coupons != null ? `<div class="plan-note">Your plan: <b>${used} of ${s.max_coupons}</b> coupons used${s.plan_expires_on ? ` · renews ${fmtDate(s.plan_expires_on)}` : ''}.</div>` : ''}
      <div class="batches">
        ${list.length ? list.map(b => `
          <div class="batch">
            <div class="batch-prev">${renderCoupon({ code: 'DEMO1234', serial: 1, theme: b.theme, headline: b.headline, subline: b.subline, expires_on: b.expires_on, baseUrl: baseUrlCache, brand: ME.tenant, treat: treatCache })}</div>
            <div>
              <h4>${esc(b.name)} ${b.sample ? '<span class="pill bumper">Demo</span>' : ''}</h4>
              <div class="meta"><span>📍 ${esc(b.outlet_name || 'All outlets')}</span><span>${THEMES[b.theme][0]}</span><span>Created ${fmtDate(b.created_at)}</span><span>${b.expires_on ? 'Expires ' + fmtDate(b.expires_on) : 'No expiry'}</span></div>
              <div class="funnel">
                <div><b>${b.count}</b>Printed</div><div><b>${b.scanned || 0}</b>Scanned</div>
                <div><b>${b.claimed || 0}</b>Scratched</div><div><b>${b.redeemed || 0}</b>Redeemed</div>
                <div><b>${b.count - (b.claimed || 0) - (b.voided || 0)}</b>Unused</div>
              </div>
            </div>
            <div class="batch-actions">
              <a class="btn primary sm" href="/admin/print/${b.id}">🖨️ Print</a>
              <a class="btn sm" href="#batch/${b.id}">View coupons</a>
              <button class="btn sm danger" data-void="${b.id}">Void unused</button>
            </div>
          </div>`).join('') : '<div class="card empty-state"><span>🎟️</span>No batches yet. Create your first one!</div>'}
      </div>`;
    $('#newBatch').onclick = batchForm;
    view.querySelectorAll('[data-void]').forEach(b => b.onclick = async () => {
      if (!confirm('Void all unused coupons in this batch? Customers scanning them will see "Coupon cancelled".')) return;
      const r = await api(`/batches/${b.dataset.void}/void-unused`, { method: 'POST' });
      toast(`${r.voided} coupons voided`); coupons();
    });
  }

  async function batchForm() {
    const outlets = (await api('/outlets')).filter(o => o.active);
    const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const f = { theme: 'orange' };
    const m = modal(`
      <h2>New coupon batch</h2>
      <p class="hint" style="margin:0">Every coupon gets its own QR code and can be scratched only once.</p>
      <div class="create-grid">
        <div>
          <label class="label">Campaign name <i>(for you)</i></label>
          <input class="input" id="bName" placeholder="e.g. Christmas 2026 – Angamaly" maxlength="60">
          <div class="grid2">
            <div><label class="label">How many coupons?</label><input class="input" id="bCount" type="number" min="1" max="1000" value="48"><p class="hint" id="bSheets"></p></div>
            <div><label class="label">Scan before</label><input class="input" id="bExp" type="date" value="${in60}"></div>
          </div>
          <label class="label">Handed out at</label>
          <select class="input" id="bOutlet"><option value="">All outlets</option>${outlets.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
          <p class="hint">Pick an outlet to see its numbers separately on the dashboard.</p>
          <label class="label">Headline on coupon</label>
          <input class="input" id="bHead" maxlength="40" value="Scratch &amp; Win">
          <label class="label">Tagline</label>
          <input class="input" id="bSub" maxlength="80" value="A sweet surprise is waiting for you!">
          <label class="label">Design</label>
          <div class="themes">${Object.entries(THEMES).map(([k, [n, bg]]) => `<button type="button" data-t="${k}"><i style="background:${bg}"></i>${n}</button>`).join('')}</div>
        </div>
        <div>
          <label class="label">Live preview</label>
          <div class="preview-box"><div class="scaler" id="bPrev"></div></div>
          <p class="hint">Printed at 95 × 64 mm, 8 per A4 sheet with cut marks. Each coupon's QR opens <b>${esc(baseUrlCache)}</b>.</p>
        </div>
      </div>
      <p class="err" id="bErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>
      <div class="modal-foot"><button class="btn" id="bCancel">Cancel</button><button class="btn primary" id="bSave">Create &amp; open print sheet</button></div>
    `, { wide: true });
    const el = m.el;
    const preview = () => {
      el.querySelectorAll('.themes button').forEach(b => b.classList.toggle('on', b.dataset.t === f.theme));
      $('#bPrev', el).innerHTML = renderCoupon({ code: 'DEMO2KXP', serial: 1, theme: f.theme, headline: $('#bHead', el).value || 'Scratch & Win', subline: $('#bSub', el).value, expires_on: $('#bExp', el).value, baseUrl: baseUrlCache, brand: ME.tenant, treat: treatCache });
      fitPreview();
      const n = +$('#bCount', el).value || 0;
      $('#bSheets', el).textContent = n ? `${Math.ceil(n / 8)} A4 sheet${n > 8 ? 's' : ''}` : '';
    };
    // Shrink the real-size (95mm) coupon so it always fits the preview box on small screens.
    function fitPreview() {
      const box = $('.preview-box', el), sc = $('#bPrev', el), cp = sc && sc.firstElementChild;
      if (!cp) return;
      const w = cp.offsetWidth, h = cp.offsetHeight;
      const k = Math.min(1, (box.clientWidth - 36) / w);
      Object.assign(sc.style, { transform: `scale(${k})`, transformOrigin: 'top left', width: w + 'px', height: h + 'px', marginRight: (w * k - w) + 'px', marginBottom: (h * k - h) + 'px' });
    }
    window.addEventListener('resize', fitPreview);
    el.querySelectorAll('.themes button').forEach(b => b.onclick = () => { f.theme = b.dataset.t; preview(); });
    ['#bHead', '#bSub', '#bExp', '#bCount'].forEach(s => $(s, el).oninput = preview);
    preview();
    $('#bCancel', el).onclick = m.close;
    $('#bSave', el).onclick = async () => {
      const btn = $('#bSave', el); btn.disabled = true;
      try {
        const r = await api('/batches', { method: 'POST', body: { name: $('#bName', el).value, count: $('#bCount', el).value, expires_on: $('#bExp', el).value, headline: $('#bHead', el).value, subline: $('#bSub', el).value, theme: f.theme, outlet_id: $('#bOutlet', el).value } });
        m.close(); toast('Batch created ✨');
        location.href = "/admin/print/" + r.id;
        coupons();
      } catch (e) { $('#bErr', el).textContent = e.message; btn.disabled = false; }
    };
    setTimeout(() => $('#bName', el).focus(), 50);
  }

  async function batch(id) {
    const { batch: b, coupons: list, public_url } = await api('/batches/' + id);
    let filter = 'all';
    const draw = () => {
      const rows = list.filter(c => filter === 'all' || c.status === filter);
      $('#rows').innerHTML = rows.map(c => `
        <tr>
          <td data-label="No." class="mono">${String(c.serial).padStart(4, '0')}</td>
          <td data-label="Code" class="mono">${fmtCode(c.code)}</td>
          <td data-label="Status"><span class="pill ${c.status}">${c.status}</span></td>
          <td data-label="Scans">${c.scans}</td>
          <td data-label="Customer">${c.customer_name ? `${esc(c.customer_name)}<small>${fmtPhone(c.phone)}</small>` : '—'}</td>
          <td data-label="Gift">${c.gift_name ? (c.gift_kind === 'prize' ? '🎁 ' : '') + esc(c.gift_name) : '—'}</td>
          <td data-label="" class="td-actions">
            <a class="btn sm" href="${public_url}/c/${c.code}" target="_blank" title="Open the customer page for this coupon">Open ↗</a>
            ${c.status === 'new' ? `<button class="btn sm danger" data-v="${c.id}">Void</button>` : ''}
          </td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty-state">Nothing here</td></tr>';
      view.querySelectorAll('[data-v]').forEach(btn => btn.onclick = async () => {
        await api(`/coupons/${btn.dataset.v}/void`, { method: 'POST' });
        list.find(c => c.id == btn.dataset.v).status = 'void'; draw(); toast('Coupon voided');
      });
    };
    view.innerHTML = `
      <div class="page-head">
        <div><a href="#coupons" style="font-size:13px">← All batches</a><h1>${esc(b.name)}</h1><p>${b.count} coupons · ${THEMES[b.theme][0]} · ${b.expires_on ? 'expires ' + fmtDate(b.expires_on) : 'no expiry'}</p></div>
        <a class="btn primary" href="/admin/print/${b.id}">🖨️ Print sheet</a>
      </div>
      <div class="toolbar"><div class="seg" id="flt" style="max-width:520px">
        ${['all', 'new', 'claimed', 'redeemed', 'void'].map(s => `<button data-f="${s}" class="${s === 'all' ? 'on' : ''}">${s === 'new' ? 'Unused' : s[0].toUpperCase() + s.slice(1)} (${s === 'all' ? list.length : list.filter(c => c.status === s).length})</button>`).join('')}
      </div></div>
      <div class="table-wrap"><table class="rtable">
        <thead><tr><th>No.</th><th>Code</th><th>Status</th><th>Scans</th><th>Customer</th><th>Gift</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>`;
    view.querySelectorAll('#flt button').forEach(btn => btn.onclick = () => {
      filter = btn.dataset.f; view.querySelectorAll('#flt button').forEach(x => x.classList.toggle('on', x === btn)); draw();
    });
    draw();
  }

  // ---------------------------------------------------------------- customers
  async function customers() {
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Customers</h1><p>Everyone who scanned and scratched — with their details and what they won.</p></div>
        <a class="btn" href="/api/admin/customers.csv">⬇ Export to Excel (CSV)</a>
      </div>
      <div class="toolbar"><input class="input" id="q" placeholder="Search name, phone, area or code…"></div>
      <div class="table-wrap"><table class="rtable">
        <thead><tr><th>When</th><th>Customer</th><th>Area</th><th>Birthday</th><th>Gift won</th><th>Reward code</th><th>Status</th></tr></thead>
        <tbody id="rows"><tr><td colspan="7" class="empty-state">Loading…</td></tr></tbody>
      </table></div>`;
    let t;
    const load = async () => {
      const rows = await api('/customers?q=' + encodeURIComponent($('#q').value));
      $('#rows').innerHTML = rows.map(r => {
        const expired = r.reward_expires && r.reward_expires < new Date().toISOString().slice(0, 10) && r.status === 'claimed';
        const msg = r.gift_kind === 'prize'
          ? `Hi ${r.customer_name.split(' ')[0]}! 🎉 Thanks for playing ${ME.tenant.name} Scratch & Win. Your reward *${r.gift_name}* (code ${r.reward_code}) is waiting for you — valid till ${fmtDate(r.reward_expires)}. See you at ${ME.tenant.name}!`
          : `Hi ${r.customer_name.split(' ')[0]}! Thanks for playing ${ME.tenant.name} Scratch & Win 🍰 Here's a little something for your next visit…`;
        return `<tr>
          <td data-label="When" style="white-space:nowrap">${fmtTime(r.claimed_at)}</td>
          <td data-label="Customer"><b>${esc(r.customer_name)}</b><small>${fmtPhone(r.phone)} <a class="wa-link" href="https://wa.me/91${r.phone}?text=${encodeURIComponent(msg)}" target="_blank" title="Message on WhatsApp">${WA_ICON}</a>${r.consent ? '' : ' · no offers'}</small></td>
          <td data-label="Area">${esc(r.area || '—')}</td>
          <td data-label="Birthday">${r.dob ? fmtDate(r.dob).replace(/ \d{4}$/, '') : '—'}</td>
          <td data-label="Gift won">${r.gift_kind === 'prize' ? '🎁 ' + esc(r.gift_name) : '<span style="color:var(--muted)">Better luck next time</span>'}<small>${esc(r.campaign)}${r.outlet ? ' · ' + esc(r.outlet) : ''}</small></td>
          <td data-label="Reward code" class="mono">${r.reward_code || '—'}${r.reward_expires ? `<small>till ${fmtDate(r.reward_expires)}</small>` : ''}</td>
          <td data-label="Status">${r.gift_kind === 'prize' ? `<span class="pill ${expired ? 'expired' : r.status}">${expired ? 'expired' : r.status === 'claimed' ? 'to redeem' : r.status}</span>` : '<span class="pill lose">—</span>'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" class="empty-state"><span>🙋</span>No customers yet</td></tr>';
    };
    $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    load();
  }

  // ---------------------------------------------------------------- redeem
  async function redeem(prefill) {
    // Counter staff always redeem at their own outlet; owners and managers choose (remembered on this device).
    const fixed = ME.role === 'counter' && ME.user.outlet;
    const outlets = fixed ? [] : (await api('/outlets')).filter(o => o.active);
    let saved = ''; try { saved = localStorage.getItem('gd-outlet-' + ME.tenant.slug) || ''; } catch {}
    if (!outlets.some(o => String(o.id) === saved)) saved = outlets[0] ? String(outlets[0].id) : '';
    view.innerHTML = `
      <div class="page-head"><div><h1>Redeem at counter</h1><p>Scan the QR on the customer's phone, or type their reward code.</p></div></div>
      <div class="redeem">
        <div class="card">
          ${fixed ? `<div class="plan-note">📍 Redeeming at <b>${esc(ME.user.outlet.name)}</b></div>`
            : outlets.length > 1 ? `<label class="label" style="margin-top:0">Redeeming at</label>
              <select class="input" id="rOutlet" style="margin-bottom:14px">${outlets.map(o => `<option value="${o.id}" ${String(o.id) === saved ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>` : ''}
          <form class="big-input" id="lookForm"><input class="input" id="code" placeholder="NB······" autocomplete="off"><button class="btn primary" style="height:54px">Check</button></form>
          <button class="btn block" id="camBtn" style="margin-top:12px">📷 Scan with camera</button>
          <div id="reader"></div>
          <p class="hint">Works with the reward QR on the customer's phone or the coupon code itself.</p>
        </div>
        <div class="card" id="rOut"><div class="empty-state"><span>🎁</span>The reward details will appear here.</div></div>
      </div>`;
    const lookup = async (code, justRedeemed) => {
      const out = $('#rOut');
      out.innerHTML = '<div class="empty-state">Checking…</div>';
      try {
        const c = await api('/lookup/' + encodeURIComponent(code));
        const win = c.gift_kind === 'prize';
        // Banner = the one thing staff must read: OK to give, or STOP.
        let banner;
        if (c.status === 'new') banner = ['stop', '⛔', 'Not scratched yet', 'This coupon has not been played. There is no reward to give.'];
        else if (c.status === 'void') banner = ['stop', '⛔', 'Coupon cancelled', 'This coupon was voided. Do not give any gift.'];
        else if (!win) banner = ['stop', '⛔', 'No prize on this coupon', 'The customer got "Better luck next time".'];
        else if (c.status === 'redeemed' && justRedeemed) banner = ['done', '✅', 'Gift handed over', `Marked as redeemed at ${fmtTime(c.redeemed_at)}. You're all set.`];
        else if (c.status === 'redeemed') banner = ['stop', '⚠️', 'Already used — do not give again', `This reward was already redeemed on ${fmtTime(c.redeemed_at)}.`];
        else if (c.expired) banner = ['stop', '⏰', 'Reward expired', `It was valid till ${fmtDate(c.reward_expires)}.`];
        else banner = ['ok', '✅', 'Valid — OK to give', 'Check the name and mobile number with the customer, then hand over.'];
        if (banner[0] === 'stop' && navigator.vibrate) navigator.vibrate([120, 60, 120]);
        out.innerHTML = `<div class="rcard">
          <div class="rbanner ${banner[0]}"><span>${banner[1]}</span><div><b>${banner[2]}</b><small>${esc(banner[3])}</small></div></div>
          <div class="rimg">${giftPic(c.gift_image, win ? '🎁' : '🎟️')}</div>
          <h2>${esc(c.gift_name || 'Unscratched coupon')}</h2>
          <dl>
            <dt>Customer</dt><dd>${esc(c.customer_name || '—')}</dd>
            <dt>Mobile</dt><dd>${c.phone ? fmtPhone(c.phone) : '—'}</dd>
            <dt>Reward code</dt><dd class="mono">${c.reward_code || '—'}</dd>
            <dt>Coupon</dt><dd class="mono">${fmtCode(c.code)} <small style="font-weight:400;color:var(--muted)">· ${esc(c.campaign)}</small></dd>
            <dt>Won on</dt><dd>${fmtTime(c.claimed_at)}</dd>
            <dt>Valid till</dt><dd>${fmtDate(c.reward_expires)}</dd>
            ${c.redeemed_at ? `<dt>Redeemed</dt><dd>${fmtTime(c.redeemed_at)}${c.redeemed_outlet ? ' · ' + esc(c.redeemed_outlet) : ''}${c.redeemed_by ? `<small style="display:block;font-weight:400;color:var(--muted)">by ${esc(c.redeemed_by)}</small>` : ''}</dd>` : ''}
          </dl>
          ${win && c.status === 'claimed' && !c.expired ? `<button class="btn primary block" id="doRedeem">Hand over gift &amp; mark redeemed</button>` : ''}
        </div>`;
        const btn = $('#doRedeem');
        if (btn) btn.onclick = async () => {
          btn.disabled = true;
          const sel = $('#rOutlet');
          try { await api('/redeem/' + c.id, { method: 'POST', body: { outlet_id: sel ? sel.value : (outlets[0] ? outlets[0].id : '') } }); toast('Redeemed ✓ Enjoy!'); lookup(c.reward_code, true); }
          catch (e) { toast(e.message); btn.disabled = false; }
        };
      } catch (e) {
        out.innerHTML = `<div class="empty-state"><span>🤔</span>${esc(e.message)}</div>`;
      }
    };
    const sel = $('#rOutlet');
    if (sel) sel.onchange = () => { try { localStorage.setItem('gd-outlet-' + ME.tenant.slug, sel.value); } catch {} };
    $('#lookForm').onsubmit = e => { e.preventDefault(); const v = $('#code').value.trim(); if (v) lookup(v); };
    $('#camBtn').onclick = async () => {
      if (scanner) { await scanner.stop().catch(() => {}); scanner = null; $('#camBtn').textContent = '📷 Scan with camera'; $('#reader').innerHTML = ''; return; }
      if (!window.Html5Qrcode) return toast('Camera scanner could not load');
      scanner = new Html5Qrcode('reader');
      $('#camBtn').textContent = 'Stop camera';
      try {
        await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, async text => {
          await scanner.stop().catch(() => {}); scanner = null;
          $('#camBtn').textContent = '📷 Scan again'; $('#reader').innerHTML = '';
          if (navigator.vibrate) navigator.vibrate(60);
          $('#code').value = text.replace(/^(NAVYA-)?REWARD:/i, '');
          lookup(text);
        });
      } catch (e) {
        scanner = null; $('#camBtn').textContent = '📷 Scan with camera';
        toast('Camera not available — type the code instead');
      }
    };
    if (prefill) { $('#code').value = prefill; lookup(prefill); } else $('#code').focus();
  }

  // ---------------------------------------------------------------- outlets
  async function outlets() {
    const list = await api('/outlets');
    const owner = ME.role === 'owner';
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Outlets</h1><p>Your shops and branches. Coupons and redemptions are counted per outlet.</p></div>
        ${owner ? '<button class="btn primary" id="addOutlet">+ Add outlet</button>' : ''}
      </div>
      <div class="table-wrap"><table class="rtable">
        <thead><tr><th>Outlet</th><th>Phone</th><th>Coupons handed out</th><th>Scratched</th><th>Redeemed here</th><th></th></tr></thead>
        <tbody>${list.map(o => `<tr>
          <td data-label="Outlet"><b>${esc(o.name)}</b> ${o.active ? '' : '<span class="pill off">Closed</span>'}<small>${esc(o.address || '—')}</small></td>
          <td data-label="Phone">${esc(o.phone || '—')}</td>
          <td data-label="Handed out">${o.issued}</td>
          <td data-label="Scratched">${o.claimed}</td>
          <td data-label="Redeemed here">${o.redeemed}</td>
          <td data-label="" class="td-actions">${owner ? `<button class="btn sm" data-edit="${o.id}">Edit</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    if (!owner) return;
    $('#addOutlet').onclick = () => outletForm(null);
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => outletForm(list.find(o => o.id === +b.dataset.edit)));
  }
  function outletForm(o) {
    const f = o || { name: '', address: '', phone: '', maps_url: '', active: 1 };
    const m = modal(`<h2>${o ? 'Edit outlet' : 'Add an outlet'}</h2>
      <label class="label">Name</label><input class="input" id="oName" maxlength="80" value="${esc(f.name)}" placeholder="e.g. Kakkanad branch">
      <label class="label">Address</label><input class="input" id="oAddr" maxlength="200" value="${esc(f.address)}">
      <div class="grid2">
        <div><label class="label">Phone</label><input class="input" id="oPhone" value="${esc(f.phone)}" inputmode="tel"></div>
        <div><label class="label">Google Maps link <i>(optional)</i></label><input class="input" id="oMaps" value="${esc(f.maps_url)}"></div>
      </div>
      ${o ? `<label class="switch"><input type="checkbox" id="oActive" ${f.active ? 'checked' : ''}> Open (untick if this outlet has closed)</label>` : ''}
      <p class="err" id="oErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>
      <div class="modal-foot"><button class="btn" id="oCancel">Cancel</button><button class="btn primary" id="oSave">${o ? 'Save' : 'Add outlet'}</button></div>`);
    const el = m.el;
    $('#oCancel', el).onclick = m.close;
    $('#oSave', el).onclick = async () => {
      const body = { name: $('#oName', el).value, address: $('#oAddr', el).value, phone: $('#oPhone', el).value, maps_url: $('#oMaps', el).value, active: o ? $('#oActive', el).checked : true };
      try { await api(o ? '/outlets/' + o.id : '/outlets', { method: o ? 'PUT' : 'POST', body }); m.close(); toast(o ? 'Outlet saved' : 'Outlet added'); outlets(); }
      catch (e) { $('#oErr', el).textContent = e.message; }
    };
    setTimeout(() => $('#oName', el).focus(), 50);
  }

  // ---------------------------------------------------------------- team (staff logins)
  const genPassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const a = new Uint32Array(12); crypto.getRandomValues(a);
    return Array.from(a, n => chars[n % chars.length]).join('');
  };
  async function team() {
    const [list, outs] = await Promise.all([api('/staff'), api('/outlets')]);
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Team</h1><p>Logins for your staff. You (the owner) sign in with <b>${esc(ME.tenant.slug)}</b>.</p></div>
        <button class="btn primary" id="addStaff">+ Add staff login</button>
      </div>
      <div class="card" style="margin-bottom:14px"><p class="hint" style="margin:0">
        <span class="role-pill manager">Manager</span> can run gifts, coupons, customers and redemption, but not settings, team or the activity log.
        &nbsp; <span class="role-pill counter">Counter</span> can only check and redeem rewards, at one outlet.</p></div>
      <div class="table-wrap"><table class="rtable">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Outlet</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${list.map(s => `<tr>
          <td data-label="Name"><b>${esc(s.name)}</b> ${s.active ? '' : '<span class="pill off">Switched off</span>'}</td>
          <td data-label="Username" class="mono">${esc(s.username)}</td>
          <td data-label="Role"><span class="role-pill ${s.role}">${s.role === 'manager' ? 'Manager' : 'Counter'}</span></td>
          <td data-label="Outlet">${esc(s.outlet_name || 'All outlets')}</td>
          <td data-label="Last sign-in">${s.last_login_at ? fmtTime(s.last_login_at) : 'Never'}</td>
          <td data-label="" class="td-actions">
            <button class="btn sm" data-edit="${s.id}">Edit</button>
            <button class="btn sm" data-pw="${s.id}">Reset password</button>
            <button class="btn sm" data-toggle="${s.id}">${s.active ? 'Switch off' : 'Switch on'}</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty-state"><span>👥</span>No staff logins yet</td></tr>'}</tbody>
      </table></div>`;
    $('#addStaff').onclick = () => staffForm(null, outs);
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => staffForm(list.find(s => s.id === +b.dataset.edit), outs));
    view.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const s = list.find(x => x.id === +b.dataset.toggle);
      if (s.active && !confirm(`Switch off ${s.name}'s login? They will be signed out straight away.`)) return;
      try { await api('/staff/' + s.id, { method: 'PUT', body: { active: !s.active } }); toast(s.active ? 'Login switched off' : 'Login switched on'); team(); } catch (e) { toast(e.message); }
    });
    view.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => {
      const s = list.find(x => x.id === +b.dataset.pw);
      const m = modal(`<h2>Reset password</h2><p class="hint" style="margin:0">${esc(s.name)} (<b>${esc(s.username)}</b>) will be signed out everywhere.</p>
        <label class="label">New password</label><div class="big-input" style="gap:8px"><input class="input" id="sp" value="${genPassword()}" style="height:44px;font-size:15px;text-transform:none;letter-spacing:.5px"><button class="btn" id="spGen" type="button">New</button></div>
        <div class="modal-foot"><button class="btn" id="spCancel">Cancel</button><button class="btn primary" id="spSave">Set password</button></div>`);
      $('#spGen', m.el).onclick = () => { $('#sp', m.el).value = genPassword(); };
      $('#spCancel', m.el).onclick = m.close;
      $('#spSave', m.el).onclick = async () => {
        try { const r = await api(`/staff/${s.id}/password`, { method: 'POST', body: { password: $('#sp', m.el).value } }); showStaffCredentials(m, s.name, s.username, r.password); }
        catch (e) { toast(e.message); }
      };
    });
  }
  function showStaffCredentials(m, name, username, password) {
    const text = `${ME.tenant.name} – staff login\nLogin: ${location.origin}/admin\nUsername: ${username}\nPassword: ${password}`;
    m.el.innerHTML = `<h2>Login ready</h2><p class="hint" style="margin:0">Give these details to ${esc(name)}. The password is shown only now.</p>
      <div class="plan-note" style="margin-top:14px;line-height:1.8">Login: <b>${esc(location.origin)}/admin</b><br>Username: <b>${esc(username)}</b><br>Password: <b class="mono">${esc(password)}</b></div>
      <div class="modal-foot"><button class="btn" id="cpy">Copy details</button><button class="btn primary" id="done">Done</button></div>`;
    $('#cpy', m.el).onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy not allowed — select the text instead'); } };
    $('#done', m.el).onclick = () => { m.close(); team(); };
  }
  function staffForm(s, outs) {
    const f = s || { name: '', username: '', role: 'counter', outlet_id: outs[0] ? outs[0].id : '' };
    const m = modal(`<h2>${s ? 'Edit staff login' : 'Add a staff login'}</h2>
      <div class="grid2">
        <div><label class="label">Name</label><input class="input" id="sName" maxlength="80" value="${esc(f.name)}" placeholder="e.g. Ravi"></div>
        <div><label class="label">Username</label><input class="input" id="sUser" maxlength="40" value="${esc(f.username)}" ${s ? 'disabled' : ''} placeholder="${esc(ME.tenant.slug)}.ravi" autocapitalize="none" spellcheck="false"></div>
      </div>
      <label class="label">What can they do?</label>
      <div class="seg" id="sRole"><button type="button" data-r="counter">Counter: redeem only</button><button type="button" data-r="manager">Manager</button></div>
      <label class="label">Outlet</label>
      <select class="input" id="sOutlet"><option value="">All outlets (managers only)</option>${outs.filter(o => o.active).map(o => `<option value="${o.id}" ${String(o.id) === String(f.outlet_id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
      ${s ? '' : `<label class="label">Password</label><div class="big-input" style="gap:8px"><input class="input" id="sPw" value="${genPassword()}" style="height:44px;font-size:15px;text-transform:none;letter-spacing:.5px"><button class="btn" id="sGen" type="button">New</button></div>`}
      <p class="err" id="sErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>
      <div class="modal-foot">${s ? '<button class="btn danger" id="sDel" style="margin-right:auto">Delete</button>' : ''}<button class="btn" id="sCancel">Cancel</button><button class="btn primary" id="sSave">${s ? 'Save' : 'Create login'}</button></div>`);
    const el = m.el;
    let role = f.role;
    const setRole = r => { role = r; el.querySelectorAll('#sRole button').forEach(b => b.classList.toggle('on', b.dataset.r === r)); };
    el.querySelectorAll('#sRole button').forEach(b => b.onclick = () => setRole(b.dataset.r));
    setRole(role);
    if (!s) {
      let touched = false;
      $('#sUser', el).oninput = () => { touched = true; };
      $('#sName', el).oninput = () => { if (!touched) $('#sUser', el).value = `${ME.tenant.slug}.${$('#sName', el).value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)}`; };
      $('#sGen', el).onclick = () => { $('#sPw', el).value = genPassword(); };
    }
    $('#sCancel', el).onclick = m.close;
    const del = $('#sDel', el);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete ${s.name}'s login for good?`)) return;
      try { await api('/staff/' + s.id, { method: 'DELETE' }); m.close(); toast('Login deleted'); team(); } catch (e) { toast(e.message); }
    };
    $('#sSave', el).onclick = async () => {
      const body = { name: $('#sName', el).value, role, outlet_id: $('#sOutlet', el).value };
      try {
        if (s) { await api('/staff/' + s.id, { method: 'PUT', body }); m.close(); toast('Saved'); team(); }
        else {
          const r = await api('/staff', { method: 'POST', body: { ...body, username: $('#sUser', el).value, password: $('#sPw', el).value } });
          showStaffCredentials(m, body.name, $('#sUser', el).value.trim().toLowerCase(), r.password);
        }
      } catch (e) { $('#sErr', el).textContent = e.message; }
    };
    setTimeout(() => $('#sName', el).focus(), 50);
  }

  // ---------------------------------------------------------------- activity log
  async function activity() {
    view.innerHTML = `
      <div class="page-head"><div><h1>Activity log</h1><p>Everything that happened in your account: who did it and when. Entries can't be edited or deleted.</p></div></div>
      <div class="card"><div id="actList"></div><div style="text-align:center;margin-top:12px"><button class="btn" id="actMore" hidden>Show older</button></div></div>`;
    let before = '';
    const more = async () => {
      const rows = await api('/activity' + (before ? '?before=' + before : ''));
      $('#actList').insertAdjacentHTML('beforeend', rows.map(e => activityRow(e)).join('') || (before ? '' : '<div class="empty-state"><span>🛡️</span>Nothing yet</div>'));
      if (rows.length) before = rows[rows.length - 1].id;
      $('#actMore').hidden = rows.length < 60;
    };
    $('#actMore').onclick = more;
    await more();
  }

  // ---------------------------------------------------------------- settings
  // Shrinks an uploaded logo to fit 480×200 (keeps transparency) and returns a data URI.
  function readLogo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 480 / img.width, 200 / img.height);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        let out = c.toDataURL('image/webp', 0.9);
        if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');
        resolve(out);
      };
      img.onerror = () => reject(new Error('That file is not an image'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function settings() {
    const s = await api('/settings');
    let logo = s.logo || '';
    view.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p>Your shop's details, branding, coupon rules and password.</p></div></div>
      <div class="dash">
        <div class="stack">
          <div class="card">
            <h3>Shop profile &amp; branding</h3>
            <p class="hint" style="margin-top:-6px">Shown on the customer's phone and on printed coupons.</p>
            <label class="label">Logo</label>
            <div class="logo-pick">
              <div class="logo-box" id="logoBox"></div>
              <label class="btn sm">Upload logo<input type="file" accept="image/*" hidden id="logoFile"></label>
              <button class="btn sm danger" id="logoClear" type="button">Remove</button>
            </div>
            <p class="hint">PNG or SVG with a transparent background looks best.</p>
            <div class="grid2">
              <div><label class="label">Shop name</label><input class="input" id="sName" maxlength="80" value="${esc(s.name)}"></div>
              <div><label class="label">Tagline</label><input class="input" id="sTag" maxlength="120" placeholder="e.g. The Tempting Taste" value="${esc(s.tagline)}"></div>
            </div>
            <div class="grid2">
              <div><label class="label">Main colour</label><div class="color-row"><input type="color" id="sColor" value="${esc(s.color)}"><input class="input" id="sColorT" value="${esc(s.color)}" maxlength="7"></div></div>
              <div><label class="label">Dark accent colour</label><div class="color-row"><input type="color" id="sColor2" value="${esc(s.color2)}"><input class="input" id="sColor2T" value="${esc(s.color2)}" maxlength="7"></div></div>
            </div>
            <label class="label">Address</label>
            <input class="input" id="sAddr" maxlength="200" placeholder="e.g. Central Junction, Angamaly" value="${esc(s.address)}">
            <div class="grid2">
              <div><label class="label">Google Maps link <i>(optional)</i></label><input class="input" id="sMaps" placeholder="Made from the address if blank" value="${esc(s.maps_url)}"></div>
              <div><label class="label">Website <i>(optional)</i></label><input class="input" id="sWeb" placeholder="https://" value="${esc(s.website)}"></div>
            </div>
            <div class="grid2">
              <div><label class="label">WhatsApp number</label><input class="input" id="sWa" placeholder="91XXXXXXXXXX" value="${esc(s.whatsapp)}"></div>
              <div><label class="label">Footer line <i>(optional)</i></label><input class="input" id="sFoot" maxlength="120" placeholder="e.g. Since 1984 · 100% natural" value="${esc(s.footer)}"></div>
            </div>
            <label class="label">Areas suggested on the customer form <i>(comma separated)</i></label>
            <input class="input" id="sAreas" placeholder="e.g. Angamaly, Kalady, Aluva" value="${esc(s.areas)}">
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <h3>Coupon rules</h3>
            <label class="label">Website address printed in QR codes</label>
            <input class="input" id="sUrl" placeholder="${esc(s.detected_url)}" value="${esc(s.public_url)}">
            <p class="hint">Leave blank to use <b>${esc(s.detected_url)}</b>. Set this before printing real coupons if you have your own web address.</p>
            <label class="switch"><input type="checkbox" id="sOne" ${s.one_per_phone ? 'checked' : ''}> Allow only one win per mobile number in each campaign</label>
            <label class="label">Terms shown to customers</label>
            <textarea class="input" id="sTerms" rows="3">${esc(s.terms)}</textarea>
          </div>
          <div class="card">
            <h3>Your plan</h3>
            <p class="hint" style="margin-top:0">Username: <b>${esc(s.slug)}</b><br>
              Coupons: <b>${s.coupons_used}${s.max_coupons != null ? ' of ' + s.max_coupons : ''}</b> used${s.max_coupons == null ? ' (no limit)' : ''}<br>
              ${s.plan_expires_on ? `Active till <b>${fmtDate(s.plan_expires_on)}</b>` : 'No expiry date'}</p>
          </div>
          <div class="card">
            <h3>Change password</h3>
            ${ME.impersonated ? '<p class="hint" style="margin:0">You are viewing as the Super Admin. Reset this merchant&#39;s password from the Super Admin page.</p>' : `
            <input class="input" type="password" id="sPwOld" placeholder="Current password" autocomplete="current-password">
            <input class="input" type="password" id="sPw" placeholder="New password (min 8 characters)" autocomplete="new-password" style="margin-top:10px">
            <div class="modal-foot"><button class="btn dark" id="sPwSave">Change password</button></div>`}
          </div>
          ${s.has_sample ? `<div class="card">
            <h3>Demo data</h3>
            <p class="hint" style="margin-top:0">The sample batch and its made-up customers were added so the dashboard isn't empty. Remove them before going live.</p>
            <div class="modal-foot"><button class="btn danger" id="sClear">Remove demo batch &amp; customers</button></div>
          </div>` : ''}
        </div>
      </div>
      <div class="modal-foot" style="position:sticky;bottom:12px"><button class="btn primary" id="sSave" style="min-width:200px;height:48px">Save settings</button></div>`;

    const drawLogo = () => { $('#logoBox').innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : 'No logo<br>(name is shown)'; };
    drawLogo();
    $('#logoFile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try { logo = await readLogo(f); drawLogo(); toast('Logo ready — remember to save'); } catch (err) { toast(err.message); }
    };
    $('#logoClear').onclick = () => { logo = ''; drawLogo(); };
    for (const [pick, text] of [['#sColor', '#sColorT'], ['#sColor2', '#sColor2T']]) {
      $(pick).oninput = () => { $(text).value = $(pick).value; };
      $(text).oninput = () => { if (/^#[0-9a-f]{6}$/i.test($(text).value)) $(pick).value = $(text).value; };
    }
    $('#sSave').onclick = async () => {
      try {
        await api('/settings', { method: 'PUT', body: {
          name: $('#sName').value, tagline: $('#sTag').value, logo, color: $('#sColorT').value, color2: $('#sColor2T').value,
          address: $('#sAddr').value, maps_url: $('#sMaps').value, website: $('#sWeb').value, whatsapp: $('#sWa').value,
          footer: $('#sFoot').value, areas: $('#sAreas').value, public_url: $('#sUrl').value.trim(),
          one_per_phone: $('#sOne').checked, terms: $('#sTerms').value,
        } });
        ME = await (await fetch('/api/admin/me')).json();
        applyBrand(ME.tenant);
        toast('Settings saved');
      } catch (e) { toast(e.message); }
    };
    const pw = $('#sPwSave');
    if (pw) pw.onclick = async () => {
      try {
        await api('/password', { method: 'PUT', body: { current: $('#sPwOld').value, password: $('#sPw').value } });
        $('#sPwOld').value = $('#sPw').value = '';
        toast('Password changed — other devices have been signed out');
      } catch (e) { toast(e.message); }
    };
    const clr = $('#sClear');
    if (clr) clr.onclick = async () => {
      if (!confirm('Remove the demo batch and all its sample customers?')) return;
      await api('/clear-sample', { method: 'POST' }); toast('Demo data removed'); settings();
    };
  }

  // ---------------------------------------------------------------- boot
  if (location.hostname === 'genuinedraw.in') location.replace('/find-shop'); // merchants sign in on their own subdomain
  else showShell();
})();
