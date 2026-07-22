// Estado PROPIO del Agent OS (no del agente): objetivos de Mission Control, y a
// futuro alertas de costos, índice de docs, config de ROI. sqlite via node:sqlite.
// Separado por completo de los sqlite de Hermes.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    brief TEXT,
    status TEXT DEFAULT 'active',      -- active | paused | done | archived
    my_role TEXT,
    agent_role TEXT,
    progress INTEGER DEFAULT 0,        -- 0..100
    target_date TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS pref_events (
    id INTEGER PRIMARY KEY,
    ts TEXT,
    category TEXT,             -- workflow | vida | aprendizaje
    action_type TEXT,
    signal REAL               -- 1 aplicada · 0 descartada · 0.5 pospuesta
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    category TEXT,              -- workflow | vida | aprendizaje
    title TEXT NOT NULL,
    rationale TEXT,
    source TEXT,
    action_type TEXT,          -- cron | kanban | reminder | memory | goal | none
    action_payload TEXT,       -- JSON
    score INTEGER DEFAULT 0,
    mode TEXT DEFAULT 'queue',  -- push | queue | store
    status TEXT DEFAULT 'new',  -- new | applied | dismissed | snoozed
    created_at TEXT,
    decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS dreams (
    id TEXT PRIMARY KEY,
    kind TEXT,                 -- idea | patron | conexion | pregunta
    title TEXT,
    body TEXT,
    status TEXT DEFAULT 'new', -- new | saved | dismissed
    created_at TEXT,
    decided_at TEXT
  );
`);

// Migraciones idempotentes (ALTER falla si la columna ya existe → try/catch).
for (const stmt of [
  "ALTER TABLE suggestions ADD COLUMN exploratory INTEGER DEFAULT 0",
  "ALTER TABLE goals ADD COLUMN outcome TEXT",
  "ALTER TABLE goals ADD COLUMN done_at TEXT",
]) { try { db.exec(stmt); } catch { /* ya existe */ } }

const now = () => new Date().toISOString();
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function listGoals() {
  return db.prepare(`SELECT * FROM goals ORDER BY
    CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
    updated_at DESC`).all();
}

export function createGoal(f) {
  const id = randomUUID().slice(0, 12);
  const ts = now();
  db.prepare(`INSERT INTO goals (id, title, brief, status, my_role, agent_role, progress, target_date, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, String(f.title || 'Sin título'), f.brief || '', f.status || 'active',
         f.my_role || '', f.agent_role || '', clampPct(f.progress), f.target_date || null, ts, ts);
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

export function updateGoal(id, patch) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!g) return null;
  const cols = ['title', 'brief', 'status', 'my_role', 'agent_role', 'target_date', 'outcome'];
  const next = { ...g };
  for (const c of cols) if (patch[c] !== undefined) next[c] = patch[c];
  if (patch.progress !== undefined) next.progress = clampPct(patch.progress);
  if (next.status === 'done' && g.status !== 'done') next.done_at = now();
  else if (next.status !== 'done') next.done_at = null;
  next.updated_at = now();
  db.prepare(`UPDATE goals SET title=?, brief=?, status=?, my_role=?, agent_role=?, progress=?, target_date=?, outcome=?, done_at=?, updated_at=? WHERE id=?`)
    .run(next.title, next.brief, next.status, next.my_role, next.agent_role, next.progress, next.target_date, next.outcome ?? null, next.done_at ?? null, next.updated_at, id);
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
}

export function deleteGoal(id) {
  const r = db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  return { ok: r.changes > 0 };
}

// --- Settings (key-value): presupuesto de costos, etc. ---
export function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  return { ok: true, key, value: String(value) };
}

export function allSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

// --- User Profile (modelo de usuario estructurado, editable). Guardado en settings. ---
const PROFILE_SKELETON = {
  preferences: {}, interests: [], traits: [], workingPatterns: [],
  goalsFocus: [], negativeSignals: [], notes: '',
};
export function getProfile() {
  const raw = getSetting('user_profile', null);
  if (!raw) return { ...PROFILE_SKELETON };
  try { return { ...PROFILE_SKELETON, ...JSON.parse(raw) }; } catch { return { ...PROFILE_SKELETON }; }
}
export function setProfile(obj) {
  const cur = getProfile();
  const next = { ...cur, ...obj };
  setSetting('user_profile', JSON.stringify(next));
  return next;
}
// Normaliza una señal negativa a {text, ts} (compat con las viejas que eran string).
const negText = (n) => (typeof n === 'string' ? n : n?.text || '');
// Agrega una señal negativa (con timestamp, para que expire → "no ahora" ≠ "no nunca").
export function addNegativeSignal(text) {
  if (!text) return getProfile();
  const p = getProfile();
  const neg = (Array.isArray(p.negativeSignals) ? p.negativeSignals : []).filter((n) => negText(n) !== text);
  neg.unshift({ text, ts: now() });
  return setProfile({ negativeSignals: neg.slice(0, 60) });
}
// Quita una señal negativa (para restaurar una sugerencia descartada).
export function removeNegativeSignal(text) {
  if (!text) return getProfile();
  const p = getProfile();
  const neg = (Array.isArray(p.negativeSignals) ? p.negativeSignals : []).filter((n) => negText(n) !== text);
  return setProfile({ negativeSignals: neg });
}
// Señales negativas ACTIVAS (no expiradas). Default: 60 días de olvido.
export function activeNegatives(maxAgeDays = 60) {
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  const p = getProfile();
  return (p.negativeSignals || [])
    .filter((n) => typeof n === 'string' || !n.ts || Date.parse(n.ts) >= cutoff)
    .map(negText).filter(Boolean);
}

// --- Sugerencias ---
export function listSuggestions(status) {
  const sql = status
    ? 'SELECT * FROM suggestions WHERE status = ? ORDER BY score DESC, created_at DESC'
    : 'SELECT * FROM suggestions ORDER BY (status=\'new\') DESC, score DESC, created_at DESC';
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  return rows.map((r) => ({ ...r, action_payload: safeParse(r.action_payload) }));
}
export function getSuggestion(id) {
  const r = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  return r ? { ...r, action_payload: safeParse(r.action_payload) } : null;
}
export function createSuggestion(f) {
  const id = randomUUID().slice(0, 12);
  db.prepare(`INSERT INTO suggestions (id, category, title, rationale, source, action_type, action_payload, score, mode, status, created_at, exploratory)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
    .run(id, f.category || 'workflow', String(f.title || '').slice(0, 300), f.rationale || '', f.source || '',
         f.action_type || 'none', JSON.stringify(f.action_payload || {}), Math.round(Number(f.score) || 0), f.mode || 'queue', now(), f.exploratory ? 1 : 0);
  return getSuggestion(id);
}
export function setSuggestionStatus(id, status) {
  const r = db.prepare('UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ?').run(status, now(), id);
  return { ok: r.changes > 0 };
}
export function clearSuggestions(scope = 'all') {
  // 'pending' = solo new/snoozed; 'all' = todo (preserva el user_profile y señales).
  const r = scope === 'pending'
    ? db.prepare("DELETE FROM suggestions WHERE status IN ('new','snoozed')").run()
    : db.prepare('DELETE FROM suggestions').run();
  return { ok: true, deleted: r.changes };
}
export function deleteSuggestion(id) {
  const r = db.prepare('DELETE FROM suggestions WHERE id = ?').run(id);
  return { ok: r.changes > 0 };
}

// Contador de PUSHES enviados hoy (para el presupuesto duro).
export function pushSentToday() {
  return getSetting('push_day', '') === now().slice(0, 10) ? Number(getSetting('push_count', '0')) : 0;
}
export function recordPushSent() {
  setSetting('push_day', now().slice(0, 10));
  setSetting('push_count', String(pushSentToday() + 1));
  return pushSentToday();
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// --- Dreams (reflexiones/ideas creativas del agente sobre tu vida) ---
export function createDream(f) {
  const id = randomUUID().slice(0, 12);
  db.prepare(`INSERT INTO dreams (id, kind, title, body, status, created_at) VALUES (?, ?, ?, ?, 'new', ?)`)
    .run(id, f.kind || 'idea', String(f.title || '').slice(0, 200), f.body || '', now());
  return db.prepare('SELECT * FROM dreams WHERE id = ?').get(id);
}
export function listDreams(limit = 60) {
  return db.prepare(`SELECT * FROM dreams ORDER BY (status='new') DESC, created_at DESC LIMIT ?`).all(limit);
}
export function getDream(id) { return db.prepare('SELECT * FROM dreams WHERE id = ?').get(id); }
export function setDreamStatus(id, status) {
  const r = db.prepare('UPDATE dreams SET status = ?, decided_at = ? WHERE id = ?').run(status, now(), id);
  return { ok: r.changes > 0 };
}
export function recentDreamTitles(n = 30) {
  return db.prepare('SELECT title FROM dreams ORDER BY created_at DESC LIMIT ?').all(n).map((r) => r.title);
}

// --- Eventos de preferencia (para el drift). Sobreviven al vaciado del inbox. ---
const SIGNAL = { applied: 1, dismissed: 0, snoozed: 0.5 };
export function recordPrefEvent(category, action_type, decision) {
  const signal = SIGNAL[decision] ?? 0.5;
  db.prepare('INSERT INTO pref_events (ts, category, action_type, signal) VALUES (?, ?, ?, ?)')
    .run(now(), category || 'workflow', action_type || 'none', signal);
}
export function listPrefEvents(limit = 500) {
  return db.prepare('SELECT category, action_type, signal, ts FROM pref_events ORDER BY id LIMIT ?').all(limit);
}
