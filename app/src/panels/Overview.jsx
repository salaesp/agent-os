import { post, useApi } from '../api.js';
import { PageHead, Loading } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { go } from '../route.js';

const CAT = { workflow: { icon: 'work', label: 'Workflow' }, vida: { icon: 'favorite', label: 'Vida' }, aprendizaje: { icon: 'school', label: 'Aprendizaje' } };

export function Overview() {
  const sugg = useApi('/api/suggestions', 20000);
  const dreaming = useApi('/api/dreaming', 60000);
  if (sugg.loading) return <Loading />;

  const pending = (sugg.data?.suggestions || []).filter((s) => s.status === 'new' && s.action_type !== 'profile').slice(0, 5);
  const brief = dreaming.data?.briefs?.find((b) => /digest|brief|resumen/i.test(b.name)) || dreaming.data?.briefs?.[0];

  const act = async (id, kind) => { await post(`/api/suggestions/${kind}`, { id }); sugg.reload(); };

  return (
    <>
      <PageHead title="Inicio" sub="Lo que requiere tu atención hoy" />

      <div class="spread" style="margin-bottom:10px">
        <h3><span class="msr" style="font-size:18px;vertical-align:-3px;color:var(--gold)">lightbulb</span> Sugerencias pendientes <span class="chip small">{pending.length}</span></h3>
        <a href="#/suggestions" class="chip small">ver todas</a>
      </div>
      {pending.length === 0 ? (
        <div class="card"><div class="muted">Nada pendiente. El agente te va a proponer cosas solo, o entrá a <a href="#/suggestions">Sugerencias</a> y tocá "Pensá algo para mí".</div></div>
      ) : (
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));align-items:start">
          {pending.map((s) => {
            const cat = CAT[s.category] || CAT.workflow;
            return (
              <div class="card" key={s.id}>
                <div class="spread" style="margin-bottom:4px">
                  <span class="chip small"><span class="msr" style="font-size:13px;color:var(--gold)">{cat.icon}</span>{cat.label}</span>
                  <span class="chip small">{s.score}</span>
                </div>
                <div class="title" style="font-size:13.5px;margin-bottom:4px">{s.title}</div>
                <div class="muted" style="font-size:12px;margin-bottom:10px">{s.rationale}</div>
                <div class="wrap">
                  {s.action_type !== 'none' && <button class="chip small filter-chip on" onClick={() => act(s.id, 'apply')}>Aplicar</button>}
                  <button class="chip small" onClick={() => go('suggestions')}>Ver</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h3 style="margin:22px 0 10px"><span class="msr" style="font-size:18px;vertical-align:-3px;color:var(--gold)">wb_twilight</span> Brief del día</h3>
      <div class="card">
        {dreaming.loading ? <div class="muted">cargando…</div>
          : brief ? <Markdown text={brief.response || '(sin contenido)'} />
          : <div class="muted">Todavía no hay brief. Se genera con el cron <b>daily-digest</b> a la mañana.</div>}
      </div>
    </>
  );
}
