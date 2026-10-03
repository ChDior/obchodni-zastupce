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
  if (!res.ok) { const er = new Error(data.error?.message || data.pending_approval?.message || 'Chyba ' + res.status); er.code = data.error?.code; throw er; }
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
  ['', 'Dashboard'], ['/leads', 'Leady'], ['/projects', 'Projekty'], ['/quotes', 'Nabídky'], ['/customers', 'Zákazníci'], ['/products', 'Katalog'], ['/followups', 'Follow-up'],
  ['/approvals', 'Ke schválení'], ['/activity', 'Aktivita AI'], ['/usage', 'Spotřeba AI'], ['/policies', 'Pravidla AI'], ['/security', 'Zabezpečení'],
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
  async '/customers' () {
    const p = new URLSearchParams(location.search);
    const rows = await api(S('/customers' + (p.get('q') ? '?q=' + encodeURIComponent(p.get('q')) : '')));
    const search = h('input', { placeholder: 'Jméno, e-mail, firma, IČO', value: p.get('q') || '' });
    const go2 = () => { history.pushState({}, '', BASE + '/customers' + (search.value ? '?q=' + encodeURIComponent(search.value) : '')); render(); };
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    return h('div', {}, h('h2', {}, 'Zákazníci'), h('div', { class: 'toolbar' }, search, h('button', { onclick: go2 }, 'Hledat')),
      table([{ label: 'Jméno', render: (r) => r.erased_at ? h('i', {}, 'anonymizován') : r.name }, { label: 'Firma', render: (r) => r.company_name || '' },
        { label: 'Kontakt', render: (r) => [r.email, r.phone].filter(Boolean).join(' · ') }, { label: 'Leady', num: true, key: 'leads' }, { label: 'Nabídky', num: true, key: 'quotes' },
        { label: 'Souhlas', render: (r) => (r.consent_marketing ? 'ano' : 'ne') }, { label: 'Vytvořen', render: (r) => fmt.d(r.created_at) }], rows, openCustomer));
  },
  async '/products' () {
    const p = new URLSearchParams(location.search);
    const rows = await api(S('/products' + (p.get('q') ? '?q=' + encodeURIComponent(p.get('q')) : '')));
    const search = h('input', { placeholder: 'SKU, název, kategorie', value: p.get('q') || '' });
    const go2 = () => { history.pushState({}, '', BASE + '/products' + (search.value ? '?q=' + encodeURIComponent(search.value) : '')); render(); };
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    return h('div', {}, h('h2', {}, 'Katalog a ceny'),
      h('p', { class: 'muted' }, 'Zdroj pravdy pro AI. Změny cen a skladu jsou okamžitě platné a zapisují se do auditu. Upravovat smí jen administrátor.'),
      h('div', { class: 'toolbar' }, search, h('button', { onclick: go2 }, 'Hledat'), user.role === 'admin' ? h('button', { class: 'primary', onclick: () => openProduct(null) }, 'Nový produkt') : null),
      table([{ label: 'SKU', key: 'sku' }, { label: 'Název', key: 'name' }, { label: 'Kategorie', key: 'category' }, { label: 'Jedn.', key: 'unit' },
        { label: 'Cena bez DPH', num: true, render: (r) => (r.price_net == null ? h('span', { class: 'chip bad' }, 'bez ceny') : fmt.money(r.price_net)) },
        { label: 'Sklad', num: true, render: (r) => (r.stock_qty == null ? '–' : r.stock_qty) }, { label: 'Aktivní', render: (r) => (r.active ? 'ano' : 'ne') }], rows, (r) => openProduct(r.id)));
  },
  async '/usage' () {
    const d = new URLSearchParams(location.search).get('days') || '30';
    const r = await api(S('/usage?days=' + encodeURIComponent(d)));
    const num = (n) => new Intl.NumberFormat('cs-CZ').format(Math.round(n || 0));
    const usd = (n) => (n == null ? '–' : '$' + n.toFixed(n < 1 ? 3 : 2));
    const cols = (first) => [first, { label: 'Volání', num: true, render: (x) => num(x.calls) }, { label: 'Vstup', num: true, render: (x) => num(x.input) },
      { label: 'Výstup', num: true, render: (x) => num(x.output) }, { label: 'Cache čtení', num: true, render: (x) => num(x.cache_read) }, { label: 'Cena', num: true, render: (x) => usd(x.cost_usd) }];
    const sel = h('select', { onchange: (e) => { history.pushState({}, '', BASE + '/usage?days=' + e.target.value); render(); } }, ['7', '30', '90'].map((v) => h('option', { value: v, selected: v === d }, 'Posledních ' + v + ' dní')));
    return h('div', {}, h('h2', {}, 'Spotřeba AI (tokeny)'), h('div', { class: 'toolbar' }, sel),
      r.pricing_configured ? null : h('p', { class: 'muted' }, 'Ceny modelu nejsou nastavené (LLM_PRICE_* v .env) – zobrazují se jen počty tokenů.'),
      h('p', {}, `Volání LLM: ${num(r.total.calls)} · konverzací: ${r.conversations} · odhad ceny: ${usd(r.total.cost_usd)}` + (r.avg_cost_per_conversation_usd != null ? ` · na konverzaci: ${usd(r.avg_cost_per_conversation_usd)}` : '')),
      h('h3', {}, 'Podle agenta'), table(cols({ label: 'Agent', key: 'agent' }), r.by_agent),
      h('h3', {}, 'Podle dne'), table(cols({ label: 'Den', key: 'day' }), r.by_day));
  },
  async '/security' () {
    const me = (await api('/me')).user;
    const box = h('div', {});
    const showCodes = (codes) => box.replaceChildren(h('h3', {}, '2FA zapnuto'), h('p', {}, 'Uložte si záložní kódy na bezpečné místo. Každý jde použít jednou a znovu se nezobrazí.'), h('pre', {}, codes.join('\n')), h('button', { onclick: render }, 'Hotovo'));
    if (me.totp_enabled) {
      const pw = h('input', { type: 'password', placeholder: 'Heslo', autocomplete: 'current-password' });
      const code = h('input', { placeholder: 'Kód z aplikace / záložní kód', autocomplete: 'one-time-code' });
      box.append(h('p', {}, 'Dvoufázové ověření: ', h('span', { class: 'chip ok' }, 'zapnuto')), h('div', { class: 'toolbar' }, pw, code,
        h('button', { class: 'danger', onclick: async () => { try { await api('/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } }); toast('2FA vypnuto'); render(); } catch (e) { toast(e.message); } } }, 'Vypnout 2FA')));
    } else {
      box.append(h('p', {}, 'Dvoufázové ověření: ', h('span', { class: 'chip warn' }, 'vypnuto')),
        h('button', { class: 'primary', onclick: async () => {
          try {
            const r = await api('/2fa/setup', { method: 'POST' });
            const code = h('input', { placeholder: '6místný kód', inputmode: 'numeric', autocomplete: 'one-time-code' });
            box.replaceChildren(h('p', {}, 'V autentizační aplikaci (Google Authenticator, Authy, 1Password…) přidejte účet ručně s tímto klíčem:'), h('pre', {}, r.secret),
              h('details', {}, h('summary', {}, 'otpauth adresa'), h('pre', {}, r.otpauth_uri)),
              h('div', { class: 'toolbar' }, code, h('button', { class: 'primary', onclick: async () => { try { showCodes((await api('/2fa/enable', { method: 'POST', body: { code: code.value } })).recovery_codes); } catch (e) { toast(e.message); } } }, 'Zapnout')));
          } catch (e) { toast(e.message); }
        } }, 'Zapnout 2FA'));
    }
    return h('div', {}, h('h2', {}, 'Zabezpečení účtu'), h('p', { class: 'muted' }, me.email), box,
      me.role === 'admin' ? h('p', {}, h('a', { href: BASE + '/users', onclick: (e) => { e.preventDefault(); go('/users'); } }, 'Správa uživatelů →')) : null);
  },
  async '/users' () {
    if (user.role !== 'admin') return h('div', { class: 'empty' }, 'Jen pro administrátory.');
    const rows = await api(S('/users'));
    const patch = (id, body) => async () => { try { await api(S('/users/' + id), { method: 'PATCH', body }); toast('Uloženo'); render(); } catch (e) { toast(e.message); } };
    const email = h('input', { type: 'email', placeholder: 'E-mail', autocomplete: 'off' });
    const name = h('input', { placeholder: 'Jméno' });
    const role = h('select', {}, ['sales', 'viewer', 'admin'].map((r) => h('option', { value: r }, r)));
    const pw = h('input', { type: 'password', placeholder: 'Heslo (min. 12 znaků)', autocomplete: 'new-password' });
    const add = h('button', { class: 'primary', onclick: async () => { try { await api(S('/users'), { method: 'POST', body: { email: email.value, name: name.value, role: role.value, password: pw.value } }); toast('Uživatel vytvořen'); render(); } catch (e) { toast(e.message); } } }, 'Přidat');
    return h('div', {}, h('h2', {}, 'Uživatelé'),
      table([{ label: 'E-mail', key: 'email' }, { label: 'Jméno', key: 'name' },
        { label: 'Role', render: (r) => h('select', { onchange: (e) => patch(r.id, { role: e.target.value })() }, ['admin', 'sales', 'viewer'].map((x) => h('option', { value: x, selected: x === r.role }, x))) },
        { label: 'Aktivní', render: (r) => h('button', { onclick: patch(r.id, { active: !r.active }) }, r.active ? 'Deaktivovat' : 'Aktivovat') },
        { label: '2FA', render: (r) => r.totp_enabled ? h('button', { onclick: patch(r.id, { reset_2fa: true }) }, 'Zrušit 2FA') : 'vypnuto' },
        { label: 'Heslo', render: (r) => h('button', { onclick: () => { const v = prompt('Nové heslo (min. 12 znaků):'); if (v) patch(r.id, { password: v })(); } }, 'Změnit') }], rows),
      h('h3', {}, 'Nový uživatel'), h('div', { class: 'toolbar' }, email, name, role, pw, add));
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
  const r0 = r;
  const q = await api(S('/quotes/' + r.id));
  const setStatus = async (status) => { try { const res = await api(S('/quotes/' + r.id), { method: 'PATCH', body: { status } }); toast(res.pending_approval ? 'Čeká na schválení' : 'Uloženo'); dlg.close(); dlg.remove(); render(); } catch (e) { toast(e.message); } };
  const dlg = h('dialog', {}, h('h3', {}, `Nabídka ${q.number}`), h('p', { class: 'muted' }, `${q.customer_name} · `, chip(q.status)),
    table([{ label: 'SKU', key: 'sku' }, { label: 'Položka', key: 'name' }, { label: 'Množ.', num: true, key: 'qty' }, { label: 'Cena/j.', num: true, render: (i) => fmt.money(i.unit_price_net) }, { label: 'Celkem', num: true, render: (i) => fmt.money(i.line_net) }], q.items),
    h('p', {}, `Doprava: ${fmt.money(Number(q.shipping_net))} · Sleva: ${q.discount_pct} % · Celkem bez DPH: `, h('b', {}, fmt.money(Number(q.total_net))), ` · s DPH: ${fmt.money(Number(q.total_gross))}`),
    q.custom_terms ? h('p', {}, 'Vlastní podmínky: ' + q.custom_terms) : null,
    h('div', { class: 'toolbar' }, user.role !== 'viewer' ? [h('button', { onclick: () => setStatus('ready') }, 'Připraveno'), h('button', { class: 'primary', onclick: () => setStatus('sent') }, 'Označit jako odeslanou'), h('button', { class: 'danger', onclick: () => setStatus('rejected') }, 'Zamítnuta')] : null,
      user.role !== 'viewer' && ['ready', 'sent'].includes(q.status) ? h('button', { class: 'primary', onclick: async () => { if (!confirm('Odeslat nabídku s PDF zákazníkovi e-mailem?')) return; try { const r = await api(S('/quotes/' + r0.id + '/send'), { method: 'POST', body: {} }); toast(r.email_status === 'sent' ? 'E-mail odeslán' : 'E-mail se nepodařilo odeslat (' + r.email_status + ')'); dlg.close(); dlg.remove(); render(); } catch (e) { toast(e.message); } } }, 'Odeslat e-mailem s PDF') : null,
      h('button', { onclick: () => window.open('/api/admin' + S('/quotes/' + r.id + '/pdf'), '_blank', 'noopener') }, 'PDF'),
      h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Zavřít')));
  document.body.append(dlg); dlg.showModal();
}

async function openCustomer(r) {
  const d = await api(S('/customers/' + r.id)); const c = d.customer;
  const sec = (title, cols, rows) => [h('h4', {}, title), table(cols, rows)];
  const isAdmin = user.role === 'admin';
  const dlg = h('dialog', {}, h('h3', {}, c.erased_at ? 'Anonymizovaný zákazník' : c.name),
    h('p', { class: 'muted' }, [c.company_name, c.ico && 'IČO ' + c.ico, c.email, c.phone, [c.street, c.postal_code, c.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '–'),
    c.note ? h('p', {}, c.note) : null,
    sec('Leady', [{ label: 'Stav', render: (x) => chip(x.status) }, { label: 'Skóre', num: true, key: 'score' }, { label: 'Shrnutí', key: 'summary' }], d.leads),
    sec('Projekty', [{ label: 'Projekt', key: 'name' }, { label: 'Stav', render: (x) => chip(x.status) }, { label: 'Hodnota', num: true, render: (x) => fmt.money(x.estimated_value_net) }], d.projects),
    sec('Nabídky', [{ label: 'Číslo', key: 'number' }, { label: 'Stav', render: (x) => chip(x.status) }, { label: 'Bez DPH', num: true, render: (x) => fmt.money(x.total_net) }], d.quotes),
    sec('Follow-upy', [{ label: 'Termín', render: (x) => fmt.dt(x.due_at) }, { label: 'Účel', key: 'purpose' }, { label: 'Stav', render: (x) => chip(x.status) }], d.followups),
    sec('E-maily', [{ label: 'Datum', render: (x) => fmt.dt(x.created_at) }, { label: 'Předmět', key: 'subject' }, { label: 'Stav', render: (x) => chip(x.status) }], d.emails),
    h('div', { class: 'toolbar' },
      isAdmin && !c.erased_at ? h('button', { onclick: () => window.open('/api/admin' + S('/customers/' + c.id + '/export'), '_blank', 'noopener') }, 'Export dat (GDPR)') : null,
      isAdmin && !c.erased_at ? h('button', { class: 'danger', onclick: async () => {
        if (prompt('Anonymizace je nevratná. Pro potvrzení napište ANONYMIZOVAT:') !== 'ANONYMIZOVAT') return;
        try { await api(S('/customers/' + c.id + '/erase'), { method: 'POST', body: {} }); toast('Zákazník anonymizován'); dlg.close(); dlg.remove(); render(); } catch (e) { toast(e.message); } } }, 'Anonymizovat (GDPR výmaz)') : null,
      h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Zavřít')));
  document.body.append(dlg); dlg.showModal();
}

async function openProduct(id) {
  const d = id ? await api(S('/products/' + id)) : { product: { sku: '', name: '', description: '', category: 'ostatni', unit: 'ks', weight_kg: 0, attributes: {}, active: true }, prices: [], stock: null, calc_rule: null, accessories: [] };
  const pr = d.product; const cur = d.prices.find((x) => x.price_list === 'retail'); const edit = user.role === 'admin';
  const f = (label, value, attrs = {}) => { const i = h('input', { value: value ?? '', disabled: !edit || attrs.disabled, ...attrs }); return [h('label', {}, label), i, i]; };
  const sku = f('SKU', pr.sku, { disabled: !!id }), name = f('Název', pr.name), desc = h('textarea', { rows: '3', disabled: !edit }, pr.description || '');
  const cat = f('Kategorie', pr.category), unit = f('Jednotka', pr.unit), weight = f('Hmotnost 1 jednotky (kg)', pr.weight_kg);
  const active = h('input', { type: 'checkbox', checked: !!pr.active, disabled: !edit });
  const attrs = h('textarea', { rows: '4', disabled: !edit }, JSON.stringify(pr.attributes || {}, null, 2));
  const price = f('Cena bez DPH', cur?.amount_net), vat = f('DPH %', cur?.vat_rate ?? 21);
  const stock = f('Skladem', d.stock?.qty_available), lead = f('Dodací lhůta (dny)', d.stock?.lead_time_days ?? 14);
  const cr = d.calc_rule || {}; const cons = f('Spotřeba na m²', cr.consumption_per_m2), waste = f('Ztráty %', cr.waste_pct ?? 5), pack = f('Velikost balení', cr.pack_size ?? 1), packLabel = f('Název balení', cr.pack_label ?? 'ks');
  const num = (el) => (el.value.trim() === '' ? undefined : Number(el.value.replace(',', '.')));
  const save = async () => {
    try {
      const body = { name: name[1].value, description: desc.value, category: cat[1].value, unit: unit[1].value, weight_kg: num(weight[1]), active: active.checked };
      if (!id) body.sku = sku[1].value;
      try { body.attributes = JSON.parse(attrs.value || '{}'); } catch { toast('Parametry musí být platný JSON objekt'); return; }
      if (num(price[1]) !== undefined) { body.price_net = num(price[1]); body.vat_rate = num(vat[1]); }
      if (num(stock[1]) !== undefined) { body.stock_qty = num(stock[1]); body.lead_time_days = num(lead[1]); }
      if (num(cons[1]) !== undefined) body.calc_rule = { consumption_per_m2: num(cons[1]), waste_pct: num(waste[1]), pack_size: num(pack[1]), pack_label: packLabel[1].value };
      await api(S(id ? '/products/' + id : '/products'), { method: id ? 'PATCH' : 'POST', body });
      toast('Uloženo'); dlg.close(); dlg.remove(); render();
    } catch (e) { toast(e.message); }
  };
  const dlg = h('dialog', {}, h('h3', {}, id ? pr.sku : 'Nový produkt'),
    h('div', { class: 'form' }, sku[0], sku[1], name[0], name[1], h('label', {}, 'Popis'), desc, cat[0], cat[1], unit[0], unit[1], weight[0], weight[1],
      h('label', {}, 'Aktivní (nabízet zákazníkům)'), active, h('label', {}, 'Technické parametry (JSON)'), attrs,
      h('h4', {}, 'Cena a sklad'), price[0], price[1], vat[0], vat[1], stock[0], stock[1], lead[0], lead[1],
      h('h4', {}, 'Kalkulace materiálu'), cons[0], cons[1], waste[0], waste[1], pack[0], pack[1], packLabel[0], packLabel[1]),
    d.accessories.length ? [h('h4', {}, 'Příslušenství (změny přes import CSV)'), table([{ label: 'SKU', key: 'sku' }, { label: 'Název', key: 'name' }, { label: 'Základ', key: 'basis' }, { label: 'Koef.', num: true, key: 'factor' }], d.accessories)] : null,
    d.prices.length ? [h('h4', {}, 'Historie cen'), table([{ label: 'Od', render: (x) => fmt.d(x.valid_from) }, { label: 'Do', render: (x) => fmt.d(x.valid_to) }, { label: 'Ceník', key: 'price_list' }, { label: 'Bez DPH', num: true, render: (x) => fmt.money(x.amount_net) }], d.prices)] : null,
    h('div', { class: 'toolbar' }, edit ? h('button', { class: 'primary', onclick: save }, 'Uložit') : null, h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Zavřít')));
  document.body.append(dlg); dlg.showModal();
}

function loginView() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '16', placeholder: '6 číslic nebo záložní kód' });
  const codeRow = h('div', { hidden: true }, h('label', {}, 'Ověřovací kód (2FA)'), code);
  const err = h('div', { class: 'err' });
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value, code: code.value || undefined } }); user = r.user; render();
    } catch (ex) {
      if (ex.code === 'totp_required') { codeRow.hidden = false; code.focus(); err.textContent = 'Zadejte ověřovací kód z aplikace.'; } else err.textContent = ex.message;
    }
  } }, h('h1', {}, 'AI SALES – přihlášení'), h('label', {}, 'E-mail'), email, h('label', {}, 'Heslo'), pw, codeRow, h('button', { class: 'primary', type: 'submit' }, 'Přihlásit'), err);
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
