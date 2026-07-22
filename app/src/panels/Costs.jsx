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
  const maxDay = Math.max(...c.days.map((d) => d.cost), 0.01);
  const recent = c.days.slice(-16);
  const maxModel = Math.max(...c.models.map((m) => m.cost), 0.01);

  return (
    <>
      <PageHead title="Costos" sub="Claude + OpenRouter · últimos 30 días · alertas de presupuesto" />

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
        <div class="card stat"><span class="num">${c.monthTotal}</span><span class="lbl">Este mes · Claude</span></div>
        <div class="card stat"><span class="num">${c.total30}</span><span class="lbl">Últimos 30 días</span></div>
        <div class="card stat"><span class="num">${data.openrouter ? data.openrouter.used_total.toFixed(0) : '—'}</span><span class="lbl">OpenRouter (acum.)</span></div>
        <PlanCard plan={c.plan} />
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3>Gasto diario (Claude)</h3>
        <div style="display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:14px">
          {recent.map((d) => (
            <div key={d.day} style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end" title={`${d.day}: $${d.cost.toFixed(2)}`}>
              <div style={`width:100%;background:var(--accent);border-radius:4px 4px 0 0;height:${Math.max(2, (d.cost / maxDay) * 100)}%`} />
              <span class="muted" style="font-size:9px">{d.day.slice(8)}</span>
            </div>
          ))}
        </div>
      </div>

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
        <div class="card">
          <h3>Por modelo (30 días)</h3>
          <div class="list" style="margin-top:10px;background:transparent;border:none;gap:8px">
            {c.models.slice(0, 10).map((m) => (
              <div key={m.model} style="display:grid;grid-template-columns:1fr 70px;gap:10px;align-items:center">
                <div>
                  <div class="ellipsis mono" style="font-size:12px">{m.model}</div>
                  <div class="bar" style="margin-top:3px"><i style={`width:${Math.round((m.cost / maxModel) * 100)}%`} /></div>
                </div>
                <span class="mono" style="text-align:right;font-size:12.5px">${m.cost}</span>
              </div>
            ))}
          </div>
        </div>
        <BudgetCard settings={settings.data} onSave={() => { settings.reload(); reload(); }} />
      </div>
    </>
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
