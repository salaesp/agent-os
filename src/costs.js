// Costos unificados + alertas. Lee READ-ONLY el sqlite que ya mantiene el
// minipc-dashboard (claude_usage, claude_plan, openrouter_*), así no duplicamos
// el polling pesado (ccusage, APIs) en la Pi. Degrada si falta.
//
// OJO con la tabla `claude_usage`: el nombre miente. La llena ccusage parseando
// las sesiones de Claude Code, y ahí adentro conviven TODOS los proveedores que
// se hayan usado desde el CLI — Anthropic directo, modelos ruteados por
// OpenRouter y modelos locales de Ollama. No trae columna `provider`, así que
// acá se deriva del id del modelo. Antes se sumaba todo junto bajo la etiqueta
// "Claude", que daba un número inflado y sin sentido.
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { getSetting } from './db.js';

function readMetrics(fn) {
  let db;
  try {
    db = new DatabaseSync(config.metricsDbPath, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

// Tolerante a tablas que todavía no existan (el dashboard puede estar viejo).
function tryAll(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}
function tryGet(db, sql, ...args) {
  try { return db.prepare(sql).get(...args); } catch { return null; }
}

const todayMinus = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const monthPrefix = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// Modelos locales: Ollama usa `nombre:tag`, y algunos vienen sin tag.
const LOCAL_RE = /^(llama|gemma|mistral|qwen2|phi|deepseek-r1|nomic|llava|codellama)[\w.\-]*(:[\w.\-]+)?$/i;

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude Code)' },
  openrouter: { label: 'OpenRouter' },
  local: { label: 'Local (Ollama)' },
  otros: { label: 'Otros / sin identificar' },
};

// Deriva el proveedor del id del modelo. `org/modelo` es la forma canónica de
// OpenRouter; `claude-*` pelado es la suscripción de Claude Code.
export function providerOf(model) {
  const m = String(model || '').trim();
  if (!m) return 'otros';
  if (m.includes('/')) return 'openrouter';
  if (m.includes(':') || LOCAL_RE.test(m)) return 'local';
  if (/^claude[-.]/i.test(m)) return 'anthropic';
  return 'otros';
}

// ccusage a veces no sabe el precio de un id de OpenRouter (alias, preset MoA,
// modelo nuevo) y lo deja en $0 con tokens reales. OpenRouter publica su propia
// lista de precios pública — la usamos como fallback en vez de solo avisar.
const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OR_PRICING_TTL_MS = 6 * 3600_000;
let orPricingCache = null; // { ts, map }

async function getOpenRouterPricing() {
  if (orPricingCache && Date.now() - orPricingCache.ts < OR_PRICING_TTL_MS) return orPricingCache.map;
  try {
    const res = await fetch(OR_MODELS_URL);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const map = new Map();
    for (const m of body.data || []) {
      const p = m.pricing || {};
      map.set(m.id, { prompt: Number(p.prompt) || 0, completion: Number(p.completion) || 0 });
    }
    orPricingCache = { ts: Date.now(), map };
    return map;
  } catch {
    return orPricingCache?.map || new Map(); // degradado: sin red, sin precios nuevos
  }
}

export async function getCosts() {
  const orPricing = await getOpenRouterPricing();
  const data = readMetrics((db) => {
    const since = todayMinus(30);
    const rows = db.prepare(
      `SELECT day, model, input_tokens, output_tokens, cost_usd
       FROM claude_usage WHERE day >= ? ORDER BY day`).all(since);
    const plan = db.prepare('SELECT ts, util_5h, util_7d FROM claude_plan ORDER BY ts DESC LIMIT 1').get();
    const orRows = db.prepare('SELECT ts, used_total FROM openrouter_usage ORDER BY ts DESC LIMIT 1').all();
    // Tablas nuevas: desglose real de OpenRouter (antes no se persistía nada).
    const orDaily = tryAll(db, 'SELECT day, cost FROM openrouter_daily WHERE day >= ? ORDER BY day', since);
    const orModels = tryAll(db, 'SELECT model, cost FROM openrouter_by_model WHERE cost > 0 ORDER BY cost DESC');
    const orCredit = tryGet(db, 'SELECT ts, used, credits, limit_usd, remaining FROM openrouter_credit ORDER BY ts DESC LIMIT 1');
    return { rows, plan, orRows, orDaily, orModels, orCredit };
  });

  if (!data) return { ok: false, error: `no se pudo leer ${config.metricsDbPath}` };

  const { rows, plan, orRows, orDaily, orModels, orCredit } = data;
  const month = monthPrefix();

  const byDay = new Map();     // día → costo por proveedor
  const byModel = new Map();
  const byProvider = {};
  for (const k of Object.keys(PROVIDERS)) byProvider[k] = { provider: k, label: PROVIDERS[k].label, cost: 0, month: 0, tokens: 0, models: 0 };
  let total30 = 0, monthTotal = 0;

  for (const r of rows) {
    const prov = providerOf(r.model);
    const inTok = Number(r.input_tokens) || 0;
    const outTok = Number(r.output_tokens) || 0;
    let cost = Number(r.cost_usd) || 0;
    // ccusage no supo precear este id: si es de OpenRouter, usar su lista de precios.
    if (cost === 0 && prov === 'openrouter' && (inTok + outTok) > 0) {
      // Precio negativo (ej. -1) es el sentinel de OpenRouter para "variable /
      // sin precio fijo" (routers como `openrouter/auto`), no un precio real.
      const price = orPricing.get(r.model);
      if (price && price.prompt >= 0 && price.completion >= 0) cost = inTok * price.prompt + outTok * price.completion;
    }
    const tok = inTok + outTok;

    const d = byDay.get(r.day) || { day: r.day, cost: 0, anthropic: 0, openrouter: 0, local: 0, otros: 0 };
    d.cost += cost; d[prov] += cost; byDay.set(r.day, d);

    const key = r.model;
    const m = byModel.get(key) || { model: key, provider: prov, cost: 0, input: 0, output: 0 };
    m.cost += cost; m.input += inTok; m.output += outTok;
    byModel.set(key, m);

    byProvider[prov].cost += cost;
    byProvider[prov].tokens += tok;
    if (r.day.startsWith(month)) byProvider[prov].month += cost;

    total30 += cost;
    if (r.day.startsWith(month)) monthTotal += cost;
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const today = days.find((d) => d.day === todayMinus(0))
    || { day: todayMinus(0), cost: 0, anthropic: 0, openrouter: 0, local: 0, otros: 0 };
  const models = [...byModel.values()].sort((a, b) => b.cost - a.cost)
    // Costo 0 con tokens reales = ccusage no supo precear ese id (alias, preset
    // MoA). No es lo mismo que "es local y sale 0" — se marca para no mentir.
    .map((m) => ({
      ...m,
      cost: Number(m.cost.toFixed(4)),
      unpriced: m.cost === 0 && (m.input + m.output) > 0 && m.provider !== 'local',
    }));
  for (const m of models) byProvider[m.provider].models++;
  const providers = Object.values(byProvider).filter((p) => p.cost > 0 || p.models > 0)
    .map((p) => ({ ...p, cost: Number(p.cost.toFixed(2)), month: Number(p.month.toFixed(2)) }))
    .sort((a, b) => b.cost - a.cost);

  // --- OpenRouter: acumulado histórico + desglose real (si el collector ya lo
  // persistió). `used_total` NO es comparable con los 30 días: es el total
  // histórico de la cuenta, y además su gasto YA está contado arriba dentro de
  // los modelos `org/modelo`. Se expone aparte y etiquetado como tal.
  const orDaily30 = (orDaily || []).map((d) => ({ day: d.day, cost: Number(Number(d.cost).toFixed(4)) }));
  const orTotal30 = orDaily30.reduce((a, d) => a + d.cost, 0);
  // Umbral de saldo bajo en USD absolutos, NO en % del crédito histórico: ese
  // % baja solo, cada vez que se carga saldo, aunque el saldo real no cambie.
  const orLowBalance = Number(getSetting('openrouter_low_balance_usd', '10')) || 10;
  const openrouter = {
    used_total: orRows?.[0]?.used_total ?? null,
    limit: orCredit?.limit_usd ?? null,
    remaining: orCredit?.remaining ?? null,
    credits: orCredit?.credits ?? null,
    lowBalanceThreshold: orLowBalance,
    updatedAt: orCredit?.ts ? new Date(orCredit.ts * 1000).toISOString() : null,
    daily: orDaily30,
    models: (orModels || []).map((m) => ({ model: m.model, cost: Number(Number(m.cost).toFixed(4)) })).slice(0, 20),
    total30: orDaily30.length ? Number(orTotal30.toFixed(2)) : null,
    // Lo que de este gasto ya está contado en la tabla de sesiones (evita que el
    // usuario sume dos veces el mismo peso).
    countedInSessions: Number((byProvider.openrouter?.cost || 0).toFixed(2)),
  };
  // La diferencia entre lo que cobra OpenRouter y lo que se ve en las sesiones es
  // gasto de OTROS clientes (el agente llamando a la API por su cuenta, scripts,
  // etc.): ccusage sólo ve las sesiones de Claude Code. Sin esto, el total real
  // queda subestimado y no hay forma de darse cuenta.
  openrouter.outsideSessions = openrouter.total30 != null
    ? Number((openrouter.total30 - openrouter.countedInSessions).toFixed(2))
    : null;

  // --- Alertas ---
  const budget = Number(getSetting('monthly_budget_usd', '0')) || 0;
  const alerts = [];
  if (plan?.util_7d != null && plan.util_7d >= 0.8) alerts.push({ level: plan.util_7d >= 0.95 ? 'err' : 'warn', text: `Cuota Claude 7d al ${Math.round(plan.util_7d * 100)}%` });
  if (plan?.util_5h != null && plan.util_5h >= 0.9) alerts.push({ level: 'warn', text: `Cuota Claude 5h al ${Math.round(plan.util_5h * 100)}%` });
  // Saldo de OpenRouter: es prepago, si se acaba dejan de andar los modelos.
  // Umbral absoluto en USD (configurable), no % del crédito histórico.
  if (openrouter.remaining != null) {
    if (openrouter.remaining <= orLowBalance) alerts.push({ level: 'err', text: `OpenRouter casi sin saldo: quedan $${openrouter.remaining.toFixed(2)}` });
    else if (openrouter.remaining <= orLowBalance * 2) alerts.push({ level: 'warn', text: `OpenRouter con poco saldo: quedan $${openrouter.remaining.toFixed(2)} (aviso bajo $${(orLowBalance * 2).toFixed(0)})` });
  }
  if (budget > 0) {
    const pct = monthTotal / budget;
    if (pct >= 1) alerts.push({ level: 'err', text: `Presupuesto del mes superado: $${monthTotal.toFixed(0)}/$${budget}` });
    else if (pct >= 0.8) alerts.push({ level: 'warn', text: `Vas por $${monthTotal.toFixed(0)} de $${budget} este mes (${Math.round(pct * 100)}%)` });
  }
  if (openrouter.outsideSessions > 1) {
    alerts.push({ level: 'warn', text: `$${openrouter.outsideSessions} de OpenRouter (30d) no salen de sesiones de Claude Code — es el agente u otros clientes pegándole a la API directo` });
  }
  // Ya no hay aviso de "modelos sin precio": los de OpenRouter se precean con su
  // propia lista de precios (arriba). Sigue quedando el flag `unpriced` por modelo
  // para el caso residual (id que ni OpenRouter reconoce), pero sin alerta.

  return {
    ok: true,
    // `claude` se mantiene por compatibilidad, pero ahora es el TOTAL de todos
    // los proveedores vistos en sesiones, no sólo Anthropic.
    claude: {
      plan: plan ? { util_5h: plan.util_5h, util_7d: plan.util_7d } : null,
      total30: Number(total30.toFixed(2)),
      monthTotal: Number(monthTotal.toFixed(2)),
      days,
      today: { ...today, cost: Number(today.cost.toFixed(2)), anthropic: Number(today.anthropic.toFixed(2)), openrouter: Number(today.openrouter.toFixed(2)) },
      models: models.map((m) => ({ ...m, cost: Number(m.cost.toFixed(2)) })),
    },
    providers,
    openrouter,
    budget,
    alerts,
  };
}
