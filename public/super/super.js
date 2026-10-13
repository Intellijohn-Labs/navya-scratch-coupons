(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toDate = s => s ? new Date(s.length > 10 ? s.replace(' ', 'T') + 'Z' : s + 'T00:00:00') : null;
  const fmtDate = s => s ? toDate(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const ago = s => {
    if (!s) return 'never';
    const m = Math.round((Date.now() - toDate(s)) / 60000);
    if (m < 60) return m <= 1 ? 'just now' : m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  };
  const initials = n => (n || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);
  const genPassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const a = new Uint32Array(12); crypto.getRandomValues(a);
    return Array.from(a, n => chars[n % chars.length]).join('');
  };

  async function api(path, opts = {}) {
    const r = await fetch('/api/super' + path, {
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
    setTimeout(() => t.remove(), 2800);
  }
  function modal(html, { wide } = {}) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
    const back = root.firstElementChild;
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    function close() { root.innerHTML = ''; }
    return { el: back.firstElementChild, close };
  }
  const logoHtml = t => t.logo ? `<img src="${esc(t.logo)}" alt="">` : esc(initials(t.name));
  const statusOf = t => t.status === 'suspended' ? 'suspended' : (t.plan_expires_on && t.plan_expires_on < new Date().toISOString().slice(0, 10) ? 'expired' : 'active');
  const STATUS_LABEL = { active: 'Active', suspended: 'Suspended', expired: 'Plan expired' };

  // Shrinks an uploaded logo to fit 480×200 (keeps transparency).
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

  // ---------------------------------------------------------------- auth
  function showLogin() { $('#login').classList.remove('hidden'); $('#shell').classList.add('hidden'); }
  function showShell() { $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden'); route(); }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await fetch('/api/super/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.password.value }) });
    if (r.ok) { e.target.reset(); showShell(); } else $('#loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Could not sign in';
  });
  $('#logout').onclick = async () => { await fetch('/api/super/logout', { method: 'POST' }); showLogin(); };

  // ---------------------------------------------------------------- router
  async function route() {
    const name = location.hash.slice(1) || 'bakeries';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
    view.innerHTML = '<div class="empty-state">Loading…</div>';
    try { await (name === 'account' ? account : bakeries)(); }
    catch (e) { if (e.message !== 'Please log in') view.innerHTML = `<div class="empty-state"><span>⚠️</span>${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- bakeries
  async function bakeries() {
    const { tenants } = await api('/overview');
    const sum = k => tenants.reduce((n, t) => n + (t[k] || 0), 0);
    const active = tenants.filter(t => statusOf(t) === 'active').length;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Bakeries</h1><p>Every bakery using your Scratch &amp; Win platform.</p></div>
        <button class="btn primary" id="addBk">+ Add bakery</button>
      </div>
      <div class="kpis">
        <div class="kpi hero"><span>Bakeries</span><b>${tenants.length}</b><small>${active} active</small></div>
        <div class="kpi"><span>Coupons printed</span><b>${sum('printed')}</b><small>all bakeries</small></div>
        <div class="kpi"><span>Scratched</span><b>${sum('claimed')}</b><small>${sum('claims_30d')} in last 30 days</small></div>
        <div class="kpi"><span>Redeemed</span><b>${sum('redeemed')}</b><small>gifts handed over</small></div>
        <div class="kpi"><span>Customers</span><b>${sum('customers')}</b><small>unique mobiles per bakery</small></div>
        <div class="kpi"><span>Need attention</span><b>${tenants.length - active}</b><small>suspended or expired</small></div>
      </div>
      <div class="toolbar"><input class="input" id="q" placeholder="Search bakery, username or contact…"></div>
      <div class="bk-list" id="bkList"></div>`;
    const draw = () => {
      const s = $('#q').value.trim().toLowerCase();
      const list = tenants.filter(t => !s || [t.name, t.slug, t.contact_name, t.contact_phone].join(' ').toLowerCase().includes(s));
      $('#bkList').innerHTML = list.map(t => {
        const st = statusOf(t);
        return `<div class="bk">
          <div class="bk-logo" style="${t.logo ? '' : `background:${esc(t.color)}`}">${logoHtml(t)}</div>
          <div>
            <h4>${esc(t.name)} <span class="pill ${st}">${STATUS_LABEL[st]}</span></h4>
            <div class="sub">Username <b>${esc(t.slug)}</b> · ${t.plan_expires_on ? 'plan till ' + fmtDate(t.plan_expires_on) : 'no expiry'}</div>
            <div class="sub">${esc([t.contact_name, t.contact_phone].filter(Boolean).join(' · ') || 'No contact saved')} · last login ${ago(t.last_login_at)}</div>
          </div>
          <div class="bk-stats">
            <div><b>${t.printed}${t.max_coupons != null ? `<small style="font-weight:600;color:var(--muted)"> / ${t.max_coupons}</small>` : ''}</b>Coupons</div>
            <div><b>${t.claimed}</b>Scratched</div>
            <div><b>${t.claims_30d}</b>Last 30 days</div>
            <div><b>${t.customers}</b>Customers</div>
          </div>
          <div class="bk-actions">
            <button class="btn sm primary" data-open="${t.id}" title="Open this bakery's admin as them">Open as bakery</button>
            <button class="btn sm" data-edit="${t.id}">Edit</button>
            <button class="btn sm" data-pw="${t.id}">Reset password</button>
          </div>
        </div>`;
      }).join('') || `<div class="card empty-state"><span>🏪</span>${tenants.length ? 'No bakery matches your search' : 'No bakeries yet — add your first one!'}</div>`;
      view.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
        await api(`/tenants/${b.dataset.open}/impersonate`, { method: 'POST' });
        location.href = '/admin';
      });
      view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editBakery(+b.dataset.edit));
      view.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => resetPassword(tenants.find(t => t.id === +b.dataset.pw)));
    };
    $('#q').oninput = draw;
    $('#addBk').onclick = addBakery;
    draw();
  }

  function credentialsHtml(t, password) {
    const loginUrl = location.origin + '/admin';
    const text = `Your Scratch & Win account for ${t.name}\nLogin: ${loginUrl}\nUsername: ${t.slug}\nPassword: ${password}\nPlease change the password after your first login (Settings → Change password).`;
    const wa = t.contact_phone ? `https://wa.me/${String(t.contact_phone).replace(/\D/g, '').replace(/^(?=\d{10}$)/, '91')}?text=${encodeURIComponent(text)}` : '';
    return { html: `<div class="cred">
        <dl><dt>Login page</dt><dd>${esc(loginUrl)}</dd><dt>Username</dt><dd>${esc(t.slug)}</dd><dt>Password</dt><dd>${esc(password)}</dd></dl>
        <div class="warn">This password is shown only now. Copy it and share it with the bakery.</div>
      </div>
      <div class="modal-foot">
        ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ''}
        <button class="btn" id="copyCred">Copy details</button>
        <button class="btn primary" id="doneCred">Done</button>
      </div>`, text };
  }
  function showCredentials(m, t, password, title) {
    const c = credentialsHtml(t, password);
    m.el.innerHTML = `<h2>${esc(title)}</h2><p class="hint" style="margin:0">${esc(t.name)} can now sign in.</p>${c.html}`;
    $('#copyCred', m.el).onclick = async () => {
      try { await navigator.clipboard.writeText(c.text); toast('Copied'); } catch { toast('Copy not allowed — select the text instead'); }
    };
    $('#doneCred', m.el).onclick = () => { m.close(); route(); };
  }

  function bakeryForm(t, isNew) {
    return `
      <div class="section-title">Bakery</div>
      <div class="grid2">
        <div><label class="label">Bakery name</label><input class="input" id="fName" maxlength="80" value="${esc(t.name)}" placeholder="e.g. Royal Bakes"></div>
        <div><label class="label">Username <i>(used to log in)</i></label><input class="input" id="fSlug" maxlength="40" value="${esc(t.slug)}" placeholder="e.g. royal-bakes" autocapitalize="none" spellcheck="false"></div>
      </div>
      ${isNew ? `<label class="label">Password <i>(min 8 characters)</i></label>
        <div class="big-input" style="gap:8px"><input class="input" id="fPw" value="${genPassword()}" style="height:44px;font-size:15px;letter-spacing:.5px;text-transform:none"><button class="btn" type="button" id="fGen">New</button></div>` : ''}
      <label class="label">Logo</label>
      <div class="logo-pick"><div class="logo-box" id="fLogoBox"></div>
        <label class="btn sm">Upload<input type="file" accept="image/*" hidden id="fLogo"></label>
        <button class="btn sm danger" type="button" id="fLogoClear">Remove</button></div>
      <div class="grid2">
        <div><label class="label">Main colour</label><div class="color-row"><input type="color" id="fColor" value="${esc(t.color)}"><input class="input" id="fColorT" value="${esc(t.color)}" maxlength="7"></div></div>
        <div><label class="label">Dark accent</label><div class="color-row"><input type="color" id="fColor2" value="${esc(t.color2)}"><input class="input" id="fColor2T" value="${esc(t.color2)}" maxlength="7"></div></div>
      </div>
      <div class="grid2">
        <div><label class="label">Tagline</label><input class="input" id="fTag" value="${esc(t.tagline)}"></div>
        <div><label class="label">Address</label><input class="input" id="fAddr" value="${esc(t.address)}"></div>
      </div>
      <div class="section-title">Plan &amp; contact</div>
      <div class="grid3">
        <div><label class="label">Status</label><select class="input" id="fStatus">
          <option value="active" ${t.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="suspended" ${t.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></div>
        <div><label class="label">Plan active till <i>(blank = no end)</i></label><input class="input" type="date" id="fExp" value="${esc(t.plan_expires_on || '')}"></div>
        <div><label class="label">Coupon limit <i>(blank = unlimited)</i></label><input class="input" type="number" min="0" id="fMax" value="${t.max_coupons ?? ''}" placeholder="Unlimited"></div>
      </div>
      <div class="grid2">
        <div><label class="label">Contact person</label><input class="input" id="fCName" value="${esc(t.contact_name)}"></div>
        <div><label class="label">Contact phone / WhatsApp</label><input class="input" id="fCPhone" value="${esc(t.contact_phone)}" inputmode="tel"></div>
      </div>
      <label class="label">Private notes <i>(only you see these)</i></label>
      <textarea class="input" id="fNotes" rows="2">${esc(t.notes)}</textarea>
      ${isNew ? '<label class="switch"><input type="checkbox" id="fStarter" checked> Add starter gifts (Free Pastry, Cookie Box, 10% Off, Better luck next time)</label>' : ''}
      <p class="err" id="fErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>`;
  }
  function wireForm(el, t) {
    let logo = t.logo || '';
    const draw = () => { $('#fLogoBox', el).innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : 'No logo'; };
    draw();
    $('#fLogo', el).onchange = async e => { const f = e.target.files[0]; if (f) { try { logo = await readLogo(f); draw(); } catch (err) { toast(err.message); } } };
    $('#fLogoClear', el).onclick = () => { logo = ''; draw(); };
    for (const [p, x] of [['#fColor', '#fColorT'], ['#fColor2', '#fColor2T']]) {
      $(p, el).oninput = () => { $(x, el).value = $(p, el).value; };
      $(x, el).oninput = () => { if (/^#[0-9a-f]{6}$/i.test($(x, el).value)) $(p, el).value = $(x, el).value; };
    }
    const gen = $('#fGen', el); if (gen) gen.onclick = () => { $('#fPw', el).value = genPassword(); };
    return () => ({
      name: $('#fName', el).value, slug: $('#fSlug', el).value, logo, color: $('#fColorT', el).value, color2: $('#fColor2T', el).value,
      tagline: $('#fTag', el).value, address: $('#fAddr', el).value, status: $('#fStatus', el).value,
      plan_expires_on: $('#fExp', el).value, max_coupons: $('#fMax', el).value,
      contact_name: $('#fCName', el).value, contact_phone: $('#fCPhone', el).value, notes: $('#fNotes', el).value,
    });
  }

  function addBakery() {
    const t = { name: '', slug: '', color: '#F47216', color2: '#963B1F', status: 'active', tagline: '', address: '', contact_name: '', contact_phone: '', notes: '', logo: '' };
    const m = modal(`<h2>Add a bakery</h2><p class="hint" style="margin:0">They get their own admin, coupons, customers and branding.</p>
      ${bakeryForm(t, true)}
      <div class="modal-foot"><button class="btn" id="fCancel">Cancel</button><button class="btn primary" id="fSave">Create bakery</button></div>`, { wide: true });
    const el = m.el, values = wireForm(el, t);
    let slugTouched = false;
    $('#fSlug', el).oninput = () => { slugTouched = true; };
    $('#fName', el).oninput = () => { if (!slugTouched) $('#fSlug', el).value = slugify($('#fName', el).value); };
    $('#fCancel', el).onclick = m.close;
    $('#fSave', el).onclick = async () => {
      const body = { ...values(), password: $('#fPw', el).value, starter_gifts: $('#fStarter', el).checked };
      try {
        const r = await api('/tenants', { method: 'POST', body });
        showCredentials(m, { ...body, slug: slugify(body.slug) || body.slug }, r.password, 'Bakery created 🎉');
      } catch (e) { $('#fErr', el).textContent = e.message; }
    };
    setTimeout(() => $('#fName', el).focus(), 50);
  }

  async function editBakery(id) {
    const t = await api('/tenants/' + id);
    const m = modal(`<h2>${esc(t.name)}</h2><p class="hint" style="margin:0">Created ${fmtDate(t.created_at)} · last login ${ago(t.last_login_at)}</p>
      ${bakeryForm(t, false)}
      <div class="modal-foot"><button class="btn" id="fCancel">Cancel</button><button class="btn primary" id="fSave">Save changes</button></div>
      <div class="danger-zone">
        <h4>Delete bakery</h4>
        <p class="hint" style="margin:0 0 10px">Permanently deletes ${esc(t.name)} with all its gifts, coupons and customers. Printed coupons stop working. This cannot be undone.</p>
        <div class="big-input" style="gap:8px"><input class="input" id="fDel" placeholder="Type ${esc(t.slug)} to confirm" style="height:44px;font-size:15px;text-transform:none;letter-spacing:0"><button class="btn danger" id="fDelBtn">Delete</button></div>
      </div>`, { wide: true });
    const el = m.el, values = wireForm(el, t);
    $('#fCancel', el).onclick = m.close;
    $('#fSave', el).onclick = async () => {
      try { await api('/tenants/' + id, { method: 'PUT', body: values() }); m.close(); toast('Saved'); route(); }
      catch (e) { $('#fErr', el).textContent = e.message; }
    };
    $('#fDelBtn', el).onclick = async () => {
      if (!confirm(`Delete ${t.name} and all its data for good?`)) return;
      try { await api('/tenants/' + id, { method: 'DELETE', body: { confirm: $('#fDel', el).value.trim() } }); m.close(); toast('Bakery deleted'); route(); }
      catch (e) { toast(e.message); }
    };
  }

  function resetPassword(t) {
    const m = modal(`<h2>Reset password</h2><p class="hint" style="margin:0">${esc(t.name)} (username <b>${esc(t.slug)}</b>) will be signed out everywhere.</p>
      <label class="label">New password <i>(min 8 characters)</i></label>
      <div class="big-input" style="gap:8px"><input class="input" id="rPw" value="${genPassword()}" style="height:44px;font-size:15px;letter-spacing:.5px;text-transform:none"><button class="btn" type="button" id="rGen">New</button></div>
      <p class="err" id="rErr" style="color:var(--red);font-weight:600;min-height:18px;margin:12px 0 0"></p>
      <div class="modal-foot"><button class="btn" id="rCancel">Cancel</button><button class="btn primary" id="rSave">Set password</button></div>`);
    const el = m.el;
    $('#rGen', el).onclick = () => { $('#rPw', el).value = genPassword(); };
    $('#rCancel', el).onclick = m.close;
    $('#rSave', el).onclick = async () => {
      try { const r = await api(`/tenants/${t.id}/password`, { method: 'POST', body: { password: $('#rPw', el).value } }); showCredentials(m, t, r.password, 'Password reset'); }
      catch (e) { $('#rErr', el).textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- my account
  async function account() {
    view.innerHTML = `
      <div class="page-head"><div><h1>My account</h1><p>Your Super Admin sign-in.</p></div></div>
      <div class="dash"><div class="card">
        <h3>Change Super Admin password</h3>
        <input class="input" type="password" id="aOld" placeholder="Current password" autocomplete="current-password">
        <input class="input" type="password" id="aNew" placeholder="New password (min 10 characters)" autocomplete="new-password" style="margin-top:10px">
        <p class="hint">Changing it signs out every other Super Admin session.</p>
        <div class="modal-foot"><button class="btn primary" id="aSave">Change password</button></div>
      </div><div></div></div>`;
    $('#aSave').onclick = async () => {
      try { await api('/password', { method: 'PUT', body: { current: $('#aOld').value, password: $('#aNew').value } }); $('#aOld').value = $('#aNew').value = ''; toast('Password changed'); }
      catch (e) { toast(e.message); }
    };
  }

  // ---------------------------------------------------------------- boot
  fetch('/api/super/me').then(r => r.json()).then(d => d.super ? showShell() : showLogin()).catch(showLogin);
})();
