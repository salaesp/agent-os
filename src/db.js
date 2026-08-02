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
  -- Hallazgos técnicos de repositorios: aislados del inbox de proactividad.
  CREATE TABLE IF NOT EXISTS code_suggestions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    branch TEXT,
    title TEXT NOT NULL,
    rationale TEXT,
    evidence TEXT,
    next_step TEXT,
    severity TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'new',
    created_at TEXT,
    decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_code_suggestions_project ON code_suggestions(project, status, created_at);
  CREATE TABLE IF NOT EXISTS code_review_events (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    action TEXT NOT NULL, -- found | task_created | done | dismissed
    board TEXT,
    detail TEXT,
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_code_review_events_finding ON code_review_events(finding_id, created_at);
  CREATE TABLE IF NOT EXISTS dreams (
    id TEXT PRIMARY KEY,
    kind TEXT,                 -- idea | patron | conexion | pregunta
    title TEXT,
    body TEXT,
    status TEXT DEFAULT 'new', -- new | saved | dismissed
    created_at TEXT,
    decided_at TEXT
  );
  -- Ejecuciones del agente: una fila por invocación del CLI hermes. Antes no
  -- quedaba NADA de una corrida (ni duración, ni error, ni qué se pidió): si el
  -- bundle nocturno fallaba, el detalle moría en un console.error.
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    ts TEXT, ended_at TEXT,
    day TEXT,         -- día LOCAL (localDay) — filtrar por ts sería UTC y correría el corte
    kind TEXT,        -- chat | raw | learn_skill | cron | kanban | curator | config | other
    profile TEXT,
    argv TEXT,        -- JSON de args (prompts truncados)
    model TEXT,
    ms INTEGER,
    ok INTEGER, code INTEGER, err TEXT,
    out_chars INTEGER,
    trigger TEXT      -- nightly | boundary | manual | api
  );
  -- Ledger append-only de DECISIONES: del agente (qué propuso y por qué), del
  -- usuario (qué hizo con eso) y humanas del vault (decisions/YYYY-MM.md).
  -- Es lo que permite reconstruir el porqué de algo que apareció en el inbox.
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    ts TEXT,
    day TEXT,           -- día LOCAL (localDay), para que el REM corte donde corta el usuario
    actor TEXT,         -- agent | user | vault
    stage TEXT,         -- suggest | dream | ideate | profile | skill_scout | promote | apply | dismiss | snooze | rem
    subject_type TEXT,  -- suggestion | dream | goal | skill | profile | none
    subject_id TEXT,
    title TEXT,
    choice TEXT,        -- push | queue | store | created | skipped | applied | dismissed | snoozed
    rationale TEXT,
    inputs TEXT,        -- JSON: qué entró (n sesiones, n goals, títulos evitados…)
    evidence TEXT,      -- JSON: evidencia concreta (goalIds, sessionIds, negativas)
    scores TEXT,        -- JSON: {relevance, gap, incr, time, base, nudge, final, threshold}
    run_id TEXT,        -- → runs.id
    parent_id TEXT,     -- → decisions.id (cadena dream → promote → suggestion → apply)
    source TEXT         -- para actor='vault': ruta relativa del .md
  );
  -- Primeros índices del repo. Estas dos tablas crecen por CORRIDA (no por acción
  -- del usuario), así que un full scan acá escala distinto que en suggestions.
  CREATE INDEX IF NOT EXISTS idx_decisions_day ON decisions(day);
  CREATE INDEX IF NOT EXISTS idx_runs_day ON runs(day);
  CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
  CREATE INDEX IF NOT EXISTS idx_decisions_subject ON decisions(subject_type, subject_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_parent ON decisions(parent_id);
  CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
`);

// Migraciones idempotentes (ALTER falla si la columna ya existe → try/catch).
for (const stmt of [
  "ALTER TABLE suggestions ADD COLUMN exploratory INTEGER DEFAULT 0",
  "ALTER TABLE suggestions ADD COLUMN dismiss_reason TEXT",
  "ALTER TABLE suggestions ADD COLUMN dismiss_note TEXT",
  "ALTER TABLE dreams ADD COLUMN promoted_to TEXT",
  "ALTER TABLE goals ADD COLUMN outcome TEXT",
  "ALTER TABLE goals ADD COLUMN done_at TEXT",
  "ALTER TABLE code_suggestions ADD COLUMN task_board TEXT",
  "ALTER TABLE code_suggestions ADD COLUMN task_created_at TEXT",
  "ALTER TABLE code_suggestions ADD COLUMN next_step TEXT",
]) { try { db.exec(stmt); } catch { /* ya existe */ } }

const now = () => new Date().toISOString();
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

// Día calendario LOCAL (YYYY-MM-DD). OJO: no usar toISOString().slice(0,10) para
// esto — es UTC, y con TZ negativa (acá UTC-3) el "día" rotaba a las 21:00 local,
// duplicando cupos diarios y desalineando los contadores con la hora del usuario.
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
// `reason` es el MOTIVO del descarte (ya lo hice / no me interesa / …) y `ttlDays`
// cuánto dura el bloqueo: "ya lo hice" bloquea mucho, "mal momento" poquito.
export function addNegativeSignal(text, { reason = null, ttlDays = null, note = null } = {}) {
  if (!text) return getProfile();
  const p = getProfile();
  const neg = (Array.isArray(p.negativeSignals) ? p.negativeSignals : []).filter((n) => negText(n) !== text);
  neg.unshift({ text, ts: now(), reason, ttl: ttlDays, note: note || null });
  return setProfile({ negativeSignals: neg.slice(0, 60) });
}
// Quita una señal negativa (para restaurar una sugerencia descartada).
export function removeNegativeSignal(text) {
  if (!text) return getProfile();
  const p = getProfile();
  const neg = (Array.isArray(p.negativeSignals) ? p.negativeSignals : []).filter((n) => negText(n) !== text);
  return setProfile({ negativeSignals: neg });
}
// Señales negativas ACTIVAS (no expiradas), con su motivo. El TTL sale de la
// señal misma si el descarte traía motivo; si no, el default de 60 días.
export function activeNegativeEntries(maxAgeDays = 60) {
  return (getProfile().negativeSignals || [])
    .map((n) => (typeof n === 'string' ? { text: n } : n))
    .filter((n) => {
      if (!n?.text) return false;
      if (!n.ts) return true;
      return Date.now() - Date.parse(n.ts) < (Number(n.ttl) || maxAgeDays) * 86400_000;
    });
}
export function activeNegatives(maxAgeDays = 60) {
  return activeNegativeEntries(maxAgeDays).map((n) => n.text);
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
// `patch` lleva el motivo del descarte; en aplicar/posponer/restaurar va vacío y
// eso LIMPIA el motivo viejo (que ya no aplica).
export function setSuggestionStatus(id, status, patch = {}) {
  const r = db.prepare('UPDATE suggestions SET status = ?, decided_at = ?, dismiss_reason = ?, dismiss_note = ? WHERE id = ?')
    .run(status, now(), patch.reason || null, patch.note || null, id);
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

// --- Revisión de código (no afecta preferencias ni el inbox personal) ---
export function listCodeSuggestions() {
  return db.prepare("SELECT * FROM code_suggestions ORDER BY (status='new') DESC, CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC").all();
}
export function listCodeSuggestionEvents() {
  return db.prepare('SELECT * FROM code_review_events ORDER BY created_at DESC').all();
}
function recordCodeSuggestionEvent(findingId, action, { board = null, detail = null } = {}) {
  db.prepare('INSERT INTO code_review_events (id, finding_id, action, board, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID().slice(0, 12), findingId, action, board, detail, now());
}
export function createCodeSuggestion(f) {
  const id = randomUUID().slice(0, 12);
  db.prepare(`INSERT INTO code_suggestions (id, project, branch, title, rationale, evidence, next_step, severity, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`)
    .run(id, String(f.project || ''), f.branch || null, String(f.title || '').slice(0, 300), f.rationale || '', f.evidence || '', f.next_step || '',
      ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'medium', now());
  const finding = db.prepare('SELECT * FROM code_suggestions WHERE id = ?').get(id);
  recordCodeSuggestionEvent(id, 'found', { detail: finding.title });
  return finding;
}
export function setCodeSuggestionStatus(id, status) {
  const next = ['new', 'dismissed', 'done'].includes(status) ? status : 'dismissed';
  const r = db.prepare('UPDATE code_suggestions SET status = ?, decided_at = ? WHERE id = ?').run(next, now(), id);
  if (r.changes > 0 && next !== 'new') recordCodeSuggestionEvent(id, next);
  return { ok: r.changes > 0 };
}
export function getCodeSuggestion(id) {
  return db.prepare('SELECT * FROM code_suggestions WHERE id = ?').get(id) || null;
}
export function linkCodeSuggestionTask(id, board) {
  const r = db.prepare("UPDATE code_suggestions SET status = 'task_created', decided_at = ?, task_board = ?, task_created_at = ? WHERE id = ?")
    .run(now(), String(board || 'default'), now(), id);
  if (r.changes > 0) recordCodeSuggestionEvent(id, 'task_created', { board: String(board || 'default') });
  return { ok: r.changes > 0 };
}

// Contador de PUSHES enviados hoy (para el presupuesto duro). Día LOCAL: si no,
// el presupuesto se reseteaba a las 21:00 y podías comerte el doble de pushes.
export function pushSentToday() {
  return getSetting('push_day', '') === localDay() ? Number(getSetting('push_count', '0')) : 0;
}
export function recordPushSent() {
  setSetting('push_day', localDay());
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
// Deja registrado que este sueño ya se bajó a una sugerencia concreta. Sin esto,
// un sueño aterrizado era indistinguible de uno simplemente guardado: si cerrabas
// la página mientras corría, no quedaba ni rastro de qué produjo.
export function setDreamPromoted(id, suggestionId) {
  const r = db.prepare('UPDATE dreams SET promoted_to = ?, status = ?, decided_at = ? WHERE id = ?')
    .run(suggestionId, 'saved', now(), id);
  return { ok: r.changes > 0 };
}
export function recentDreamTitles(n = 30) {
  return db.prepare('SELECT title FROM dreams ORDER BY created_at DESC LIMIT ?').all(n).map((r) => r.title);
}

// --- Eventos de preferencia (para el drift). Sobreviven al vaciado del inbox. ---
// `override` permite que el MOTIVO del descarte module la señal: descartar algo
// porque "ya lo hice" no es lo mismo que porque "no me interesa" — en el primer
// caso la sugerencia era buena y no hay que castigar la categoría.
const SIGNAL = { applied: 1, dismissed: 0, snoozed: 0.5 };
export function recordPrefEvent(category, action_type, decision, override = null) {
  const signal = override != null ? Math.max(0, Math.min(1, Number(override) || 0)) : (SIGNAL[decision] ?? 0.5);
  db.prepare('INSERT INTO pref_events (ts, category, action_type, signal) VALUES (?, ?, ?, ?)')
    .run(now(), category || 'workflow', action_type || 'none', signal);
}
export function listPrefEvents(limit = 500) {
  return db.prepare('SELECT category, action_type, signal, ts FROM pref_events ORDER BY id LIMIT ?').all(limit);
}

// --- Rastro de decisiones (decision trail) ---------------------------------
// Ledger append-only: por qué el agente propuso algo, con qué evidencia y qué
// corrida lo produjo; qué hizo el usuario con eso; y las decisiones humanas que
// ya viven en el vault. NINGUNA de estas funciones lanza: es telemetría, no
// puede tumbar el flujo que la está registrando.

const json = (v) => { try { return v == null ? null : JSON.stringify(v); } catch { return null; } };
const unjson = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const hydrate = (r) => (r ? { ...r, inputs: unjson(r.inputs), evidence: unjson(r.evidence), scores: unjson(r.scores) } : null);

export function recordDecision(f = {}) {
  try {
    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO decisions
      (id, ts, day, actor, stage, subject_type, subject_id, title, choice, rationale, inputs, evidence, scores, run_id, parent_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      // `day` es normalmente hoy, pero se puede fijar: una decisión humana que el
      // REM levanta del vault pertenece al día en que se tomó, no al día en que
      // se la ingirió (si no, reconsolidar un día viejo la duplica).
      .run(id, now(), f.day || localDay(), f.actor || 'agent', f.stage || 'suggest',
           f.subject_type || 'none', f.subject_id || null, String(f.title || '').slice(0, 300),
           f.choice || null, f.rationale || null,
           json(f.inputs), json(f.evidence), json(f.scores),
           f.run_id || null, f.parent_id || null, f.source || null);
    return hydrate(db.prepare('SELECT * FROM decisions WHERE id = ?').get(id));
  } catch { return null; }
}

// Par start/end para envolver una ejecución. startRun devuelve el id (o null si
// falló el insert) y endRun lo cierra con duración y resultado.
export function startRun(f = {}) {
  try {
    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO runs (id, ts, day, kind, profile, argv, model, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, now(), localDay(), f.kind || 'other', f.profile || null, json(f.argv), f.model || null, f.trigger || 'api');
    return id;
  } catch { return null; }
}

export function endRun(id, r = {}) {
  if (!id) return;
  try {
    db.prepare('UPDATE runs SET ended_at=?, ms=?, ok=?, code=?, err=?, out_chars=? WHERE id=?')
      .run(now(), Math.round(Number(r.ms) || 0), r.ok ? 1 : 0, Number(r.code) || 0,
           (r.err || '').slice(0, 500) || null, Number(r.out_chars) || 0, id);
  } catch { /* telemetría: nunca rompe al caller */ }
}

export function listDecisions({ day = null, subjectId = null, stage = null, actor = null, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (day) { where.push('day = ?'); args.push(day); }
  if (subjectId) { where.push('subject_id = ?'); args.push(subjectId); }
  if (stage) { where.push('stage = ?'); args.push(stage); }
  if (actor) { where.push('actor = ?'); args.push(actor); }
  const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`;
  try { return db.prepare(sql).all(...args, limit).map(hydrate); } catch { return []; }
}

export function listRuns({ day = null, limit = 500 } = {}) {
  try {
    return day
      ? db.prepare('SELECT * FROM runs WHERE day = ? ORDER BY ts DESC LIMIT ?').all(day, limit)
      : db.prepare('SELECT * FROM runs ORDER BY ts DESC LIMIT ?').all(limit);
  } catch { return []; }
}

// Cadena completa de una decisión: sus ancestros por parent_id y sus hijos.
// Es lo que permite ir de "apliqué esto" hasta el sueño que lo originó.
export function getDecisionChain(id) {
  const out = [];
  try {
    let cur = hydrate(db.prepare('SELECT * FROM decisions WHERE id = ?').get(id));
    if (!cur) return { ok: false, chain: [] };
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {           // hacia arriba
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parent_id ? hydrate(db.prepare('SELECT * FROM decisions WHERE id = ?').get(cur.parent_id)) : null;
    }
    let frontier = [id];                          // hacia abajo
    while (frontier.length) {
      const kids = frontier.flatMap((p) => db.prepare('SELECT * FROM decisions WHERE parent_id = ?').all(p).map(hydrate));
      const fresh = kids.filter((k) => k && !seen.has(k.id));
      if (!fresh.length) break;
      for (const k of fresh) { seen.add(k.id); out.push(k); }
      frontier = fresh.map((k) => k.id);
    }
    return { ok: true, chain: out };
  } catch { return { ok: false, chain: out }; }
}

// Retención: el ledger crece por corrida, no por acción del usuario. Lo purga el
// REM al cerrar la noche.
export function purgeTrail(days = 90) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(days) || 90) * 86400_000).toISOString();
  try {
    const d = db.prepare('DELETE FROM decisions WHERE ts < ?').run(cutoff);
    const r = db.prepare('DELETE FROM runs WHERE ts < ?').run(cutoff);
    return { ok: true, decisions: d.changes, runs: r.changes };
  } catch (e) { return { ok: false, error: e.message }; }
}
