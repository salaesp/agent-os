// Costos unificados + alertas. Lee READ-ONLY el sqlite que ya mantiene el
// minipc-dashboard (claude_usage, claude_plan, openrouter_usage), así no
// duplicamos el polling pesado (ccusage, APIs) en la Pi. Degrada si falta.
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

const todayMinus = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const monthPrefix = () => new Date().toISOString().slice(0, 7); // YYYY-MM

export function getCosts() {
  const data = readMetrics((db) => {
    const since = todayMinus(30);
    const rows = db.prepare(
      `SELECT day, model, input_tokens, output_tokens, cost_usd
       FROM claude_usage WHERE day >= ? ORDER BY day`).all(since);
    const plan = db.prepare('SELECT ts, util_5h, util_7d FROM claude_plan ORDER BY ts DESC LIMIT 1').get();
    const orRows = db.prepare('SELECT ts, used_total FROM openrouter_usage ORDER BY ts DESC LIMIT 2').all();
    return { rows, plan, orRows };
  });

  if (!data) return { ok: false, error: `no se pudo leer ${config.metricsDbPath}` };

  const { rows, plan, orRows } = data;
  const byDay = new Map();
  const byModel = new Map();
  let total30 = 0, monthTotal = 0;
  const month = monthPrefix();
  for (const r of rows) {
    const d = byDay.get(r.day) || { day: r.day, cost: 0 };
    d.cost += r.cost_usd; byDay.set(r.day, d);
    const m = byModel.get(r.model) || { model: r.model, cost: 0, input: 0, output: 0 };
    m.cost += r.cost_usd; m.input += r.input_tokens; m.output += r.output_tokens; byModel.set(r.model, m);
    total30 += r.cost_usd;
    if (r.day.startsWith(month)) monthTotal += r.cost_usd;
  }
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const models = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  const openrouter = orRows?.[0] ? { used_total: orRows[0].used_total } : null;

  // --- Alertas ---
  const budget = Number(getSetting('monthly_budget_usd', '0')) || 0;
  const alerts = [];
  if (plan?.util_7d != null && plan.util_7d >= 0.8) alerts.push({ level: plan.util_7d >= 0.95 ? 'err' : 'warn', text: `Cuota Claude 7d al ${Math.round(plan.util_7d * 100)}%` });
  if (plan?.util_5h != null && plan.util_5h >= 0.9) alerts.push({ level: 'warn', text: `Cuota Claude 5h al ${Math.round(plan.util_5h * 100)}%` });
  if (budget > 0) {
    const pct = monthTotal / budget;
    if (pct >= 1) alerts.push({ level: 'err', text: `Presupuesto del mes superado: $${monthTotal.toFixed(0)}/$${budget}` });
    else if (pct >= 0.8) alerts.push({ level: 'warn', text: `Vas por $${monthTotal.toFixed(0)} de $${budget} este mes (${Math.round(pct * 100)}%)` });
  }

  return {
    ok: true,
    claude: {
      plan: plan ? { util_5h: plan.util_5h, util_7d: plan.util_7d } : null,
      total30: Number(total30.toFixed(2)),
      monthTotal: Number(monthTotal.toFixed(2)),
      days,
      models: models.map((m) => ({ ...m, cost: Number(m.cost.toFixed(2)) })),
    },
    openrouter,
    budget,
    alerts,
  };
}
