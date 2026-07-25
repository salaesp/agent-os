// Motor de proactividad (Fase 1). Loop dirigido estilo ProAct:
// contexto local → predicción/generación (pass LLM tool-free) → scoring+gate →
// inbox. Aplicar despacha a los writers YA EXISTENTES del adapter. Descartar deja
// señal negativa en el perfil. Nada se ejecuta sin tu 1-click.
import {
  createSuggestion, listSuggestions, getSuggestion, setSuggestionStatus,
  getProfile, setProfile, addNegativeSignal, removeNegativeSignal, activeNegativeEntries, listGoals, getSetting, setSetting, createGoal, updateGoal,
  pushSentToday, recordPushSent, recordPrefEvent, recordDecision, listDecisions,
} from './db.js';
import { computeAffinity, affinityHint, scoreNudge } from './preferences.js';
import { createHmac, randomBytes } from 'node:crypto';
import { config } from './config.js';

const CATEGORIES = new Set(['workflow', 'vida', 'aprendizaje']);
const ACTIONS = new Set(['cron', 'kanban', 'reminder', 'memory', 'goal', 'goal_progress', 'skill_learn', 'none']);

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
    ? `\n\nNO PROPONGAS NADA parecido a esto (ya está en el inbox o el usuario lo descartó — repetirlo lo molesta). Entre paréntesis, POR QUÉ lo descartó: usalo como dato real sobre él (si dice "ya lo hice", ESO YA ESTÁ HECHO; si dice "no aplica", tu premisa era falsa — no la repitas en otra forma):\n${avoid.map((a) => `- ${a.text} (${a.why})`).join('\n')}\n`
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
- kanban: {"title":"…","body":"…","board":"default|research"}   (usá "research" si la tarea es INVESTIGAR/analizar/recopilar información —no es algo que el equipo de dev pueda ejecutar directo—; "default" para tareas de desarrollo ejecutables)
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
  const negEntries = activeNegativeEntries();
  const negativeTitles = negEntries.map((n) => n.text);
  // Cada item del avoid lleva su POR QUÉ: el motivo del descarte es información
  // sobre el usuario, no sólo un bloqueo ("ya lo hice" ≠ "no me interesa").
  const avoid = [];
  const seenAvoid = new Set();
  for (const t of inboxTitles) if (t && !seenAvoid.has(t)) { seenAvoid.add(t); avoid.push({ text: t, why: 'ya está en el inbox' }); }
  for (const n of negEntries) if (!seenAvoid.has(n.text)) { seenAvoid.add(n.text); avoid.push({ text: n.text, why: DISMISS_REASONS[n.reason]?.hint || 'lo descartó' }); }
  avoid.splice(40);
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

  // Rastro: qué entró a esta tanda. Se repite en cada candidato para que una
  // decisión sea legible sola, sin tener que reconstruir la corrida entera.
  const inputs = {
    trigger, avoid: avoid.length, minScore, pesos: W,
    contexto: { crons: ctx.crons?.length ?? 0, kanban: ctx.kanban?.tasks?.length ?? 0, sesiones: ctx.sessions?.length ?? 0, objetivos: ctx.goals?.length ?? 0 },
    exploreCats: [...exploreCats],
  };
  // Se registra CADA candidato, incluidos los que no dejan fila en `suggestions`:
  // los `skipped` y los `store` eran completamente invisibles hasta acá.
  const trace = (c, choice, scores, extra = {}) => recordDecision({
    actor: 'agent', stage: 'suggest', subject_type: extra.subject_id ? 'suggestion' : 'none',
    subject_id: extra.subject_id || null, title: c.title, choice,
    rationale: extra.why || c.rationale || null,
    inputs, scores,
    evidence: { fuente: c.source || null, categoria: c.category || null, timeliness: c.timeliness || null, action_type: c.action_type || null },
  });

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
    const nudge = isExplore ? 0 : scoreNudge(category, affinity);
    const score = Math.max(0, Math.min(100, Math.round(base) + nudge));
    const scores = {
      relevance: num100(c.relevance), gap: num100(c.knowledge_gap), incremental: num100(c.incremental_value),
      time: timeScore, base: Math.round(base), nudge, final: score, minScore, exploratory: isExplore,
    };
    if (!isExplore && score < minScore) { trace(c, 'skipped', scores, { why: `score ${score} < mínimo ${minScore}` }); skipped++; continue; }
    const t = norm(c.title);
    if (existing.has(t) || negatives.some((n) => n && (t.includes(n) || n.includes(t)))) {
      trace(c, 'skipped', scores, { why: 'duplicada o bloqueada por una señal negativa activa' });
      skipped++; continue;
    }
    existing.add(t);
    const action_type = ACTIONS.has(c.action_type) ? c.action_type : 'none';
    let mode = decideMode(score, c.timeliness);
    // Modo "store" (bajo valor): NO ensucia el inbox — se guarda como insight en el perfil.
    // (una exploratoria nunca se guarda callada: queremos que la veas.)
    if (mode === 'store' && !isExplore) {
      storeInsight(c.title, c.rationale);
      trace(c, 'store', scores, { why: 'bajo valor: guardada como insight en el perfil, no entra al inbox' });
      stored++; continue;
    }
    if (mode === 'store') mode = 'queue';
    // Gate de entrega: push solo si está habilitado y queda presupuesto; si no, cae a cola.
    const canPush = mode === 'push' && pushEnabled && pushSentToday() < budget;
    if (mode === 'push' && !canPush) mode = 'queue';
    const s = createSuggestion({
      category, title: c.title, rationale: c.rationale, source: `${c.source || ''}${trigger !== 'manual' ? ` · auto:${trigger}` : ''}`,
      action_type, action_payload: c.action_payload || {}, score, mode, exploratory: isExplore,
    });
    trace(c, mode, scores, { subject_id: s.id });
    created++;
    if (isExplore) exploredOne = true;
    if (canPush) { const ok = await deliverPush(adapter, s); if (ok) { recordPushSent(); pushed++; } }
  }
  return { ok: true, created, skipped, pushed, stored, total: arr.length };
}

const num100 = (v) => Math.max(0, Math.min(100, Number(v) || 0));

// La decisión del AGENTE que creó esta sugerencia. Es el eslabón que permite ir
// de "descarté esto" hacia atrás, hasta el score y el contexto que lo propusieron.
const originOf = (id) => listDecisions({ subjectId: id, stage: 'suggest', limit: 1 })[0]?.id || null;
// Decisión del USUARIO sobre una sugerencia, colgada de su origen.
function traceUser(s, choice, extra = {}) {
  recordDecision({
    actor: 'user', stage: choice === 'applied' ? 'apply' : choice === 'snoozed' ? 'snooze' : 'dismiss',
    subject_type: 'suggestion', subject_id: s.id, title: s.title, choice,
    rationale: extra.why || null, parent_id: originOf(s.id),
    evidence: { categoria: s.category, action_type: s.action_type, score: s.score, motivo: extra.reason || null },
  });
}
// Guarda un insight de baja prioridad en el perfil (modo "store"), acotado.
function storeInsight(title, rationale) {
  const p = getProfile();
  const list = Array.isArray(p.storedInsights) ? p.storedInsights : [];
  const line = rationale ? `${title} — ${rationale}` : title;
  if (!list.some((x) => x === line)) list.unshift(line);
  setProfile({ storedInsights: list.slice(0, 30) });
}

// --- Links de un-click (notificaciones interactivas): el canal de push
// (`hermes send`) sólo manda texto plano, sin botones — así que la
// "interactividad" es un link firmado que aplica/descarta al tocarlo, sin
// abrir el dashboard. El secreto vive en settings, se genera una sola vez.
function pushSecret() {
  let secret = getSetting('push_link_secret', null);
  if (!secret) { secret = randomBytes(24).toString('hex'); setSetting('push_link_secret', secret); }
  return secret;
}
function signAction(id, action) {
  return createHmac('sha256', pushSecret()).update(`${id}:${action}`).digest('hex').slice(0, 24);
}
function quickActionUrl(id, action) {
  if (!config.publicUrl) return null;
  return `${config.publicUrl}/api/suggestions/quick-action?id=${id}&action=${action}&token=${signAction(id, action)}`;
}
// Verifica el token y despacha a apply/dismiss existentes — nada de lógica nueva.
export async function quickAction(adapter, id, action, token) {
  if (action !== 'apply' && action !== 'dismiss') return { ok: false, error: 'acción inválida' };
  if (!token || token !== signAction(id, action)) return { ok: false, error: 'link inválido o vencido' };
  return action === 'apply' ? applySuggestion(adapter, id) : dismissSuggestion(id, 'not_interested');
}

// --- Entrega push (Fase 3): manda una sugerencia a un canal vía `hermes send`. ---
function formatPush(s) {
  const emoji = { workflow: '🛠️', vida: '🌱', aprendizaje: '📚' }[s.category] || '💡';
  const prev = s.action_type !== 'none' ? `\n▸ acción disponible en el Agent OS` : '';
  const applyUrl = s.action_type !== 'none' ? quickActionUrl(s.id, 'apply') : null;
  const dismissUrl = quickActionUrl(s.id, 'dismiss');
  const links = (applyUrl || dismissUrl)
    ? `\n\n${applyUrl ? `✅ Aplicar: ${applyUrl}\n` : ''}${dismissUrl ? `❌ Descartar: ${dismissUrl}` : ''}`
    : '';
  return `${emoji} Sugerencia (${s.category})\n*${s.title}*\n${s.rationale || ''}${prev}${links}\n— tu Agent OS`;
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
      case 'skill_learn': {
        // El /learn corre el agente COMPLETO de Hermes y tarda minutos: no
        // bloquear el HTTP. Se marca aplicada optimista, el learn corre en
        // background y el resultado llega por push al canal configurado.
        const req = p.request || s.title;
        setSuggestionStatus(id, 'applied');
        recordPrefEvent(s.category, s.action_type, 'applied');
        traceUser(s, 'applied', { why: 'skill_learn: marcada optimista, el /learn corre en background' });
        adapter.learnSkill('(default)', req)
          .then((r) => adapter.pushMessage(getSetting('push_channel', 'discord'),
            r.ok
              ? `🎓 Skill aprendida: ${r.newSkills?.length ? r.newSkills.join(', ') : '(actualizó una skill existente)'}\n— tu Agent OS`
              : `⚠️ Falló el /learn de «${s.title}»: ${r.error || 'sin detalle'}\nPodés correrlo a mano: /learn ${String(req).slice(0, 300)}`))
          .catch(() => {});
        return { ok: true, info: 'learning en curso — te aviso por push cuando termine', suggestion: getSuggestion(id) };
      }
      case 'none':
      default:
        res = { ok: true, info: true };
    }
  } catch (e) { res = { ok: false, error: e.message }; }

  if (res.ok) { setSuggestionStatus(id, 'applied'); recordPrefEvent(s.category, s.action_type, 'applied'); traceUser(s, 'applied'); }
  else traceUser(s, 'failed', { why: res.error || 'falló al aplicar' });
  return { ...res, suggestion: getSuggestion(id) };
}

// --- Batch (bandeja de decisiones): mismas rutinas de arriba, una por id.
// No hay lógica nueva de negocio — sólo evita ida-vuelta HTTP por sugerencia
// cuando el usuario decide varias de una.
export async function applySuggestions(adapter, ids) {
  const results = [];
  for (const id of ids) results.push({ id, ...(await applySuggestion(adapter, id)) });
  return { ok: true, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

export function dismissSuggestions(ids, reason) {
  const results = ids.map((id) => ({ id, ...dismissSuggestion(id, reason) }));
  return { ok: true, dismissed: results.length, results };
}

// Motivos de descarte. El motivo cambia DOS cosas: cuánto tiempo se bloquea el
// tema (ttl de la señal negativa) y qué aprende el modelo de preferencias
// (signal). "Ya lo hice" = la sugerencia era buena, sólo llegó tarde: no castiga
// la categoría. "No me interesa" / "No aplica" sí.
export const DISMISS_REASONS = {
  done: { label: 'Ya lo hice', hint: 'ya estaba resuelto cuando lo sugerí', signal: 0.9, ttlDays: 365 },
  not_interested: { label: 'No me interesa', hint: 'el tema no le interesa', signal: 0, ttlDays: 60 },
  wrong: { label: 'No aplica', hint: 'la sugerencia estaba mal o partía de algo falso', signal: 0, ttlDays: 180 },
};

export function dismissSuggestion(id, reason) {
  const s = getSuggestion(id);
  if (!s) return { ok: false, error: 'no existe' };
  const key = DISMISS_REASONS[reason] ? reason : null;
  const r = key ? DISMISS_REASONS[key] : null;
  addNegativeSignal(s.title, { reason: key, ttlDays: r?.ttlDays });
  setSuggestionStatus(id, 'dismissed', { reason: key });
  recordPrefEvent(s.category, s.action_type, 'dismissed', r?.signal);
  traceUser(s, 'dismissed', { reason: key, why: r?.hint || null });
  return { ok: true, reason: key };
}

export function snoozeSuggestion(id) {
  const s = getSuggestion(id);
  setSuggestionStatus(id, 'snoozed');
  if (s) { recordPrefEvent(s.category, s.action_type, 'snoozed'); traceUser(s, 'snoozed'); }
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
