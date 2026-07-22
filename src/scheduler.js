// Scheduler de proactividad (Fase 2). Genera sugerencias AUTOMÁTICAMENTE:
//  - de noche (hora configurable, superficie de baja interrupción tipo digest), y
//  - en LÍMITES DE TAREA (nueva sesión de chat, transición de kanban, cron corrido)
// que el research marca como el momento correcto — NUNCA por "idle" (falso positivo).
// Con rate-limit (intervalo mínimo), tope diario de generaciones (costo) y lock.
import { generateSuggestions, sendMorningBrief } from './suggestions.js';
import { learnProfile } from './profile-learner.js';
import { generateDreams } from './dreamer.js';
import { getSetting, setSetting } from './db.js';

const CHECK_MS = 15 * 60 * 1000; // cada 15 min
let inFlight = false;

const num = (k, d) => Number(getSetting(k, String(d)));
const todayStr = () => new Date().toISOString().slice(0, 10);

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
  const generatedToday = getSetting('sugg_gen_day', '') === todayStr();
  const count = genCountToday();
  const cap = num('auto_daily_cap', 3);
  const minGapMs = num('auto_min_interval_h', 4) * 3600 * 1000;

  let trigger = null;
  // Nocturno: a la hora configurada, si todavía no generamos hoy.
  if (new Date().getHours() === num('auto_nightly_hour', 8) && !generatedToday) trigger = 'nightly';
  // Límite de tarea: cambió la firma, pasó el intervalo mínimo y hay presupuesto.
  else if (sig !== lastSig && (now - lastGenMs) >= minGapMs && count < cap) trigger = 'boundary';

  if (!trigger) { if (sig !== lastSig) setSetting('sugg_last_sig', sig); return; }
  if (count >= cap) { setSetting('sugg_last_sig', sig); return; }

  inFlight = true;
  try {
    const r = await generateSuggestions(adapter, { trigger });
    recordGen(sig);
    console.log(`[scheduler] auto-gen (${trigger}): ${r.created ?? 0} nuevas, ${r.skipped ?? 0} dedup, ${r.pushed ?? 0} push`);
    // Tras la generación nocturna, mandar el morning brief (1 push/día, batcheado).
    if (trigger === 'nightly') {
      const b = await sendMorningBrief(adapter);
      if (b.ok) console.log(`[scheduler] morning brief enviado (${b.sent} sugerencias)`);
      // Aprendizaje de perfil (propone updates para que el usuario confirme).
      const l = await learnProfile(adapter);
      if (l.ok && l.created) console.log(`[scheduler] perfil: ${l.created} cambios propuestos`);
      // Dreaming inventivo (ideas/patrones sobre la vida del usuario).
      const dr = await generateDreams(adapter);
      if (dr.ok && dr.created) console.log(`[scheduler] dreaming: ${dr.created} ideas`);
    }
  } catch (e) {
    console.error('[scheduler] auto-gen falló:', e.message);
  } finally {
    inFlight = false;
  }
}

export function startScheduler(adapter) {
  // Primer chequeo a los 60s del arranque (deja que todo levante).
  setTimeout(() => maybeGenerate(adapter).catch(() => {}), 60_000);
  setInterval(() => maybeGenerate(adapter).catch(() => {}), CHECK_MS);
  console.log('[scheduler] proactividad automática activa (chequeo cada 15 min)');
}
