import { useState, useEffect } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

export function Onboarding() {
  const sw = useApi('/api/software');
  const settings = useApi('/api/settings');
  if (sw.loading) return <Loading />;
  if (sw.error) return <><PageHead title="Onboarding" /><ErrorBox error={sw.error} /></>;

  return (
    <>
      <PageHead title="Onboarding" sub="Software detectado + configuración de ROI de tu tiempo" />
      <RoiConfig settings={settings.data} onSave={settings.reload} />

      <div class="card">
        <div class="spread" style="margin-bottom:12px"><h3>Software en la máquina</h3><span class="chip small">{sw.data.found}/{sw.data.total}</span></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
          {sw.data.tools.map((t) => (
            <div class="list-row" key={t.name} style="border-radius:var(--radius-m)">
              <span class="msr" style={`color:var(--${t.found ? 'ok' : 'text-3'})`}>{t.found ? 'check_circle' : 'cancel'}</span>
              <div class="grow">
                <div class="title" style="font-size:13px">{t.label}</div>
                <div class="muted mono ellipsis" style="font-size:10.5px">{t.found ? (t.version || t.path) : 'no instalado'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function RoiConfig({ settings, onSave }) {
  const [min, setMin] = useState('');
  const [rate, setRate] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setMin(settings?.roi_minutes_per_use || '');
    setRate(settings?.roi_hourly_rate || '');
  }, [settings?.roi_minutes_per_use, settings?.roi_hourly_rate]);

  const save = async () => {
    await post('/api/settings/set', { key: 'roi_minutes_per_use', value: min || '0' });
    await post('/api/settings/set', { key: 'roi_hourly_rate', value: rate || '0' });
    setSaved(true); onSave();
  };

  return (
    <div class="card" style="margin-bottom:16px">
      <h3>ROI de tu tiempo</h3>
      <div class="muted" style="font-size:12.5px;margin:6px 0 12px">Cuántos minutos te ahorra en promedio cada invocación de skill, y cuánto vale tu hora. El Agent OS calcula tiempo y plata ahorrados en <b>Analytics</b>.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:420px">
        <label style="font-size:12px">Minutos por invocación
          <div class="search" style="margin-top:4px"><input type="number" value={min} onInput={(e) => setMin(e.target.value)} placeholder="ej: 8" /></div>
        </label>
        <label style="font-size:12px">Valor de tu hora (USD)
          <div class="search" style="margin-top:4px"><input type="number" value={rate} onInput={(e) => setRate(e.target.value)} placeholder="ej: 50" /></div>
        </label>
      </div>
      <div class="wrap" style="margin-top:12px;align-items:center">
        <button class="chip filter-chip on" onClick={save}>Guardar ROI</button>
        {saved && <span class="mono" style="font-size:11px;color:var(--ok)">✓ guardado</span>}
      </div>
    </div>
  );
}
