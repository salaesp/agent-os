// Elem 2 — El perfil se auto-aprende (CON confirmación). Un pass tool-free lee
// conversaciones + memoria recientes y PROPONE updates al perfil (intereses,
// rasgos, patrones). Cada propuesta entra al inbox como sugerencia action_type
// 'profile' → el usuario la acepta con 1 click (merge) o la descarta. Nada se
// aplica solo (los LLMs infieren mal las preferencias implícitas: 37-48%).
import { getProfile, getSetting, createSuggestion, listSuggestions } from './db.js';

const FIELDS = new Set(['interests', 'traits', 'workingPatterns', 'goalsFocus']);
const norm = (s) => String(s || '').toLowerCase().trim();

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('['); const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

let learning = false;

export async function learnProfile(adapter) {
  if (learning) return { ok: false, error: 'ya hay un aprendizaje en curso', created: 0, busy: true };
  learning = true;
  try { return await _learn(adapter); } finally { learning = false; }
}

async function _learn(adapter) {
  const profile = getProfile();
  // Contexto: últimas sesiones (con mensajes) + memoria del default.
  const sessions = await adapter.getSessions('(default)', 6).catch(() => []);
  const convos = [];
  for (const s of sessions.slice(0, 6)) {
    const msgs = await adapter.getSessionMessages('(default)', s.id).catch(() => []);
    const txt = msgs.slice(-8).map((m) => `${m.role}: ${String(m.text).slice(0, 300)}`).join('\n');
    if (txt) convos.push(`— ${s.title || s.source}:\n${txt}`);
  }
  const mem = (await adapter.getMemory()).find((m) => m.profile === '(default)') || {};

  const prompt = `Sos el módulo de APRENDIZAJE DE PERFIL de un Agent OS personal. A partir de las conversaciones y la memoria del usuario, extraé HECHOS ESTABLES sobre él para su perfil: intereses, rasgos/estilo de comunicación, patrones de trabajo, foco de objetivos. SOLO lo que se infiere CLARAMENTE (con evidencia). NO inventes. NO repitas lo que ya está en el perfil.

PERFIL ACTUAL (no repitas nada de esto):
${JSON.stringify({ interests: profile.interests, traits: profile.traits, workingPatterns: profile.workingPatterns, goalsFocus: profile.goalsFocus }).slice(0, 1500)}

MEMORIA:
${(mem.memory?.text || '').slice(0, 800)}
${(mem.user?.text || '').slice(0, 500)}

CONVERSACIONES RECIENTES:
${convos.join('\n\n').slice(0, 6000)}

Devolvé EXCLUSIVAMENTE un array JSON (sin texto extra, sin herramientas). Entre 0 y 5 items, solo los que tengan evidencia clara:
[{"field":"interests|traits|workingPatterns|goalsFocus","value":"el hecho, conciso","evidence":"de qué conversación/dato lo inferís"}]`;

  const gen = await adapter.generateRawSuggestions(prompt);
  if (!gen.ok) return { ok: false, error: gen.error || 'falló el aprendizaje', created: 0 };
  const arr = extractJsonArray(gen.text);
  if (!Array.isArray(arr)) return { ok: false, error: 'respuesta no-JSON', created: 0, raw: (gen.text || '').slice(0, 200) };

  // Dedup contra el perfil actual + propuestas ya pendientes.
  const already = new Set([
    ...FIELDS_VALUES(profile).map(norm),
    ...listSuggestions('new').filter((s) => s.action_type === 'profile').map((s) => norm(s.action_payload?.value)),
  ]);
  let created = 0;
  for (const it of arr) {
    if (!FIELDS.has(it.field) || !it.value) continue;
    if (already.has(norm(it.value))) continue;
    already.add(norm(it.value));
    createSuggestion({
      category: 'aprendizaje', title: `Agregar a tu perfil (${it.field}): ${String(it.value).slice(0, 80)}`,
      rationale: it.evidence || 'inferido de tus conversaciones', source: 'aprendizaje de perfil',
      action_type: 'profile', action_payload: { field: it.field, value: it.value }, score: 60, mode: 'queue',
    });
    created++;
  }
  return { ok: true, created, total: arr.length };
}

function FIELDS_VALUES(p) {
  return [...FIELDS].flatMap((f) => (Array.isArray(p[f]) ? p[f] : []));
}
