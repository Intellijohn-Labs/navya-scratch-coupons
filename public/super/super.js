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
    const card = e.target, btn = card.querySelector('.btn.primary');
    $('#loginErr').textContent = '';
    btn.classList.add('loading');
    const r = await fetch('/api/super/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: card.password.value }) }).catch(() => null);
    if (r && r.ok) {
      card.classList.add('leaving');
      setTimeout(() => { card.reset(); card.classList.remove('leaving'); btn.classList.remove('loading'); showShell(); }, 420);
      return;
    }
    btn.classList.remove('loading');
    $('#loginErr').textContent = r ? ((await r.json().catch(() => ({}))).error || 'Could not sign in') : 'No connection. Please try again.';
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  });
  $('#logout').onclick = async () => { await fetch('/api/super/logout', { method: 'POST' }); showLogin(); };

  // ---------------------------------------------------------------- router
  async function route() {
    const name = ['merchants', 'approvals', 'complaints', 'activity', 'account'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'merchants';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
    view.innerHTML = '<div class="empty-state">Loading…</div>';
    try { await ({ merchants: bakeries, approvals, complaints, activity, account })[name](); }
    catch (e) { if (e.message !== 'Please log in') view.innerHTML = `<div class="empty-state"><span>⚠️</span>${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  function setBadges(c) {
    if (!c) return;
    for (const [r, n] of [['approvals', c.pending], ['complaints', c.escalated]]) {
      const a = document.querySelector(`#nav a[data-r="${r}"]`);
      let b = a.querySelector('.nbadge');
      if (!b) { b = document.createElement('em'); b.className = 'nbadge'; a.appendChild(b); }
      b.textContent = n; b.hidden = !n;
    }
  }
  const refreshBadges = () => api('/overview').then(r => setBadges(r.counts)).catch(() => {});

  // ---------------------------------------------------------------- approvals
  async function approvals() {
    const { pending, decided } = await api('/approvals');
    refreshBadges();
    const row = (t, actions) => `<div class="bk">
      <div class="bk-logo" style="background:#2A3F6E">${esc(initials(t.name))}</div>
      <div>
        <h4>${esc(t.name)} ${t.status === 'pending' ? '<span class="pill expired">Waiting</span>' : t.status === 'rejected' ? '<span class="pill suspended">Not approved</span>' : '<span class="pill active">Approved</span>'}</h4>
        <div class="sub">Username <b>${esc(t.slug)}</b> · ${esc(t.slug)}.genuinedraw.in · signed up ${ago(t.created_at)}</div>
        <div class="sub">${esc(t.owner_name)} · ${esc(t.contact_phone)}${t.email ? ' · ' + esc(t.email) : ''}</div>
        <div class="sub">${esc([t.business_type, t.address, t.gst_number ? 'GST ' + t.gst_number : ''].filter(Boolean).join(' · ') || '—')}</div>
        ${t.reject_reason ? `<div class="sub" style="color:var(--red)">Reason: ${esc(t.reject_reason)}</div>` : ''}
      </div>
      <div></div>
      <div class="bk-actions">${actions}</div>
    </div>`;
    view.innerHTML = `
      <div class="page-head"><div><h1>Approvals</h1><p>Businesses that signed up at <b>genuinedraw.in/register</b>. They can't sign in until you approve them.</p></div>
        <a class="btn" href="/register" target="_blank" rel="noopener">Open sign-up page ↗</a></div>
      <h3 class="section-title">Waiting (${pending.length})</h3>
      <div class="bk-list">${pending.map(t => row(t, `<button class="btn sm primary" data-ok="${t.id}">Approve</button><button class="btn sm danger" data-no="${t.id}">Reject</button>`)).join('')
        || '<div class="card empty-state"><span>✅</span>No sign-ups waiting</div>'}</div>
      ${decided.length ? `<h3 class="section-title">Recently decided</h3><div class="bk-list">${decided.map(t => row(t, t.status === 'rejected' ? `<button class="btn sm" data-ok="${t.id}">Approve after all</button>` : '')).join('')}</div>` : ''}`;
    const all = [...pending, ...decided], find = id => all.find(t => t.id === +id);
    view.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => {
      const t = find(b.dataset.ok);
      const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
      const m = modal(`<h2>Approve ${esc(t.name)}</h2>
        <p class="hint">They'll get a WhatsApp message and can sign in at <b>${esc(t.admin_url)}</b> with the password they chose.</p>
        <div class="grid2">
          <div><label class="label">Plan valid till <i>(optional)</i></label><input class="input" type="date" id="aPlan" value="${nextYear}"></div>
          <div><label class="label">Coupon limit <i>(optional)</i></label><input class="input" type="number" min="0" id="aMax" placeholder="No limit"></div>
        </div>
        <p class="err" id="aErr" style="color:var(--red);font-weight:600;min-height:18px"></p>
        <div class="modal-foot"><button class="btn" id="aCancel">Cancel</button><button class="btn primary" id="aGo">Approve</button></div>`);
      $('#aCancel', m.el).onclick = m.close;
      $('#aGo', m.el).onclick = async () => {
        try { await api(`/tenants/${t.id}/approve`, { method: 'POST', body: { plan_expires_on: $('#aPlan', m.el).value, max_coupons: $('#aMax', m.el).value } }); m.close(); toast(`${t.name} approved ✅`); approvals(); }
        catch (e) { $('#aErr', m.el).textContent = e.message; }
      };
    });
    view.querySelectorAll('[data-no]').forEach(b => b.onclick = () => {
      const t = find(b.dataset.no);
      const m = modal(`<h2>Reject ${esc(t.name)}?</h2>
        <label class="label">Reason <i>(the merchant will see this)</i></label>
        <textarea class="input" id="rReason" maxlength="500" placeholder="e.g. We couldn't verify the business details. Please call us."></textarea>
        <p class="err" id="rErr" style="color:var(--red);font-weight:600;min-height:18px"></p>
        <div class="modal-foot"><button class="btn" id="rCancel">Cancel</button><button class="btn danger" id="rGo">Reject</button></div>`);
      $('#rCancel', m.el).onclick = m.close;
      $('#rGo', m.el).onclick = async () => {
        try { await api(`/tenants/${t.id}/reject`, { method: 'POST', body: { reason: $('#rReason', m.el).value } }); m.close(); toast('Sign-up rejected'); approvals(); }
        catch (e) { $('#rErr', m.el).textContent = e.message; }
      };
    });
  }

  // ---------------------------------------------------------------- complaints
  async function complaints() {
    let filter = 'escalated';
    view.innerHTML = `
      <div class="page-head"><div><h1>Complaints</h1><p>Tickets not resolved by the merchant within 24 hours, or that the customer escalated, land here.</p></div></div>
      <div class="seg" id="kSeg" style="max-width:520px;margin-bottom:16px">
        <button data-f="escalated" class="on">Escalated</button><button data-f="open">All open</button><button data-f="all">Everything</button>
      </div>
      <div id="kList"></div>`;
    const ST = COMPLAINT_STATUS, CAT = COMPLAINT_CAT;
    const load = async () => {
      const list = await api('/complaints?filter=' + filter);
      refreshBadges();
      $('#kList').innerHTML = list.length ? `<div class="table-wrap"><table class="rtable">
        <thead><tr><th>Ticket</th><th>Merchant</th><th>Problem</th><th>Status</th><th>Updated</th><th></th></tr></thead>
        <tbody>${list.map(k => `<tr>
          <td data-label="Ticket"><b>${esc(k.ticket_no)}</b><small>${esc(k.customer_name || '')} ${esc(k.phone)}</small></td>
          <td data-label="Merchant">${esc(k.shop || '—')}<small>${esc(k.outlet || '')}</small></td>
          <td data-label="Problem">${esc(CAT[k.category])}<small>${esc((k.last_message || '').slice(0, 80))}</small></td>
          <td data-label="Status"><span class="pill ${ST[k.status][0]}">${ST[k.status][1]}</span>${k.escalated ? ' <span class="pill void">Escalated</span>' : ''}</td>
          <td data-label="Updated">${ago(k.updated_at)}</td>
          <td class="td-actions"><button class="btn sm primary" data-open="${k.id}">Open</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty-state"><span>🙌</span>Nothing here</div>';
      view.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openTicket(b.dataset.open));
    };
    const openTicket = async id => {
      const k = await api('/complaints/' + id);
      const m = modal(`<h2>Complaint</h2>${complaintThread(k)}
        <label class="label">Reply as Genuine Draw team <i>(the customer and the merchant get it on WhatsApp)</i></label>
        <textarea class="input" id="kBody" maxlength="2000"></textarea>
        <label class="label">Status</label>
        <select class="input" id="kStatus">${Object.entries(ST).map(([v, [, l]]) => `<option value="${v}" ${v === k.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <p class="err" id="kErr" style="color:var(--red);font-weight:600;min-height:18px"></p>
        <div class="modal-foot"><button class="btn" id="kClose">Close</button><button class="btn primary" id="kSend">Send</button></div>`, { wide: true });
      $('#kClose', m.el).onclick = m.close;
      $('#kSend', m.el).onclick = async () => {
        const st = $('#kStatus', m.el).value;
        try { await api(`/complaints/${id}/reply`, { method: 'POST', body: { body: $('#kBody', m.el).value, status: st !== k.status ? st : undefined } }); m.close(); toast('Reply sent'); load(); }
        catch (e) { $('#kErr', m.el).textContent = e.message; }
      };
    };
    view.querySelectorAll('#kSeg button').forEach(b => b.onclick = () => {
      filter = b.dataset.f; view.querySelectorAll('#kSeg button').forEach(x => x.classList.toggle('on', x === b)); load();
    });
    await load();
  }

  // ---------------------------------------------------------------- bakeries
  async function bakeries() {
    const { tenants, counts } = await api('/overview');
    setBadges(counts);
    const sum = k => tenants.reduce((n, t) => n + (t[k] || 0), 0);
    const active = tenants.filter(t => statusOf(t) === 'active').length;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Merchants</h1><p>Every business using Genuine Draw.</p></div>
        <button class="btn primary" id="addBk">+ Add merchant</button>
      </div>
      <div class="kpis">
        <div class="kpi hero"><span>Merchants</span><b>${tenants.length}</b><small>${active} active</small></div>
        <div class="kpi"><span>Coupons printed</span><b>${sum('printed')}</b><small>all bakeries</small></div>
        <div class="kpi"><span>Scratched</span><b>${sum('claimed')}</b><small>${sum('claims_30d')} in last 30 days</small></div>
        <div class="kpi"><span>Redeemed</span><b>${sum('redeemed')}</b><small>gifts handed over</small></div>
        <div class="kpi"><span>Customers</span><b>${sum('customers')}</b><small>unique mobiles per merchant</small></div>
        <div class="kpi"><span>Need attention</span><b>${tenants.length - active}</b><small>suspended or expired</small></div>
      </div>
      <div class="toolbar"><input class="input" id="q" placeholder="Search merchant, username or contact…"></div>
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
            <div class="sub">${t.outlets} outlet${t.outlets === 1 ? '' : 's'} · ${t.staff} staff · ${esc([t.contact_name, t.contact_phone].filter(Boolean).join(' · ') || 'no contact saved')} · last login ${ago(t.last_login_at)}</div>
          </div>
          <div class="bk-stats">
            <div><b>${t.printed}${t.max_coupons != null ? `<small style="font-weight:600;color:var(--muted)"> / ${t.max_coupons}</small>` : ''}</b>Coupons</div>
            <div><b>${t.claimed}</b>Scratched</div>
            <div><b>${t.claims_30d}</b>Last 30 days</div>
            <div><b>${t.customers}</b>Customers</div>
          </div>
          <div class="bk-actions">
            <button class="btn sm primary" data-open="${t.id}" title="Open this merchant's admin as them">Open as merchant</button>
            <button class="btn sm" data-edit="${t.id}">Edit</button>
            <button class="btn sm" data-pw="${t.id}">Reset password</button>
          </div>
        </div>`;
      }).join('') || `<div class="card empty-state"><span>🏪</span>${tenants.length ? 'No merchant matches your search' : 'No merchants yet — add your first one!'}</div>`;
      view.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
        const r = await api(`/tenants/${b.dataset.open}/impersonate`, { method: 'POST' });
        location.href = r.url || '/admin';
      });
      view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editBakery(+b.dataset.edit));
      view.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => resetPassword(tenants.find(t => t.id === +b.dataset.pw)));
    };
    $('#q').oninput = draw;
    $('#addBk').onclick = addBakery;
    draw();
  }

  function credentialsHtml(t, password) {
    const loginUrl = t.admin_url || location.origin + '/admin';
    const text = `Your Genuine Draw account for ${t.name}\nLogin: ${loginUrl}\nUsername: ${t.slug}\nPassword: ${password}\nPlease change the password after your first login (Settings → Change password).`;
    const wa = t.contact_phone ? `https://wa.me/${String(t.contact_phone).replace(/\D/g, '').replace(/^(?=\d{10}$)/, '91')}?text=${encodeURIComponent(text)}` : '';
    return { html: `<div class="cred">
        <dl><dt>Login page</dt><dd>${esc(loginUrl)}</dd><dt>Username</dt><dd>${esc(t.slug)}</dd><dt>Password</dt><dd>${esc(password)}</dd></dl>
        <div class="warn">This password is shown only now. Copy it and share it with the merchant.</div>
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
      <div class="section-title">Merchant</div>
      <div class="grid2">
        <div><label class="label">Business name</label><input class="input" id="fName" maxlength="80" value="${esc(t.name)}" placeholder="e.g. Royal Bakes"></div>
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
    const m = modal(`<h2>Add a merchant</h2><p class="hint" style="margin:0">They get their own admin, outlets, staff logins, coupons, customers and branding.</p>
      ${bakeryForm(t, true)}
      <div class="modal-foot"><button class="btn" id="fCancel">Cancel</button><button class="btn primary" id="fSave">Create merchant</button></div>`, { wide: true });
    const el = m.el, values = wireForm(el, t);
    let slugTouched = false;
    $('#fSlug', el).oninput = () => { slugTouched = true; };
    $('#fName', el).oninput = () => { if (!slugTouched) $('#fSlug', el).value = slugify($('#fName', el).value); };
    $('#fCancel', el).onclick = m.close;
    $('#fSave', el).onclick = async () => {
      const body = { ...values(), password: $('#fPw', el).value, starter_gifts: $('#fStarter', el).checked };
      try {
        const r = await api('/tenants', { method: 'POST', body });
        showCredentials(m, { ...body, slug: slugify(body.slug) || body.slug, admin_url: r.admin_url }, r.password, 'Merchant created 🎉');
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
        <h4>Delete merchant</h4>
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
      if (!await askConfirm({ title: `Delete ${t.name}?`, text: 'All of its outlets, staff, gifts, coupons and customers will be deleted for good.', ok: 'Delete merchant' })) return;
      try { await api('/tenants/' + id, { method: 'DELETE', body: { confirm: $('#fDel', el).value.trim() } }); m.close(); toast('Merchant deleted'); route(); }
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
      try { const r = await api(`/tenants/${t.id}/password`, { method: 'POST', body: { password: $('#rPw', el).value } }); showCredentials(m, { ...t, admin_url: r.admin_url || t.admin_url }, r.password, 'Password reset'); }
      catch (e) { $('#rErr', el).textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- activity log
  async function activity() {
    const { tenants } = await api('/overview');
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Activity log</h1><p>Every important action on the platform. Each entry is sealed with a fingerprint of the one before, so any change to history is detectable.</p></div>
        <button class="btn primary" id="verify">🛡️ Verify log</button>
      </div>
      <div class="chain idle" id="chain">Press <b>Verify log</b> to re-check every entry from the very first one.</div>
      <div class="toolbar"><select class="input" id="fTenant" style="max-width:320px"><option value="">All merchants</option>${tenants.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="card"><div id="actList"></div><div style="text-align:center;margin-top:12px"><button class="btn" id="actMore" hidden>Show older</button></div></div>`;
    let before = '';
    const load = async reset => {
      if (reset) { before = ''; $('#actList').innerHTML = ''; }
      const t = $('#fTenant').value;
      const rows = await api('/activity?' + new URLSearchParams({ ...(t ? { tenant: t } : {}), ...(before ? { before } : {}) }));
      $('#actList').insertAdjacentHTML('beforeend', rows.map(e => activityRow(e, { showMerchant: true })).join('') || (before ? '' : '<div class="empty-state"><span>🛡️</span>Nothing yet</div>'));
      if (rows.length) before = rows[rows.length - 1].id;
      $('#actMore').hidden = rows.length < 80;
    };
    $('#fTenant').onchange = () => load(true);
    $('#actMore').onclick = () => load(false);
    $('#verify').onclick = async () => {
      const box = $('#chain'), btn = $('#verify');
      btn.disabled = true; box.className = 'chain idle'; box.textContent = 'Checking every entry…';
      try {
        const r = await api('/activity/verify');
        box.className = 'chain ' + (r.ok ? 'ok' : 'bad');
        box.innerHTML = r.ok
          ? `✅ Log intact: all <b>${r.checked}</b> entries check out. Latest fingerprint <code>${esc(r.last_hash.slice(0, 16))}…</code>`
          : `⚠️ Log has been altered at entry <b>#${r.broken_at}</b> (${r.checked} entries before it are fine). Investigate before trusting anything after it.`;
      } catch (e) { box.className = 'chain bad'; box.textContent = e.message; }
      btn.disabled = false;
    };
    await load(true);
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
  if (location.hostname.endsWith('.genuinedraw.in')) { location.replace('https://genuinedraw.in/super'); return; }
  fetch('/api/super/me').then(r => r.json()).then(d => d.super ? showShell() : showLogin()).catch(showLogin);
})();
