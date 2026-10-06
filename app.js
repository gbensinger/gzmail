import * as db from './db.js';
import * as real from './gmail.js';
import { ME } from './config.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const gm = DEMO ? await import('./demo.js').then(d => d.fakeGmail(real)) : real;
const $ = s => document.querySelector(s);
const PAGE = 150;

let contacts = [];
let chat = null; // { contact, msgs, shown, replyTo, replyAll, newSubject }
let syncing = false;

// ---------- formatting ----------
const DAY = 864e5;
const startOfDay = d => new Date(d).setHours(0, 0, 0, 0);
const time = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function shortDate(d) {
  const diff = (startOfDay(Date.now()) - startOfDay(d)) / DAY;
  if (diff < 1) return time(d);
  if (diff < 2) return 'Yesterday';
  if (diff < 7) return new Date(d).toLocaleDateString([], { weekday: 'short' });
  return new Date(d).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}
function stampDate(d) {
  const diff = (startOfDay(Date.now()) - startOfDay(d)) / DAY;
  const dt = new Date(d);
  const day = diff < 1 ? 'Today' : diff < 2 ? 'Yesterday' : diff < 7 ? dt.toLocaleDateString([], { weekday: 'long' })
    : dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(dt.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
  return [day, time(d)];
}
const normSubj = s => (s || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtAddr = a => a.name ? `${a.name} <${a.email}>` : a.email;
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) * 137 % 360;

function linkify(parent, text) {
  text.split(/(https?:\/\/[^\s<>"]+)/).forEach((part, i) => {
    if (i % 2) {
      const a = el('a', null, part.length > 60 ? part.slice(0, 57) + '…' : part);
      a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
      parent.append(a);
    } else if (part) parent.append(part);
  });
}

// ---------- contact list ----------
async function loadContacts() {
  contacts = (await db.all('contacts')).sort((a, b) => (b.last?.date || 0) - (a.last?.date || 0));
  renderContacts();
}

function renderContacts() {
  const q = $('#search').value.trim().toLowerCase();
  const ul = $('#contacts');
  ul.replaceChildren();
  for (const c of contacts) {
    if (q && !c.name.toLowerCase().includes(q) && !c.addresses.some(a => a.includes(q))) continue;
    const li = el('li');
    if (c.last && !c.last.out && c.last.date > (c.seen || 0)) li.classList.add('unread');
    const av = el('div', 'avatar', c.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase());
    av.style.background = `hsl(${hue(c.id)} 45% 50%)`;
    const main = el('div', 'row-main');
    const top = el('div', 'row-top');
    top.append(el('b', null, c.name), el('time', null, c.last ? shortDate(c.last.date) : ''));
    const pv = c.last ? (c.last.out ? 'You: ' : '') + c.last.text.replace(/\s+/g, ' ') : c.count === 0 ? 'No emails yet' : 'Loading…';
    main.append(top, el('div', 'preview', pv));
    li.append(av, main);
    li.onclick = () => location.hash = 'c/' + c.id;
    ul.append(li);
  }
  $('#empty').hidden = contacts.length > 0;
}

// ---------- chat ----------
async function openChat(id) {
  const contact = await db.get('contacts', id);
  if (!contact) return (location.hash = '');
  chat = { contact, msgs: await db.messagesFor(id), shown: PAGE, replyTo: null, replyAll: false, newSubject: false };
  $('#chatTitle').textContent = contact.name;
  $('#list').hidden = true; $('#chat').hidden = false;
  setNewSubject(chat.msgs.length === 0);
  renderChat(true);
  markSeen(contact);
}

async function markSeen(c) {
  if (c.last && c.seen !== c.last.date) { c.seen = c.last.date; await db.put('contacts', c); }
}

async function reloadChat() {
  if (!chat) return;
  const sc = $('#scroller');
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  chat.contact = await db.get('contacts', chat.contact.id) || chat.contact;
  chat.msgs = await db.messagesFor(chat.contact.id);
  renderChat(atBottom);
  markSeen(chat.contact);
}

function renderChat(scrollBottom) {
  const { msgs, contact } = chat;
  const list = msgs.slice(-chat.shown);
  const frag = document.createDocumentFragment();
  const others = new Set([ME, ...contact.addresses]);
  list.forEach((m, i) => {
    const prev = list[i - 1], next = list[i + 1];
    const newBlock = !prev || m.date - prev.date > 36e5;
    if (newBlock) {
      const [d, t] = stampDate(m.date);
      const s = el('div', 'stamp'); s.append(el('b', null, d), ' ' + t); frag.append(s);
    }
    const tail = !next || next.out !== m.out || next.date - m.date > 36e5;
    const row = el('div', 'msg' + (m.out ? ' out' : '') + (tail ? ' tail' : ''));
    const b = el('div', 'bubble');
    b.dataset.id = m.id;
    if (!prev || normSubj(m.subject) !== normSubj(prev.subject)) {
      if (m.subject) b.append(el('span', 'subj', m.subject));
    }
    let text = m.text;
    if (text.length > 1500) text = text.slice(0, 1500).trimEnd() + '…  (tap for full email)';
    if (text) linkify(b, text);
    else if (!m.atts.length) { b.classList.add('empty'); b.append('(no text)'); }
    for (const a of m.atts) { b.append(m.text || a !== m.atts[0] ? '\n' : ''); b.append(el('span', 'att', '📎 ' + a.name)); }
    row.append(b);
    const extra = [...m.to, ...m.cc].filter(a => !others.has(a.email) && a.email !== m.from.email).length;
    if (tail || extra) row.append(el('div', 'meta', [tail && time(m.date), extra && `+${extra} other${extra > 1 ? 's' : ''}`].filter(Boolean).join(' · ')));
    frag.append(row);
  });
  const sc = $('#scroller');
  const fromBottom = sc.scrollHeight - sc.scrollTop;
  $('#bubbles').replaceChildren(frag);
  sc.scrollTop = scrollBottom ? sc.scrollHeight : sc.scrollHeight - fromBottom;
  updateReplyChip();
}

// Load older messages when scrolled to the top.
new IntersectionObserver(([e]) => {
  if (e.isIntersecting && chat && chat.shown < chat.msgs.length) { chat.shown += PAGE; renderChat(false); }
}, { root: $('#scroller'), rootMargin: '400px 0px 0px 0px' }).observe($('#top'));

$('#bubbles').onclick = e => {
  if (e.target.closest('a')) return;
  const b = e.target.closest('.bubble');
  if (b) showDetail(chat.msgs.find(m => m.id === b.dataset.id));
};

function showDetail(m) {
  const dl = $('#detailMeta');
  dl.replaceChildren();
  const rows = [['From', fmtAddr(m.from)], ['To', m.to.map(fmtAddr).join(', ')], ['Cc', m.cc.map(fmtAddr).join(', ')],
    ['Bcc', m.bcc.map(fmtAddr).join(', ')], ['Date', new Date(m.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })], ['Subject', m.subject]];
  for (const [k, v] of rows) if (v) dl.append(el('dt', null, k), el('dd', null, v));
  $('#detailAtts').textContent = m.atts.map(a => `📎 ${a.name} (${Math.ceil(a.size / 1024)} KB)`).join('   ');
  $('#detailBody').textContent = m.full || m.text;
  $('#openGmail').href = `https://mail.google.com/mail/u/${ME}/#all/${m.threadId}`;
  $('#replyAll').hidden = [...m.to, ...m.cc].filter(a => a.email !== ME).length + (m.out ? 0 : 1) < 2;
  $('#replyHere').onclick = () => { setReply(m, false); $('#detail').close(); };
  $('#replyAll').onclick = () => { setReply(m, true); $('#detail').close(); };
  $('#detail').showModal();
  $('#detailBody').scrollTop = 0;
}

// ---------- composing ----------
function setReply(m, all) {
  chat.replyTo = m; chat.replyAll = all;
  setNewSubject(false);
  $('#msg').focus();
}

function setNewSubject(on) {
  chat.newSubject = on;
  $('#subject').hidden = !on;
  if (!on) $('#subject').value = '';
  updateReplyChip();
  updateSend();
}

function target() {
  const c = chat.contact;
  const r = chat.replyTo || chat.msgs.at(-1);
  if (chat.newSubject || !r) return { to: [{ name: c.name, email: c.addresses[0] }], cc: [], subject: $('#subject').value.trim(), replyTo: null };
  const everyone = [r.from, ...r.to, ...r.cc];
  const toAddr = everyone.find(a => c.addresses.includes(a.email))?.email || c.addresses[0];
  const seen = new Set([ME, toAddr]);
  const cc = chat.replyAll ? everyone.filter(a => !seen.has(a.email) && seen.add(a.email)) : [];
  const subject = /^\s*re:/i.test(r.subject) ? r.subject : 'Re: ' + (r.subject || '');
  return { to: [{ name: c.name, email: toAddr }], cc, subject, replyTo: r };
}

function updateReplyChip() {
  if (!chat) return;
  const t = target();
  const chip = $('#replyChip');
  chip.hidden = !t.replyTo;
  if (t.replyTo) {
    chip.querySelector('span').textContent = `↩ ${t.subject}` + (t.cc.length ? `  ·  cc ${t.cc.map(a => a.name || a.email).join(', ')}` : '');
    chip.querySelector('button').hidden = !chat.replyTo;
  }
}

function updateSend() {
  const m = $('#msg');
  m.style.height = 'auto';
  m.style.height = m.scrollHeight + 2 + 'px';
  $('#sendBtn').disabled = !m.value.trim() || (chat?.newSubject && !$('#subject').value.trim());
}

$('#msg').oninput = updateSend;
$('#subject').oninput = updateSend;
$('#subjBtn').onclick = () => { setNewSubject(!chat.newSubject); (chat.newSubject ? $('#subject') : $('#msg')).focus(); };
$('#replyChip button').onclick = () => { chat.replyTo = null; chat.replyAll = false; updateReplyChip(); };

$('#composer').onsubmit = async e => {
  e.preventDefault();
  const body = $('#msg').value.trim();
  if (!body) return;
  const btn = $('#sendBtn');
  btn.disabled = true;
  try {
    if (!gm.hasToken()) await gm.signIn();
    await gm.send({ ...target(), body, contactId: chat.contact.id });
    $('#msg').value = '';
    chat.replyTo = null; chat.replyAll = false;
    setNewSubject(false);
    await reloadChat();
    $('#scroller').scrollTop = $('#scroller').scrollHeight;
    loadContacts();
  } catch (err) {
    alert('Not sent: ' + err.message);
  }
  updateSend();
};

// ---------- contacts: add / edit ----------
function openEditor(c) {
  $('#editTitle').textContent = c ? 'Edit contact' : 'New contact';
  $('#editName').value = c?.name || '';
  $('#editEmails').value = c?.addresses.join(', ') || '';
  $('#editDelete').hidden = !c;
  $('#editDelete').onclick = async () => {
    if (!confirm(`Remove ${c.name} and their stored emails from this app? (Nothing is deleted from Gmail.)`)) return;
    $('#editor').close();
    await db.deleteContact(c.id);
    location.hash = '';
  };
  $('#editor').onclose = async () => {
    if ($('#editor').returnValue !== 'ok') return;
    const addresses = [...new Set($('#editEmails').value.toLowerCase().split(/[\s,;]+/).filter(a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)))];
    if (!addresses.length) return alert('Please enter a valid email address.');
    const contact = c ? { ...c } : { id: crypto.randomUUID(), count: null, last: null, complete: false };
    const added = addresses.some(a => !c?.addresses.includes(a));
    Object.assign(contact, { name: $('#editName').value.trim(), addresses });
    if (added) contact.complete = false;
    await db.put('contacts', contact);
    if (c) { $('#chatTitle').textContent = contact.name; chat && (chat.contact = contact); }
    else location.hash = 'c/' + contact.id;
    if (contact.complete !== true) {
      if (!gm.hasToken()) try { await gm.signIn(); } catch (e) { return alert('Sign-in failed: ' + e.message); }
      queueBackfill(contact);
    }
  };
  $('#editor').returnValue = '';
  $('#editor').showModal();
}

// History loads run one at a time so they stay under Gmail's rate limit.
const queued = new Set();
let queue = Promise.resolve();
function queueBackfill(contact) {
  if (queued.has(contact.id)) return;
  queued.add(contact.id);
  queue = queue.then(() => runBackfill(contact)).finally(() => queued.delete(contact.id));
}

async function runBackfill(contact) {
  const bar = $('#progress');
  const show = () => chat?.contact.id === contact.id;
  let lastRender = 0;
  try {
    if (show()) { bar.hidden = false; bar.querySelector('span').textContent = 'Finding emails…'; }
    await gm.backfill(contact, async (done, total) => {
      if (!show()) return;
      bar.hidden = false;
      bar.querySelector('div').style.width = total ? (done / total * 100) + '%' : '0';
      bar.querySelector('span').textContent = total ? `Loading history… ${done} / ${total}` : 'Finding emails…';
      if (Date.now() - lastRender > 1500) { lastRender = Date.now(); reloadChat(); }
    });
    const c = await db.get('contacts', contact.id);
    if (c) { c.complete = true; if (c.last) c.seen = c.last.date; await db.put('contacts', c); }
  } catch (err) {
    const msg = `Couldn't finish loading ${contact.name} (${err.message}).`;
    banner(msg, 'Retry', () => withGmail(async () => queueBackfill(contact)));
    if (show()) alert(msg + '\nIt will pick up where it left off next time you refresh.');
  } finally {
    bar.hidden = true;
    if (show()) await reloadChat(); else loadContacts();
  }
}

$('#addBtn').onclick = () => openEditor(null);
$('#chatTitle').onclick = () => openEditor(chat.contact);
$('#backBtn').onclick = () => history.length > 1 ? history.back() : (location.hash = '');
$('#search').oninput = renderContacts;

// ---------- contact list backup / restore (via an email to yourself) ----------
async function withGmail(fn) {
  try {
    if (!gm.hasToken()) await gm.signIn();
    await fn();
  } catch (e) { alert(e.message); }
}

$('#menuBtn').onclick = () => $('#menu').showModal();
$('#backupBtn').onclick = () => withGmail(async () => {
  if (!contacts.length) return alert('No contacts to back up yet.');
  await gm.backupContacts(contacts);
  $('#menu').close();
  alert(`Backed up ${contacts.length} contact${contacts.length > 1 ? "s" : ""} as an email to yourself ("GzMail contact list backup"). Use Restore on your other devices.`);
});
const restore = () => withGmail(async () => {
  const list = await gm.fetchBackup();
  if (!list) return alert('No backup found. On the device that has your contacts, tap ⋯ → Back up contact list.');
  $('#menu').close();
  const have = new Set(contacts.flatMap(c => c.addresses));
  const fresh = list.filter(c => !c.addresses.some(a => have.has(a)));
  for (const c of fresh) {
    const contact = { id: crypto.randomUUID(), name: c.name, addresses: c.addresses, count: null, last: null, complete: false };
    await db.put('contacts', contact);
    queueBackfill(contact);
  }
  await loadContacts();
  alert(fresh.length ? `Restored ${fresh.length} contact${fresh.length > 1 ? "s" : ""}. Their email history is loading now, one contact at a time.` : 'All contacts in the backup are already here.');
});
$('#restoreBtn').onclick = restore;
$('#emptyRestore').onclick = restore;

// ---------- sync ----------
function banner(text, action, fn = () => doSync(true)) {
  const b = $('#banner');
  b.hidden = !text;
  b.replaceChildren();
  if (!text) return;
  b.append(text + ' ');
  if (action) { const btn = el('button', null, action); btn.onclick = fn; b.append(btn); }
}

async function doSync(interactive = false) {
  if (syncing) return;
  if (!gm.hasToken()) {
    if (!interactive) return contacts.length && banner('Showing saved emails.', 'Tap to check for new mail');
    try { await gm.signIn(); } catch (e) { return banner('Sign-in failed: ' + e.message, 'Try again'); }
  }
  syncing = true;
  $('#syncBtn').classList.add('spin');
  banner('');
  try {
    const touched = await gm.sync();
    if (chat && touched?.includes(chat.contact.id)) await reloadChat();
    await loadContacts();
    contacts.filter(c => c.complete !== true).forEach(c => queueBackfill(c)); // resume interrupted loads
  } catch (e) {
    if (e instanceof real.AuthError) banner('Gmail session expired.', 'Tap to reconnect');
    else banner('Could not reach Gmail (' + e.message + ').', 'Retry');
  } finally {
    syncing = false;
    $('#syncBtn').classList.remove('spin');
  }
}

$('#syncBtn').onclick = () => doSync(true);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && doSync());
setInterval(() => document.visibilityState === 'visible' && doSync(), 120_000);

// ---------- routing (hash keeps Android back button working) ----------
async function route() {
  const id = location.hash.match(/^#c\/(.+)/)?.[1];
  if (id) return openChat(id);
  chat = null;
  $('#chat').hidden = true; $('#list').hidden = false;
  await loadContacts();
}
addEventListener('hashchange', route);

navigator.storage?.persist?.();
if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js');
await route();
doSync();
