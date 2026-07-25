// Consolidación nocturna REM. Cierra el día: junta lo que pasó (kanban, crons,
// sesiones), lo que el Agent OS DECIDIÓ y por qué (el ledger de decisions/runs),
// lo que soñó y lo que quedó pendiente, y lo escribe como una nota del vault en
// <vault>/rem/YYYY-MM-DD.md.
//
// Dos reglas que vienen de errores ya cometidos en este vault:
//  1. REESCRITURA COMPLETA, nunca append. daily/2026-07-07.md terminó con dos
//     «## Tasks», dos «## Log» y dos «## Wins» por appendear sin dedupe.
//  2. Día LOCAL vía localDay(). Con toISOString() el corte cae 21:00 hora local
//     y el "día" del REM no coincide con el día del usuario.
//
// Los HECHOS se arman en JS desde la base; al modelo sólo se le pide la prosa de
// «Síntesis» y «Patrones». Si ese pass falla, la nota se escribe igual (degraded).
import {
  localDay, listDecisions, listRuns, recordDecision, listDreams, listSuggestions,
  listGoals, getSetting,
} from './db.js';
import { getCosts } from './costs.js';

let running = false;

export async function consolidateREM(adapter, { day = null } = {}) {
  if (running) return { ok: false, error: 'ya hay un REM en curso', busy: true };
  running = true;
  try { return await _rem(adapter, day || yesterday()); } finally { running = false; }
}

// A las 08:00 se cierra el día que pasó, no el que arranca.
function yesterday() {
  return localDay(new Date(Date.now() - 86400_000));
}

// Las fuentes traen TRES formatos de fecha: la base propia guarda ISO UTC,
// kanban y sesiones de Hermes traen epoch en SEGUNDOS (float), y los crons ISO
// con offset. Normalizar acá o el filtro por día no matchea nunca.
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e11 ? v * 1000 : v); // segundos vs ms
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(String(v))) return new Date(n < 1e11 ? n * 1000 : n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const onDay = (v, day) => {
  const d = toDate(v);
  return !!d && localDay(d) === day;
};
const weekdayOf = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
const monthOf = (day) => day.slice(0, 7);

// --- Ingesta de las decisiones HUMANAS del vault ---------------------------
// decisions/YYYY-MM.md tiene una sección «## YYYY-MM-DD — Título» por decisión,
// con bullets «- **Contexto**: …» / «- **Decisión**: …». Se levantan las del día
// y se meten en el MISMO ledger que las del agente, con actor='vault'.
export function parseVaultDecisions(text, day) {
  if (!text) return [];
  const out = [];
  const re = /^##\s+(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$/gm;
  const heads = [...text.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    if (heads[i][1] !== day) continue;
    const start = heads[i].index + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const body = text.slice(start, end).trim();
    const field = (name) => {
      const m = body.match(new RegExp(`^-\\s*\\*\\*${name}\\*\\*\\s*:?\\s*(.+)$`, 'im'));
      return m ? m[1].trim() : null;
    };
    out.push({
      title: heads[i][2].trim(),
      rationale: field('Decisión') || field('Contexto') || body.split('\n')[0] || '',
      context: field('Contexto'),
      alternatives: field('Alternativas'),
    });
  }
  return out;
}

async function _rem(adapter, day) {
  // --- Hechos (deterministas, desde la base y el adapter) ---
  const [kanban, crons, sessions, costs, monthNote] = await Promise.all([
    adapter.getKanban().catch(() => ({ tasks: [], byStatus: {} })),
    adapter.getCrons().catch(() => []),
    adapter.getSessions('(default)', 40).catch(() => []),
    Promise.resolve().then(() => getCosts()).catch(() => ({ ok: false })),
    adapter.getObsidianFile(`decisions/${monthOf(day)}.md`).catch(() => ({ ok: false })),
  ]);

  const tasks = kanban.tasks || [];
  const doneToday = tasks.filter((t) => onDay(t.completedAt, day));
  const createdToday = tasks.filter((t) => onDay(t.createdAt, day));
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const cronsRun = crons.filter((c) => onDay(c.lastRunAt, day));
  const cronsFailed = cronsRun.filter((c) => c.lastStatus && c.lastStatus !== 'ok' && c.lastStatus !== 'success');
  const sessionsToday = sessions.filter((s) => onDay(s.startedAt, day));

  const decisions = listDecisions({ day, limit: 400 });
  const runs = listRuns({ day, limit: 400 });
  const runsFailed = runs.filter((r) => r.ok === 0);
  const dreamsToday = listDreams(200).filter((d) => onDay(d.created_at, day));
  const allSuggestions = listSuggestions();
  const suggCreated = allSuggestions.filter((s) => onDay(s.created_at, day));
  const suggDecided = allSuggestions.filter((s) => onDay(s.decided_at, day));
  const pending = allSuggestions
    .filter((s) => s.status === 'new')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);
  const goals = listGoals().filter((g) => g.status === 'active');
  const costDay = (costs?.claude?.days || []).find((d) => d.day === day) || null;

  // Decisiones humanas del vault → al mismo ledger que las del agente.
  // La dedup va contra TODAS las de actor='vault' (no solo las del día): el REM
  // se puede reconsolidar, y si no, cada corrida volvía a insertar las mismas.
  const vaultDecisions = monthNote?.ok ? parseVaultDecisions(monthNote.text, day) : [];
  const alreadyIngested = new Set(listDecisions({ actor: 'vault', limit: 1000 }).map((d) => `${d.day}|${d.title}`));
  for (const v of vaultDecisions) {
    if (alreadyIngested.has(`${day}|${v.title}`)) continue;
    recordDecision({
      actor: 'vault', stage: 'rem', subject_type: 'none', day,
      title: v.title, choice: 'created', rationale: v.rationale,
      evidence: { contexto: v.context, alternativas: v.alternatives },
      source: `decisions/${monthOf(day)}.md`,
    });
  }

  const facts = {
    day,
    kanban: {
      completadas: doneToday.map((t) => t.title),
      creadas: createdToday.map((t) => t.title),
      bloqueadas: blocked.map((t) => t.title),
    },
    crons: { corridos: cronsRun.length, fallados: cronsFailed.map((c) => `${c.name || c.id}: ${c.lastError || c.lastStatus}`) },
    sesiones: sessionsToday.length,
    decisionesDelAgente: decisions.filter((d) => d.actor === 'agent').map((d) => ({ etapa: d.stage, titulo: d.title, eleccion: d.choice, score: d.scores?.final ?? null })),
    decisionesDelUsuario: suggDecided.map((s) => ({ titulo: s.title, estado: s.status, motivo: s.dismiss_reason })),
    decisionesHumanas: vaultDecisions.map((v) => v.title),
    suenos: dreamsToday.map((d) => ({ tipo: d.kind, titulo: d.title, cuerpo: String(d.body || '').slice(0, 300) })),
    objetivos: goals.map((g) => ({ titulo: g.title, progreso: g.progress ?? 0 })),
    ejecuciones: { total: runs.length, fallidas: runsFailed.length },
  };

  // --- Prosa (único pass del modelo, tool-free y opcional) ---
  // Si la nota del día ya existe con su síntesis, se REUSA: así rehacer el REM
  // sobre un día ya cerrado devuelve el mismo archivo (y no paga otro pass).
  const existing = await adapter.getObsidianFile(`rem/${day}.md`).catch(() => ({ ok: false }));
  let prose = existing?.ok ? reuseProse(existing.text) : null;
  if (!prose && hasSubstance(facts)) {
    prose = await writeProse(adapter, facts);
  }

  const md = renderNote({ day, facts, prose, costDay, pending, blocked });
  const rel = `rem/${day}.md`;
  const w = await adapter.writeObsidian(rel, md);
  if (!w.ok) return { ok: false, day, error: w.error || 'no se pudo escribir la nota' };

  recordDecision({
    actor: 'agent', stage: 'rem', subject_type: 'none',
    title: `Consolidación REM ${day}`, choice: 'created',
    rationale: prose ? 'nota completa' : 'nota sin síntesis (el pass del modelo no respondió)',
    inputs: { decisiones: decisions.length, runs: runs.length, suenos: dreamsToday.length, sugerencias: suggCreated.length },
    source: rel,
  });

  return {
    ok: true, day, rel, path: w.path, bytes: w.bytes,
    degraded: !prose,
    sections: { decisiones: decisions.length, suenos: dreamsToday.length, pendientes: pending.length, vault: vaultDecisions.length },
  };
}

// Un día sin nada no merece gastar un pass del modelo.
function hasSubstance(f) {
  return f.kanban.completadas.length || f.kanban.creadas.length || f.decisionesDelAgente.length
    || f.decisionesDelUsuario.length || f.suenos.length || f.decisionesHumanas.length || f.sesiones;
}

// Recupera la prosa de una nota REM ya escrita. Los bullets de «Patrones» que
// arrancan con **negrita** son sueños (se regeneran desde la base); los que no,
// son los patrones que escribió el modelo.
function reuseProse(text) {
  if (!text) return null;
  // Sin flag 'm' a propósito: con 'm' el `$` del lookahead matchea fin de LÍNEA
  // y el grupo perezoso capturaba vacío, así que la prosa nunca se reusaba.
  const sec = (name) => {
    const m = text.match(new RegExp(`(?:^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1].trim() : null;
  };
  const sintesis = sec('Síntesis');
  if (!sintesis) return null;
  const pat = (sec('Patrones') || '').split('\n')
    .filter((l) => l.startsWith('- ') && !l.startsWith('- **'))
    .map((l) => l.slice(2).trim());
  return { sintesis, patrones: pat };
}

async function writeProse(adapter, facts) {
  const prompt = `Sos la consolidación nocturna (REM) de un Agent OS personal. Te paso los HECHOS ya verificados del día. Tu trabajo es SOLO interpretarlos: no inventes datos, no repitas los números, no agregues detalle especulativo.

Escribí en español rioplatense, tono sobrio y directo (Alfred Pennyworth: formal, seco, leal). Sin adjetivos de relleno, sin felicitaciones.

HECHOS DEL ${facts.day}:
${JSON.stringify(facts).slice(0, 6000)}

Devolvé EXCLUSIVAMENTE un objeto JSON, sin markdown ni texto extra:
{"sintesis":"2-4 oraciones: qué fue este día en términos de lo que el usuario está construyendo","patrones":["1 a 3 observaciones, cada una una frase; algo que se repite, algo que se está trabando, algo que conecta dos cosas del día. Si no hay nada honesto que decir, devolvé el array vacío."]}`;

  const gen = await adapter.generateRawSuggestions(prompt, { timeout: 120_000 }).catch(() => ({ ok: false }));
  if (!gen?.ok || !gen.text) return null;
  const a = gen.text.indexOf('{');
  const b = gen.text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const p = JSON.parse(gen.text.slice(a, b + 1));
    if (!p?.sintesis) return null;
    return { sintesis: String(p.sintesis), patrones: Array.isArray(p.patrones) ? p.patrones.map(String) : [] };
  } catch { return null; }
}

// --- Render -----------------------------------------------------------------
// Convenciones del vault (observadas, no inventadas): sin frontmatter YAML,
// «# YYYY-MM-DD Weekday» como daily/, blockquote de metadatos en prosa como
// living/*.md, wikilinks relativos, bullets con **término en bold**, sin tablas.
function renderNote({ day, facts, prose, costDay, pending, blocked }) {
  const L = [];
  // Sin hora de generación a propósito: la nota tiene que ser idéntica al
  // reconsolidar el mismo día (ver la regla de reescritura completa arriba).
  L.push(`# ${day} ${weekdayOf(day)}`);
  L.push('');
  L.push('> REM. Consolidación automática del Agent OS.');
  L.push(`> Ver también [[../daily/${day}]] · [[../decisions/${monthOf(day)}]]`);
  L.push('');

  if (prose?.sintesis) {
    L.push('## Síntesis', '', prose.sintesis, '');
  }

  const k = facts.kanban;
  const pasó = [];
  if (k.completadas.length) pasó.push(`- **Completado**: ${k.completadas.map((t) => `«${t}»`).join(' · ')}`);
  if (k.creadas.length) pasó.push(`- **Nuevo en el tablero**: ${k.creadas.map((t) => `«${t}»`).join(' · ')}`);
  if (facts.sesiones) pasó.push(`- **Conversaciones**: ${facts.sesiones} sesión(es) con el agente.`);
  if (facts.crons.corridos) pasó.push(`- **Crons**: ${facts.crons.corridos} corrida(s)${facts.crons.fallados.length ? `, ${facts.crons.fallados.length} con error` : ' sin errores'}.`);
  for (const f of facts.crons.fallados) pasó.push(`  - **Falló**: ${f}`);
  if (facts.ejecuciones.fallidas) pasó.push(`- **Ejecuciones del agente**: ${facts.ejecuciones.total} en total, ${facts.ejecuciones.fallidas} fallidas.`);
  L.push('## Qué pasó', '', ...(pasó.length ? pasó : ['- Sin actividad registrada.']), '');

  L.push('## Decisiones', '');
  if (!facts.decisionesDelAgente.length && !facts.decisionesDelUsuario.length && !facts.decisionesHumanas.length) {
    L.push('- Ninguna decisión registrada.');
  }
  for (const d of facts.decisionesDelAgente.slice(0, 15)) {
    const score = d.score != null ? ` (score ${d.score})` : '';
    L.push(`- **${d.etapa}** → ${d.eleccion || 'sin resolver'}${score}: «${d.titulo}»`);
  }
  for (const d of facts.decisionesDelUsuario.slice(0, 15)) {
    L.push(`- **Decidiste** ${d.estado}${d.motivo ? ` (${d.motivo})` : ''}: «${d.titulo}»`);
  }
  for (const t of facts.decisionesHumanas) {
    L.push(`- **Del log de decisiones**: «${t}» — ver [[../decisions/${monthOf(day)}]]`);
  }
  L.push('');

  if (facts.suenos.length || prose?.patrones?.length) {
    L.push('## Patrones', '');
    for (const p of (prose?.patrones || [])) L.push(`- ${p}`);
    for (const s of facts.suenos) L.push(`- **${s.tipo}**: ${s.titulo} — ${s.cuerpo}`);
    L.push('');
  }

  L.push('## Pendiente', '');
  if (!pending.length && !blocked.length) L.push('- Nada esperando decisión.');
  for (const s of pending) L.push(`- **Sugerencia** (${s.score}): «${s.title}»${s.rationale ? ` — ${String(s.rationale).slice(0, 200)}` : ''}`);
  for (const t of blocked.slice(0, 5)) L.push(`- **Bloqueada** en el tablero: «${t.title}»`);
  L.push('');

  if (costDay) {
    L.push('## Costo', '');
    L.push(`- **Total del día**: USD ${costDay.cost.toFixed(2)}.`);
    const parts = ['anthropic', 'openrouter', 'local', 'otros']
      .filter((p) => costDay[p] > 0)
      .map((p) => `${p} ${costDay[p].toFixed(2)}`);
    if (parts.length) L.push(`- **Por proveedor**: ${parts.join(' · ')}.`);
    L.push('');
  }

  if (facts.objetivos.length) {
    L.push('## Objetivos', '');
    for (const g of facts.objetivos) L.push(`- **${g.progreso}%** — «${g.titulo}»`);
    L.push('');
  }

  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// Retención del ledger. Lo llama el scheduler después del REM.
export function remRetentionDays() {
  return Number(getSetting('rem_retention_days', '90')) || 90;
}
