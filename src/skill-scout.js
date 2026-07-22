// Skill-Scout — detecta FLUJOS DE TRABAJO REPETIDOS en conversaciones recientes
// (+ cron y kanban como contexto de "ya cubierto") que todavía no son una skill de
// Hermes, y propone convertirlos vía /learn. Cada candidato entra al inbox como
// sugerencia action_type 'skill_learn' → 1 click corre el /learn real headless
// (adapter.learnSkill) o se descarta. Espejo del patrón de profile-learner.js.
// Señal ortogonal al creation_nudge interno de Hermes: el nudge mira UNA sesión
// viva con muchos tool-calls; esto mira repetición ENTRE sesiones a lo largo de días.
import { getSetting, createSuggestion, listSuggestions, activeNegatives } from './db.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim();
// state.db guarda epochs en SEGUNDOS (float); tolerar también ms o ISO.
const toMs = (v) => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return n > 1e12 ? n : n * 1000;
  return Date.parse(v) || 0;
};

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // Con el modelo default en un preset MoA, el CLI mete líneas de progreso en
  // stdout (┊ ◇ Reference n/m, [thinking] …) aun con -Q: filtrarlas antes de parsear.
  const body = (fence ? fence[1] : text)
    .split('\n').filter((l) => !/^\s*(┊|◇|\[thinking\])/.test(l)).join('\n');
  const b = body.lastIndexOf(']');
  if (b < 0) return null;
  // Probar cada '[' de adelante hacia atrás: el array final del agregador es lo
  // último del stdout; arranques falsos (arrays internos, ruido) fallan el parse.
  let a = body.indexOf('[');
  for (let i = 0; a >= 0 && a < b && i < 25; i++, a = body.indexOf('[', a + 1)) {
    try { return JSON.parse(body.slice(a, b + 1)); } catch { /* siguiente '[' */ }
  }
  return null;
}

let scouting = false;

export async function scoutSkills(adapter) {
  if (scouting) return { ok: false, error: 'ya hay un scouting en curso', created: 0, busy: true };
  scouting = true;
  try { return await _scout(adapter); } finally { scouting = false; }
}

async function _scout(adapter) {
  if (getSetting('skill_scout_enabled', '1') !== '1') return { ok: false, error: 'skill scout deshabilitado', created: 0 };
  const minOcc = Math.max(2, Number(getSetting('skill_scout_min_occ', '3')) || 3);
  const days = Number(getSetting('skill_scout_days', '14')) || 14;
  const cutoff = Date.now() - days * 86_400_000;

  const [sessions, crons, kanban, skillsRes] = await Promise.all([
    adapter.getSessions('(default)', 40).catch(() => []),
    adapter.getCrons().catch(() => []),
    adapter.getKanban().catch(() => ({ tasks: [] })),
    adapter.getSkills().catch(() => ({ skills: [] })),
  ]);
  const skills = skillsRes.skills || [];

  // Conversaciones humanas recientes (kind 'chat'; las 'task' son corridas
  // programáticas cli/cron y meterían ruido). Principalmente mensajes del usuario:
  // lo que ÉL pide repetido es la señal de flujo, no lo que el agente contesta.
  const chats = sessions
    .filter((s) => s.kind === 'chat' && (!s.startedAt || toMs(s.startedAt) >= cutoff))
    .slice(0, 12);
  const convos = [];
  for (const s of chats) {
    const msgs = await adapter.getSessionMessages('(default)', s.id).catch(() => []);
    const users = msgs.filter((m) => m.role === 'user').slice(-25)
      .map((m) => `[${new Date(toMs(m.ts)).toISOString().slice(0, 10)}] ${String(m.text).replace(/\s+/g, ' ').slice(0, 250)}`);
    if (users.length) convos.push(`— «${s.preview || s.source}» (${s.threads || 1} hilos):\n${users.join('\n')}`);
  }
  if (!convos.length) return { ok: true, created: 0, total: 0, info: 'sin conversaciones recientes' };

  // Dedup dirigido: TODO lo ya sugerido (cualquier status: applied y dismissed
  // incluidos, para no reproponer) + señales negativas + skills existentes.
  const prior = listSuggestions().filter((s) => s.action_type === 'skill_learn');
  const priorKeys = new Set([
    ...prior.map((s) => norm(String(s.title).replace(/^aprender skill:\s*/i, ''))),
    ...prior.map((s) => norm(s.action_payload?.request)).filter(Boolean),
  ]);
  const negatives = activeNegatives().map(norm).filter(Boolean);
  const skillNames = skills.map((s) => norm(s.name));
  const avoid = [...new Set([
    ...prior.map((s) => String(s.title).replace(/^Aprender skill:\s*/i, '')),
    ...activeNegatives(),
  ])].slice(0, 40);

  const prompt = `Sos el módulo SKILL-SCOUT de un Agent OS personal montado sobre el agente Hermes. Tu trabajo: detectar FLUJOS DE TRABAJO que el usuario pidió o ejecutó REPETIDAMENTE (≥${minOcc} veces, en conversaciones distintas) y que convendría convertir en una skill reutilizable de Hermes vía /learn. Basate SOLO en la evidencia de abajo; no inventes.

REGLAS:
- Solo flujos con ≥${minOcc} ocurrencias claras en sesiones/días distintos.
- NO propongas nada ya cubierto por una SKILL EXISTENTE ni ya automatizado por un CRON (listas abajo), ni nada de la lista NO PROPONGAS.
- "learn_request" debe ser AUTO-CONTENIDO: qué hace el flujo, pasos concretos, herramientas/servicios involucrados y 1-2 ejemplos citados de las conversaciones. Se va a ejecutar en una sesión NUEVA sin acceso a estas conversaciones — nunca digas "lo que hicimos recién"; describí todo.
- Máximo 3 candidatos. Calidad sobre cantidad; si no hay nada claro, devolvé [].
- Respondé EXCLUSIVAMENTE con un array JSON válido, sin texto extra, sin markdown, sin herramientas.

Formato de cada item:
{"title":"nombre corto del flujo","occurrences":N,"evidence":["cita corta + fecha","…"],"learn_request":"texto auto-contenido para /learn","not_covered_because":"por qué ninguna skill/cron existente lo cubre","confidence":0-100}
${avoid.length ? `\nNO PROPONGAS nada parecido a esto (ya sugerido o descartado — repetirlo molesta):\n${avoid.map((t) => `- ${t}`).join('\n')}\n` : ''}
SKILLS EXISTENTES (ya cubierto — no proponer):
${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n').slice(0, 2500)}

CRONS ACTIVOS (ya automatizado — no proponer):
${crons.map((c) => `- ${c.name} (${c.schedule})`).join('\n').slice(0, 800)}

KANBAN RECIENTE (títulos repetidos = señal de flujo recurrente):
${(kanban.tasks || []).slice(0, 20).map((t) => `- ${t.title} [${t.status}]`).join('\n').slice(0, 800)}

CONVERSACIONES (últimos ${days} días, mensajes del usuario):
${convos.join('\n\n').slice(0, 9000)}`;

  // Prompt grande + modelo default posiblemente MoA (4 referencias + agregador):
  // darle más aire que el default de 240s. skill_scout_model permite fijar un
  // modelo rápido solo para este pass (ej: deepseek-v4-flash).
  const model = getSetting('skill_scout_model', '') || undefined;
  const gen = await adapter.generateRawSuggestions(prompt, { timeout: 480_000, model });
  if (!gen.ok) return { ok: false, error: gen.error || 'falló el scouting', created: 0 };
  const arr = extractJsonArray(gen.text);
  if (!Array.isArray(arr)) return { ok: false, error: 'respuesta no-JSON', created: 0, raw: (gen.text || '').slice(0, 200) };

  let created = 0, skipped = 0;
  for (const c of arr) {
    if (created >= 2) { skipped++; continue; } // máx 2 por corrida — anti skills basura
    const title = String(c.title || '').trim();
    const request = String(c.learn_request || '').trim();
    if (!title || !request) { skipped++; continue; }
    if ((Number(c.occurrences) || 0) < minOcc || (Number(c.confidence) || 0) < 60) { skipped++; continue; }
    // Backstop determinista por string (por si el modelo ignoró las exclusiones).
    const t = norm(title);
    if (priorKeys.has(t) || priorKeys.has(norm(request))) { skipped++; continue; }
    if (skillNames.some((n) => n && (t.includes(n) || n.includes(t)))) { skipped++; continue; }
    if (negatives.some((n) => t.includes(n) || n.includes(t))) { skipped++; continue; }
    priorKeys.add(t);
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).map(String).slice(0, 4);
    createSuggestion({
      category: 'workflow',
      title: `Aprender skill: ${title.slice(0, 80)}`,
      rationale: `Detectado ${c.occurrences}× · ${evidence.join(' · ')}`.slice(0, 500),
      source: 'skill-scout',
      action_type: 'skill_learn',
      action_payload: { request, occurrences: Number(c.occurrences) || 0, evidence },
      score: Math.min(95, Math.max(0, Number(c.confidence) || 60)),
      mode: 'queue',
    });
    created++;
  }
  return { ok: true, created, skipped, total: arr.length };
}
