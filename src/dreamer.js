// Dreaming INVENTIVO. Un pass creativo/estratégico (tool-free) que mira TODO
// (conversaciones, memoria, objetivos, patrones) y devuelve IDEAS y PATRONES sobre
// la vida del usuario — NO tareas concretas (eso es Sugerencias). Es el rincón de
// mayor vuelo: "venís mencionando X, ¿probaste Y?", "conectando A con B, podrías…".
import { createDream, listDreams, recentDreamTitles, getProfile, listGoals, getDream, createSuggestion, setDreamPromoted, recordDecision, listDecisions } from './db.js';

// Aterrizajes EN CURSO, por id de sueño. Vive en el server a propósito: la
// llamada tarda ~1 min y si el estado viviera sólo en el browser, recargar la
// página lo borraba y no quedaba forma de saber si algo estaba corriendo (ni,
// después, qué había producido).
const promoting = new Map(); // dreamId → ts de arranque
export function promotingDreams() {
  return Object.fromEntries([...promoting.entries()].map(([id, at]) => [id, { since: at, seconds: Math.round((Date.now() - at) / 1000) }]));
}

const KINDS = new Set(['idea', 'patron', 'conexion', 'pregunta']);

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('['); const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

let dreaming = false;

export async function generateDreams(adapter) {
  if (dreaming) return { ok: false, error: 'ya hay un dreaming en curso', created: 0, busy: true };
  dreaming = true;
  try { return await _dream(adapter); } finally { dreaming = false; }
}

async function _dream(adapter) {
  const profile = getProfile();
  const goals = listGoals().filter((g) => g.status === 'active');
  const [memory, sessions] = await Promise.all([
    adapter.getMemory().catch(() => []), adapter.getSessions('(default)', 12).catch(() => []),
  ]);
  const mem = memory.find((m) => m.profile === '(default)') || {};
  const convos = [];
  for (const s of sessions.slice(0, 10)) {
    const msgs = await adapter.getSessionMessages('(default)', s.id).catch(() => []);
    const txt = msgs.filter((m) => m.role === 'user').slice(-4).map((m) => String(m.text).slice(0, 200)).join(' · ');
    if (txt) convos.push(txt);
  }
  const avoid = [...new Set([...recentDreamTitles(30), ...listDreams().filter((d) => d.status === 'new').map((d) => d.title)])];

  const prompt = `Sos la parte "DREAMING" de un Agent OS personal: el rincón CREATIVO y ESTRATÉGICO. Mientras el usuario no mira, pensás en su vida y le devolvés IDEAS, PATRONES y CONEXIONES de mayor vuelo — NO tareas concretas ni acciones (eso es otra sección). Imaginativo pero anclado en SUS datos. Que dé ganas de pensar, no de ejecutar.

Podés: notar un patrón en sus semanas, conectar dos cosas suyas que no vio juntas, proponer una idea de vida/proyecto/aprendizaje que le pegue, hacer una pregunta que lo haga reflexionar.

PERFIL:
${JSON.stringify({ interests: profile.interests, traits: profile.traits, workingPatterns: profile.workingPatterns, goalsFocus: profile.goalsFocus }).slice(0, 1200)}
OBJETIVOS ACTIVOS DE SU MISSION CONTROL (con lo que ya lleva hecho):
${goals.map((g) => `- «${g.title}» (${g.progress ?? 0}%)${g.brief ? ` — ${String(g.brief).slice(0, 200)}` : ''}`).join('\n') || '(ninguno)'}
Al menos UNA de tus ideas tiene que morder alguno de esos objetivos: no proponerle la tarea obvia que le falta, sino ver el objetivo desde un ángulo que él no tiene (qué está asumiendo de más, con qué otra cosa suya se conecta, por qué puede estar trabado en ese %).
MEMORIA: ${(mem.memory?.text || '').slice(0, 900)}
DE QUÉ VINO HABLANDO: ${convos.join(' || ').slice(0, 3000)}

NO repitas nada parecido a esto (ya se lo dijiste): ${avoid.slice(0, 25).join(' | ')}

Devolvé EXCLUSIVAMENTE un array JSON (sin texto extra, sin herramientas), 3 a 5 items:
[{"kind":"idea|patron|conexion|pregunta","title":"frase corta y evocadora","body":"2-4 oraciones, imaginativo y anclado en sus datos"}]`;

  const gen = await adapter.generateRawSuggestions(prompt);
  if (!gen.ok) return { ok: false, error: gen.error || 'falló el dreaming', created: 0 };
  const arr = extractJsonArray(gen.text);
  if (!Array.isArray(arr)) return { ok: false, error: 'respuesta no-JSON', created: 0, raw: (gen.text || '').slice(0, 200) };

  const inputs = { objetivos: goals.length, sesiones: convos.length, evitados: avoid.length };
  let created = 0;
  for (const d of arr) {
    if (!d.title) continue;
    const kind = KINDS.has(d.kind) ? d.kind : 'idea';
    const row = createDream({ kind, title: d.title, body: d.body || '' });
    recordDecision({
      actor: 'agent', stage: 'dream', subject_type: 'dream', subject_id: row.id,
      title: d.title, choice: 'created', rationale: d.body || null, inputs,
      evidence: { tipo: kind, objetivos: goals.map((g) => g.title) },
    });
    created++;
  }
  return { ok: true, created, total: arr.length };
}

// --- Puente sueño → acción -------------------------------------------------
// Un sueño era un callejón sin salida: sólo se podía guardar o descartar, y el
// texto moría ahí. Esto lo baja a una SUGERENCIA aplicable (que ya tiene todo el
// pipeline de 1-click hecho): el modelo elige si es una tarea o un objetivo.
export async function promoteDream(adapter, id) {
  const d = getDream(id);
  if (!d) return { ok: false, error: 'no existe' };
  if (d.promoted_to) return { ok: false, error: 'este sueño ya está aterrizado', suggestionId: d.promoted_to };
  if (promoting.has(id)) return { ok: false, error: 'ya se está aterrizando', busy: true };
  promoting.set(id, Date.now());
  try { return await _promote(adapter, d, id); } finally { promoting.delete(id); }
}

async function _promote(adapter, d, id) {
  const goals = listGoals().filter((g) => g.status === 'active');
  const prompt = `Convertí esta IDEA suelta en algo EJECUTABLE para el usuario. La idea salió de la sección creativa de su Agent OS, así que es de vuelo — tu trabajo es aterrizarla sin domesticarla: que siga siendo la misma idea, pero con un primer paso concreto.

IDEA (${d.kind}): ${d.title}
${d.body || ''}

SUS OBJETIVOS ACTIVOS: ${goals.map((g) => `«${g.title}» (${g.progress ?? 0}%)`).join(' · ') || '(ninguno)'}

Decidí el formato:
- Si es un primer paso concreto (horas/días) → action_type "kanban".
- Si es una apuesta de mediano plazo (semanas) → action_type "goal".

Respondé EXCLUSIVAMENTE con un objeto JSON, sin markdown ni texto extra:
{"title":"qué hacer, en una frase accionable","rationale":"por qué vale la pena, atado a la idea original","action_type":"kanban|goal","action_payload":{…},"score":0-100}

action_payload:
- kanban: {"title":"…","body":"los pasos concretos","board":"default|research"}   (usá "research" si es investigar/analizar antes de poder ejecutar, no una tarea de dev directa; "default" si no)
- goal: {"title":"…","brief":"…","my_role":"…","agent_role":"…"}`;

  const gen = await adapter.generateRawSuggestions(prompt, { timeout: 120_000 });
  if (!gen.ok) return { ok: false, error: gen.error || 'falló la conversión' };
  const text = gen.text || '';
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  let p = null;
  try { p = JSON.parse(text.slice(a, b + 1)); } catch { /* abajo */ }
  if (!p?.title) return { ok: false, error: 'la respuesta no fue JSON válido', raw: text.slice(0, 200) };

  const s = createSuggestion({
    category: 'workflow',
    title: String(p.title).slice(0, 300),
    rationale: p.rationale || d.body || '',
    source: `sueño · «${d.title}»`,
    action_type: p.action_type === 'goal' ? 'goal' : 'kanban',
    action_payload: p.action_payload || {},
    score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 60))),
    mode: 'queue',
  });
  setDreamPromoted(id, s.id);
  // El eslabón sueño → sugerencia. Sin esto la sugerencia aparecía en el inbox
  // sin ninguna forma de saber de qué idea salió.
  recordDecision({
    actor: 'agent', stage: 'promote', subject_type: 'suggestion', subject_id: s.id,
    title: s.title, choice: 'created', rationale: s.rationale || null,
    parent_id: listDecisions({ subjectId: id, stage: 'dream', limit: 1 })[0]?.id || null,
    evidence: { sueño: d.title, tipo: d.kind, action_type: s.action_type },
    scores: { final: s.score },
  });
  return { ok: true, suggestion: s };
}
