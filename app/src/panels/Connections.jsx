import { useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, Dot } from '../components/ui.jsx';
import { personaLabel } from '../persona.js';

export function Connections() {
  const { data, error, loading } = useApi('/api/connections', 15000);
  const secrets = useApi('/api/secrets');
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Conexiones" /><ErrorBox error={error} /></>;

  return (
    <>
      <PageHead title="Conexiones" sub="Gateways, canales, MCP, software y secretos" />
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
        {data.connections.map((c) => (
          <div class="card" key={c.profile}>
            <div class="spread">
              <h3>{personaLabel(c.profile)}</h3>
              <span class="chip small"><Dot state={c.gateway?.state} />{c.gateway?.state || 'sin gateway'}</span>
            </div>
            {c.gateway && (
              <div class="muted" style="font-size:12px;margin-top:2px">
                pid {c.gateway.pid ?? '—'} · {c.gateway.active_agents ?? 0} agentes activos
              </div>
            )}
            {Object.keys(c.gateway?.platforms || {}).length > 0 && (
              <div class="wrap" style="margin-top:10px">
                {Object.entries(c.gateway.platforms).map(([n, st]) => (
                  <span class="chip small" key={n}><Dot state={st} />{n}</span>
                ))}
              </div>
            )}
            {c.mcp.length > 0 && (
              <div style="margin-top:12px">
                <div class="lbl" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-2)">MCP</div>
                {c.mcp.map((s) => (
                  <div class="row" style="margin-top:6px" key={s.name}>
                    <Dot state={s.enabled ? 'ok' : 'paused'} />
                    <span class="grow ellipsis"><b>{s.name}</b> <span class="muted mono">{s.url}</span></span>
                  </div>
                ))}
              </div>
            )}
            {c.channels.length > 0 && (
              <div class="muted" style="font-size:11px;margin-top:12px">{c.channels.length} canales conocidos</div>
            )}
          </div>
        ))}
      </div>

      {secrets.data?.ok && (
        <div class="card" style="margin-top:16px;border-color:var(--gold)">
          <div class="spread" style="margin-bottom:8px">
            <div class="row"><span class="msr" style="color:var(--gold)">lock</span><h3 style="margin:0">Secretos</h3></div>
            <span class="chip small">{secrets.data.count} · solo nombres</span>
          </div>
          <div class="muted" style="font-size:12px;margin-bottom:10px">Bóveda Bitwarden ({secrets.data.source}). Los valores nunca se exponen.</div>
          <div class="wrap">
            {secrets.data.secrets.map((s) => (
              <span class="chip small mono" key={s.id + s.key} title={s.category}>🔑 {s.key}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
