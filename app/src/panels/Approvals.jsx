import { useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

export function Approvals() {
  const { data, error, loading } = useApi('/api/approvals', 15000);
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Aprobaciones" /><ErrorBox error={error} /></>;

  return (
    <>
      <PageHead title="Aprobaciones" sub="Cola HITL — acciones que el agente deja pendientes de tu OK" />
      {data.available ? (
        data.pending?.length ? (
          <div class="list">
            {data.pending.map((p, i) => (
              <div class="list-row" key={i}>
                <div class="grow"><div class="title">{p.title || p.action || 'acción'}</div><div class="muted" style="font-size:12px">{p.detail}</div></div>
                <div class="wrap"><button class="chip filter-chip on">Aprobar</button><button class="chip" style="color:var(--err)">Rechazar</button></div>
              </div>
            ))}
          </div>
        ) : (
          <div class="card"><div class="row"><span class="msr" style="color:var(--ok)">check_circle</span><b>Sin aprobaciones pendientes.</b><span class="muted">{data.note}</span></div></div>
        )
      ) : (
        <div class="card" style="border-color:var(--warn)">
          <div class="row" style="margin-bottom:10px"><span class="msr" style="color:var(--warn)">info</span><b>La cola HITL necesita el gateway API de Hermes</b></div>
          <div class="muted" style="font-size:13px;margin-bottom:12px">
            Motivo: {data.reason}. Hermes maneja las aprobaciones de forma inline (TTY/gateway), no como cola persistente.
            Para verlas y responderlas desde acá hay que habilitar el gateway API (<span class="mono">:8642</span>).
          </div>
          <div class="lbl muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Cómo habilitarlo</div>
          <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:12px;border-radius:var(--radius-m);margin:0">{`# 1) Definir una API key en ~/.hermes/.env
echo "API_SERVER_KEY=$(openssl rand -hex 24)" >> ~/.hermes/.env

# 2) Reiniciar el gateway (parpadea la conexión de Discord/Slack un instante)
systemctl --user restart hermes-gateway.service

# 3) Pasarle la key al Agent OS (en ~/.config/agent-os/env)
#    API_SERVER_KEY=<la misma de arriba>
systemctl --user restart agent-os.service`}</pre>
        </div>
      )}
    </>
  );
}
