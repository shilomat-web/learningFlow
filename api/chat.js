// /api/chat.js — Vercel Serverless Function  (Phase 1 & 2 update)
// Handles authenticated user-data CRUD against Supabase.
// Deploy alongside index.html. Set env vars in Vercel dashboard:
//   SUPABASE_URL         = https://xirsfctsowhrsyytgcnh.supabase.co
//   SUPABASE_SERVICE_KEY = <your service_role key>  ← NOT the anon key
//   SUPABASE_ANON_KEY    = <your anon/public key>

import { createClient } from '@supabase/supabase-js';

// ── Supabase admin client (service role — bypasses RLS for server-side ops)
function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

// ── Verify the JWT the browser sends and return the user id
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const sb = getAdminClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

// ── CORS headers (adjust origin in production)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─────────────────────────────────────────────────────────────
// SCHEMA HELPERS
// Phase 1 & 2 add two new fields to the JSONB payload:
//   subject.category   : '' | 'university' | 'matriculation' | 'other'
//   task.recurring     : boolean  (daily auto-reset at midnight)
//   task.lastReset     : string   (YYYY-MM-DD — date of last recurring reset)
//
// migrateData() is a pure-JS forward-migration that runs on every
// load so old rows stored before the update are transparently upgraded.
// No Supabase column changes are required — everything lives in the
// existing JSONB `data` column.
// ─────────────────────────────────────────────────────────────
function migrateData(data) {
  if (!data || typeof data !== 'object') return data;

  // Ensure top-level arrays exist
  if (!Array.isArray(data.subjects)) data.subjects = [];
  if (!Array.isArray(data.tasks))    data.tasks    = [];
  if (!Array.isArray(data.exams))    data.exams    = [];
  if (!Array.isArray(data.logs))     data.logs     = [];
  if (!Array.isArray(data.archive))  data.archive  = [];

  // Forward-migrate subjects: add category field if missing
  data.subjects = data.subjects.map(s => ({
    ...s,
    category: s.category ?? '',   // '' = no category
  }));

  // Forward-migrate tasks: add recurring fields if missing
  const todayStr = new Date().toISOString().split('T')[0];
  data.tasks = data.tasks.map(t => ({
    ...t,
    recurring:  t.recurring  ?? false,
    lastReset:  t.lastReset  ?? (t.recurring ? todayStr : null),
  }));

  return data;
}

// ─────────────────────────────────────────────────────────────
// SEED DATA for new users (includes category on the demo subject)
// ─────────────────────────────────────────────────────────────
function buildSeedData() {
  return {
    subjects: [],   // frontend adds the Math demo subject on first login
    tasks:    [],
    exams:    [],
    logs:     [],
    archive:  [],
  };
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).set(CORS).end();
  }

  // Set CORS on all responses
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // ── Route: /api/chat?action=<action>
  const action = req.query.action;

  // ─────────────────────────────────────────────
  // PUBLIC: Register a new user
  // POST /api/chat?action=register
  // Body: { username, password }
  // ─────────────────────────────────────────────
  if (action === 'register') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;
    const sb = getAdminClient();

    // Create auth user
    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,   // skip email confirmation flow
    });
    if (authErr) {
      const msg = authErr.message || '';
      if (msg.includes('already registered') || msg.includes('already exists')) {
        return res.status(409).json({ error: 'שם משתמש כבר קיים' });
      }
      return res.status(400).json({ error: msg });
    }

    const userId = authData.user.id;

    // Seed initial data row (Phase 1 & 2: use buildSeedData)
    const seedData = buildSeedData();
    await sb.from('user_data').upsert(
      { user_id: userId, data: seedData },
      { onConflict: 'user_id' }
    );

    return res.status(201).json({ ok: true, userId });
  }

  // ─────────────────────────────────────────────
  // PUBLIC: Sign in — returns a Supabase session token
  // POST /api/chat?action=login
  // Body: { username, password }
  // ─────────────────────────────────────────────
  if (action === 'login') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const email = username.includes('@') ? username : `${username}@studyapp.local`;

    // Use anon client for signIn (returns user-scoped JWT)
    const anonSb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    const { data, error } = await anonSb.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    return res.status(200).json({
      ok:           true,
      accessToken:  data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId:       data.user.id,
      expiresAt:    data.session.expires_at,
    });
  }

  // ─────────────────────────────────────────────
  // AUTHENTICATED: load user data
  // GET /api/chat?action=load
  // Header: Authorization: Bearer <access_token>
  // ─────────────────────────────────────────────
  if (action === 'load') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sb = getAdminClient();
    const { data, error } = await sb
      .from('user_data')
      .select('data')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
      return res.status(500).json({ error: error.message });
    }

    // Phase 1 & 2: run forward migration before returning to client
    const migrated = migrateData(data?.data || null);
    return res.status(200).json({ ok: true, data: migrated });
  }

  // ─────────────────────────────────────────────
  // AUTHENTICATED: save (upsert) user data
  // POST /api/chat?action=save
  // Header: Authorization: Bearer <access_token>
  // Body: { data: <full state object> }
  // ─────────────────────────────────────────────
  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const payload = req.body?.data;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Missing data payload' });
    }

    // Phase 1 & 2: run migration on the incoming payload before saving,
    // so any client that hasn't yet applied the front-end update is still
    // handled gracefully.
    const migratedPayload = migrateData(payload);

    const sb = getAdminClient();
    const { error } = await sb
      .from('user_data')
      .upsert({ user_id: userId, data: migratedPayload }, { onConflict: 'user_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ─────────────────────────────────────────────
  // AUTHENTICATED: delete account & all data
  // DELETE /api/chat?action=delete
  // Header: Authorization: Bearer <access_token>
  // ─────────────────────────────────────────────
  if (action === 'delete') {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
    const userId = await verifyToken(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const sb = getAdminClient();
    // Delete data row first (FK constraint if any)
    await sb.from('user_data').delete().eq('user_id', userId);
    // Delete auth user
    const { error } = await sb.auth.admin.deleteUser(userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: `Unknown action: ${action}` });
}
