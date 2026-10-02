'use strict';
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('msg');
let conv = null;
try { conv = sessionStorage.getItem('beleta_conv'); } catch { /* storage nedostupné */ }

function add(text, me, sources) {
  const d = document.createElement('div');
  d.className = 'm' + (me ? ' me' : '');
  d.textContent = text;
  if (sources && sources.length) {
    const s = document.createElement('small');
    s.textContent = 'Zdroje: ' + [...new Set(sources.map((x) => x.system))].join(', ');
    d.append(s);
  }
  log.append(d); log.scrollTop = log.scrollHeight;
}
add('Dobrý den, jsem AI poradce BELETA Plus. S čím vám mohu pomoci?', false);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  add(text, true); input.value = ''; form.querySelector('button').disabled = true;
  try {
    const res = await fetch('/api/public/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, conversation_id: conv || undefined }) });
    const data = await res.json();
    if (!res.ok) add(data.error?.message || 'Chyba, zkuste to prosím znovu.', false);
    else { conv = data.conversation_id; try { sessionStorage.setItem('beleta_conv', conv); } catch { /* ignore */ } add(data.reply, false, data.sources); }
  } catch { add('Spojení se nezdařilo, zkuste to prosím znovu.', false); }
  form.querySelector('button').disabled = false; input.focus();
});
