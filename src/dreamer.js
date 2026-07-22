// Dreaming INVENTIVO. Un pass creativo/estratégico (tool-free) que mira TODO
// (conversaciones, memoria, objetivos, patrones) y devuelve IDEAS y PATRONES sobre
// la vida del usuario — NO tareas concretas (eso es Sugerencias). Es el rincón de
// mayor vuelo: "venís mencionando X, ¿probaste Y?", "conectando A con B, podrías…".
import { createDream, listDreams, recentDreamTitles, getProfile, listGoals } from './db.js';

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
OBJETIVOS ACTIVOS: ${goals.map((g) => g.title).join(' · ') || '(ninguno)'}
MEMORIA: ${(mem.memory?.text || '').slice(0, 900)}
DE QUÉ VINO HABLANDO: ${convos.join(' || ').slice(0, 3000)}

NO repitas nada parecido a esto (ya se lo dijiste): ${avoid.slice(0, 25).join(' | ')}

Devolvé EXCLUSIVAMENTE un array JSON (sin texto extra, sin herramientas), 3 a 5 items:
[{"kind":"idea|patron|conexion|pregunta","title":"frase corta y evocadora","body":"2-4 oraciones, imaginativo y anclado en sus datos"}]`;

  const gen = await adapter.generateRawSuggestions(prompt);
  if (!gen.ok) return { ok: false, error: gen.error || 'falló el dreaming', created: 0 };
  const arr = extractJsonArray(gen.text);
  if (!Array.isArray(arr)) return { ok: false, error: 'respuesta no-JSON', created: 0, raw: (gen.text || '').slice(0, 200) };

  let created = 0;
  for (const d of arr) {
    if (!d.title) continue;
    createDream({ kind: KINDS.has(d.kind) ? d.kind : 'idea', title: d.title, body: d.body || '' });
    created++;
  }
  return { ok: true, created, total: arr.length };
}
