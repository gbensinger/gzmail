// Demo mode (?demo): fake data in a separate local database, no Gmail access. For trying the UI.
import * as db from './db.js';
import { ME } from './config.js';

const people = [
  { id: 'd1', name: 'Sarah Lee', addresses: ['sarah@example.com'] },
  { id: 'd2', name: 'Dad', addresses: ['dad@example.net', 'pop@example.org'] },
  { id: 'd3', name: 'Marcus Chen', addresses: ['marcus@example.com'] },
];
const lines = [
  'Are we still on for Saturday?', 'Yes! 10am works for me.', 'Great, see you then.',
  'Did you get a chance to look at the photos?', 'Not yet, will tonight.',
  'Here is the article I mentioned: https://example.com/article', 'Thanks, that was a good read.',
  'Can you call me when you get a minute?', 'On my way.', 'Happy birthday!! 🎉',
  'Running 10 minutes late, sorry.', 'No worries.',
  'I was thinking about the trip again and I think we should leave Friday instead of Saturday. That gives us a full day there, and traffic should be lighter. What do you think?',
];

export async function fakeGmail(real) {
  if (!(await db.all('contacts')).length) {
    let t = Date.now() - 400 * 864e5, n = 0;
    for (const p of people) {
      const msgs = [];
      let d = t + Math.random() * 864e5;
      for (let i = 0; i < 40; i++) {
        d += Math.random() < 0.3 ? 6e4 * (2 + Math.random() * 30) : 864e5 * Math.random() * 20;
        if (d > Date.now()) break;
        const out = Math.random() < 0.45;
        const them = { name: p.name, email: p.addresses[i % p.addresses.length] };
        msgs.push({
          id: 'm' + n++, threadId: 't' + Math.floor(i / 4) + p.id, date: d,
          from: out ? { name: '', email: ME } : them, to: [out ? them : { name: '', email: ME }],
          cc: i % 9 === 0 ? [{ name: 'Alex Kim', email: 'alex@example.com' }] : [], bcc: [],
          subject: (i % 4 ? 'Re: ' : '') + ['Weekend plans', 'Photos', 'Quick question', 'The trip'][Math.floor(i / 4) % 4],
          msgId: '', refs: '', out, text: lines[(i + n) % lines.length],
          full: '', atts: i % 11 === 5 ? [{ name: 'IMG_2041.jpg', size: 2_400_000 }] : [], contactIds: [p.id],
        });
      }
      msgs.at(-1).full = msgs.at(-1).text + '\n\nOn Mon, someone wrote:\n> earlier quoted text that the bubble hides';
      await db.upsertMessages(msgs);
      await db.put('contacts', { ...p, seen: 0 });
      await real.refreshSummary(p.id);
    }
  }
  return {
    ...real,
    hasToken: () => true,
    signIn: async () => {},
    sync: async () => [],
    backfill: async c => { await db.put('contacts', { ...c, count: 0 }); },
    send: async ({ to, cc, subject, body, replyTo, contactId }) => {
      const m = { id: 'm' + Date.now(), threadId: replyTo?.threadId || 'new', date: Date.now(), from: { name: '', email: ME },
        to, cc, bcc: [], subject, msgId: '', refs: '', out: true, text: body, full: '', atts: [], contactIds: [contactId] };
      await db.upsertMessages([m]);
      await real.refreshSummary(contactId);
    },
  };
}
