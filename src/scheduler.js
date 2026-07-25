// Scheduler de proactividad (Fase 2). Genera sugerencias AUTOMÁTICAMENTE:
//  - de noche (hora configurable, superficie de baja interrupción tipo digest), y
//  - en LÍMITES DE TAREA (nueva sesión de chat, transición de kanban, cron corrido)
// que el research marca como el momento correcto — NUNCA por "idle" (falso positivo).
// Con rate-limit (intervalo mínimo), tope diario de generaciones (costo) y lock.
import { generateSuggestions, sendMorningBrief } from './suggestions.js';
import { learnProfile } from './profile-learner.js';
import { scoutSkills } from './skill-scout.js';
import { generateDreams } from './dreamer.js';
import { ideateForGoals } from './ideator.js';
import { runInvestigations } from './investigator.js';
import { consolidateREM } from './rem.js';
import { getSetting, setSetting, localDay, purgeTrail } from './db.js';

const CHECK_MS = 15 * 60 * 1000; // cada 15 min
let inFlight = false;
let nightlyInFlight = false;

const num = (k, d) => Number(getSetting(k, String(d)));
const todayStr = () => localDay();

// Firma del "estado de borde": cambia cuando pasa algo digno de reflexionar.
async function boundarySignature(adapter) {
  const [sessions, kanban, crons] = await Promise.all([
    adapter.getSessions('(default)', 1).catch(() => []),
    adapter.getKanban().catch(() => ({ byStatus: {} })),
    adapter.getCrons().catch(() => []),
  ]);
  const sess = sessions[0]?.id || '';
  const kb = (kanban.byStatus?.done || 0) + (kanban.byStatus?.archived || 0);
  const cronDone = crons.reduce((a, c) => a + (c.completed || 0), 0);
  return `${sess}|${kb}|${cronDone}`;
}

function genCountToday() {
  return getSetting('sugg_gen_day', '') === todayStr() ? num('sugg_gen_count', 0) : 0;
}
function recordGen(sig) {
  setSetting('sugg_last_gen_at', new Date().toISOString());
  setSetting('sugg_gen_day', todayStr());
  setSetting('sugg_gen_count', String(genCountToday() + 1));
  setSetting('sugg_last_sig', sig);
}

async function maybeGenerate(adapter) {
  if (inFlight) return;
  if (getSetting('auto_suggest_enabled', '1') !== '1') return;

  const sig = await boundarySignature(adapter);
  const lastSig = getSetting('sugg_last_sig', null);
  // Primer arranque: registrar la firma sin generar (evita gen en cada restart).
  if (lastSig === null) { setSetting('sugg_last_sig', sig); return; }

  const now = Date.now();
  const lastGenAt = getSetting('sugg_last_gen_at', null);
  const lastGenMs = lastGenAt ? Date.parse(lastGenAt) : 0;
  const count = genCountToday(); // 0 si el contador es de otro día
  const cap = num('auto_daily_cap', 3);
  const minGapMs = num('auto_min_interval_h', 4) * 3600 * 1000;

  // Sólo generación de BORDE: cambió la firma, pasó el intervalo mínimo y hay
  // presupuesto. Lo nocturno vive aparte (runNightly) con su propio cupo.
  if (count >= cap) { if (sig !== lastSig) setSetting('sugg_last_sig', sig); return; }
  // Si el borde llegó antes del intervalo mínimo NO se pisa la firma: queda
  // pendiente para el próximo chequeo (antes se la comía y el borde se perdía).
  if (sig === lastSig || (now - lastGenMs) < minGapMs) return;

  inFlight = true;
  try {
    const r = await generateSuggestions(adapter, { trigger: 'boundary' });
    recordGen(sig);
    console.log(`[scheduler] auto-gen (boundary): ${r.created ?? 0} nuevas, ${r.skipped ?? 0} dedup, ${r.pushed ?? 0} push`);
  } catch (e) {
    console.error('[scheduler] auto-gen falló:', e.message);
  } finally {
    inFlight = false;
  }
}

// Un paso del bundle: aislado, nunca tumba a los que siguen.
async function step(name, fn) {
  try {
    const r = await fn();
    console.log(`[scheduler] ${name}: ${r || 'ok'}`);
  } catch (e) {
    console.error(`[scheduler] ${name} falló: ${e.message}`);
  }
}

// --- Bundle nocturno: sugerencias + brief + perfil + skills + sueños (+ ideación).
// Tiene su PROPIO marcador de día y su propio cupo: antes colgaba de la generación
// de sugerencias y compartía el tope diario con las de borde, así que en cuanto se
// gastaba el cupo temprano el bundle entero no corría nunca — ni brief, ni perfil,
// ni skill-scout, ni sueños. Además hace CATCH-UP: si el server no estaba vivo a la
// hora exacta, corre igual más tarde ese mismo día (antes se perdía el día entero).
async function maybeNightly(adapter) {
  if (nightlyInFlight) return;
  if (getSetting('auto_suggest_enabled', '1') !== '1') return;
  const today = todayStr();
  if (getSetting('nightly_day', '') === today) return;
  if (new Date().getHours() < num('auto_nightly_hour', 8)) return;

  nightlyInFlight = true;
  // Se marca ANTES de correr: si algún paso falla no queremos reintentar el bundle
  // completo cada 15 min durante todo el día (cada paso ya loguea su propio error).
  setSetting('nightly_day', today);
  console.log('[scheduler] bundle nocturno: arrancando');
  try {
    await step('sugerencias (nocturna)', async () => {
      const r = await generateSuggestions(adapter, { trigger: 'nightly' });
      if (!r.ok) throw new Error(r.error || 'sin detalle');
      recordGen(await boundarySignature(adapter).catch(() => getSetting('sugg_last_sig', '')));
      return `${r.created ?? 0} nuevas, ${r.skipped ?? 0} dedup, ${r.pushed ?? 0} push`;
    });
    await step('morning brief', async () => {
      const b = await sendMorningBrief(adapter);
      return b.ok ? `enviado (${b.sent} sugerencias)` : `no enviado (${b.reason || b.error || '?'})`;
    });
    await step('perfil', async () => {
      const l = await learnProfile(adapter);
      return l.created ? `${l.created} cambios propuestos` : 'sin cambios';
    });
    await step('skill-scout', async () => {
      const sk = await scoutSkills(adapter);
      return sk.created ? `${sk.created} candidato(s) a skill` : 'sin candidatos';
    });
    if (getSetting('auto_dream_enabled', '1') === '1') {
      await step('dreaming', async () => {
        const dr = await generateDreams(adapter);
        if (!dr.ok) throw new Error(dr.error || 'sin detalle');
        return `${dr.created} ideas`;
      });
    } else console.log('[scheduler] dreaming: deshabilitado');
    // Ideación divergente sobre los objetivos: cara (varias pasadas del modelo),
    // así que arranca APAGADA — se prende desde Mission Control.
    if (getSetting('auto_ideate_enabled', '0') === '1') {
      await step('ideación', async () => {
        const i = await ideateForGoals(adapter);
        if (!i.ok) throw new Error(i.error || 'sin detalle');
        return `${i.created} ideas sobre «${i.goal}»`;
      });
    }
    // Investigador: procesa tareas del board "research" (investigación, no dev)
    // con herramientas reales (web). Cara igual que la ideación → arranca APAGADA.
    if (getSetting('auto_investigate_enabled', '0') === '1') {
      await step('investigador', async () => {
        const r = await runInvestigations(adapter);
        if (!r.ok) throw new Error(r.error || 'sin detalle');
        return `${r.processed} tarea(s) investigada(s), ${r.created} sugerencia(s) nueva(s)`;
      });
    }
    // REM va ÚLTIMO: consolida el día anterior leyendo todo lo que los pasos de
    // arriba acaban de dejar en el ledger.
    if (getSetting('auto_rem_enabled', '1') === '1') {
      await step('REM', async () => {
        const r = await consolidateREM(adapter);
        if (!r.ok) throw new Error(r.error || 'sin detalle');
        const p = purgeTrail(num('rem_retention_days', 90));
        const purged = p.ok && (p.decisions || p.runs) ? ` · purga: ${p.decisions}+${p.runs}` : '';
        return `${r.day} → ${r.rel}${r.degraded ? ' (sin síntesis)' : ''}${purged}`;
      });
    } else console.log('[scheduler] REM: deshabilitado');
    console.log('[scheduler] bundle nocturno: listo');
  } finally {
    nightlyInFlight = false;
  }
}

async function tick(adapter) {
  await maybeNightly(adapter).catch((e) => console.error('[scheduler] nocturno falló:', e.message));
  await maybeGenerate(adapter).catch((e) => console.error('[scheduler] borde falló:', e.message));
}

export function startScheduler(adapter) {
  // Primer chequeo a los 60s del arranque (deja que todo levante).
  setTimeout(() => tick(adapter).catch(() => {}), 60_000);
  setInterval(() => tick(adapter).catch(() => {}), CHECK_MS);
  console.log('[scheduler] proactividad automática activa (chequeo cada 15 min)');
}
