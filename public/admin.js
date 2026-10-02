'use strict';
// Administrace AI SALES. Všechna data se vkládají přes textContent (žádné innerHTML => bez XSS).
const $app = document.getElementById('app');
const BASE = '/ai-sales';
const API = '/api/admin';
let user = null;
let pendingCount = 0;

const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || 'GET', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'beleta-admin' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login' && path !== '/me') { user = null; render(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.pending_approval?.message || 'Chyba ' + res.status);
  return data;
}
const S = (p) => '/ai-sales' + p;

function toast(msg) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 3500); }
const fmt = {
  money: (n) => (n == null ? '–' : new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(n) + ' Kč'),
  dt: (s) => (s ? new Date(s).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }) : '–'),
  d: (s) => (s ? String(s).slice(0, 10) : '–'),
};
const tone = (s) => ({ approved: 'ok', executed: 'ok', success: 'ok', sent: 'ok', won: 'ok', qualified: 'ok', done: 'ok', pending: 'warn', pending_approval: 'warn', draft: 'warn', new: 'warn',
  rejected: 'bad', failed: 'bad', error: 'bad', denied: 'bad', forbidden: 'bad', lost: 'bad', expired: 'bad', validation_error: 'bad' }[s] || '');
const chip = (s) => h('span', { class: 'chip ' + tone(s) }, s);

const PAGES = [
  ['', 'Dashboard'], ['/leads', 'Leady'], ['/projects', 'Projekty'], ['/quotes', 'Nabídky'], ['/followups', 'Follow-up'],
  ['/approvals', 'Ke schválení'], ['/activity', 'Aktivita AI'], ['/policies', 'Pravidla AI'],
];
const path = () => location.pathname.replace(/\/+$/, '').slice(BASE.length);
function go(p) { history.pushState({}, '', BASE + p); render(); }
window.addEventListener('popstate', render);

function table(cols, rows, onRow) {
  if (!rows.length) return h('div', { class: 'empty' }, 'Zatím žádné záznamy.');
  return h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key] ?? '–'))))));
}
function filterBar(options, current, onChange) {
  const sel = h('select', { onchange: (e) => onChange(e.target.value) }, h('option', { value: '' }, 'Všechny stavy'),
    options.map((o) => h('option', { value: o, selected: o === current }, o)));
  return h('div', { class: 'toolbar' }, sel);
}

const views = {
  async '' () {
    const d = await api(S('/dashboard'));
    const card = (k, v, cls) => h('div', { class: 'card ' + (cls || '') }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    return h('div', {}, h('h2', {}, 'Dashboard'), h('div', { class: 'grid' },
      card('Nové leady', d.new_leads), card('Kvalifikované leady', d.qualified_leads), card('Rozpracované projekty', d.active_projects),
      card('Otevřené nabídky', d.open_quotes), card('Hodnota otevřených nabídek', fmt.money(d.open_quotes_value_net)),
      card('Follow-up (splatné / čekající)', `${d.followups_due} / ${d.followups_pending}`, d.followups_due ? 'alert' : ''),
      card('Čekající schválení', d.pending_approvals, d.pending_approvals ? 'alert' : ''),
      card('Potenciální obchodní hodnota', fmt.money(d.potential_value_net))));
  },
  async '/leads' () {
    const st = new URLSearchParams(location.search).get('status') || '';
    const rows = await api(S('/leads' + (st ? '?status=' + encodeURIComponent(st) : '')));
    const bar = filterBar(['new', 'contacted', 'qualified', 'nurturing', 'won', 'lost'], st, (v) => { history.pushState({}, '', BASE + '/leads' + (v ? '?status=' + v : '')); render(); });
    return h('div', {}, h('h2', {}, 'Leady'), bar, table([
      { label: 'Zákazník', render: (r) => r.customer_name }, { label: 'Kontakt', render: (r) => [r.email, r.phone].filter(Boolean).join(' · ') },
      { label: 'Stav', render: (r) => chip(r.status) }, { label: 'Skóre', num: true, key: 'score' },
      { label: 'Shrnutí', render: (r) => r.summary }, { label: 'Vytvořeno', render: (r) => fmt.dt(r.created_at) },
      { label: '', render: (r) => user.role === 'viewer' ? '' : h('select', { onchange: async (e) => {
          try { const res = await api(S('/leads/' + r.id), { method: 'PATCH', body: { status: e.target.value } }); toast(res.pending_approval ? 'Změna čeká na schválení' : 'Uloženo'); } catch (er) { toast(er.message); }
          render(); } }, ['', 'contacted', 'qualified', 'nurturing', 'won', 'lost'].map((o) => h('option', { value: o }, o || 'Změnit stav…'))) },
    ], rows));
  },
  async '/projects' () {
    return h('div', {}, h('h2', {}, 'Projekty'), table([
      { label: 'Projekt', key: 'name' }, { label: 'Zákazník', key: 'customer_name' }, { label: 'Stav', render: (r) => chip(r.status) },
      { label: 'Typ', key: 'project_type' }, { label: 'Plocha m²', num: true, render: (r) => r.area_m2 ?? '–' },
      { label: 'Hodnota bez DPH', num: true, render: (r) => fmt.money(r.estimated_value_net) }, { label: 'Vytvořeno', render: (r) => fmt.dt(r.created_at) },
    ], await api(S('/projects'))));
  },
  async '/quotes' () {
    const rows = await api(S('/quotes'));
    return h('div', {}, h('h2', {}, 'Nabídky'), table([
      { label: 'Číslo', key: 'number' }, { label: 'Zákazník', key: 'customer_name' }, { label: 'Stav', render: (r) => chip(r.status) },
      { label: 'Celkem bez DPH', num: true, render: (r) => fmt.money(r.total_net) }, { label: 'Sleva %', num: true, key: 'discount_pct' },
      { label: 'Nejdříve dodání', render: (r) => fmt.d(r.earliest_delivery_date) }, { label: 'Platí do', render: (r) => fmt.d(r.valid_until) },
      { label: 'Vytvořil', key: 'created_by' },
    ], rows, openQuote));
  },
  async '/followups' () {
    const rows = await api(S('/followups'));
    const act = (r, a, label) => h('button', { onclick: async () => { try { await api(S(`/followups/${r.id}/${a}`), { method: 'POST' }); toast('Uloženo'); } catch (e) { toast(e.message); } render(); } }, label);
    return h('div', {}, h('h2', {}, 'Follow-up'), table([
      { label: 'Termín', render: (r) => fmt.dt(r.due_at) }, { label: 'Zákazník', key: 'customer_name' }, { label: 'Kanál', key: 'channel' },
      { label: 'Účel', key: 'purpose' }, { label: 'Stav', render: (r) => chip(r.status) },
      { label: '', render: (r) => (['pending', 'draft_created'].includes(r.status) && user.role !== 'viewer') ? h('span', {}, act(r, 'done', 'Hotovo'), ' ', act(r, 'cancel', 'Zrušit')) : '' },
    ], rows));
  },
  async '/approvals' () {
    const st = new URLSearchParams(location.search).get('status') || 'pending';
    const rows = await api(S('/approvals?status=' + encodeURIComponent(st)));
    const bar = filterBar(['pending', 'executed', 'approved', 'rejected', 'failed', 'expired'], st, (v) => { history.pushState({}, '', BASE + '/approvals?status=' + (v || 'pending')); render(); });
    const list = rows.length ? rows.map((a) => {
      const note = h('input', { class: 'note', placeholder: 'Poznámka k rozhodnutí (volitelné)', maxlength: '1000' });
      const decide = (d) => async () => { try { await api(S(`/approvals/${a.id}/${d}`), { method: 'POST', body: { note: note.value || undefined } }); toast(d === 'approve' ? 'Schváleno' : 'Zamítnuto'); } catch (e) { toast(e.message); } render(); };
      return h('div', { class: 'approval' },
        h('h3', {}, a.summary), h('div', { class: 'muted' }, `${a.category} · ${a.tool || 'rozhodnutí člověka'} · ${a.actor_id} · ${fmt.dt(a.created_at)} · platí do ${fmt.dt(a.expires_at)} `, chip(a.status)),
        a.reason ? h('p', {}, a.reason) : null,
        a.input ? h('details', {}, h('summary', {}, 'Vstup akce'), h('pre', {}, JSON.stringify(a.input, null, 2))) : null,
        a.error ? h('p', { class: 'err' }, a.error) : null,
        a.decided_by ? h('div', { class: 'muted' }, `Rozhodl: ${a.decided_by} (${fmt.dt(a.decided_at)})${a.decision_note ? ' – ' + a.decision_note : ''}`) : null,
        a.status === 'pending' && user.role !== 'viewer' ? h('div', { class: 'row' }, note, h('button', { class: 'primary', onclick: decide('approve') }, 'Schválit a provést'), h('button', { class: 'danger', onclick: decide('reject') }, 'Zamítnout')) : null);
    }) : h('div', { class: 'empty' }, 'Nic k vyřízení.');
    return h('div', {}, h('h2', {}, 'Ke schválení'), bar, list);
  },
  async '/activity' () {
    const p = new URLSearchParams(location.search);
    const qs = ['tool', 'status'].filter((k) => p.get(k)).map((k) => `${k}=${encodeURIComponent(p.get(k))}`).join('&');
    const [rows, ver] = await Promise.all([api(S('/activity' + (qs ? '?' + qs : ''))), api(S('/audit/verify'))]);
    const tool = h('input', { placeholder: 'Nástroj (např. create_quote)', value: p.get('tool') || '' });
    const status = h('select', {}, h('option', { value: '' }, 'Všechny výsledky'), ['success', 'error', 'denied', 'forbidden', 'validation_error', 'pending_approval', 'approved', 'rejected'].map((o) => h('option', { value: o, selected: p.get('status') === o }, o)));
    const apply = () => { const q = new URLSearchParams(); if (tool.value) q.set('tool', tool.value); if (status.value) q.set('status', status.value); history.pushState({}, '', BASE + '/activity' + (q.toString() ? '?' + q : '')); render(); };
    return h('div', {}, h('h2', {}, 'Aktivita AI (audit log)'),
      h('p', { class: 'muted' }, 'Integrita řetězce: ', h('span', { class: 'chip ' + (ver.ok ? 'ok' : 'bad') }, ver.ok ? `OK (${ver.checked} záznamů)` : `PORUŠENO u záznamu ${ver.brokenAt}`)),
      h('div', { class: 'toolbar' }, tool, status, h('button', { onclick: apply }, 'Filtrovat')),
      table([
        { label: 'Čas', render: (r) => fmt.dt(r.ts) }, { label: 'Aktér', key: 'actor_id' }, { label: 'Akce', key: 'action' }, { label: 'Nástroj', render: (r) => r.tool || '–' },
        { label: 'Výsledek', render: (r) => chip(r.status) }, { label: 'Kód', render: (r) => r.error_code || '' },
        { label: 'Entita', render: (r) => r.entity_type ? `${r.entity_type}:${String(r.entity_id).slice(0, 8)}` : '' }, { label: 'ms', num: true, render: (r) => r.duration_ms ?? '' },
      ], rows, (r) => showJson('Záznam #' + r.id, r)));
  },
  async '/policies' () {
    const rows = await api(S('/policies'));
    return h('div', {}, h('h2', {}, 'Pravidla AI'), h('p', { class: 'muted' }, 'Limity pravomocí AI. Mění je jen administrátor; každá změna se zapisuje do auditu.'),
      table([{ label: 'Klíč', key: 'key' }, { label: 'Popis', key: 'description' },
        { label: 'Hodnota', render: (r) => {
          const input = h('input', { value: String(r.value), size: '10', disabled: user.role !== 'admin' });
          const save = h('button', { disabled: user.role !== 'admin', onclick: async () => {
            let v = input.value.trim(); if (typeof r.value === 'number') v = Number(v); else if (typeof r.value === 'boolean') v = v === 'true';
            try { await api(S('/policies/' + r.key), { method: 'PUT', body: { value: v } }); toast('Uloženo'); } catch (e) { toast(e.message); } render(); } }, 'Uložit');
          return h('span', {}, input, ' ', save); } }], rows));
  },
};

function showJson(title, obj) {
  const dlg = h('dialog', {}, h('h3', {}, title), h('pre', {}, JSON.stringify(obj, null, 2)), h('div', { class: 'toolbar' }, h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Zavřít')));
  document.body.append(dlg); dlg.showModal();
}
async function openQuote(r) {
  const q = await api(S('/quotes/' + r.id));
  const setStatus = async (status) => { try { const res = await api(S('/quotes/' + r.id), { method: 'PATCH', body: { status } }); toast(res.pending_approval ? 'Čeká na schválení' : 'Uloženo'); dlg.close(); dlg.remove(); render(); } catch (e) { toast(e.message); } };
  const dlg = h('dialog', {}, h('h3', {}, `Nabídka ${q.number}`), h('p', { class: 'muted' }, `${q.customer_name} · `, chip(q.status)),
    table([{ label: 'SKU', key: 'sku' }, { label: 'Položka', key: 'name' }, { label: 'Množ.', num: true, key: 'qty' }, { label: 'Cena/j.', num: true, render: (i) => fmt.money(i.unit_price_net) }, { label: 'Celkem', num: true, render: (i) => fmt.money(i.line_net) }], q.items),
    h('p', {}, `Doprava: ${fmt.money(Number(q.shipping_net))} · Sleva: ${q.discount_pct} % · Celkem bez DPH: `, h('b', {}, fmt.money(Number(q.total_net))), ` · s DPH: ${fmt.money(Number(q.total_gross))}`),
    q.custom_terms ? h('p', {}, 'Vlastní podmínky: ' + q.custom_terms) : null,
    h('div', { class: 'toolbar' }, user.role !== 'viewer' ? [h('button', { onclick: () => setStatus('ready') }, 'Připraveno'), h('button', { class: 'primary', onclick: () => setStatus('sent') }, 'Označit jako odeslanou'), h('button', { class: 'danger', onclick: () => setStatus('rejected') }, 'Zamítnuta')] : null,
      h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Zavřít')));
  document.body.append(dlg); dlg.showModal();
}

function loginView() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'err' });
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } }); user = r.user; render(); } catch (ex) { err.textContent = ex.message; }
  } }, h('h1', {}, 'AI SALES – přihlášení'), h('label', {}, 'E-mail'), email, h('label', {}, 'Heslo'), pw, h('button', { class: 'primary', type: 'submit' }, 'Přihlásit'), err);
  return form;
}

async function render() {
  if (!user) {
    try { user = (await api('/me')).user; } catch { /* nepřihlášen */ }
    if (!user) { $app.replaceChildren(loginView()); return; }
  }
  const p = path();
  const view = views[p] || views[''];
  try { pendingCount = (await api(S('/dashboard'))).pending_approvals; } catch { /* ignore */ }
  let content;
  try { content = await view(); } catch (e) { content = h('div', { class: 'empty' }, e.message === 'unauthorized' ? '' : 'Chyba: ' + e.message); }
  const nav = h('nav', { class: 'side' }, h('h1', {}, 'BELETA · AI SALES'),
    PAGES.map(([href, label]) => h('a', { href: BASE + href, class: (views[p] ? p : '') === href ? 'active' : '', onclick: (e) => { e.preventDefault(); go(href); } },
      label, href === '/approvals' && pendingCount ? h('span', { class: 'badge' }, pendingCount) : null)),
    h('div', { class: 'who' }, user.email, h('br'), user.role, ' · ', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ } user = null; render(); } }, 'Odhlásit')));
  $app.replaceChildren(h('div', { class: 'layout' }, nav, h('main', {}, content)));
}
render();
