// /api/chat.js — Vercel Serverless Function
// Phase 3 — Fixed Groq AI integration:
//   • System prompt now strictly separates READ vs WRITE intent.
//   • No tools are sent to Groq; the model answers from injected JSONB state.
//   • Robust error boundary handles `failed_generation` and Groq 400/500s.
//
// Env vars required in Vercel dashboard:
//   SUPABASE_URL         = https://xirsfctsowhrsyytgcnh.supabase.co
//   SUPABASE_SERVICE_KEY = <service_role key>
//   SUPABASE_ANON_KEY    = <anon/public key>
//   GROQ_API_KEY         = <Groq API key>

import { createClient } from '@supabase/supabase-js';

// ── Supabase admin client ──────────────────────────────────────
function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Verify JWT, return userId ──────────────────────────────────
async function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const sb = getAdminClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  return (error || !user) ? null : user.id;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Schema helpers ─────────────────────────────────────────────
function migrateData(data) {
  if (!data || typeof data !== 'object') return data;
  if (!Array.isArray(data.subjects)) data.subjects = [];
  if (!Array.isArray(data.tasks))    data.tasks    = [];
  if (!Array.isArray(data.exams))    data.exams    = [];
  if (!Array.isArray(data.logs))     data.logs     = [];
  if (!Array.isArray(data.archive))  data.archive  = [];
  data.subjects = data.subjects.map(s => ({ ...s, category: s.category ?? '' }));
  const todayStr = new Date().toISOString().split('T')[0];
  data.tasks = data.tasks.map(t => ({
    ...t,
    recurring: t.recurring ?? false,
    lastReset: t.lastReset ?? (t.recurring ? todayStr : null),
  }));
  return data;
}

function buildSeedData() {
  return { subjects: [], tasks: [], exams: [], logs: [], archive: [] };
}

// ── Formatting helpers ─────────────────────────────────────────
function fmtMins(m) {
  const h = Math.floor(m / 60), min = m % 60;
  if (h && min) return `${h}ש׳ ${min}ד׳`;
  if (h) return `${h}ש׳`;
  return `${min}ד׳`;
}

function daysUntil(dateStr) {
  const today = new Date().toISOString().split('T')[0];
  return Math.ceil(
    (new Date(dateStr + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000
  );
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function countNodes(node) {
  let total = 0, done = 0;
  function walk(n) {
    for (const c of (n.subtopics || [])) {
      total++; if (c.done) done++;
      walk(c);
    }
  }
  walk(node);
  return { total, done };
}

function calcReadiness(exam, subjects) {
  const subj = subjects.find(s => s.id === exam.subjId);
  let subtopicScore = 0;
  if (subj) {
    const { total, done } = countNodes(subj);
    subtopicScore = total ? Math.round(done / total * 100) : 0;
  }
  const prepScore = { red: 0, amber: 40, green: 80 }[exam.prep] || 0;
  return Math.round(subtopicScore * 0.6 + prepScore * 0.4);
}

// ── Context builder ────────────────────────────────────────────
function buildServerContext(state, userName) {
  const { subjects = [], tasks = [], exams = [], logs = [], archive = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push('=== נושאים ===');
  if (!subjects.length) {
    lines.push('אין נושאים.');
  } else {
    subjects.forEach(subj => {
      const { total, done } = countNodes(subj);
      const pct = total ? Math.round(done / total * 100) : 0;
      lines.push(`נושא: "${subj.name}" (id:${subj.id}) | קטגוריה: ${subj.category || 'ללא'} | התקדמות: ${done}/${total} (${pct}%)`);
      function dumpNode(node, depth) {
        (node.subtopics || []).forEach(c => {
          lines.push('  '.repeat(depth) + (c.done ? '✓' : '○') + ` "${c.name}" (id:${c.id})`);
          dumpNode(c, depth + 1);
        });
      }
      dumpNode(subj, 1);
    });
  }

  lines.push('\n=== משימות ===');
  if (!tasks.length) {
    lines.push('אין משימות.');
  } else {
    const done = tasks.filter(t => t.done).length;
    const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
    lines.push(`סה"כ: ${tasks.length} | הושלמו: ${done} | ממתינות: ${tasks.length - done} | באיחור: ${overdue.length}`);
    ['daily', 'monthly'].forEach(type => {
      const grp = tasks.filter(t => t.type === type);
      if (!grp.length) return;
      lines.push(type === 'daily' ? 'יומיות:' : 'חודשיות:');
      grp.forEach(t => {
        const subj = subjects.find(s => s.id === t.subjId);
        const due = t.dueDate ? ` | יעד: ${fmtDate(t.dueDate)}${t.dueTime ? ' ' + t.dueTime : ''}` : '';
        const late = t.dueDate && t.dueDate < today && !t.done ? ' ⚠️ באיחור' : '';
        lines.push(`  ${t.done ? '✓' : '○'} "${t.name}" (id:${t.id})${subj ? ' (' + subj.name + ')' : ''}${due}${late}`);
      });
    });
  }

  lines.push('\n=== מבחנים ===');
  if (!exams.length) {
    lines.push('אין מבחנים.');
  } else {
    const upcoming = exams.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past     = exams.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
    if (upcoming.length) {
      lines.push('קרובים:');
      upcoming.forEach(e => {
        const subj = subjects.find(s => s.id === e.subjId);
        const readiness = calcReadiness(e, subjects);
        const prepLabel = { red: 'חלש', amber: 'בינוני', green: 'מוכן' }[e.prep] || '?';
        lines.push(`  📅 "${e.name}" (id:${e.id})${subj ? ' (' + subj.name + ')' : ''} | ${fmtDate(e.date)} | בעוד ${daysUntil(e.date)} ימים | הכנה: ${prepLabel} | מוכנות: ${readiness}%`);
      });
    }
    if (past.length) {
      lines.push('שעברו:');
      past.forEach(e => {
        const subj = subjects.find(s => s.id === e.subjId);
        const score = e.score !== null ? ` | ציון: ${e.score}` : ' | ציון: לא הוזן';
        lines.push(`  📝 "${e.name}" (id:${e.id})${subj ? ' (' + subj.name + ')' : ''} | ${fmtDate(e.date)}${score}`);
      });
    }
  }

  lines.push('\n=== זמן לימוד ===');
  if (!logs.length) {
    lines.push('אין רשומות.');
  } else {
    const total = logs.reduce((s, l) => s + l.minutes, 0);
    const bySubj = {};
    logs.forEach(l => { bySubj[l.subjId] = (bySubj[l.subjId] || 0) + l.minutes; });
    lines.push(`סה"כ: ${fmtMins(total)}`);
    lines.push('לפי נושא:');
    Object.entries(bySubj).sort((a, b) => b[1] - a[1]).forEach(([sid, m]) => {
      const s = subjects.find(s => s.id === sid);
      lines.push(`  ${s ? s.name : '?'}: ${fmtMins(m)}`);
    });
    const todayMins = logs.filter(l => l.date === today).reduce((s, l) => s + l.minutes, 0);
    lines.push(`היום: ${fmtMins(todayMins)}`);
    lines.push('רשומות אחרונות:');
    [...logs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15).forEach(l => {
      const s = subjects.find(s => s.id === l.subjId);
      lines.push(`  (id:${l.id}) ${fmtDate(l.date)} | ${s ? s.name : '?'} | ${l.minutes}ד׳${l.desc ? ' | ' + l.desc : ''}`);
    });
  }

  lines.push('\n=== ארכיון מבחנים ===');
  if (!archive.length) {
    lines.push('אין רשומות בארכיון.');
  } else {
    const scored = archive.filter(e => e.score !== null);
    const avg = scored.length ? Math.round(scored.reduce((s, e) => s + e.score, 0) / scored.length) : null;
    lines.push(`סה"כ: ${archive.length}${avg !== null ? ' | ממוצע: ' + avg : ''}`);
    [...archive].sort((a, b) => b.date.localeCompare(a.date)).forEach(e => {
      lines.push(`  📋 "${e.name}" (id:${e.id}) | ${fmtDate(e.date)}${e.score !== null ? ' | ציון: ' + e.score : ''}${e.subject ? ' | ' + e.subject : ''}${e.notes ? ' | ' + e.notes : ''}`);
    });
  }

  lines.push('\n=== כללי ===');
  let totSub = 0, doneSub = 0;
  subjects.forEach(s => { const c = countNodes(s); totSub += c.total; doneSub += c.done; });
  lines.push(`התקדמות כוללת: ${doneSub}/${totSub} (${totSub ? Math.round(doneSub / totSub * 100) : 0}%)`);
  lines.push(`תאריך היום: ${fmtDate(today)}`);
  lines.push(`שם משתמש: ${userName}`);

  return lines.join('\n');
}

// ── Analytics insights builder ─────────────────────────────────
function buildServerInsights(state) {
  const { subjects = [], tasks = [], exams = [], logs = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  const lines = [];

  const upcoming = exams.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) {
    lines.push('=== ניתוח דחיפות מבחנים ===');
    upcoming.forEach(e => {
      const days = daysUntil(e.date);
      const subj = subjects.find(s => s.id === e.subjId);
      const readiness = calcReadiness(e, subjects);
      const urgency = days <= 3 ? '🔴 דחוף מאוד' : days <= 7 ? '🟡 דחוף' : '🟢 יש זמן';
      const rLabel  = readiness >= 70 ? '✅ מוכן' : readiness >= 40 ? '⚠️ חלקי' : '❌ לא מוכן';
      const pending = subj ? countNodes(subj).total - countNodes(subj).done : 0;
      lines.push(`  ${urgency} "${e.name}" — עוד ${days}ד | מוכנות ${readiness}% (${rLabel}) | ממתינים: ${pending} תת-נושאים`);
    });
  }

  const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
  if (overdue.length) {
    lines.push(`\n=== משימות באיחור (${overdue.length}) ===`);
    overdue.forEach(t => {
      const subj = subjects.find(s => s.id === t.subjId);
      lines.push(`  ⚠️ "${t.name}" (${subj ? subj.name : 'ללא נושא'}) — ${Math.abs(daysUntil(t.dueDate))}ד באיחור`);
    });
  }

  const now = new Date();
  const d7  = new Date(now); d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now); d14.setDate(d14.getDate() - 14);
  const last7 = logs.filter(l => new Date(l.date) >= d7).reduce((s, l) => s + l.minutes, 0);
  const prev7 = logs.filter(l => new Date(l.date) >= d14 && new Date(l.date) < d7).reduce((s, l) => s + l.minutes, 0);
  const trend = last7 > prev7 ? '📈 עולה' : last7 < prev7 ? '📉 יורד' : '➡️ יציב';
  lines.push(`\n=== קצב לימוד ===\n  שבוע אחרון: ${fmtMins(last7)} | שבוע קודם: ${fmtMins(prev7)} | מגמה: ${trend}`);

  const bySubj = {};
  logs.forEach(l => { bySubj[l.subjId] = (bySubj[l.subjId] || 0) + l.minutes; });
  const totalMins = Object.values(bySubj).reduce((a, b) => a + b, 0);
  if (totalMins > 0) {
    lines.push('\n=== איזון בין נושאים ===');
    subjects.forEach(subj => {
      const mins    = bySubj[subj.id] || 0;
      const pct     = Math.round(mins / totalMins * 100);
      const { total, done } = countNodes(subj);
      const compPct = total ? Math.round(done / total * 100) : 0;
      const nearExam = exams.some(e => e.subjId === subj.id && e.date >= today && daysUntil(e.date) <= 14);
      const flag =  (compPct < 40 && pct > 25) ? '⚠️ ריבוי זמן, התקדמות נמוכה'
                  : (nearExam && compPct < 60)  ? '🚨 מבחן קרוב, הכנה לא מספקת'
                  : '';
      lines.push(`  ${subj.name}: ${fmtMins(mins)} (${pct}%) | השלמה: ${compPct}% ${flag}`);
    });
  }

  lines.push('\n=== המלצת עדיפות לימוד ===');
  const scored = exams
    .filter(e => e.date >= today)
    .map(e => {
      const days = daysUntil(e.date);
      const readiness = calcReadiness(e, subjects);
      const subj = subjects.find(s => s.id === e.subjId);
      return { name: e.name, subjName: subj ? subj.name : '', days, readiness, priority: Math.round((100 - readiness) * (30 / Math.max(days, 1))) };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3);

  if (scored.length) {
    scored.forEach((s, i) => {
      const lvl = s.priority > 150 ? 'גבוהה מאוד' : s.priority > 80 ? 'גבוהה' : 'בינונית';
      lines.push(`  ${i + 1}. ${s.subjName} (מבחן "${s.name}" בעוד ${s.days}ד) — מוכנות ${s.readiness}% — עדיפות: ${lvl}`);
    });
  } else {
    lines.push('  אין מבחנים קרובים לניתוח.');
  }

  return lines.join('\n');
}

// ── FIXED: System prompt — strict READ-only, no tool descriptions ──
//
// Key changes from original:
//  1. Explicit READ vs WRITE section with a hard rule:
//     "Do NOT call any function. Answer ONLY from the data below."
//  2. Removed all tool/function references from the prompt.
//  3. Model is NOT given a `tools` array (no function calling on this endpoint).
//  4. Conversational fallback phrases for unknown queries.
function buildGroqSystemPrompt(state, userName) {
  const context  = buildServerContext(state, userName);
  const insights = buildServerInsights(state);
  const { subjects = [], tasks = [], exams = [], logs = [] } = state;
  const today = new Date().toISOString().split('T')[0];

  const stateSnapshot = JSON.stringify({
    user: userName,
    today,
    subjects: subjects.map(subj => {
      const { total, done } = countNodes(subj);
      return { id: subj.id, name: subj.name, category: subj.category || '', completion: { done, total, pct: total ? Math.round(done / total * 100) : 0 } };
    }),
    upcomingExams: exams
      .filter(e => e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(e => ({ id: e.id, name: e.name, date: e.date, daysUntil: daysUntil(e.date), prep: e.prep, readiness: calcReadiness(e, subjects) })),
    tasks: {
      total: tasks.length,
      done: tasks.filter(t => t.done).length,
      overdue: tasks.filter(t => !t.done && t.dueDate && t.dueDate < today).length,
      list: tasks.map(t => ({ id: t.id, name: t.name, done: t.done, type: t.type, dueDate: t.dueDate || null })),
    },
    studyMins: {
      today: logs.filter(l => l.date === today).reduce((s, l) => s + l.minutes, 0),
      last7days: logs.filter(l => { const d = new Date(); d.setDate(d.getDate() - 7); return new Date(l.date) >= d; }).reduce((s, l) => s + l.minutes, 0),
      total: logs.reduce((s, l) => s + l.minutes, 0),
      bySubject: (() => {
        const m = {};
        logs.forEach(l => { m[l.subjId] = (m[l.subjId] || 0) + l.minutes; });
        return Object.entries(m).map(([id, mins]) => {
          const s = subjects.find(x => x.id === id);
          return { subjectName: s ? s.name : id, minutes: mins, formatted: fmtMins(mins) };
        }).sort((a, b) => b.minutes - a.minutes);
      })(),
    },
  }, null, 2);

  return [
    '## תפקידך',
    'אתה עוזר לימודים אישי שמנתח את הנתונים של הסטודנט ועונה בעברית, קצר וברור.',
    '',
    '## ══ חוק ברזל — קריאה בלבד ══',
    'אתה עונה על שאלות אינפורמטיביות מתוך הנתונים שמוזרקים למטה.',
    'אתה **לא** מבצע שום פעולה, לא מוסיף, לא מוחק, לא משנה כלום.',
    'אם המשתמש מבקש פעולה (הוסף / מחק / עדכן), השב: "כדי לבצע פעולה זו, השתמש בממשק האפליקציה או כתוב לי פקודה מפורשת בתוך הצ׳אט."',
    '',
    '## כללים',
    '1. ענה אך ורק על בסיס הנתונים שלמטה — אל תמציא ואל תשער.',
    '2. עברית בלבד. פורמט bullet points לרשימות.',
    '3. לניתוח: (א) מצב נוכחי (ב) סיכון (ג) המלצה פרקטית.',
    '4. לשאלות שאינן קשורות ללימודים: "אני מנתח רק את הנתונים שלך באפליקציה."',
    '5. אם הנתון לא קיים בסנאפשוט — אמור זאת מפורשות, אל תנחש.',
    '',
    '## נתוני האפליקציה:',
    context,
    '',
    '## תובנות מחושבות:',
    insights,
    '',
    '## Snapshot JSON (לניתוח מדויק):',
    '```json',
    stateSnapshot,
    '```',
    '',
    '## דוגמאות לתשובות טובות:',
    '- "כמה זמן למדתי ג׳אווה?" → חפש ב-studyMins.bySubject את הנושא הרלוונטי והצג את הזמן המפורמט.',
    '- "מה המשימות שלי?" → הצג את tasks.list מהסנאפשוט: שם, סטטוס (✓/○), סוג, תאריך יעד.',
    '- "מה המצב שלי?" → אחוז השלמה + מבחנים קרובים + משימות ממתינות + נושא בסיכון + המלצה.',
    '- "על מה להתמקד?" → עדיפויות לפי: ימים למבחן × (100-מוכנות).',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).set(CORS).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const action = req.query.action;

  // ── POST /api/chat?action=register ────────────────────────
  if (action === 'register') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;
    const sb = getAdminClient();
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authErr) {
      const msg = authErr.message || '';
      if (msg.includes('already registered') || msg.includes('already exists'))
        return res.status(409).json({ error: 'שם משתמש כבר קיים' });
      return res.status(400).json({ error: msg });
    }
    const userId = authData.user.id;
    await sb.from('user_data').upsert(
      { user_id: userId, data: buildSeedData() },
      { onConflict: 'user_id' }
    );
    return res.status(201).json({ ok: true, userId });
  }

  // ── POST /api/chat?action=login ───────────────────────────
  if (action === 'login') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;
    const anonSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await anonSb.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    return res.status(200).json({
      ok: true,
      accessToken:  data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId:       data.user.id,
      expiresAt:    data.session.expires_at,
    });
  }

  // ── GET /api/chat?action=load ─────────────────────────────
  if (action === 'load') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sb = getAdminClient();
    const { data, error } = await sb.from('user_data').select('data').eq('user_id', userId).single();
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true, data: migrateData(data?.data || null) });
  }

  // ── POST /api/chat?action=save ────────────────────────────
  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const payload = req.body?.data;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Missing data payload' });

    const sb = getAdminClient();
    const { error } = await sb.from('user_data').upsert(
      { user_id: userId, data: migrateData(payload) },
      { onConflict: 'user_id' }
    );
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── DELETE /api/chat?action=delete ────────────────────────
  if (action === 'delete') {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sb = getAdminClient();
    await sb.from('user_data').delete().eq('user_id', userId);
    const { error } = await sb.auth.admin.deleteUser(userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── POST /api/chat?action=ai ──────────────────────────────
  // FIXED: No function-calling tools passed to Groq.
  // The model reads from injected JSONB state only.
  // Robust error handling for failed_generation and other Groq errors.
  if (action === 'ai') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { messages = [], userState, userName = 'student' } = req.body || {};
    if (!messages.length) return res.status(400).json({ error: 'No messages provided' });

    // Resolve user state (client-sent preferred over DB round-trip)
    let state = userState ? migrateData(userState) : null;
    if (!state) {
      try {
        const sb = getAdminClient();
        const { data, error } = await sb.from('user_data').select('data').eq('user_id', userId).single();
        if (!error && data?.data) state = migrateData(data.data);
      } catch (_) { /* fall through */ }
    }
    if (!state) state = buildSeedData();

    const groqApiKey = process.env.GROQ_API_KEY;
    // ── Debug log: confirms key is loaded in Vercel without exposing it ──
    // Check Vercel Function Logs (dashboard → Functions tab) for this line.
    console.log('[Groq] Key loaded:', !!groqApiKey, '| Length:', groqApiKey?.length ?? 0);
    if (!groqApiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

    const systemPrompt    = buildGroqSystemPrompt(state, userName);
    const trimmedMessages = messages.slice(-10);

    // ── Groq call with full error boundary ────────────────
    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model:       'llama-3.3-70b-versatile',
          messages:    [
            { role: 'system', content: systemPrompt },
            ...trimmedMessages,
          ],
          temperature: 0.15,
          max_tokens:  1024,
          // ⚠️ NO `tools` array here — this is the root fix for false positives
          // and failed_generation crashes. The model answers from injected data.
        }),
      });
    } catch (fetchErr) {
      console.error('[AI] Network error reaching Groq:', fetchErr.message);
      return res.status(502).json({
        ok: false,
        reply: 'מצטער, לא הצלחתי להתחבר לשרת ה-AI. בדוק את החיבור לאינטרנט ונסה שוב.',
      });
    }

    // ── Parse Groq response ────────────────────────────────
    let groqData;
    try {
      groqData = await groqRes.json();
    } catch (_) {
      return res.status(502).json({
        ok: false,
        reply: 'קיבלתי תגובה לא תקינה משרת ה-AI. אנא נסה שוב.',
      });
    }

    // ── Handle Groq-level errors (failed_generation, etc.) ─
    if (!groqRes.ok) {
      const errType = groqData?.error?.type || '';
      const errMsg  = groqData?.error?.message || `שגיאת Groq ${groqRes.status}`;
      console.error('[AI] Groq error:', groqRes.status, errType, errMsg);

      // failed_generation: model tried (and failed) to call a tool.
      // Return a graceful conversational fallback instead of crashing.
      if (errType === 'failed_generation' || groqRes.status === 400) {
        return res.status(200).json({
          ok: true,
          reply: 'מצטער, לא הצלחתי לעבד את הבקשה הזו. נסה לנסח מחדש את השאלה, לדוגמה: "מה המשימות הפתוחות שלי?" או "כמה זמן למדתי השבוע?"',
        });
      }

      return res.status(200).json({
        ok: true,
        reply: `מצטער, שרת ה-AI החזיר שגיאה (${groqRes.status}). נסה שוב בעוד רגע.`,
      });
    }

    const reply = groqData.choices?.[0]?.message?.content || '';
    if (!reply) {
      return res.status(200).json({
        ok: true,
        reply: 'לא קיבלתי תשובה מהמודל. נסה שוב.',
      });
    }

    return res.status(200).json({ ok: true, reply, usage: groqData.usage });
  }

  return res.status(404).json({ error: `Unknown action: ${action}` });
}
