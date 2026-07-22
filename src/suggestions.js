// Motor de proactividad (Fase 1). Loop dirigido estilo ProAct:
// contexto local → predicción/generación (pass LLM tool-free) → scoring+gate →
// inbox. Aplicar despacha a los writers YA EXISTENTES del adapter. Descartar deja
// señal negativa en el perfil. Nada se ejecuta sin tu 1-click.
import {
  createSuggestion, listSuggestions, getSuggestion, setSuggestionStatus,
  getProfile, setProfile, addNegativeSignal, removeNegativeSignal, activeNegatives, listGoals, getSetting, setSetting, createGoal, updateGoal,
  pushSentToday, recordPushSent, recordPrefEvent,
} from './db.js';
import { computeAffinity, affinityHint, scoreNudge } from './preferences.js';

const CATEGORIES = new Set(['workflow', 'vida', 'aprendizaje']);
const ACTIONS = new Set(['cron', 'kanban', 'reminder', 'memory', 'goal', 'goal_progress', 'none']);

// --- Contexto local (todo lo que el Agent OS ya lee) ---
async function buildContext(adapter) {
  const [crons, kanban, memory, skills, dreaming, sessions] = await Promise.all([
    adapter.getCrons(), adapter.getKanban(), adapter.getMemory(), adapter.getSkills(),
    adapter.getDreaming().catch(() => ({ briefs: [] })), adapter.getSessions('(default)', 15),
  ]);
  const goals = listGoals();
  const profile = getProfile();
  const mem = memory.find((m) => m.profile === '(default)') || memory[0] || {};
  const digest = dreaming.briefs?.[0]?.response?.slice(0, 1200) || '';
  const deadSkills = skills.skills.filter((s) => s.useCount === 0).map((s) => s.name).slice(0, 20);
  const topSkills = skills.skills.filter((s) => s.useCount > 0).slice(0, 10).map((s) => `${s.name}(${s.useCount})`);

  return {
    profile,
    crons: crons.map((c) => ({ name: c.name, schedule: c.schedule, enabled: c.enabled, lastStatus: c.lastStatus })),
    kanban: { byStatus: kanban.byStatus, recent: kanban.tasks.slice(0, 12).map((t) => ({ title: t.title, status: t.status, board: t.board })) },
    goals: goals.map((g) => ({ title: g.title, status: g.status, progress: g.progress })),
    memory: { memory: mem.memory?.text || '', user: mem.user?.text || '' },
    skills: { top: topSkills, dead: deadSkills },
    digest,
    sessions: sessions.map((s) => s.title || s.source).slice(0, 12),
  };
}

function buildPrompt(ctx, avoid = [], hint = '') {
  const avoidBlock = avoid.length
    ? `\n\nNO PROPONGAS NADA parecido a esto (ya está en el inbox o el usuario lo descartó — repetirlo lo molesta):\n${avoid.map((t) => `- ${t}`).join('\n')}\n`
    : '';
  return `Sos el motor de PROACTIVIDAD de un "Agent OS" personal. Analizá el contexto del usuario y proponé sugerencias CONCRETAS y ACCIONABLES para mejorar su trabajo/flujos, su vida/hábitos y su aprendizaje. Basate SOLO en los datos; no inventes. Cada sugerencia debe tener un "por qué" anclado en el contexto.
${avoidBlock}${hint}
REGLAS:
- No repitas temas que el usuario ya descartó ni los que ya están en el inbox (lista de arriba).
- Preferí acciones que se puedan ejecutar: crear un cron, una tarea de kanban, un recordatorio, una nota de memoria, o un objetivo.
- Sé específico: si sugerís un cron, dá el schedule y el prompt exactos.
- Entre 3 y 6 sugerencias. Priorizá calidad sobre cantidad.
- Respondé EXCLUSIVAMENTE con un array JSON válido, sin texto extra, sin markdown, sin herramientas.

Formato de cada item:
{"category":"workflow|vida|aprendizaje","title":"…","rationale":"por qué, citando el dato","source":"de dónde salió (ej: kanban, digest, skills muertas)","action_type":"cron|kanban|reminder|memory|goal|none","action_payload":{…},"relevance":0-100,"knowledge_gap":0-100,"incremental_value":0-100,"timeliness":"now|soon|whenever"}
Sub-scores (0-100): relevance = qué tan relevante para el usuario ahora; knowledge_gap = qué tanto NO lo sabe o no lo tiene resuelto; incremental_value = cuánto AGREGA MÁS ALLÁ de lo que YA está en su memoria/perfil (si ya lo tiene anotado o resuelto, bajá esto fuerte); timeliness = urgencia temporal.

action_payload según action_type:
- cron/reminder: {"schedule":"0 9 * * * | 30m | 2026-08-01 09:00","prompt":"instrucción","name":"nombre","deliver":"local|discord|slack|telegram"}
- kanban: {"title":"…","body":"…","board":"default"}
- memory: {"which":"user|memory","text":"línea a recordar"}
- goal: {"title":"…","brief":"…","my_role":"…","agent_role":"…"}   (proponé un OBJETIVO de mediano plazo si detectás una meta grande)
- goal_progress: {"goalTitle":"título EXACTO de un objetivo activo del contexto","progress":0-100,"note":"por qué ese %"}   (si notás avance en un objetivo existente)
- none: {}

CONTEXTO (JSON):
${JSON.stringify(ctx).slice(0, 12000)}`;
}

// Extrae el primer array JSON del texto (el agente puede envolver en prosa/```).
function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Gate: modo de entrega según score + timeliness + presupuesto de push.
function decideMode(score, timeliness) {
  const pushThresh = Number(getSetting('sugg_push_threshold', '75'));
  const queueThresh = Number(getSetting('sugg_queue_threshold', '45'));
  if (score >= pushThresh && timeliness === 'now') return 'push';
  if (score >= queueThresh) return 'queue';
  return 'store';
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim();

// Lock global: manual y scheduler NO deben generar en paralelo (contención del modelo).
let generating = false;

export async function generateSuggestions(adapter, { trigger = 'manual' } = {}) {
  if (generating) return { ok: false, error: 'ya hay una generación en curso', created: 0, busy: true };
  generating = true;
  try {
    return await _generateSuggestions(adapter, { trigger });
  } finally {
    generating = false;
  }
}

async function _generateSuggestions(adapter, { trigger = 'manual' } = {}) {
  const ctx = await buildContext(adapter);
  // Dedup dirigido: pasarle al modelo lo que ya está en el inbox + lo descartado (activo).
  const inboxTitles = listSuggestions().filter((s) => s.status === 'new' || s.status === 'snoozed').map((s) => s.title);
  const negativeTitles = activeNegatives();
  const avoid = [...new Set([...inboxTitles, ...negativeTitles])].slice(0, 40);
  const affinity = computeAffinity(); // drift de preferencias (Fase 4)

  // Anti-burbuja: categorías que el usuario viene ignorando/descartando → pedir ≥1 exploratoria.
  const exploreCats = new Set(Object.entries(affinity.categories || {})
    .filter(([, x]) => x.n >= 2 && (x.trend === 'falling' || x.affinity <= 0.4)).map(([c]) => c));
  const exploreHint = exploreCats.size
    ? `\n\nANTI-BURBUJA: incluí al menos 1 sugerencia de estas categorías que el usuario viene ignorando (para no encerrarlo): ${[...exploreCats].join(', ')}.\n`
    : '';

  const gen = await adapter.generateRawSuggestions(buildPrompt(ctx, avoid, affinityHint(affinity) + exploreHint));
  if (!gen.ok) return { ok: false, error: gen.error || 'falló la generación', created: 0 };
  const arr = extractJsonArray(gen.text);
  if (!Array.isArray(arr)) return { ok: false, error: 'la respuesta no fue JSON válido', created: 0, raw: (gen.text || '').slice(0, 300) };

  // Backstop por string (por si el modelo igual repite algo).
  const existing = new Set(listSuggestions().filter((s) => s.status !== 'applied').map((s) => norm(s.title)));
  const negatives = negativeTitles.map(norm);
  const minScore = Number(getSetting('sugg_min_score', '40'));
  const pushEnabled = getSetting('push_enabled', '0') === '1';
  const budget = Number(getSetting('push_budget', '4'));
  // Pesos de la fórmula de valor (ProAct). Configurables por settings.
  const W = {
    rel: Number(getSetting('sugg_w_rel', '0.30')), gap: Number(getSetting('sugg_w_gap', '0.20')),
    incr: Number(getSetting('sugg_w_incr', '0.30')), time: Number(getSetting('sugg_w_time', '0.20')),
  };
  const TIME = { now: 100, soon: 60, whenever: 20 };
  let created = 0, skipped = 0, pushed = 0, stored = 0, exploredOne = false;
  for (const c of arr) {
    const category = CATEGORIES.has(c.category) ? c.category : 'workflow';
    // Exploratoria: 1 por tanda, de una categoría que el usuario viene ignorando.
    const isExplore = !exploredOne && exploreCats.has(category);
    // Score determinista desde 4 sub-scores; si el modelo dio `score` (compat), usarlo.
    const timeScore = TIME[c.timeliness] ?? 50;
    const base = c.score != null
      ? Number(c.score) || 0
      : (W.rel * (num100(c.relevance)) + W.gap * (num100(c.knowledge_gap)) + W.incr * (num100(c.incremental_value)) + W.time * timeScore);
    // La exploratoria NO recibe el nudge negativo (sería injusto castigarla justo por bajar).
    const score = Math.max(0, Math.min(100, Math.round(base) + (isExplore ? 0 : scoreNudge(category, affinity))));
    if (!isExplore && score < minScore) { skipped++; continue; }
    const t = norm(c.title);
    if (existing.has(t) || negatives.some((n) => n && (t.includes(n) || n.includes(t)))) { skipped++; continue; }
    existing.add(t);
    const action_type = ACTIONS.has(c.action_type) ? c.action_type : 'none';
    let mode = decideMode(score, c.timeliness);
    // Modo "store" (bajo valor): NO ensucia el inbox — se guarda como insight en el perfil.
    // (una exploratoria nunca se guarda callada: queremos que la veas.)
    if (mode === 'store' && !isExplore) { storeInsight(c.title, c.rationale); stored++; continue; }
    if (mode === 'store') mode = 'queue';
    // Gate de entrega: push solo si está habilitado y queda presupuesto; si no, cae a cola.
    const canPush = mode === 'push' && pushEnabled && pushSentToday() < budget;
    if (mode === 'push' && !canPush) mode = 'queue';
    const s = createSuggestion({
      category, title: c.title, rationale: c.rationale, source: `${c.source || ''}${trigger !== 'manual' ? ` · auto:${trigger}` : ''}`,
      action_type, action_payload: c.action_payload || {}, score, mode, exploratory: isExplore,
    });
    created++;
    if (isExplore) exploredOne = true;
    if (canPush) { const ok = await deliverPush(adapter, s); if (ok) { recordPushSent(); pushed++; } }
  }
  return { ok: true, created, skipped, pushed, stored, total: arr.length };
}

const num100 = (v) => Math.max(0, Math.min(100, Number(v) || 0));
// Guarda un insight de baja prioridad en el perfil (modo "store"), acotado.
function storeInsight(title, rationale) {
  const p = getProfile();
  const list = Array.isArray(p.storedInsights) ? p.storedInsights : [];
  const line = rationale ? `${title} — ${rationale}` : title;
  if (!list.some((x) => x === line)) list.unshift(line);
  setProfile({ storedInsights: list.slice(0, 30) });
}

// --- Entrega push (Fase 3): manda una sugerencia a un canal vía `hermes send`. ---
function formatPush(s) {
  const emoji = { workflow: '🛠️', vida: '🌱', aprendizaje: '📚' }[s.category] || '💡';
  const prev = s.action_type !== 'none' ? `\n▸ acción disponible en el Agent OS` : '';
  return `${emoji} Sugerencia (${s.category})\n*${s.title}*\n${s.rationale || ''}${prev}\n— tu Agent OS`;
}
export async function deliverPush(adapter, s) {
  const channel = getSetting('push_channel', 'discord');
  const r = await adapter.pushMessage(channel, formatPush(s));
  return r.ok;
}

// --- Morning brief (Fase 3): un ÚNICO push/día con el top de la cola. ---
export async function sendMorningBrief(adapter, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force) {
    if (getSetting('brief_enabled', '0') !== '1') return { ok: false, reason: 'brief deshabilitado' };
    if (getSetting('brief_day', '') === today) return { ok: false, reason: 'ya enviado hoy' };
  }
  const queued = listSuggestions('new').filter((s) => s.mode !== 'store').slice(0, 5);
  if (!queued.length) { setSetting('brief_day', today); return { ok: false, reason: 'sin sugerencias en cola' }; }
  const lines = queued.map((s, i) => `${i + 1}. ${{ workflow: '🛠️', vida: '🌱', aprendizaje: '📚' }[s.category] || '•'} ${s.title}`);
  const text = `☀️ *Brief proactivo* — ${queued.length} sugerencia(s) esperándote en el Agent OS:\n\n${lines.join('\n')}\n\nEntrá al dashboard para aplicarlas o descartarlas.`;
  const channel = getSetting('push_channel', 'discord');
  const r = await adapter.pushMessage(channel, text);
  if (r.ok) setSetting('brief_day', today);
  return { ok: r.ok, sent: queued.length, error: r.error };
}

// --- Aplicar (1 click) → despacha al writer correspondiente del adapter ---
export async function applySuggestion(adapter, id) {
  const s = getSuggestion(id);
  if (!s) return { ok: false, error: 'no existe' };
  if (s.status === 'applied') return { ok: false, error: 'ya aplicada' };
  const p = s.action_payload || {};
  let res = { ok: true };
  try {
    switch (s.action_type) {
      case 'cron':
      case 'reminder':
        res = await adapter.cronCreate('(default)', { schedule: p.schedule, prompt: p.prompt, name: p.name || s.title, deliver: p.deliver, skills: p.skills });
        break;
      case 'kanban':
        res = await adapter.kanbanCreate('(default)', { title: p.title || s.title, body: p.body, board: p.board });
        break;
      case 'memory': {
        const mem = (await adapter.getMemory()).find((m) => m.profile === '(default)');
        const which = p.which === 'memory' ? 'memory' : 'user';
        const cur = which === 'memory' ? mem?.memory?.text : mem?.user?.text;
        const sep = cur && !cur.endsWith('\n') ? '\n' : '';
        res = await adapter.writeMemory('(default)', which, `${cur || ''}${sep}§ ${p.text || s.title}`);
        break;
      }
      case 'goal':
        res = { ok: true, goal: createGoal({ title: p.title || s.title, brief: p.brief, my_role: p.my_role, agent_role: p.agent_role }) };
        break;
      case 'goal_progress': {
        const g = listGoals().find((x) => x.title === p.goalTitle) || listGoals().find((x) => (x.title || '').toLowerCase().includes(String(p.goalTitle || '').toLowerCase()));
        if (!g) { res = { ok: false, error: 'objetivo no encontrado' }; break; }
        res = { ok: true, goal: updateGoal(g.id, { progress: p.progress }) };
        break;
      }
      case 'profile': {
        // Merge de un hecho aprendido al perfil (campo de lista), con confirmación del usuario.
        const prof = getProfile();
        const field = ['interests', 'traits', 'workingPatterns', 'goalsFocus'].includes(p.field) ? p.field : 'interests';
        const list = Array.isArray(prof[field]) ? prof[field] : [];
        if (p.value && !list.includes(p.value)) list.unshift(p.value);
        setProfile({ [field]: list });
        res = { ok: true, profile: true };
        break;
      }
      case 'none':
      default:
        res = { ok: true, info: true };
    }
  } catch (e) { res = { ok: false, error: e.message }; }

  if (res.ok) { setSuggestionStatus(id, 'applied'); recordPrefEvent(s.category, s.action_type, 'applied'); }
  return { ...res, suggestion: getSuggestion(id) };
}

export function dismissSuggestion(id, reason) {
  const s = getSuggestion(id);
  if (!s) return { ok: false, error: 'no existe' };
  addNegativeSignal(reason || s.title);
  setSuggestionStatus(id, 'dismissed');
  recordPrefEvent(s.category, s.action_type, 'dismissed');
  return { ok: true };
}

export function snoozeSuggestion(id) {
  const s = getSuggestion(id);
  setSuggestionStatus(id, 'snoozed');
  if (s) recordPrefEvent(s.category, s.action_type, 'snoozed');
  return { ok: true };
}

// Restaura una sugerencia descartada: vuelve al inbox y quita la señal negativa
// que la bloqueaba (para que sí se pueda volver a agregar/sugerir).
export function restoreSuggestion(id) {
  const s = getSuggestion(id);
  if (!s) return { ok: false, error: 'no existe' };
  removeNegativeSignal(s.title);
  setSuggestionStatus(id, 'new');
  return { ok: true };
}

export function getInbox() {
  const day = new Date().toISOString().slice(0, 10);
  const auto = {
    enabled: getSetting('auto_suggest_enabled', '1') === '1',
    nightlyHour: Number(getSetting('auto_nightly_hour', '8')),
    lastGenAt: getSetting('sugg_last_gen_at', null),
    genToday: getSetting('sugg_gen_day', '') === day ? Number(getSetting('sugg_gen_count', '0')) : 0,
    dailyCap: Number(getSetting('auto_daily_cap', '3')),
  };
  const delivery = {
    pushEnabled: getSetting('push_enabled', '0') === '1',
    channel: getSetting('push_channel', 'discord'),
    budget: Number(getSetting('push_budget', '4')),
    pushedToday: pushSentToday(),
    briefEnabled: getSetting('brief_enabled', '0') === '1',
    briefDay: getSetting('brief_day', null),
  };
  return { ok: true, suggestions: listSuggestions(), profile: getProfile(), auto, delivery };
}
