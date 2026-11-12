// MoneyMate backend: cloud sync + Telegram bot + reminders. Runs on Cloudflare Workers (free tier).
// Secrets: BOT_TOKEN, SYNC_TOKEN, WEBHOOK_SECRET, ALLOWED_CHAT_ID. KV binding: MM.

const TZ = 'Asia/Jerusalem';
const KEYWORDS = {
  'אוכל': ['סופר', 'שופרסל', 'רמי לוי', 'מגה', 'מסעדה', 'קפה', 'וולט', 'wolt', 'פיצה', 'מאפ', 'שוק', 'ארוחה'],
  'תחבורה': ['דלק', 'פז', 'סונול', 'רב קו', 'רב-קו', 'gett', 'חניה', 'מונית', 'כביש 6', 'אוטובוס', 'רכבת'],
  'בילויים': ['קולנוע', 'סינמה', 'netflix', 'spotify', 'הופעה', 'בר', 'פאב', 'משחק'],
  'בריאות': ['מכבי', 'כללית', 'מאוחדת', 'לאומית', 'מרקחת', 'רופא', 'תרופות', 'סופר פארם', 'סופר-פארם'],
  'קניות': ['amazon', 'אמזון', 'aliexpress', 'בגדים', 'נעליים', 'ikea', 'איקאה', 'מתנה', 'אונליין'],
  'דיור': ['ארנונה', 'חשמל', 'מים', 'גז', 'שכר דירה', 'שכירות', 'ועד בית', 'אינטרנט'],
};
const HELP = `פקודות:
• קפה 18 — הוצאה (קטגוריה נוחשת אוטומטית)
• קפה 18 אוכל — עם קטגוריה
• +5000 משכורת — הכנסה
• בטל — מבטל את הרישום האחרון
• יתרה — סיכום החודש
• תקציב — מצב התקציבים
• תזכורת מחר 9:00 לקנות חלב
• תזכורת 20/11 18:30 תור לרופא
• תזכורת בעוד 30 דקות להוציא כביסה
• תזכורת כל חודש 10 לשלם ארנונה
• תזכורות — רשימה, ו"מחק 2" למחיקה`;

/* ---------- time (Asia/Jerusalem) ---------- */
const pad = n => String(n).padStart(2, '0');
function parts(ts) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second };
}
const offsetMs = ts => { const p = parts(ts); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000; };
function localToUtc(y, m, d, hh, mm) { const g = Date.UTC(y, m - 1, d, hh, mm); let u = g - offsetMs(g); u = g - offsetMs(u); return u; }
const dateStr = ts => { const p = parts(ts); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const fmtLocal = ts => { const p = parts(ts); return `${pad(p.d)}/${pad(p.m)} ${pad(p.hh)}:${pad(p.mm)}`; };
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function nextMonthly(now, day, hh, mi) {
  const p = parts(now);
  let y = p.y, m = p.m;
  let at = localToUtc(y, m, Math.min(day, dim(y, m)), hh, mi);
  if (at <= now) { m++; if (m > 12) { m = 1; y++; } at = localToUtc(y, m, Math.min(day, dim(y, m)), hh, mi); }
  return at;
}

/* ---------- parsing ---------- */
export function parseReminder(s, now) {
  s = s.trim();
  let m = s.match(/^כל חודש\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?\s+(.+)$/);
  if (m) {
    const day = +m[1], hh = m[2] ? +m[2] : 9, mi = m[3] ? +m[3] : 0;
    if (day < 1 || day > 31 || hh > 23 || mi > 59) return { error: 'תאריך או שעה לא תקינים.' };
    return { text: m[4], every: 'month', day, time: `${pad(hh)}:${pad(mi)}`, at: nextMonthly(now, day, hh, mi) };
  }
  m = s.match(/^בעוד\s+(?:(\d+)\s+)?(דקות|דקה|שעות|שעה|שעתיים|ימים|יום)\s+(.+)$/);
  if (m) {
    let n = m[1] ? +m[1] : (m[2] === 'שעתיים' ? 2 : 1);
    const unit = m[2].startsWith('דק') ? 60e3 : m[2].startsWith('שע') ? 3600e3 : 86400e3;
    return { text: m[3], at: now + n * unit };
  }
  m = s.match(/^(היום|מחר|מחרתיים|\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?)(?:\s+(\d{1,2}):(\d{2}))?\s+(.+)$/);
  if (!m) return null;
  const hh = m[2] ? +m[2] : 9, mi = m[3] ? +m[3] : 0;
  if (hh > 23 || mi > 59) return { error: 'שעה לא תקינה.' };
  const p = parts(now);
  let y = p.y, mo = p.m, d = p.d;
  if (m[1] === 'מחר' || m[1] === 'מחרתיים') {
    const t = new Date(Date.UTC(y, mo - 1, d + (m[1] === 'מחר' ? 1 : 2)));
    y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
  } else if (m[1] !== 'היום') {
    const dm = m[1].split(/[\/.]/).map(Number);
    d = dm[0]; mo = dm[1];
    if (mo < 1 || mo > 12 || d < 1 || d > dim(y, mo)) return { error: 'תאריך לא תקין.' };
    if (dm[2]) y = dm[2] < 100 ? 2000 + dm[2] : dm[2];
    else if (localToUtc(y, mo, d, 23, 59) < now) y++;
  }
  const at = localToUtc(y, mo, d, hh, mi);
  if (at <= now) return { error: 'הזמן הזה כבר עבר.' };
  return { text: m[4], at };
}
const guess = (note, cats) => {
  const n = note.toLowerCase();
  for (const [c, ws] of Object.entries(KEYWORDS)) if (ws.some(w => n.includes(w.toLowerCase()))) return cats.includes(c) ? c : 'אחר';
  return 'אחר';
};
export function parseExpense(t, cats) {
  const income = /^[+＋]/.test(t);
  t = t.replace(/^[+＋]\s*/, '');
  const m = t.match(/(?:^|\s)(\d+(?:[.,]\d+)?)(?=\s|$)/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(',', '.'));
  if (!(amount > 0) || amount > 1e7) return null;
  const words = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim().split(/\s+/).filter(Boolean);
  let category;
  if (words.length > 1 && cats.includes(words[words.length - 1])) category = words.pop();
  const note = words.join(' ');
  if (!category) category = income ? 'אחר' : guess(note, cats);
  return { type: income ? 'income' : 'expense', amount, note, category };
}

/* ---------- storage ---------- */
const kget = async (env, k, d) => (await env.MM.get(k, 'json')) ?? d;
const kput = (env, k, v) => env.MM.put(k, JSON.stringify(v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const money = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '₪';
const rate = (st, cur) => (!cur || cur === 'ILS') ? 1 : Number((st.rates || {})[cur]) || 1;

async function send(env, chat, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!r.ok) throw new Error('telegram ' + r.status);
}

/* ---------- bot ---------- */
async function monthData(env, now) {
  const st = (await kget(env, 'state', {})).state || {};
  const inbox = await kget(env, 'inbox', []);
  const seen = new Set(), tx = [];
  for (const t of [...(st.tx || []), ...inbox]) { if (t && !seen.has(String(t.id))) { seen.add(String(t.id)); tx.push(t); } }
  const month = dateStr(now).slice(0, 7);
  return { st, month, tx: tx.filter(t => String(t.date).startsWith(month)) };
}
async function route(env, text, now) {
  const t = text.replace(/^\//, '').replace(/@\w+$/, '').trim();
  if (!t || /^(start|help|עזרה)$/i.test(t)) return HELP;
  if (t === 'יתרה' || t === 'balance') {
    const { st, tx } = await monthData(env, now);
    let inc = 0, exp = 0; const cats = {};
    for (const x of tx) { const v = (Number(x.amount) || 0) * rate(st, x.currency); if (x.type === 'income') inc += v; else { exp += v; cats[x.category || 'אחר'] = (cats[x.category || 'אחר'] || 0) + v; } }
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c} ${money(v)}`).join(' · ');
    return `החודש עד עכשיו:\nהכנסות ${money(inc)}\nהוצאות ${money(exp)}\nיתרה ${money(inc - exp)}${top ? '\nהכי הרבה: ' + top : ''}`;
  }
  if (t === 'תקציב') {
    const { st, tx } = await monthData(env, now);
    const b = Object.entries(st.budgets || {}).filter(([, l]) => Number(l) > 0);
    if (!b.length) return 'עוד לא הגדרת תקציבים באפליקציה.';
    const spent = {}; for (const x of tx) if (x.type !== 'income') spent[x.category || 'אחר'] = (spent[x.category || 'אחר'] || 0) + (Number(x.amount) || 0) * rate(st, x.currency);
    return b.map(([c, l]) => { const s = spent[c] || 0, p = Math.round(s / l * 100); return `${p > 100 ? '🔴' : p >= 80 ? '🟠' : '🟢'} ${c}: ${money(s)} מתוך ${money(l)} (${p}%)`; }).join('\n');
  }
  if (t === 'בטל') {
    const inbox = await kget(env, 'inbox', []);
    const last = inbox.pop();
    if (!last) return 'אין מה לבטל. רישומים שכבר נקלטו באפליקציה נמחקים משם.';
    await kput(env, 'inbox', inbox);
    return `בוטל: ${last.note || last.category} ${money(last.amount)}`;
  }
  if (t === 'תזכורות') {
    const list = (await kget(env, 'reminders', [])).filter(r => !r.sent).sort((a, b) => a.at - b.at);
    return list.length ? list.map((r, i) => `${i + 1}. ${fmtLocal(r.at)}${r.every ? ' (כל חודש)' : ''} — ${r.text}`).join('\n') : 'אין תזכורות פעילות.';
  }
  let m = t.match(/^מחק\s+(\d+)$/);
  if (m) {
    const all = await kget(env, 'reminders', []);
    const list = all.filter(r => !r.sent).sort((a, b) => a.at - b.at), r = list[+m[1] - 1];
    if (!r) return 'לא מצאתי תזכורת במספר הזה. שלח "תזכורות" לרשימה.';
    await kput(env, 'reminders', all.filter(x => x.id !== r.id));
    return `נמחקה: ${r.text}`;
  }
  if (t.startsWith('תזכורת ')) {
    const p = parseReminder(t.slice(7), now);
    if (!p) return 'לא הבנתי. למשל: תזכורת מחר 9:00 לקנות חלב';
    if (p.error) return p.error;
    const all = await kget(env, 'reminders', []);
    all.push({ id: uid(), text: p.text.slice(0, 200), at: p.at, every: p.every || null, day: p.day || null, time: p.time || null, sent: false });
    await kput(env, 'reminders', all);
    return `נקבע: ${fmtLocal(p.at)}${p.every ? ' (וכל חודש)' : ''} — ${p.text}`;
  }
  if (t.length > 200) return HELP;
  const st = (await kget(env, 'state', {})).state || {};
  const cats = Array.isArray(st.cats) && st.cats.length ? st.cats : ['אוכל', 'תחבורה', 'דיור', 'בילויים', 'בריאות', 'קניות', 'אחר'];
  const e = parseExpense(t, cats);
  if (!e) return 'לא הבנתי. כתוב למשל: קפה 18\nאו שלח "עזרה".';
  const inbox = await kget(env, 'inbox', []);
  inbox.push({ id: 'tg' + uid(), type: e.type, amount: e.amount, currency: 'ILS', category: e.category, date: dateStr(now), note: e.note, src: 'telegram' });
  await kput(env, 'inbox', inbox.slice(-500));
  return `${e.type === 'income' ? 'הכנסה' : 'הוצאה'} נרשמה: ${e.note || e.category} ${money(e.amount)} (${e.category})`;
}
async function handleUpdate(env, u, now = Date.now()) {
  const msg = u && u.message;
  if (!msg || typeof msg.text !== 'string') return;
  const chat = String(msg.chat.id);
  if (!env.ALLOWED_CHAT_ID || chat !== String(env.ALLOWED_CHAT_ID)) {
    await send(env, chat, env.ALLOWED_CHAT_ID ? 'אין הרשאה.' : `מזהה הצ'אט שלך: ${chat}\nשמור אותו כסוד ALLOWED_CHAT_ID ופרוס מחדש.`);
    return;
  }
  await send(env, chat, await route(env, msg.text.trim(), now));
}

/* ---------- reminders cron ---------- */
export async function runReminders(env, now = Date.now()) {
  if (!env.ALLOWED_CHAT_ID) return;
  const list = await kget(env, 'reminders', []);
  let changed = false;
  for (const r of list) {
    if (r.sent || r.at > now) continue;
    try { await send(env, env.ALLOWED_CHAT_ID, '⏰ ' + r.text); } catch (e) { continue; }
    if (r.every === 'month') { const [hh, mi] = (r.time || '09:00').split(':').map(Number); r.at = nextMonthly(now, r.day || 1, hh, mi); }
    else r.sent = true;
    changed = true;
  }
  const keep = list.filter(r => !(r.sent && r.at < now - 7 * 864e5));
  if (changed || keep.length !== list.length) await kput(env, 'reminders', keep);
}

/* ---------- HTTP ---------- */
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function handle(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const cors = {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
  };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...cors } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/tg' && request.method === 'POST') {
    if (!env.WEBHOOK_SECRET || !safeEq(request.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) return json({ error: 'forbidden' }, 403);
    try { await handleUpdate(env, await request.json(), now); } catch (e) { /* always 200 so Telegram doesn't retry forever */ }
    return json({ ok: true });
  }
  if (!url.pathname.startsWith('/api/')) return json({ ok: true, service: 'moneymate-api' });
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.SYNC_TOKEN || !safeEq(bearer, env.SYNC_TOKEN)) return json({ error: 'unauthorized' }, 401);

  const p = url.pathname, mth = request.method;
  if (p === '/api/state' && mth === 'GET') return json(await kget(env, 'state', { state: null, updatedAt: 0 }));
  if (p === '/api/state' && mth === 'PUT') {
    const b = await request.json();
    if (!b || typeof b.state !== 'object' || !b.state) return json({ error: 'bad body' }, 400);
    const rec = { state: b.state, updatedAt: Number(b.updatedAt) || now };
    await kput(env, 'state', rec);
    return json({ ok: true, updatedAt: rec.updatedAt });
  }
  if (p === '/api/inbox' && mth === 'GET') return json(await kget(env, 'inbox', []));
  if (p === '/api/inbox/ack' && mth === 'POST') {
    const ids = new Set(((await request.json()) || {}).ids || []);
    await kput(env, 'inbox', (await kget(env, 'inbox', [])).filter(x => !ids.has(x.id)));
    return json({ ok: true });
  }
  if (p === '/api/reminders' && mth === 'GET') return json((await kget(env, 'reminders', [])).filter(r => !r.sent));
  if (p === '/api/reminders' && mth === 'POST') {
    const b = await request.json(), at = typeof b.at === 'number' ? b.at : Date.parse(b.at);
    if (!b.text || !Number.isFinite(at)) return json({ error: 'bad body' }, 400);
    const all = await kget(env, 'reminders', []);
    const r = { id: uid(), text: String(b.text).slice(0, 200), at, every: null, sent: false };
    all.push(r); await kput(env, 'reminders', all);
    return json(r);
  }
  let m = p.match(/^\/api\/reminders\/(.+)$/);
  if (m && mth === 'DELETE') {
    await kput(env, 'reminders', (await kget(env, 'reminders', [])).filter(r => r.id !== decodeURIComponent(m[1])));
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(runReminders(env)),
};
