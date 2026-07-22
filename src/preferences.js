// Drift de preferencias (Fase 4, basado en PAMU arXiv 2510.09720).
// Sobre la secuencia de decisiones (aplicar=1 / descartar=0 / posponer=0.5) por
// categoría, estima DOS señales: corto plazo (ventana deslizante SW) y largo plazo
// (media móvil exponencial EMA). Su MEZCLA da la afinidad; su DIVERGENCIA es el
// drift (te está gustando más/menos que antes). Eso modula qué se surfacea:
//  - un "hint" al prompt de generación (priorizá lo que viene subiendo), y
//  - un ajuste de score (+/-) para que ordene el inbox y pase/no pase el umbral.
import { listPrefEvents } from './db.js';

const CATS = ['workflow', 'vida', 'aprendizaje'];
const WINDOW = 5;        // ventana corta: últimas N decisiones
const SW_DAYS = 21;      // …dentro de los últimos N días (gusto RECIENTE)
const HALFLIFE = 45;     // días: half-life del olvido para el largo plazo (EMA temporal)
const LAMBDA = 0.6;      // mezcla: peso del corto plazo
const DELTA = 0.2;       // umbral de drift (SW−EMA) para marcar tendencia

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5);
const ageDays = (ts) => (ts ? (Date.now() - Date.parse(ts)) / 86400_000 : 0);

// Largo plazo con OLVIDO: media ponderada por recencia (peso = 0.5^(edad/half-life)).
// Un descarte viejo pesa menos que uno de ayer.
function decayedMean(events) {
  let wsum = 0, vsum = 0;
  for (const e of events) {
    const w = Math.pow(0.5, ageDays(e.ts) / HALFLIFE);
    wsum += w; vsum += w * e.signal;
  }
  return wsum > 0 ? vsum / wsum : 0.5;
}

export function computeAffinity() {
  const events = listPrefEvents();
  const byCat = {};
  for (const c of CATS) {
    const ev = events.filter((e) => e.category === c);
    if (!ev.length) { byCat[c] = { n: 0, ema: 0.5, sw: 0.5, affinity: 0.5, drift: 0, trend: 'stable' }; continue; }
    const lp = decayedMean(ev); // histórico con olvido
    // Corto plazo: últimas WINDOW decisiones dentro de SW_DAYS; si no hay, últimas WINDOW.
    const recent = ev.filter((e) => ageDays(e.ts) <= SW_DAYS).slice(-WINDOW).map((e) => e.signal);
    const sp = recent.length ? mean(recent) : mean(ev.slice(-WINDOW).map((e) => e.signal));
    const affinity = LAMBDA * sp + (1 - LAMBDA) * lp;
    const drift = sp - lp;
    const trend = drift > DELTA ? 'rising' : drift < -DELTA ? 'falling' : 'stable';
    byCat[c] = { n: ev.length, ema: r2(lp), sw: r2(sp), affinity: r2(affinity), drift: r2(drift), trend };
  }
  return { ok: true, categories: byCat, total: events.length };
}

// Ajuste de score por afinidad de la categoría: −10..+10 (0.5 = neutro).
export function scoreNudge(category, aff = computeAffinity()) {
  const a = aff.categories?.[category]?.affinity ?? 0.5;
  return Math.round((a - 0.5) * 20);
}

// Texto para el prompt: qué viene subiendo/bajando (solo si hay señal real).
export function affinityHint(aff = computeAffinity()) {
  if (aff.total < 4) return ''; // sin suficiente historia todavía
  const rising = [], falling = [];
  for (const c of CATS) {
    const x = aff.categories[c];
    if (!x || x.n < 2) continue;
    if (x.trend === 'rising' || x.affinity >= 0.7) rising.push(c);
    if (x.trend === 'falling' || x.affinity <= 0.3) falling.push(c);
  }
  if (!rising.length && !falling.length) return '';
  let s = '\n\nPREFERENCIAS APRENDIDAS (de lo que el usuario viene aceptando/descartando):';
  if (rising.length) s += `\n- Prioriza: ${rising.join(', ')} (viene aceptando más).`;
  if (falling.length) s += `\n- Modera: ${falling.join(', ')} (viene descartando).`;
  return s + '\n';
}

function r2(n) { return Math.round(n * 100) / 100; }
