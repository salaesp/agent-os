import { useState, useEffect } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

export function Costs() {
  const { data, error, loading, reload } = useApi('/api/costs', 60000);
  const settings = useApi('/api/settings');
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Costos" /><ErrorBox error={error} /></>;
  if (!data.ok) return <><PageHead title="Costos" /><div class="card"><div class="muted">{data.error}. Configurá <span class="mono">METRICS_DB</span> hacia el sqlite del dashboard.</div></div></>;

  const c = data.claude;
  const or = data.openrouter || {};
  const providers = data.providers || [];
  const maxDay = Math.max(...c.days.map((d) => d.cost), 0.01);
  const recent = c.days.slice(-16);
  const maxModel = Math.max(...c.models.map((m) => m.cost), 0.01);
  const [allModels, setAllModels] = useState(false);
  const shown = allModels ? c.models : c.models.slice(0, 10);

  return (
    <>
      <PageHead title="Costos" sub="Todo lo que se gastó desde las sesiones · últimos 30 días" />

      {data.alerts.length > 0 && (
        <div style="margin-bottom:14px;display:grid;gap:8px">
          {data.alerts.map((a, i) => (
            <div class="card" key={i} style={`border-color:var(--${a.level});padding:12px 16px`}>
              <div class="row"><span class="msr" style={`color:var(--${a.level})`}>{a.level === 'err' ? 'error' : 'warning'}</span><b>{a.text}</b></div>
            </div>
          ))}
        </div>
      )}

      <div class="grid" style="margin-bottom:18px">
        <div class="card stat"><span class="num">${c.monthTotal}</span><span class="lbl">Este mes · todo</span></div>
        <div class="card stat"><span class="num">${c.total30}</span><span class="lbl">Últimos 30 días</span></div>
        <OpenRouterCard or={or} />
        <PlanCard plan={c.plan} />
      </div>

      {providers.length > 0 && (
        <div class="card" style="margin-bottom:16px">
          <h3>Por proveedor (30 días)</h3>
          <div class="muted" style="font-size:11.5px;margin:4px 0 12px">
            Las sesiones mezclan proveedores: lo que se ve arriba es la suma de todos. El proveedor se deduce del id del modelo.
          </div>
          <div class="list" style="background:transparent;border:none;gap:8px">
            {providers.map((p) => (
              <div key={p.provider} style="display:grid;grid-template-columns:1fr 90px;gap:10px;align-items:center">
                <div>
                  <div style="font-size:12.5px">{p.label} <span class="muted">· {p.models} modelo(s)</span></div>
                  <div class="bar" style="margin-top:3px"><i style={`width:${Math.round((p.cost / Math.max(c.total30, 0.01)) * 100)}%`} /></div>
                </div>
                <span class="mono" style="text-align:right;font-size:12.5px">${p.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="card" style="margin-bottom:16px">
        <h3>Gasto diario</h3>
        <div style="display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:14px">
          {recent.map((d) => (
            <div key={d.day} style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end"
              title={`${d.day}: $${d.cost.toFixed(2)} (anthropic $${(d.anthropic || 0).toFixed(2)} · openrouter $${(d.openrouter || 0).toFixed(2)})`}>
              {/* Barra apilada: se ve de un vistazo qué parte del día fue de cada
                  proveedor, en vez de un único bloque indiferenciado. */}
              <div style={`width:100%;height:${Math.max(2, (d.cost / maxDay) * 100)}%;display:flex;flex-direction:column;justify-content:flex-end;border-radius:4px 4px 0 0;overflow:hidden`}>
                <div style={`background:var(--gold);height:${pct(d.otros + d.local, d.cost)}%`} />
                <div style={`background:var(--ok);height:${pct(d.openrouter, d.cost)}%`} />
                <div style={`background:var(--accent);height:${pct(d.anthropic, d.cost)}%`} />
              </div>
              <span class="muted" style="font-size:9px">{d.day.slice(8)}</span>
            </div>
          ))}
        </div>
        <div class="wrap" style="margin-top:10px;font-size:11px">
          <span class="chip small"><i style="width:8px;height:8px;border-radius:2px;background:var(--accent);display:inline-block;margin-right:5px" />Anthropic</span>
          <span class="chip small"><i style="width:8px;height:8px;border-radius:2px;background:var(--ok);display:inline-block;margin-right:5px" />OpenRouter</span>
          <span class="chip small"><i style="width:8px;height:8px;border-radius:2px;background:var(--gold);display:inline-block;margin-right:5px" />Local / otros</span>
        </div>
      </div>

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
        <div class="card">
          <div class="spread"><h3>Por modelo (30 días)</h3><span class="muted" style="font-size:11px">{c.models.length} modelos</span></div>
          <div class="list" style="margin-top:10px;background:transparent;border:none;gap:8px">
            {shown.map((m) => (
              <div key={m.model} style="display:grid;grid-template-columns:1fr 70px;gap:10px;align-items:center">
                <div>
                  <div class="ellipsis mono" style="font-size:12px">
                    {m.model}
                    {m.unpriced && <span class="msr" style="font-size:13px;vertical-align:-2px;color:var(--warn);margin-left:4px" title="tuvo tokens pero ccusage no sabe el precio de este id — el costo real no está contado">help</span>}
                  </div>
                  <div class="bar" style="margin-top:3px"><i style={`width:${Math.round((m.cost / maxModel) * 100)}%`} /></div>
                </div>
                <span class="mono" style="text-align:right;font-size:12.5px">{m.unpriced ? <span class="muted">s/precio</span> : `$${m.cost}`}</span>
              </div>
            ))}
          </div>
          {c.models.length > 10 && (
            <button class="chip small" style="margin-top:10px" onClick={() => setAllModels((v) => !v)}>
              {allModels ? 'Ver menos' : `Ver los ${c.models.length - 10} restantes`}
            </button>
          )}
        </div>

        {or.models?.length > 0 && (
          <div class="card">
            <h3>OpenRouter · por modelo</h3>
            <div class="muted" style="font-size:11.5px;margin:4px 0 10px">
              Directo de la API de OpenRouter, no de las sesiones. {or.total30 != null && <>Últimos 30 días: <b>${or.total30}</b>
              {or.outsideSessions > 1 && <> — de los cuales <b>${or.outsideSessions}</b> no salen de sesiones de Claude Code (el agente pegándole directo a la API).</>}</>}
            </div>
            <div class="list" style="background:transparent;border:none;gap:8px">
              {or.models.slice(0, 12).map((m) => (
                <div key={m.model} style="display:grid;grid-template-columns:1fr 70px;gap:10px;align-items:center">
                  <div>
                    <div class="ellipsis mono" style="font-size:12px">{m.model}</div>
                    <div class="bar" style="margin-top:3px"><i style={`width:${Math.round((m.cost / Math.max(or.models[0].cost, 0.01)) * 100)}%`} /></div>
                  </div>
                  <span class="mono" style="text-align:right;font-size:12.5px">${m.cost.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <BudgetCard settings={settings.data} onSave={() => { settings.reload(); reload(); }} />
      </div>
    </>
  );
}

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

// Saldo prepago de OpenRouter. Si se acaba, los modelos ruteados dejan de andar
// — por eso el número que importa es lo que QUEDA, no lo acumulado.
function OpenRouterCard({ or }) {
  if (!or || or.used_total == null) return <div class="card stat"><span class="num">—</span><span class="lbl">OpenRouter</span></div>;
  if (or.limit > 0 && or.remaining != null) {
    const leftPct = Math.round((or.remaining / or.limit) * 100);
    const cls = leftPct <= 5 ? 'err' : leftPct <= 20 ? 'warn' : '';
    return (
      <div class="card">
        <span class="lbl" style="font-size:11.5px;text-transform:uppercase;color:var(--text-2)">OpenRouter · saldo</span>
        <div class="spread" style="margin-top:6px;align-items:baseline">
          <span class="num" style="font-size:26px">${or.remaining.toFixed(2)}</span>
          <span class="muted mono" style="font-size:11px">de ${or.limit}</span>
        </div>
        <div class="bar" style="margin-top:8px"><i class={cls} style={`width:${100 - leftPct}%`} /></div>
        <div class="muted" style="font-size:10.5px;margin-top:6px">
          gastado ${Number(or.used_total).toFixed(2)} histórico{or.countedInSessions > 0 ? ` · $${or.countedInSessions} ya contados arriba` : ''}
        </div>
      </div>
    );
  }
  return (
    <div class="card stat">
      <span class="num">${Number(or.used_total).toFixed(0)}</span>
      <span class="lbl">OpenRouter · gastado histórico</span>
      <div class="muted" style="font-size:10px;margin-top:4px">no es sumable con los 30 días</div>
    </div>
  );
}

function PlanCard({ plan }) {
  if (!plan) return <div class="card stat"><span class="num">—</span><span class="lbl">Cuota del plan</span></div>;
  const Bar = ({ label, v }) => {
    const pct = Math.round((v || 0) * 100);
    const cls = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : '';
    return (
      <div style="margin-top:8px">
        <div class="spread" style="font-size:11px;margin-bottom:3px"><span class="muted">{label}</span><span class="mono">{pct}%</span></div>
        <div class="bar"><i class={cls} style={`width:${pct}%`} /></div>
      </div>
    );
  };
  return (
    <div class="card">
      <span class="lbl" style="font-size:11.5px;text-transform:uppercase;color:var(--text-2)">Cuota Claude</span>
      <Bar label="ventana 5h" v={plan.util_5h} />
      <Bar label="ventana 7d" v={plan.util_7d} />
    </div>
  );
}

function BudgetCard({ settings, onSave }) {
  const [val, setVal] = useState(settings?.monthly_budget_usd || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setVal(settings?.monthly_budget_usd || ''); }, [settings?.monthly_budget_usd]);

  const save = async () => {
    setBusy(true); setSaved(false);
    try { await post('/api/settings/set', { key: 'monthly_budget_usd', value: val }); setSaved(true); onSave(); }
    finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h3>Presupuesto mensual</h3>
      <div class="muted" style="font-size:12px;margin:6px 0 12px">Definí un tope en USD y el Agent OS te avisa al 80% y al 100%.</div>
      <div class="row">
        <div class="search" style="flex:1"><input type="number" placeholder="ej: 500" value={val} onInput={(e) => setVal(e.target.value)} /></div>
        <button class="chip filter-chip on" disabled={busy} onClick={save}>{busy ? '…' : 'Guardar'}</button>
      </div>
      {saved && <div class="mono" style="font-size:11px;color:var(--ok);margin-top:8px">✓ guardado</div>}
    </div>
  );
}
