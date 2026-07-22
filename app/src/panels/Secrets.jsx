import { useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

export function Secrets() {
  const { data, error, loading } = useApi('/api/secrets');
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Secretos" /><ErrorBox error={error} /></>;

  if (!data.ok) {
    return <><PageHead title="Secretos" sub="Bitwarden Secrets Manager" /><div class="card"><div class="muted">No se pudo leer la bóveda: {data.error}. Configurá <span class="mono">BWS_ACCESS_TOKEN</span>.</div></div></>;
  }

  const groups = {};
  for (const s of data.secrets) (groups[s.category] = groups[s.category] || []).push(s);

  return (
    <>
      <PageHead title="Secretos" sub={`${data.count} secretos · fuente: ${data.source} · los valores nunca se exponen`} />
      <div class="card" style="margin-bottom:14px;border-color:var(--gold)">
        <div class="row"><span class="msr" style="color:var(--gold)">lock</span><b>Solo nombres.</b><span class="muted">El Agent OS lee las claves de la bóveda pero nunca sus valores.</span></div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
        {Object.entries(groups).map(([cat, items]) => (
          <div class="card" key={cat}>
            <div class="spread" style="margin-bottom:8px"><h3>{cat}</h3><span class="chip small">{items.length}</span></div>
            <div class="list">
              {items.map((s) => (
                <div class="list-row" style="padding:9px 12px" key={s.id + s.key}>
                  <span class="msr" style="font-size:15px;color:var(--text-3)">key</span>
                  <div class="grow"><span class="mono" style="font-size:12.5px">{s.key}</span></div>
                  <span class="mono muted" style="font-size:10px">••••••</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
