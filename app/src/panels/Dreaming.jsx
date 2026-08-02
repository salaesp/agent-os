import { useEffect, useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';

const KIND = {
  idea: { icon: 'lightbulb', label: 'idea' },
  patron: { icon: 'insights', label: 'patrón' },
  conexion: { icon: 'hub', label: 'conexión' },
  pregunta: { icon: 'help', label: 'pregunta' },
};

export function Dreaming() {
  // El aterrizaje tarda ~1 min y el estado vive en el SERVER: si hay alguno en
  // curso se refresca rápido, así recargar la página (o abrirla en otro
  // dispositivo) sigue mostrando qué está pasando.
  const [fast, setFast] = useState(false);
  const { data, error, loading, reload } = useApi('/api/dreams', fast ? 5000 : 60000);
  const { data: settings, reload: reloadCfg } = useApi('/api/settings', 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [editModel, setEditModel] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);

  const promoting = data?.promoting || {};
  const anyPromoting = Object.keys(promoting).length > 0;
  useEffect(() => { setFast(anyPromoting); }, [anyPromoting]);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Dreaming" /><ErrorBox error={error} /></>;

  const autoOn = (settings?.auto_dream_enabled ?? '1') === '1';
  const nightlyHour = Number(settings?.auto_nightly_hour || '8');
  const model = settings?.auto_model || null;
  const provider = settings?.auto_provider || null;
  const toggleAuto = async () => {
    await post('/api/settings/set', { key: 'auto_dream_enabled', value: autoOn ? '0' : '1' });
    reloadCfg();
  };
  const setCfg = async (key, value) => { await post('/api/settings/set', { key, value }); reloadCfg(); };
  const saveModel = async ({ model: m, provider: p }) => {
    setModelBusy(true);
    try {
      await post('/api/settings/set', { key: 'auto_model', value: m || '' });
      await post('/api/settings/set', { key: 'auto_provider', value: p || '' });
      setEditModel(false);
      reloadCfg();
    } finally { setModelBusy(false); }
  };

  const dream = async () => {
    setBusy(true); setMsg(null);
    try { const r = await post('/api/dreams/generate', {}); setMsg(r.created ? `${r.created} ideas nuevas` : 'sin ideas nuevas esta vez'); reload(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const act = async (id, status) => { await post('/api/dreams/action', { id, status }); reload(); };
  // Bajar un sueño a algo aplicable. NO se espera la respuesta para mostrar
  // estado: el server ya marca el sueño como "en curso" y el refresh rápido lo
  // levanta — si cerrás la pestaña, el trabajo sigue igual y el resultado queda
  // registrado en el sueño.
  const promote = async (d) => {
    setMsg(null); setFast(true);
    try { const r = await post('/api/dreams/promote', { id: d.id }); setMsg(`«${r.suggestion.title}» → está en Sugerencias, lista para aplicar`); }
    catch (e) { setMsg(e.message); }
    finally { reload(); }
  };

  const active = (data?.dreams || []).filter((d) => d.status === 'new');
  const saved = (data?.dreams || []).filter((d) => d.status === 'saved').slice(0, 12);

  return (
    <>
      <PageHead title="Dreaming" sub="Lo que el agente imagina sobre tu vida — ideas, patrones y conexiones, no tareas">
        <button class="chip filter-chip on" disabled={busy} onClick={dream} style="padding:8px 16px">
          <span class="msr" style={`font-size:17px;${busy ? 'animation:spin 1s linear infinite' : ''}`}>{busy ? 'progress_activity' : 'bedtime'}</span>
          {busy ? 'Soñando…' : 'Soñar ahora'}
        </button>
      </PageHead>
      <div class="card" style="margin-bottom:12px;padding:12px 16px">
        <div class="spread">
          <div class="row" style="font-size:12.5px">
            <span class="msr" style={`color:var(--${autoOn ? 'ok' : 'text-3'})`}>{autoOn ? 'motion_photos_on' : 'motion_photos_off'}</span>
            <b>Sueña solo {autoOn ? 'ON' : 'OFF'}</b>
            <span class="muted">· una vez por día, a partir de las {nightlyHour}h</span>
          </div>
          <div class="wrap">
            <button class="chip small" onClick={() => setShowCfg((v) => !v)}>
              <span class="msr" style="font-size:14px">{showCfg ? 'expand_less' : 'tune'}</span>{showCfg ? 'ocultar' : 'ajustar'}
            </button>
            <button class={`chip filter-chip ${autoOn ? 'on' : ''}`} onClick={toggleAuto}>{autoOn ? 'Desactivar' : 'Activar'}</button>
          </div>
        </div>

        {showCfg && (
          <>
            <div class="spread" style="padding:10px 0 0;margin-top:10px;border-top:1px solid var(--hairline)">
              <span class="muted" style="font-size:12px">Hora del bundle nocturno</span>
              <div class="seg">{[6, 7, 8, 9, 10].map((h) => <button class={nightlyHour === h ? 'on' : ''} onClick={() => setCfg('auto_nightly_hour', String(h))} key={h}>{h}h</button>)}</div>
            </div>
            <div class="muted" style="font-size:11px;padding:6px 0 4px">Compartida con Sugerencias: es la misma hora para todo el bundle nocturno.</div>

            <div style="padding:10px 0 0;margin-top:2px;border-top:1px solid var(--hairline)">
              <div class="wrap">
                <span class="muted" style="font-size:12px">Modelo</span>
                <span class="chip small mono">{model || 'modelo del perfil'}</span>
                {provider && <span class="chip small">{provider}</span>}
                {!editModel && (
                  <button class="chip small" onClick={() => setEditModel(true)}>
                    <span class="msr" style="font-size:14px">edit</span>cambiar
                  </button>
                )}
              </div>
              {editModel && (
                <div style="margin-top:8px;max-width:520px">
                  <ModelPicker model={model} provider={provider} inherit busy={modelBusy} onSave={saveModel} onCancel={() => setEditModel(false)} />
                </div>
              )}
              <div class="muted" style="font-size:11px;margin-top:8px">Mismo modelo que usa la generación nocturna de sugerencias — es un ajuste compartido del motor.</div>
            </div>
          </>
        )}
      </div>
      {busy && <div class="card" style="margin-bottom:12px"><div class="muted">El agente está pensando en tu vida — patrones, conexiones, ideas de mayor vuelo. Puede tardar un rato…</div></div>}
      {anyPromoting && (
        <div class="card" style="margin-bottom:12px;border-color:var(--gold)">
          <div class="muted" style="font-size:12.5px">
            <span class="msr" style="font-size:15px;vertical-align:-3px;color:var(--gold);animation:spin 1s linear infinite">progress_activity</span>{' '}
            Aterrizando {Object.keys(promoting).length === 1 ? 'una idea' : `${Object.keys(promoting).length} ideas`} — {Object.values(promoting).map((p) => `${p.seconds}s`).join(' · ')}.
            Corre en el servidor: podés cerrar esta página, cuando termine queda anotado en el sueño.
          </div>
        </div>
      )}
      {msg && <div class="card" style="margin-bottom:12px"><span class="mono" style="font-size:12px">{msg}</span></div>}

      {active.length === 0 && !busy && (
        <div class="card"><div class="muted">Todavía no hay sueños. Tocá <b>«Soñar ahora»</b> y el agente te va a tirar ideas y patrones sobre tu vida a partir de tus conversaciones, memoria y objetivos — incluyendo los objetivos de tu Mission Control.</div></div>
      )}

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr));align-items:start">
        {active.map((d) => {
          const k = KIND[d.kind] || KIND.idea;
          return (
            <div class="card" key={d.id}>
              <div class="spread" style="margin-bottom:6px">
                <span class="chip small"><span class="msr" style="font-size:14px;color:var(--gold)">{k.icon}</span>{k.label}</span>
                <span class="muted" style="font-size:10px">{rel(d.created_at)}</span>
              </div>
              <h3 style="margin:2px 0 6px;font-size:15px">{d.title}</h3>
              <div class="muted" style="font-size:13px;margin-bottom:12px">{d.body}</div>
              <div class="wrap">
                <button class="chip small filter-chip on" disabled={!!promoting[d.id]} onClick={() => promote(d)}
                  title="Convertirla en una tarea o un objetivo — se va a Sugerencias con su botón de aplicar">
                  <span class="msr" style={`font-size:14px;${promoting[d.id] ? 'animation:spin 1s linear infinite' : ''}`}>{promoting[d.id] ? 'progress_activity' : 'bolt'}</span>
                  {promoting[d.id] ? `Aterrizando… ${promoting[d.id].seconds}s` : 'Hacerla'}
                </button>
                <button class="chip small" disabled={!!promoting[d.id]} onClick={() => act(d.id, 'saved')}><span class="msr" style="font-size:14px">bookmark</span>Guardar</button>
                <button class="chip small" disabled={!!promoting[d.id]} onClick={() => act(d.id, 'dismissed')}>Descartar</button>
              </div>
            </div>
          );
        })}
      </div>

      {saved.length > 0 && (
        <div style="margin-top:22px">
          <h3 style="margin-bottom:10px"><span class="msr" style="font-size:16px;vertical-align:-3px;color:var(--gold)">bookmark</span> Guardados</h3>
          <div class="list">
            {saved.map((d) => (
              <div class="list-row" key={d.id} style="display:block">
                <div class="row">
                  <span class="msr" style="font-size:15px;color:var(--gold)">{(KIND[d.kind] || KIND.idea).icon}</span>
                  <div class="grow"><div class="title" style="font-size:13px">{d.title}</div><div class="muted" style="font-size:11.5px">{d.body}</div></div>
                </div>
                {/* En qué terminó: sin esto, un sueño aterrizado se veía igual
                    que uno simplemente guardado y el resultado se perdía. */}
                {d.promoted_to && (
                  <div class="row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--hairline)">
                    <span class="msr" style="font-size:14px;color:var(--ok)">bolt</span>
                    {d.suggestion
                      ? <>
                        <span class="muted" style="font-size:11.5px">aterrizada como</span>
                        <a class="chip small" href="#/suggestions">{d.suggestion.title}</a>
                        <span class="chip small">{d.suggestion.status === 'applied' ? '✓ aplicada' : d.suggestion.status === 'dismissed' ? '✕ descartada' : 'esperándote en Sugerencias'}</span>
                      </>
                      : <span class="muted" style="font-size:11.5px">se aterrizó, pero la sugerencia ya no existe (la borraste o vaciaste el inbox)</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
