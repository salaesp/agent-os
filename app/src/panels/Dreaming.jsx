import { useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';

const KIND = {
  idea: { icon: 'lightbulb', label: 'idea' },
  patron: { icon: 'insights', label: 'patrón' },
  conexion: { icon: 'hub', label: 'conexión' },
  pregunta: { icon: 'help', label: 'pregunta' },
};

export function Dreaming() {
  const { data, error, loading, reload } = useApi('/api/dreams', 60000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Dreaming" /><ErrorBox error={error} /></>;

  const dream = async () => {
    setBusy(true); setMsg(null);
    try { const r = await post('/api/dreams/generate', {}); setMsg(r.created ? `${r.created} ideas nuevas` : 'sin ideas nuevas esta vez'); reload(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const act = async (id, status) => { await post('/api/dreams/action', { id, status }); reload(); };

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
      {busy && <div class="card" style="margin-bottom:12px"><div class="muted">El agente está pensando en tu vida — patrones, conexiones, ideas de mayor vuelo. Puede tardar un rato…</div></div>}
      {msg && <div class="card" style="margin-bottom:12px"><span class="mono" style="font-size:12px">{msg}</span></div>}

      {active.length === 0 && !busy && (
        <div class="card"><div class="muted">Todavía no hay sueños. Tocá <b>«Soñar ahora»</b> y el agente te va a tirar ideas y patrones sobre tu vida a partir de tus conversaciones, memoria y objetivos. También sueña solo de noche.</div></div>
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
                <button class="chip small filter-chip on" onClick={() => act(d.id, 'saved')}><span class="msr" style="font-size:14px">bookmark</span>Guardar</button>
                <button class="chip small" onClick={() => act(d.id, 'dismissed')}>Descartar</button>
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
              <div class="list-row" key={d.id}>
                <span class="msr" style="font-size:15px;color:var(--gold)">{(KIND[d.kind] || KIND.idea).icon}</span>
                <div class="grow"><div class="title" style="font-size:13px">{d.title}</div><div class="muted" style="font-size:11.5px">{d.body}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
