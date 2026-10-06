// Tiny IndexedDB wrapper. Stores: contacts, messages (indexed by contactIds), meta.
const DB_NAME = new URLSearchParams(location.search).has('demo') ? 'gzmail-demo' : 'gzmail';
let dbp;

function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('contacts', { keyPath: 'id' });
      d.createObjectStore('messages', { keyPath: 'id' })
        .createIndex('byContact', 'contactIds', { multiEntry: true });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function tx(store, mode, fn) {
  const t = (await open()).transaction(store, mode);
  const out = fn(t.objectStore(store));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  return out instanceof IDBRequest ? out.result : out;
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const all = (store) => tx(store, 'readonly', s => s.getAll());
export const put = (store, val, key) => tx(store, 'readwrite', s => s.put(val, key));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const meta = (key) => get('meta', key);
export const setMeta = (key, val) => put('meta', val, key);

export const messagesFor = (contactId) =>
  tx('messages', 'readonly', s => s.index('byContact').getAll(contactId))
    .then(list => list.sort((a, b) => a.date - b.date));

// Which of these message ids are already stored?
export async function existingIds(ids) {
  const s = (await open()).transaction('messages').objectStore('messages');
  const found = await Promise.all(ids.map(id => req(s.getKey(id))));
  return new Set(found.filter(Boolean));
}

// Insert messages, merging contactIds with any copy already stored.
export function upsertMessages(msgs) {
  return tx('messages', 'readwrite', s => {
    for (const m of msgs) {
      const g = s.get(m.id);
      g.onsuccess = () => {
        const old = g.result;
        if (old) m.contactIds = [...new Set([...old.contactIds, ...m.contactIds])];
        s.put(m);
      };
    }
  });
}

export async function linkMessages(ids, contactId) {
  return tx('messages', 'readwrite', s => {
    for (const id of ids) {
      const g = s.get(id);
      g.onsuccess = () => {
        const m = g.result;
        if (m && !m.contactIds.includes(contactId)) { m.contactIds.push(contactId); s.put(m); }
      };
    }
  });
}

// Remove a contact and any messages no longer linked to a contact.
export async function deleteContact(id) {
  await tx('messages', 'readwrite', s => {
    const c = s.index('byContact').openCursor(IDBKeyRange.only(id));
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return;
      const m = cur.value;
      m.contactIds = m.contactIds.filter(x => x !== id);
      m.contactIds.length ? cur.update(m) : cur.delete();
      cur.continue();
    };
  });
  await del('contacts', id);
}

export async function wipe() {
  (await open()).close();
  dbp = null;
  await req(indexedDB.deleteDatabase(DB_NAME));
}
