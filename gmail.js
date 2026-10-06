// Gmail API access, message parsing, and sync. No AI and no server: the phone talks to Gmail directly.
import { CLIENT_ID, ME } from './config.js';
import * as db from './db.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
const SKIP_LABELS = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'];

// ---------- auth (Google Identity Services, token stays on this device) ----------
let token = null, expires = 0, tokenClient;
try { ({ token, expires } = JSON.parse(localStorage.getItem('gz.token')) || {}); } catch {}

export const hasToken = () => !!token && Date.now() < expires - 60_000;

export function signIn() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in did not load'));
    tokenClient ||= google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, hint: ME, callback() {} });
    tokenClient.callback = r => {
      if (r.error) return reject(new Error(r.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES.split(' ')))
        return reject(new Error('Please allow both read and send access'));
      token = r.access_token;
      expires = Date.now() + r.expires_in * 1000;
      localStorage.setItem('gz.token', JSON.stringify({ token, expires }));
      resolve();
    };
    tokenClient.error_callback = e => reject(new Error(e.message || e.type));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  if (token) google?.accounts?.oauth2?.revoke(token, () => {});
  token = null; expires = 0;
  localStorage.removeItem('gz.token');
}

export class AuthError extends Error {}

// Gmail allows 250 quota units/sec per user (a message fetch costs 5), so space requests ~30ms apart.
let nextSlot = 0;
const sleep = ms => new Promise(s => setTimeout(s, ms));
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 30;
  if (wait) await sleep(wait);
}

const RETRY_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'quotaExceeded'];

async function api(path, opts = {}, attempt = 0) {
  if (!hasToken()) throw new AuthError('Not signed in');
  await throttle();
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...opts.headers } });
  if (r.status === 401) { token = null; localStorage.removeItem('gz.token'); throw new AuthError('Session expired'); }
  if (r.ok) return r.json();
  const err = await r.json().catch(() => ({}));
  const reason = err.error?.errors?.[0]?.reason || err.error?.status || '';
  const retry = r.status === 429 || r.status >= 500 || (r.status === 403 && RETRY_REASONS.includes(reason));
  if (retry && attempt < 6) {
    await sleep(Math.min(32, 2 ** attempt) * 1000 + Math.random() * 1000);
    return api(path, opts, attempt + 1);
  }
  const e = new Error(`Gmail ${r.status}${reason ? ' ' + reason : ''}: ${err.error?.message || r.statusText}`);
  e.status = r.status;
  throw e;
}

// Run fn over items with limited concurrency (Gmail allows ~50 message fetches/sec).
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// ---------- parsing ----------
export function parseAddrs(s = '') {
  const out = [];
  const re = /(?:"([^"]*)"|([^,<"]*?))\s*<([^>]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;
  for (let m; (m = re.exec(s));) {
    const email = (m[3] || m[4]).trim().toLowerCase();
    const name = (m[1] ?? m[2] ?? '').trim().replace(/^'|'$/g, '');
    out.push({ name: name && name.toLowerCase() !== email ? name : '', email });
  }
  return out;
}

function decode(data, charset) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}

function charsetOf(part) {
  const ct = part.headers?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  return /charset="?([^";\s]+)/i.exec(ct)?.[1];
}

function walk(part, acc) {
  const isAtt = part.filename || part.body?.attachmentId && !part.mimeType.startsWith('text/');
  if (part.filename) acc.atts.push({ name: part.filename, size: part.body?.size || 0 });
  else if (!isAtt && part.body?.data) {
    if (part.mimeType === 'text/plain' && acc.plain == null) acc.plain = decode(part.body.data, charsetOf(part));
    if (part.mimeType === 'text/html' && acc.html == null) acc.html = decode(part.body.data, charsetOf(part));
  }
  part.parts?.forEach(p => walk(p, acc));
}

// HTML -> text. DOMParser documents are inert: no scripts run, no images load.
function htmlToText(html, dropQuotes) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style,script,head,title').forEach(e => e.remove());
  if (dropQuotes) {
    doc.querySelectorAll('.gmail_quote,blockquote,.gmail_signature,#appendonsend,#divRplyFwdMsg,.moz-cite-prefix')
      .forEach(e => e.remove());
    const rply = doc.querySelector('#divRplyFwdMsg, hr#stopSpelling');
    if (rply) { let n = rply; while (n) { const nx = n.nextSibling; n.remove(); n = nx; } }
  }
  doc.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,h5,h6,table').forEach(b => b.append('\n'));
  return (doc.body?.textContent || '').replace(/ /g, ' ');
}

const tidy = t => t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Cut quoted replies, forwarded headers and signatures so a bubble reads like a text.
export function stripQuotes(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const next3 = [t, ...lines.slice(i + 1, i + 3).map(x => x.trim())].join(' ');
    if (/^On\b/i.test(t) && /^On\b.{0,250}?wrote:/i.test(next3)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(t)) break;
    if (/^_{10,}$/.test(t)) break;
    if (/^From:\s/i.test(t) && lines.slice(i + 1, i + 5).some(x => /^(Sent|Date|To):/i.test(x.trim()))) break;
    if (lines[i] === '-- ' || t === '--') break;
    if (t.startsWith('>')) continue;
    if (/^(Sent from my|Get Outlook for|Sent via|Sent from Yahoo)/i.test(t)) continue;
    out.push(lines[i]);
  }
  return tidy(out.join('\n'));
}

const header = (m, name) => m.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value || '';

export function parseMessage(m) {
  const acc = { atts: [], plain: null, html: null };
  walk(m.payload, acc);
  const full = tidy(acc.plain ?? (acc.html ? htmlToText(acc.html, false) : ''));
  let text = acc.plain != null ? stripQuotes(acc.plain) : acc.html ? stripQuotes(htmlToText(acc.html, true)) : '';
  if (!text) text = full ? stripQuotes(full) || full : decodeEntities(m.snippet || '');
  const from = parseAddrs(header(m, 'from'))[0] || { name: '', email: '' };
  return {
    id: m.id,
    threadId: m.threadId,
    date: Number(m.internalDate),
    from,
    to: parseAddrs(header(m, 'to')),
    cc: parseAddrs(header(m, 'cc')),
    bcc: parseAddrs(header(m, 'bcc')),
    subject: header(m, 'subject'),
    msgId: header(m, 'message-id'),
    refs: header(m, 'references'),
    out: m.labelIds?.includes('SENT') || from.email === ME,
    text, full: full !== text ? full : '',
    atts: acc.atts,
    contactIds: [],
  };
}

function decodeEntities(s) {
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
}

const participants = m => [m.from, ...m.to, ...m.cc, ...m.bcc].map(a => a.email);

function matchContacts(m, contacts) {
  const people = new Set(participants(m));
  return contacts.filter(c => c.addresses.some(a => people.has(a))).map(c => c.id);
}

// ---------- contacts summary ----------
export async function refreshSummary(contactId) {
  const c = await db.get('contacts', contactId);
  if (!c) return;
  const msgs = await db.messagesFor(contactId);
  const last = msgs.at(-1);
  c.last = last ? { date: last.date, text: last.text.slice(0, 140), out: last.out } : null;
  c.count = msgs.length;
  await db.put('contacts', c);
}

async function ensureHistoryId() {
  if (!(await db.meta('historyId'))) {
    const p = await api('profile');
    await db.setMeta('historyId', p.historyId);
  }
}

// ---------- full history for one contact ----------
export async function backfill(contact, onProgress = () => {}) {
  await ensureHistoryId();
  const q = '{' + contact.addresses.map(a => `from:${a} to:${a} cc:${a} bcc:${a}`).join(' ') + '}';
  const ids = [];
  let pageToken = '';
  do {
    const r = await api(`messages?maxResults=500&q=${encodeURIComponent(q)}` + (pageToken ? `&pageToken=${pageToken}` : ''));
    r.messages?.forEach(m => ids.push(m.id));
    pageToken = r.nextPageToken;
    onProgress(0, ids.length);
  } while (pageToken);

  const have = await db.existingIds(ids);
  await db.linkMessages([...have], contact.id);
  const todo = ids.filter(id => !have.has(id));
  let done = 0, batch = [];
  const flush = async () => { const b = batch; batch = []; if (b.length) await db.upsertMessages(b); };
  await pool(todo, 8, async id => {
    const raw = await api(`messages/${id}?format=full`);
    if (!raw.labelIds?.some(l => SKIP_LABELS.includes(l))) {
      const m = parseMessage(raw);
      m.contactIds = [contact.id];
      batch.push(m);
    }
    done++;
    if (batch.length >= 50) await flush();
    if (done % 10 === 0 || done === todo.length) onProgress(done, todo.length);
  });
  await flush();
  await refreshSummary(contact.id);
}

// ---------- incremental sync: only what changed since last time ----------
export async function sync() {
  const contacts = await db.all('contacts');
  const start = await db.meta('historyId');
  if (!start) return ensureHistoryId();
  let ids = new Set(), pageToken = '', latest = start;
  try {
    do {
      const r = await api(`history?historyTypes=messageAdded&startHistoryId=${start}` + (pageToken ? `&pageToken=${pageToken}` : ''));
      r.history?.forEach(h => h.messagesAdded?.forEach(({ message: m }) => {
        if (!m.labelIds?.some(l => SKIP_LABELS.includes(l))) ids.add(m.id);
      }));
      latest = r.historyId || latest;
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e.status !== 404) throw e;
    // History too old (Gmail keeps about a week): re-check each contact; already-stored messages are skipped.
    const p = await api('profile');
    for (const c of contacts) await backfill(c);
    await db.setMeta('historyId', p.historyId);
    return contacts.map(c => c.id);
  }
  const touched = new Set();
  const found = [];
  const have = await db.existingIds([...ids]);
  await pool([...ids].filter(id => !have.has(id)), 6, async id => {
    let raw;
    try { raw = await api(`messages/${id}?format=full`); } catch (e) { if (e.status === 404) return; throw e; }
    if (raw.labelIds?.some(l => SKIP_LABELS.includes(l))) return;
    const m = parseMessage(raw);
    m.contactIds = matchContacts(m, contacts);
    if (m.contactIds.length) { found.push(m); m.contactIds.forEach(c => touched.add(c)); }
  });
  if (found.length) await db.upsertMessages(found);
  for (const c of touched) await refreshSummary(c);
  await db.setMeta('historyId', latest);
  return [...touched];
}

// ---------- sending ----------
const b64 = bytes => { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s); };
const utf8 = s => new TextEncoder().encode(s);
const encHeader = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(utf8(s))}?=` : s;
const fmtAddr = a => a.name ? `${encHeader(/[",<>@]/.test(a.name) ? `"${a.name.replace(/"/g, '')}"` : a.name)} <${a.email}>` : a.email;

function sendRaw({ to, cc = [], subject, body, replyTo }) {
  const lines = [
    `From: ${ME}`,
    `To: ${to.map(fmtAddr).join(', ')}`,
    cc.length && `Cc: ${cc.map(fmtAddr).join(', ')}`,
    `Subject: ${encHeader(subject)}`,
    replyTo?.msgId && `In-Reply-To: ${replyTo.msgId}`,
    replyTo?.msgId && `References: ${[replyTo.refs, replyTo.msgId].filter(Boolean).join(' ')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(utf8(body)).replace(/.{76}/g, '$&\r\n'),
  ].filter(x => typeof x === 'string');
  const raw = b64(utf8(lines.join('\r\n'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return api('messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(replyTo?.threadId ? { raw, threadId: replyTo.threadId } : { raw }),
  });
}

export async function send({ contactId, ...msg }) {
  const sent = await sendRaw(msg);
  const m = parseMessage(await api(`messages/${sent.id}?format=full`));
  m.contactIds = matchContacts(m, await db.all('contacts'));
  if (!m.contactIds.includes(contactId)) m.contactIds.push(contactId);
  await db.upsertMessages([m]);
  for (const c of m.contactIds) await refreshSummary(c);
  return m;
}

// ---------- contact list backup (an email to yourself, so every device can restore it) ----------
const BACKUP_SUBJECT = 'GzMail contact list backup';
const BACKUP_START = '----- GZMAIL CONTACTS START -----', BACKUP_END = '----- GZMAIL CONTACTS END -----';

export async function backupContacts(contacts) {
  const list = contacts.map(c => ({ name: c.name, addresses: c.addresses }));
  const body = 'GzMail uses this email to restore your contact list on another device. ' +
    'Only the newest one is used, so older copies can be deleted.\n\n' +
    list.map(c => `${c.name}: ${c.addresses.join(', ')}`).join('\n') +
    `\n\n${BACKUP_START}\n${JSON.stringify(list)}\n${BACKUP_END}\n`;
  await sendRaw({ to: [{ name: '', email: ME }], subject: `${BACKUP_SUBJECT} (${list.length} contacts)`, body });
}

// Returns [{name, addresses}] from the newest backup email, or null if none exists.
export async function fetchBackup() {
  const q = encodeURIComponent(`from:${ME} to:${ME} subject:"${BACKUP_SUBJECT}"`);
  const r = await api(`messages?maxResults=1&q=${q}`);
  if (!r.messages?.length) return null;
  const acc = { atts: [], plain: null, html: null };
  walk((await api(`messages/${r.messages[0].id}?format=full`)).payload, acc);
  const text = acc.plain ?? htmlToText(acc.html || '', false);
  const json = text.slice(text.indexOf(BACKUP_START) + BACKUP_START.length, text.indexOf(BACKUP_END));
  return JSON.parse(json.replace(/\s*\n\s*/g, ''));
}
