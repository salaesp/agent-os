// Revisión periódica de salud técnica. Es deliberadamente independiente de
// suggestions.js: no propone producto ni automatiza cambios, sólo deja hallazgos
// verificables para que el equipo decida qué hacer.
import { createCodeSuggestion, listCodeSuggestions, getSetting, setSetting } from './db.js';
import { projectSuggestionContext } from './projects.js';

let reviewing = false;

function jsonArray(text) {
  const body = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || String(text || '');
  const a = body.indexOf('['), b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim();

function prompt(projects, existing) {
  return `Sos un revisor de código. Analizá EXCLUSIVAMENTE la salud técnica de los repositorios del contexto Git.

No propongas funcionalidades, producto, UX, nuevas integraciones ni cambios de alcance. Sólo podés reportar mantenimiento, riesgos de calidad, seguridad, pruebas, documentación técnica, conflictos Git, deuda técnica o higiene del repositorio cuando la evidencia alcance.
No inventes problemas del código que no se puedan inferir del contexto. Si no hay hallazgos defendibles, devolvé []. Nunca sugieras ejecutar pull, checkout, merge ni modificar archivos automáticamente.

Devolvé exclusivamente un array JSON de hasta 3 items:
{"project":"nombre exacto","branch":"rama exacta","title":"qué se encontró","rationale":"por qué importa","evidence":"dato concreto del contexto","next_step":"qué revisar o decidir manualmente","severity":"low|medium|high"}

Hallazgos ya abiertos o recientes (no repetir): ${JSON.stringify(existing)}
CONTEXTO GIT: ${JSON.stringify(projects)}`;
}

export async function generateCodeReview(adapter, { trigger = 'manual' } = {}) {
  if (reviewing) return { ok: false, busy: true, error: 'ya hay una revisión en curso' };
  reviewing = true;
  try {
    const ctx = await projectSuggestionContext();
    const projects = ctx.projects || [];
    if (!projects.length) return { ok: true, created: 0, skipped: 0, reason: 'sin proyectos incluidos' };
    const existing = listCodeSuggestions().filter((x) => x.status === 'new').map((x) => `${x.project}: ${x.title}`).slice(0, 40);
    const model = getSetting('code_review_model', '') || getSetting('auto_model', '') || undefined;
    const r = await adapter.generateRawSuggestions(prompt(projects, existing), { model });
    if (!r.ok) return { ok: false, error: r.error || 'falló la revisión' };
    const items = jsonArray(r.text);
    if (!Array.isArray(items)) return { ok: false, error: 'la revisión no devolvió JSON válido' };
    const byName = new Map(projects.map((p) => [p.name, p]));
    const seen = new Set(existing.map(norm));
    let created = 0, skipped = 0;
    for (const item of items.slice(0, 3)) {
      const project = byName.get(item?.project);
      const key = norm(`${item?.project}: ${item?.title}`);
      if (!project || !item?.title || seen.has(key)) { skipped++; continue; }
      createCodeSuggestion({ project: project.name, branch: project.branch, title: item.title, rationale: item.rationale, evidence: item.evidence, next_step: item.next_step, severity: item.severity });
      seen.add(key); created++;
    }
    setSetting('code_review_last_at', new Date().toISOString());
    setSetting('code_review_last_trigger', trigger);
    return { ok: true, created, skipped, total: items.length };
  } finally { reviewing = false; }
}

export function codeReviewStatus() {
  return {
    enabled: getSetting('code_review_enabled', '1') === '1',
    intervalDays: Number(getSetting('code_review_interval_days', '7')),
    lastAt: getSetting('code_review_last_at', null),
  };
}
