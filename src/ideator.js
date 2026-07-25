// Ideación DIVERGENTE sobre los objetivos de Mission Control. Es el puente que
// faltaba: dreamer.js tiene vuelo pero sus sueños mueren como texto, y
// suggestions.js es accionable pero conservador (mira el contexto y propone lo
// obvio). Acá se replica el patrón de la skill `adhd` de Claude Code —que NO se
// puede invocar desde este proceso, vive en otro runtime— con las piezas que sí
// tenemos: N pasadas AISLADAS del modelo, cada una con un "frame" cognitivo
// distinto, y después una pasada de convergencia que puntúa, descarta trampas y
// deja las mejores como sugerencias APLICABLES (kanban/goal/goal_progress).
//
// Aislar los frames es el invariante: si un mismo pass ve las ideas de los otros,
// converge solo y perdés la divergencia (que es todo el punto).
import { createSuggestion, listSuggestions, activeNegatives, listGoals, getSetting, setSetting, recordDecision } from './db.js';

// Frames cognitivos. Cada uno fuerza un ángulo de ataque distinto sobre el MISMO
// objetivo. Se rotan entre corridas para que no proponga siempre lo mismo.
const FRAMES = [
  { key: 'regulador', prompt: 'Pensá como un REGULADOR/auditor: ¿qué se rompe, qué falta controlar, qué riesgo invisible hay? Ideas que blinden el objetivo.' },
  { key: 'biologo', prompt: 'Pensá como un BIÓLOGO: ¿cómo resolvería esto un sistema vivo? Analogías de evolución, simbiosis, metabolismo, inmunidad. Ideas orgánicas, no mecánicas.' },
  { key: 'speedrunner', prompt: 'Pensá como un SPEEDRUNNER: ¿cuál es el atajo, el glitch, la secuencia que saltea el 80% del trabajo? Ideas que lleguen al resultado por la vía rápida y sucia.' },
  { key: 'nene', prompt: 'Pensá como un NENE DE 10 AÑOS: sin saber qué es "imposible" ni qué se hace normalmente. Ideas obvias-pero-nadie-las-dice, ingenuas, divertidas.' },
  { key: 'cero_peso', prompt: 'Restricción dura: CERO PESOS y UNA HORA. ¿Qué se puede hacer HOY con lo que ya tiene, sin comprar ni instalar nada nuevo?' },
  { key: 'inversor', prompt: 'Pensá como un INVERSOR: ¿dónde está el retorno desproporcionado? ¿Qué palanca chica mueve algo grande? ¿Qué habría que matar por costo de oportunidad?' },
  { key: 'saboteador', prompt: 'Pensá como un SABOTEADOR: si tu trabajo fuera hacer FRACASAR este objetivo, ¿qué harías? Después dá vuelta cada sabotaje y convertilo en una idea de defensa.' },
  { key: 'futuro', prompt: 'Pensá desde DENTRO DE UN AÑO, con el objetivo ya terminado y salido bárbaro: mirando para atrás, ¿qué fue lo que lo destrabó? Ideas escritas como retrospectiva.' },
];
const PER_RUN = 4;      // frames por corrida (cada uno = una pasada del modelo)
const CONCURRENCY = 2;  // pasadas en paralelo — la caja no banca 4 juntas

let ideating = false;

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('['); const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// Corre `fn` sobre items con concurrencia acotada (no hay p-limit acá).
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

// Rotación persistida: cada corrida arranca donde terminó la anterior.
function pickFrames(n = PER_RUN) {
  const start = Number(getSetting('ideate_frame_cursor', '0')) || 0;
  const picked = Array.from({ length: n }, (_, i) => FRAMES[(start + i) % FRAMES.length]);
  setSetting('ideate_frame_cursor', String((start + n) % FRAMES.length));
  return picked;
}

// Elige el objetivo a atacar: el activo más "trabado" (menor progreso, y a
// igualdad el más viejo sin tocar).
function pickGoal(goalId) {
  const active = listGoals().filter((g) => g.status === 'active');
  if (goalId) return active.find((g) => g.id === goalId) || null;
  return active.sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0)
    || String(a.updated_at || '').localeCompare(String(b.updated_at || '')))[0] || null;
}

function divergePrompt(goal, frame, ctx) {
  return `Sos un generador de ideas. Te doy UN objetivo real de una persona y un ÁNGULO obligatorio desde el cual pensarlo.

OBJETIVO: ${goal.title}
${goal.brief ? `DETALLE: ${String(goal.brief).slice(0, 600)}` : ''}
${goal.my_role ? `LO QUE HACE ÉL: ${String(goal.my_role).slice(0, 300)}` : ''}
${goal.agent_role ? `LO QUE HACE SU AGENTE: ${String(goal.agent_role).slice(0, 300)}` : ''}
PROGRESO ACTUAL: ${goal.progress ?? 0}%
${ctx}

TU ÁNGULO OBLIGATORIO (no lo abandones ni lo suavices):
${frame.prompt}

REGLAS:
- 6 ideas. Cortas, concretas, distintas entre sí.
- NO evalúes ni filtres: en esta etapa la crítica está PROHIBIDA. Preferí raro y específico antes que sensato y genérico.
- Nada de generalidades tipo "planificar mejor": si no se puede empezar mañana, no sirve.
- Respondé EXCLUSIVAMENTE con un array JSON válido, sin markdown, sin texto extra, sin usar herramientas.

[{"text":"la idea en una frase","rationale":"por qué desde este ángulo"}]`;
}

function convergePrompt(goal, pool, avoid) {
  return `Sos el filtro crítico de una sesión de ideación. Abajo hay ideas crudas generadas en paralelo por varias cabezas con ángulos DISTINTOS sobre un mismo objetivo. Ninguna fue evaluada todavía.

OBJETIVO: ${goal.title}${goal.brief ? `\nDETALLE: ${String(goal.brief).slice(0, 600)}` : ''}
PROGRESO ACTUAL: ${goal.progress ?? 0}%

IDEAS CRUDAS (frame::idea):
${pool.map((p, i) => `${i + 1}. [${p.frame}] ${p.text}${p.rationale ? ` — ${p.rationale}` : ''}`).join('\n')}
${avoid.length ? `\nYA PROPUESTO O DESCARTADO (no repitas nada parecido):\n${avoid.slice(0, 25).map((t) => `- ${t}`).join('\n')}\n` : ''}
TU TRABAJO:
1. Puntuá mentalmente cada idea: novedad (¿se le habría ocurrido solo?), viabilidad (¿puede hacerlo él?), encaje (¿mueve ESTE objetivo?).
2. Descartá las trampas: lo que suena brillante pero es un pozo de tiempo, o lo que ya está resuelto.
3. Quedate con las 3 MEJORES, y que al menos UNA sea no-obvia (de las que no se le habrían ocurrido). Preferí ideas de frames distintos: si las 3 salen del mismo ángulo, cambiá una.
4. Convertí cada una en algo EJECUTABLE.

Respondé EXCLUSIVAMENTE con un array JSON de 3 items, sin markdown ni texto extra:
[{"title":"qué hacer, en una frase accionable","rationale":"por qué esta y no otra, mencionando el ángulo del que salió","action_type":"kanban|goal|goal_progress|none","action_payload":{…},"novelty":0-100,"viability":0-100,"fit":0-100,"obvious":true|false}]

action_payload según action_type:
- kanban: {"title":"…","body":"pasos concretos","board":"default"}
- goal: {"title":"…","brief":"…","my_role":"…","agent_role":"…"}   (sólo si la idea es un objetivo NUEVO de mediano plazo, no una tarea)
- goal_progress: {"goalTitle":"${goal.title}","progress":0-100,"note":"por qué ese %"}
- none: {}`;
}

export async function ideateForGoals(adapter, { goalId = null } = {}) {
  if (ideating) return { ok: false, error: 'ya hay una ideación en curso', created: 0, busy: true };
  ideating = true;
  try { return await _ideate(adapter, goalId); } finally { ideating = false; }
}

async function _ideate(adapter, goalId) {
  const goal = pickGoal(goalId);
  if (!goal) return { ok: false, error: 'no hay objetivos activos en Mission Control', created: 0 };

  // Contexto liviano: lo que ya está en el kanban para que no proponga lo hecho.
  const kanban = await adapter.getKanban().catch(() => ({ tasks: [] }));
  const openTasks = (kanban.tasks || []).filter((t) => t.status !== 'done' && t.status !== 'archived')
    .slice(0, 15).map((t) => t.title);
  const ctx = openTasks.length ? `YA TIENE ESTAS TAREAS ABIERTAS (no las repitas):\n${openTasks.map((t) => `- ${t}`).join('\n')}` : '';

  // --- Fase 1: diverger. Pasadas AISLADAS, una por frame. ---
  const frames = pickFrames();
  const results = await mapLimit(frames, CONCURRENCY, async (f) => {
    // Timeout corto: cada pasada devuelve 6 líneas de JSON, no un ensayo. Acota el
    // peor caso de la request HTTP (el botón bloquea mientras piensa).
    const gen = await adapter.generateRawSuggestions(divergePrompt(goal, f, ctx), { timeout: 150_000 });
    if (!gen.ok) return { frame: f.key, ideas: [], error: gen.error };
    const arr = extractJsonArray(gen.text);
    return { frame: f.key, ideas: Array.isArray(arr) ? arr.filter((x) => x?.text) : [] };
  });

  const pool = results.flatMap((r) => r.ideas.map((i) => ({ frame: r.frame, text: String(i.text).slice(0, 300), rationale: String(i.rationale || '').slice(0, 300) })));
  const framesOk = results.filter((r) => r.ideas.length).map((r) => r.frame);
  if (!pool.length) return { ok: false, error: 'ninguna pasada devolvió ideas', created: 0, goal: goal.title };

  // --- Fase 2: converger. Puntúa, descarta trampas, deja 3 ejecutables. ---
  const avoid = [...new Set([
    ...listSuggestions().filter((s) => s.status === 'new' || s.status === 'snoozed').map((s) => s.title),
    ...activeNegatives(),
  ])];
  const gen = await adapter.generateRawSuggestions(convergePrompt(goal, pool, avoid), { timeout: 180_000 });
  if (!gen.ok) return { ok: false, error: gen.error || 'falló la convergencia', created: 0, goal: goal.title, pool: pool.length };
  const picks = extractJsonArray(gen.text);
  if (!Array.isArray(picks)) return { ok: false, error: 'la convergencia no devolvió JSON', created: 0, goal: goal.title, pool: pool.length, raw: (gen.text || '').slice(0, 300) };

  const ACTIONS = new Set(['kanban', 'goal', 'goal_progress', 'none']);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim();
  const existing = new Set(listSuggestions().filter((s) => s.status !== 'applied').map((s) => norm(s.title)));
  let created = 0;
  const inputs = { objetivo: goal.title, frames: framesOk, pool: pool.length, picks: picks.length };
  for (const p of picks) {
    if (!p?.title || existing.has(norm(p.title))) continue;
    existing.add(norm(p.title));
    const n100 = (v) => Math.max(0, Math.min(100, Number(v) || 0));
    // Score propio: acá pesa la NOVEDAD (es el punto de la ideación divergente),
    // no la urgencia. Y lo no-obvio se premia explícitamente.
    const score = Math.round(0.35 * n100(p.novelty) + 0.35 * n100(p.viability) + 0.30 * n100(p.fit)) + (p.obvious === false ? 8 : 0);
    const s = createSuggestion({
      category: 'workflow',
      title: String(p.title).slice(0, 300),
      rationale: p.rationale || '',
      source: `ideación · objetivo «${goal.title}» · frames: ${framesOk.join('/')}`,
      action_type: ACTIONS.has(p.action_type) ? p.action_type : 'none',
      action_payload: p.action_payload || {},
      score: Math.max(0, Math.min(100, score)),
      mode: 'queue',
      exploratory: p.obvious === false,
    });
    recordDecision({
      actor: 'agent', stage: 'ideate', subject_type: 'suggestion', subject_id: s.id,
      title: s.title, choice: 'queue', rationale: p.rationale || null, inputs,
      evidence: { objetivo: goal.title, goalId: goal.id, frames: framesOk, obvia: p.obvious !== false, action_type: s.action_type },
      scores: { novelty: n100(p.novelty), viability: n100(p.viability), fit: n100(p.fit), final: Math.max(0, Math.min(100, score)) },
    });
    created++;
  }
  return { ok: true, created, goal: goal.title, goalId: goal.id, frames: framesOk, pool: pool.length };
}

export function ideatorFrames() {
  return { frames: FRAMES.map((f) => f.key), perRun: PER_RUN, cursor: Number(getSetting('ideate_frame_cursor', '0')) || 0 };
}
