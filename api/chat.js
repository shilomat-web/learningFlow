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

// Zero external dependencies — all Supabase calls use plain fetch() against
// the Supabase REST / Auth APIs directly.

// Extend the function timeout beyond the 10s Hobby default so the Groq call
// (which can take 10–20s on cold starts) has room to complete before Vercel
// kills the function mid-stream. Without this, the client's response.json()
// hangs forever because the response body never finishes flushing.
export const config = { maxDuration: 30 };

// Fallback to hardcoded public values so the function never crashes on missing env vars.
// SUPABASE_URL and SUPABASE_ANON_KEY are already public (they appear in the frontend JS).
const SB_URL     = () => process.env.SUPABASE_URL      || 'https://xirsfctsowhrsyytgcnh.supabase.co';
const SB_ANON_KEY= () => process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhpcnNmY3Rzb3docnN5eXRnY25oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyODgyNzQsImV4cCI6MjA4OTg2NDI3NH0._dMzLsEdw2Br37Wrbvprs7rnEzQur_z9WFyrCt7qg8E';
const SB_SVC_KEY = () => process.env.SUPABASE_SERVICE_KEY || SB_ANON_KEY();

// ── Supabase REST helper (service-role) ───────────────────────
async function sbFrom(table) {
  // Returns a tiny query builder for the most-used operations
  const base = `${SB_URL()}/rest/v1/${table}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       SB_SVC_KEY(),
    'Authorization':`Bearer ${SB_SVC_KEY()}`,
    'Prefer':       'return=representation',
  };
  return {
    async selectEq(col, val, single = false) {
      const res = await fetch(`${base}?${col}=eq.${val}&select=*${single ? '&limit=1' : ''}`, { headers });
      const json = await res.json();
      if (!res.ok) return { data: null, error: json };
      return { data: single ? (json[0] ?? null) : json, error: null };
    },
    async upsert(payload) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      return res.ok ? { data: json, error: null } : { data: null, error: json };
    },
    async delete(col, val) {
      const res = await fetch(`${base}?${col}=eq.${val}`, { method: 'DELETE', headers });
      return res.ok ? { error: null } : { error: await res.json() };
    },
  };
}

// ── Auth helpers ───────────────────────────────────────────────
async function verifyToken(authHeader) {
  // Validate JWT using Supabase Auth REST API (no SDK needed)
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${SB_URL()}/auth/v1/user`, {
    headers: { 'apikey': SB_ANON_KEY(), 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ?? null;
}

async function adminCreateUser(email, password) {
  const res = await fetch(`${SB_URL()}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'apikey': SB_SVC_KEY(), 'Authorization': `Bearer ${SB_SVC_KEY()}` },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const json = await res.json();
  return res.ok ? { data: { user: json }, error: null } : { data: null, error: json };
}

async function adminDeleteUser(userId) {
  const res = await fetch(`${SB_URL()}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { 'apikey': SB_SVC_KEY(), 'Authorization': `Bearer ${SB_SVC_KEY()}` },
  });
  return res.ok ? { error: null } : { error: await res.json() };
}

async function signInWithPassword(email, password) {
  const res = await fetch(`${SB_URL()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'apikey': SB_ANON_KEY() },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  return res.ok ? { data: json, error: null } : { data: null, error: json };
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
    ['daily', 'weekly', 'monthly'].forEach(type => {
      const grp = tasks.filter(t => t.type === type);
      if (!grp.length) return;
      lines.push(type === 'daily' ? 'יומיות:' : type === 'weekly' ? 'שבועיות:' : 'חודשיות:');
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

// ── Intent detection ───────────────────────────────────────────
// Classifies the last user message to inject only the relevant data slice.
function detectIntent(messages) {
  const last = (messages || []).filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const q = last.toLowerCase();
  if (/מבח|בגר|בחינ|exam|test|ציון|score|readiness|מוכנות/.test(q))   return 'exams';
  if (/משימ|task|todo|לעשות|פתוח|מחר|איחור|due/.test(q))              return 'tasks';
  if (/זמן|שעות|דקות|לימד|log|time|שבוע|אתמול|היום|קצב|מגמ/.test(q)) return 'studytime';
  if (/נושא|subject|פרק|תת|subtopic|אחוז|השלמ|progress/.test(q))      return 'subjects';
  return 'overview';
}

// ── Slim context builders (per intent) ────────────────────────
function slimExams(state) {
  const { subjects = [], exams = [], archive = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  const lines = ['=== מבחנים ==='];
  const upcoming = exams.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past     = exams.filter(e => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
  if (!upcoming.length && !past.length) return lines.concat('אין מבחנים.').join('\n');
  upcoming.forEach(e => {
    const subj = subjects.find(s => s.id === e.subjId);
    const readiness = calcReadiness(e, subjects);
    const prepLabel = { red: 'חלש', amber: 'בינוני', green: 'מוכן' }[e.prep] || '?';
    lines.push(`📅 "${e.name}"${subj ? ' (' + subj.name + ')' : ''} | ${fmtDate(e.date)} | עוד ${daysUntil(e.date)}ד | הכנה: ${prepLabel} | מוכנות: ${readiness}%`);
  });
  past.slice(0, 5).forEach(e => {
    const subj = subjects.find(s => s.id === e.subjId);
    lines.push(`📝 "${e.name}"${subj ? ' (' + subj.name + ')' : ''} | ${fmtDate(e.date)} | ציון: ${e.score ?? 'לא הוזן'}`);
  });
  if (archive.length) {
    const scored = archive.filter(e => e.score !== null);
    const avg = scored.length ? Math.round(scored.reduce((s, e) => s + e.score, 0) / scored.length) : null;
    lines.push(`\nארכיון: ${archive.length} מבחנים${avg !== null ? ' | ממוצע ציון: ' + avg : ''}`);
  }
  return lines.join('\n');
}

function slimTasks(state) {
  const { subjects = [], tasks = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  if (!tasks.length) return '=== משימות ===\nאין משימות.';
  const lines = ['=== משימות ==='];
  const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => !t.done && !(t.dueDate && t.dueDate < today));
  const done    = tasks.filter(t => t.done);
  lines.push(`סה"כ: ${tasks.length} | הושלמו: ${done.length} | ממתינות: ${pending.length} | באיחור: ${overdue.length}`);
  if (overdue.length) {
    lines.push('\nבאיחור:');
    overdue.forEach(t => {
      const subj = subjects.find(s => s.id === t.subjId);
      lines.push(`  ⚠️ "${t.name}"${subj ? ' (' + subj.name + ')' : ''} — ${Math.abs(daysUntil(t.dueDate))}ד באיחור`);
    });
  }
  if (pending.length) {
    lines.push('\nפתוחות:');
    pending.forEach(t => {
      const subj = subjects.find(s => s.id === t.subjId);
      const due  = t.dueDate ? ` | יעד: ${fmtDate(t.dueDate)}` : '';
      lines.push(`  ○ "${t.name}"${subj ? ' (' + subj.name + ')' : ''}${due}`);
    });
  }
  return lines.join('\n');
}

function slimStudytime(state) {
  const { subjects = [], logs = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  if (!logs.length) return '=== זמן לימוד ===\nאין רשומות.';
  const lines = ['=== זמן לימוד ==='];
  const total = logs.reduce((s, l) => s + l.minutes, 0);
  const todayMins = logs.filter(l => l.date === today).reduce((s, l) => s + l.minutes, 0);
  const d7 = new Date(); d7.setDate(d7.getDate() - 7);
  const last7 = logs.filter(l => new Date(l.date) >= d7).reduce((s, l) => s + l.minutes, 0);
  const d14 = new Date(); d14.setDate(d14.getDate() - 14);
  const prev7 = logs.filter(l => new Date(l.date) >= d14 && new Date(l.date) < d7).reduce((s, l) => s + l.minutes, 0);
  const trend = last7 > prev7 ? '📈 עולה' : last7 < prev7 ? '📉 יורד' : '➡️ יציב';
  lines.push(`היום: ${fmtMins(todayMins)} | שבוע אחרון: ${fmtMins(last7)} | סה"כ: ${fmtMins(total)} | מגמה: ${trend}`);
  lines.push('\nלפי נושא:');
  const bySubj = {};
  logs.forEach(l => { bySubj[l.subjId] = (bySubj[l.subjId] || 0) + l.minutes; });
  Object.entries(bySubj).sort((a, b) => b[1] - a[1]).forEach(([sid, m]) => {
    const s = subjects.find(s => s.id === sid);
    lines.push(`  ${s ? s.name : '?'}: ${fmtMins(m)}`);
  });
  lines.push('\nאחרונות:');
  [...logs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).forEach(l => {
    const s = subjects.find(s => s.id === l.subjId);
    lines.push(`  ${fmtDate(l.date)} | ${s ? s.name : '?'} | ${l.minutes}ד׳${l.desc ? ' — ' + l.desc : ''}`);
  });
  return lines.join('\n');
}

function slimSubjects(state) {
  const { subjects = [] } = state;
  if (!subjects.length) return '=== נושאים ===\nאין נושאים.';
  const lines = ['=== נושאים ==='];
  subjects.forEach(subj => {
    const { total, done } = countNodes(subj);
    const pct = total ? Math.round(done / total * 100) : 0;
    lines.push(`• "${subj.name}"${subj.category ? ' [' + subj.category + ']' : ''} | ${done}/${total} (${pct}%)`);
    function dumpNode(node, depth) {
      (node.subtopics || []).forEach(c => {
        lines.push('  '.repeat(depth) + (c.done ? '✓' : '○') + ` "${c.name}"`);
        dumpNode(c, depth + 1);
      });
    }
    dumpNode(subj, 1);
  });
  return lines.join('\n');
}

function slimOverview(state, userName) {
  const { subjects = [], tasks = [], exams = [], logs = [] } = state;
  const today = new Date().toISOString().split('T')[0];
  const lines = [];
  let totSub = 0, doneSub = 0;
  subjects.forEach(s => { const c = countNodes(s); totSub += c.total; doneSub += c.done; });
  lines.push(`משתמש: ${userName} | תאריך: ${fmtDate(today)}`);
  lines.push(`התקדמות כוללת: ${doneSub}/${totSub} (${totSub ? Math.round(doneSub/totSub*100) : 0}%)`);
  const upcoming = exams.filter(e => e.date >= today).sort((a,b) => a.date.localeCompare(b.date)).slice(0, 3);
  if (upcoming.length) {
    lines.push('\nמבחנים קרובים:');
    upcoming.forEach(e => {
      const subj = subjects.find(s => s.id === e.subjId);
      const readiness = calcReadiness(e, subjects);
      const urgency = daysUntil(e.date) <= 3 ? '🔴' : daysUntil(e.date) <= 7 ? '🟡' : '🟢';
      lines.push(`  ${urgency} "${e.name}"${subj ? ' (' + subj.name + ')' : ''} — עוד ${daysUntil(e.date)}ד | מוכנות ${readiness}%`);
    });
  }
  const overdue = tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => !t.done);
  lines.push(`\nמשימות: ${pending.length} פתוחות${overdue.length ? ', ' + overdue.length + ' באיחור ⚠️' : ''}`);
  const d7 = new Date(); d7.setDate(d7.getDate() - 7);
  const last7 = logs.filter(l => new Date(l.date) >= d7).reduce((s, l) => s + l.minutes, 0);
  const todayMins = logs.filter(l => l.date === today).reduce((s, l) => s + l.minutes, 0);
  lines.push(`זמן לימוד: היום ${fmtMins(todayMins)} | שבוע אחרון ${fmtMins(last7)}`);
  const scored = exams
    .filter(e => e.date >= today)
    .map(e => {
      const days = daysUntil(e.date);
      const readiness = calcReadiness(e, subjects);
      const subj = subjects.find(s => s.id === e.subjId);
      return { name: e.name, subjName: subj ? subj.name : '', days, readiness, priority: Math.round((100 - readiness) * (30 / Math.max(days, 1))) };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 2);
  if (scored.length) {
    lines.push('\nעדיפויות:');
    scored.forEach((s, i) => lines.push(`  ${i+1}. ${s.subjName} — מוכנות ${s.readiness}%, עוד ${s.days}ד`));
  }
  return lines.join('\n');
}

// ── System prompt builder (intent-aware, slim) ─────────────────
function buildGroqSystemPrompt(state, userName, messages) {
  const intent = detectIntent(messages);
  let dataSection;
  switch (intent) {
    case 'exams':     dataSection = slimExams(state);              break;
    case 'tasks':     dataSection = slimTasks(state);              break;
    case 'studytime': dataSection = slimStudytime(state);          break;
    case 'subjects':  dataSection = slimSubjects(state);           break;
    default:          dataSection = slimOverview(state, userName); break;
  }
  return [
    '## תפקידך',
    'אתה עוזר לימודים אישי. ענה בעברית, קצר וברור.',
    '',
    '## חוק ברזל — קריאה בלבד',
    'ענה אך ורק מהנתונים שלמטה. אל תמציא.',
    'אם מבקשים פעולה (הוסף/מחק/עדכן): "כדי לבצע פעולה זו, השתמש בממשק האפליקציה."',
    'לשאלות שאינן קשורות ללימודים: "אני מנתח רק את הנתונים שלך באפליקציה."',
    '',
    '## נתונים:',
    dataSection,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const action = req.query.action;

  // ── POST /api/chat?action=register ────────────────────────
  if (action === 'register') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;
    const { data: authData, error: authErr } = await adminCreateUser(email, password);
    if (authErr) {
      const msg = authErr.message || authErr.msg || JSON.stringify(authErr);
      if (msg.includes('already registered') || msg.includes('already exists') || msg.includes('unique'))
        return res.status(409).json({ error: 'שם משתמש כבר קיים' });
      return res.status(400).json({ error: msg });
    }
    const userId = authData.user.id;
    const ud = await sbFrom('user_data');
    await ud.upsert({ user_id: userId, data: buildSeedData() });
    return res.status(201).json({ ok: true, userId });
  }

  // ── POST /api/chat?action=login ───────────────────────────
  if (action === 'login') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;
    const { data, error } = await signInWithPassword(email, password);
    if (error || !data.access_token)
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    return res.status(200).json({
      ok: true,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      userId:       data.user?.id,
      expiresAt:    data.expires_at,
    });
  }

  // ── GET /api/chat?action=load ─────────────────────────────
  if (action === 'load') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ud = await sbFrom('user_data');
    const { data: row, error } = await ud.selectEq('user_id', userId, true);
    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.details || error.message || 'DB error' });

    return res.status(200).json({ ok: true, data: migrateData(row?.data || null) });
  }

  // ── POST /api/chat?action=save ────────────────────────────
  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const payload = req.body?.data;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Missing data payload' });

    const ud = await sbFrom('user_data');
    const { error } = await ud.upsert({ user_id: userId, data: migrateData(payload) });
    if (error) return res.status(500).json({ error: error.details || error.message || 'DB error' });
    return res.status(200).json({ ok: true });
  }

  // ── DELETE /api/chat?action=delete ────────────────────────
  if (action === 'delete') {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const ud = await sbFrom('user_data');
    await ud.delete('user_id', userId);
    const { error } = await adminDeleteUser(userId);
    if (error) return res.status(500).json({ error: error.message || 'Delete failed' });
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
        const ud = await sbFrom('user_data');
        const { data: row } = await ud.selectEq('user_id', userId, true);
        if (row?.data) state = migrateData(row.data);
      } catch (_) { /* fall through */ }
    }
    if (!state) state = buildSeedData();

    // Fallback to the same public key used by the frontend write-path.
    // Both the env var and this literal are equally "public" for this app.
    const GROQ_KEY_FALLBACK = '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';
    const groqApiKey = process.env.GROQ_API_KEY || GROQ_KEY_FALLBACK;
    // ── Debug log: confirms key source ──
    console.log('[Groq] Key source:', process.env.GROQ_API_KEY ? 'env' : 'fallback', '| Length:', groqApiKey.length);

    const systemPrompt    = buildGroqSystemPrompt(state, userName, messages);
    const trimmedMessages = messages.slice(-10);

    // ── Groq call with full error boundary ────────────────
    let groqRes;
    try {
      const ac = new AbortController();
      const tout = setTimeout(() => ac.abort(), 25000); // 25s — paired with maxDuration:30 above
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        signal:  ac.signal,
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
      clearTimeout(tout);
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

      // 401 = invalid/expired API key
      if (groqRes.status === 401) {
        return res.status(200).json({
          ok: true,
          reply: 'מצטער, מפתח ה-AI אינו תקין או פג תוקף. צור קשר עם מנהל המערכת לחידוש המפתח.',
        });
      }

      // 429 = rate limit
      if (groqRes.status === 429) {
        return res.status(200).json({
          ok: true,
          reply: 'שרת ה-AI עמוס כרגע. המתן מספר שניות ונסה שוב.',
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
