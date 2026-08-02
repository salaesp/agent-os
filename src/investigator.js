// Investigador: el "alguien más" que procesa las tareas del board "research" del
// Kanban — items que suggestions.js/ideator.js/dreamer.js marcaron como
// investigación, no como trabajo de dev. A diferencia de esos tres módulos (que
// generan con el modelo tool-free), acá SÍ se le dan herramientas reales
// (web/file) vía adapter.research(), porque el punto es buscar información real,
// no elucubrar. Cierra el loop: postea hallazgos como comentario, completa la
// tarea, y lo que encuentra puede bajar a nuevas sugerencias (mismo pipeline de
// 1-click que dreamer.js::promoteDream).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSuggestion, listSuggestions, activeNegatives, recordDecision } from './db.js';
import { config } from './config.js';

const RESEARCH_DOCS_DIR = join(config.docsDir, 'research');

function slugify(s) {
  return String(s || 'investigacion')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'investigacion';
}

// Guarda el hallazgo completo como markdown en docsDir/research — así queda
// accesible desde el panel Documentos del Agent OS (y en la búsqueda global),
// en vez de perderse truncado en un comentario de kanban.
async function saveFindingsDoc(task, findings) {
  await mkdir(RESEARCH_DOCS_DIR, { recursive: true }).catch(() => {});
  const rel = `research/${task.id}-${slugify(task.title)}.md`;
  const full = join(config.docsDir, rel);
  const body = `---
title: "${String(task.title || '').replace(/"/g, '\\"')}"
task_id: ${task.id}
board: research
date: ${new Date().toISOString()}
---

${findings}
`;
  await writeFile(full, body, 'utf8');
  return rel;
}

const ACTIONS = new Set(['cron', 'kanban', 'reminder', 'memory', 'goal', 'none']);
const CATEGORIES = new Set(['workflow', 'vida', 'aprendizaje']);

let investigating = false;

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('['); const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// Los hallazgos son todo el texto ANTES del bloque JSON (fenced o no) — así el
// comentario del kanban no arrastra el JSON de sugerencias, que es para el modelo.
function extractFindings(text) {
  if (!text) return '';
  const fence = text.indexOf('```');
  const cut = fence >= 0 ? fence : text.lastIndexOf('[');
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

function investigatePrompt(task) {
  return `Investigá el siguiente tema para el usuario, usando tus herramientas (web, archivos) para buscar información REAL. No inventes nada: si no encontrás algo, decilo.

TEMA: ${task.title}
${task.body ? `DETALLE: ${String(task.body).slice(0, 1000)}` : ''}

Tu respuesta va en DOS partes, en este orden exacto:

1. HALLAZGOS: 3-6 bullets o párrafos cortos con lo que encontraste, específico y anclado en fuentes reales (citá de dónde salió cada dato concreto: nombre del sitio, búsqueda que hiciste, etc.).
2. Al final, un bloque de código con un array JSON (puede ir vacío si no hay nada accionable) de 0 a 3 sugerencias de SEGUIMIENTO que se desprenden de la investigación:

\`\`\`json
[{"category":"workflow|vida|aprendizaje","title":"…","rationale":"por qué, citando el hallazgo","action_type":"cron|kanban|reminder|memory|goal|none","action_payload":{…}}]
\`\`\`

action_payload según action_type (mismo formato que siempre):
- cron/reminder: {"schedule":"…","prompt":"…","name":"…","deliver":"local|discord|slack|telegram"}
- kanban: {"title":"…","body":"…","board":"default"}   (acá SÍ "default": si la sugerencia ya es ejecutable por el equipo de dev, no vuelve a "research")
- memory: {"which":"user|memory","text":"…"}
- goal: {"title":"…","brief":"…","my_role":"…","agent_role":"…"}
- none: {}`;
}

export async function runInvestigations(adapter, { limit = 2 } = {}) {
  if (investigating) return { ok: false, error: 'ya hay una investigación en curso', processed: 0, created: 0, busy: true };
  investigating = true;
  try { return await _run(adapter, limit); } finally { investigating = false; }
}

async function _run(adapter, limit) {
  const kanban = await adapter.getKanban().catch(() => ({ tasks: [] }));
  const pending = (kanban.tasks || [])
    .filter((t) => t.board === 'research' && t.status !== 'done' && t.status !== 'archived')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(0, Math.max(1, limit));

  if (!pending.length) return { ok: true, processed: 0, created: 0, info: 'sin tareas pendientes en el board research' };

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, '').trim();
  const existing = new Set(listSuggestions().filter((s) => s.status !== 'applied').map((s) => norm(s.title)));
  const avoid = new Set(activeNegatives().map(norm));

  let processed = 0, created = 0;
  for (const task of pending) {
    // Claim ready → running: así queda visible en el board mientras se
    // investiga, no solo al terminar. Si no se puede (ya no está ready,
    // alguien más la tomó), se salta sin tocarla.
    const claimed = await adapter.kanbanClaim('(default)', task.id, 'research').catch(() => ({ ok: false }));
    if (!claimed.ok) continue;

    const gen = await adapter.research('(default)', investigatePrompt(task)).catch((e) => ({ ok: false, error: e.message }));
    if (!gen.ok) {
      await adapter.kanbanReclaim('(default)', task.id, 'research', gen.error || 'investigación falló').catch(() => {});
      recordDecision({
        actor: 'agent', stage: 'investigate', subject_type: 'none', title: task.title,
        choice: 'failed', rationale: gen.error || 'sin detalle', evidence: { taskId: task.id, board: task.board },
      });
      continue;
    }

    const findings = extractFindings(gen.text) || '(sin hallazgos de texto)';
    const docPath = await saveFindingsDoc(task, findings).catch(() => null);
    const docLink = docPath ? `\n\n📄 Documento completo: #/docs?doc=${encodeURIComponent(docPath)}` : '';
    await adapter.kanbanComment('(default)', task.id, findings.slice(0, 4000) + docLink, 'research').catch(() => {});
    await adapter.kanbanAction('(default)', task.id, 'complete', { board: 'research', summary: findings.slice(0, 300) }).catch(() => {});
    processed++;

    const picks = extractJsonArray(gen.text);
    const followUps = Array.isArray(picks) ? picks : [];
    const parentDecision = recordDecision({
      actor: 'agent', stage: 'investigate', subject_type: 'none', title: task.title,
      choice: 'completed', rationale: findings.slice(0, 500),
      evidence: { taskId: task.id, board: task.board, followUps: followUps.length },
    });

    for (const p of followUps) {
      if (!p?.title) continue;
      const t = norm(p.title);
      if (existing.has(t) || avoid.has(t)) continue;
      existing.add(t);
      const s = createSuggestion({
        category: CATEGORIES.has(p.category) ? p.category : 'workflow',
        title: String(p.title).slice(0, 300),
        rationale: p.rationale || '',
        source: `investigación · «${task.title}»`,
        action_type: ACTIONS.has(p.action_type) ? p.action_type : 'none',
        action_payload: p.action_payload || {},
        score: 55,
        mode: 'queue',
      });
      recordDecision({
        actor: 'agent', stage: 'investigate', subject_type: 'suggestion', subject_id: s.id,
        title: s.title, choice: 'created', rationale: p.rationale || null,
        parent_id: parentDecision?.id || null,
        evidence: { taskId: task.id, taskTitle: task.title },
      });
      created++;
    }
  }
  return { ok: true, processed, created, total: pending.length };
}
