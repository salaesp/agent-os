import { useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';

export function Analytics() {
  const { data, error, loading } = useApi('/api/skills');
  const settings = useApi('/api/settings');
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Analytics" /><ErrorBox error={error} /></>;

  const skills = data.skills;
  const totalUses = skills.reduce((a, s) => a + s.useCount, 0);
  const roiMin = Number(settings.data?.roi_minutes_per_use || 0);
  const roiRate = Number(settings.data?.roi_hourly_rate || 0);
  const hoursSaved = (totalUses * roiMin) / 60;
  const moneySaved = hoursSaved * roiRate;
  const used = skills.filter((s) => s.useCount > 0);
  const dead = skills.filter((s) => s.useCount === 0);
  const top = [...used].sort((a, b) => b.useCount - a.useCount).slice(0, 12);
  const maxUse = top[0]?.useCount || 1;

  // Uso agregado por categoría.
  const byCat = {};
  for (const s of skills) byCat[s.category] = (byCat[s.category] || 0) + s.useCount;
  const cats = Object.entries(byCat).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHead title="Analytics" sub="Uso de skills · detección de skills muertas" />
      <div class="grid" style="margin-bottom:18px">
        <div class="card stat"><span class="num">{totalUses}</span><span class="lbl">Invocaciones totales</span></div>
        <div class="card stat"><span class="num">{used.length}<span class="muted" style="font-size:18px">/{skills.length}</span></span><span class="lbl">Skills en uso</span></div>
        <div class="card stat"><span class="num" style="color:var(--warn)">{dead.length}</span><span class="lbl">Skills muertas (0 usos)</span></div>
        <div class="card stat"><span class="num">{cats.length}</span><span class="lbl">Categorías activas</span></div>
      </div>

      {roiMin > 0 && (
        <div class="grid" style="margin-bottom:18px">
          <div class="card stat"><span class="num" style="color:var(--gold)">{hoursSaved.toFixed(0)}h</span><span class="lbl">Tiempo ahorrado (≈{roiMin}min/uso)</span></div>
          {roiRate > 0 && <div class="card stat"><span class="num" style="color:var(--gold)">${moneySaved.toFixed(0)}</span><span class="lbl">Valor ahorrado (${roiRate}/h)</span></div>}
        </div>
      )}
      {roiMin === 0 && <div class="card" style="margin-bottom:18px"><div class="muted" style="font-size:13px">Configurá el <b>ROI</b> en Onboarding para ver tiempo y plata ahorrados por las skills.</div></div>}

      <div class="card" style="margin-bottom:16px">
        <h3>Top skills por uso</h3>
        <div class="list" style="margin-top:10px;background:transparent;border:none;gap:8px">
          {top.map((s) => (
            <div key={s.name} style="display:grid;grid-template-columns:180px 1fr 44px;gap:10px;align-items:center">
              <span class="ellipsis" style="font-size:12.5px" title={s.category + '/' + s.name}>{s.name}</span>
              <div class="bar"><i style={`width:${Math.round((s.useCount / maxUse) * 100)}%`} /></div>
              <span class="mono muted" style="font-size:12px;text-align:right">{s.useCount}×</span>
            </div>
          ))}
        </div>
      </div>

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
        <div class="card">
          <h3>Uso por categoría</h3>
          <div class="list" style="margin-top:10px;background:transparent;border:none;gap:6px">
            {cats.map(([c, n]) => (
              <div key={c} class="spread" style="font-size:12.5px"><span>{c}</span><span class="mono muted">{n}×</span></div>
            ))}
          </div>
        </div>
        <div class="card">
          <div class="spread"><h3>Skills muertas</h3><span class="chip small">{dead.length}</span></div>
          <div class="muted" style="font-size:12px;margin:6px 0 10px">Candidatas a archivar — nunca se invocaron.</div>
          <div class="wrap">
            {dead.slice(0, 40).map((s) => <span class="chip small" key={s.name} title={s.category}>{s.name}</span>)}
            {dead.length > 40 && <span class="chip small">+{dead.length - 40}</span>}
          </div>
        </div>
      </div>
    </>
  );
}
