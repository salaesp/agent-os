import { useState, useEffect } from 'preact/hooks';
import { get } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

export function CodeGraph() {
  const [projects, setProjects] = useState(null);
  const [sel, setSel] = useState(null);
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    get('/api/codegraph/projects').then((r) => {
      setProjects(r.projects);
      const def = r.projects.find((p) => p.name === 'agent-os') || r.projects[0];
      if (def) setSel(def.path);
    }).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!sel) return;
    setLoading(true); setGraph(null); setErr(null);
    get(`/api/codegraph?path=${encodeURIComponent(sel)}`)
      .then((g) => g.ok ? setGraph(g) : setErr(g.error))
      .catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [sel]);

  if (!projects) return <Loading />;

  return (
    <>
      <PageHead title="Code Graph" sub="Grafo de dependencias (imports) de tus proyectos">
        <div class="seg" style="flex-wrap:wrap;max-width:60vw">
          {projects.map((p) => <button class={sel === p.path ? 'on' : ''} onClick={() => setSel(p.path)} key={p.path}>{p.name}</button>)}
        </div>
      </PageHead>

      {err && <ErrorBox error={err} />}
      {loading && <Loading />}
      {graph && <Graph g={graph} />}
    </>
  );
}

function Graph({ g }) {
  // Subconjunto visual: top nodos por grado (imports+importedBy) para legibilidad.
  const withDeg = g.nodes.map((n) => ({ ...n, deg: n.imports + n.importedBy }));
  const top = withDeg.sort((a, b) => b.deg - a.deg).slice(0, 60).filter((n) => n.deg > 0);
  const ids = new Set(top.map((n) => n.id));
  const edges = g.edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  const N = top.length;
  const CX = 400, CY = 400, R = 330;
  const pos = {};
  top.forEach((n, i) => {
    const a = (i / N) * 2 * Math.PI - Math.PI / 2;
    pos[n.id] = { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a), a };
  });
  const maxImp = Math.max(...top.map((n) => n.importedBy), 1);
  const rOf = (n) => 3 + (n.importedBy / maxImp) * 11;

  return (
    <>
      <div class="grid" style="margin-bottom:14px">
        <div class="card stat"><span class="num">{g.files}</span><span class="lbl">Archivos</span></div>
        <div class="card stat"><span class="num">{g.edgeCount}</span><span class="lbl">Dependencias</span></div>
        <div class="card stat"><span class="num">{g.hubs.length}</span><span class="lbl">Hubs (más importados)</span></div>
      </div>

      <div class="card" style="padding:8px;overflow:auto">
        <svg viewBox="0 0 800 800" style="width:100%;max-width:720px;margin:auto;display:block;aspect-ratio:1">
          {edges.map((e, i) => {
            const a = pos[e.from], b = pos[e.to];
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--accent)" stroke-width="0.6" opacity="0.22" />;
          })}
          {top.map((n) => {
            const p = pos[n.id];
            const hub = n.importedBy >= maxImp * 0.5 && n.importedBy > 1;
            const label = n.id.split('/').pop();
            const flip = p.x < CX;
            return (
              <g key={n.id}>
                <circle cx={p.x} cy={p.y} r={rOf(n)} fill={hub ? 'var(--gold)' : 'var(--accent)'} opacity={hub ? 1 : 0.75}>
                  <title>{n.id} · importado {n.importedBy}× · importa {n.imports}</title>
                </circle>
                <text x={p.x + (flip ? -1 : 1) * (rOf(n) + 3)} y={p.y + 3}
                  text-anchor={flip ? 'end' : 'start'} font-size="9"
                  fill={hub ? 'var(--gold)' : 'var(--text-2)'}
                  transform={`rotate(${(p.a * 180 / Math.PI) + (flip ? 180 : 0)}, ${p.x + (flip ? -1 : 1) * (rOf(n) + 3)}, ${p.y})`}>{label}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <div class="card" style="margin-top:14px">
        <h3>Hubs — archivos más importados</h3>
        <div class="list" style="margin-top:10px;background:transparent;border:none;gap:6px">
          {g.hubs.map((h) => (
            <div key={h.id} class="spread" style="font-size:12.5px"><span class="mono ellipsis">{h.id}</span><span class="chip small">importado {h.importedBy}×</span></div>
          ))}
        </div>
      </div>

      <div class="card" style="margin-top:14px;border-color:var(--gold)">
        <div class="muted" style="font-size:12.5px">
          <b>Nota:</b> esta es la <b>vista visual</b> del code graph (grafo de dependencias real de tu repo).
          La parte del video de <b>reducir tokens del agente</b> en repos grandes requiere clonar e integrar su
          repo <span class="mono">graph</span> específico — pasame el link y lo conecto a Claude Code/Hermes.
        </div>
      </div>
    </>
  );
}
