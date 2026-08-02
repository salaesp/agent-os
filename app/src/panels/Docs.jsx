import { useState, useEffect } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { routeParam } from '../route.js';

const ICON = { html: 'code', markdown: 'article', text: 'description', data: 'data_object', image: 'image', pdf: 'picture_as_pdf', audio: 'headphones', other: 'draft' };
const TYPES = ['todos', 'html', 'markdown', 'text', 'data', 'image', 'pdf', 'audio', 'other'];
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function Docs() {
  const { data, error, loading, reload } = useApi('/api/docs', 8000);
  const ttsAvailable = data?.ttsAvailable;
  const [type, setType] = useState('todos');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [autoDone, setAutoDone] = useState(false);

  // Deep-link desde el buscador: #/docs?doc=<path>
  useEffect(() => {
    if (autoDone) return;
    const dp = routeParam('doc');
    if (dp && data?.docs?.length) {
      const d = data.docs.find((x) => x.path === dp);
      if (d) { setOpen(d); setAutoDone(true); }
    }
  }, [data, autoDone]);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Documentos" /><ErrorBox error={error} /></>;

  let docs = data.docs;
  if (type !== 'todos') docs = docs.filter((d) => d.type === type);
  if (q) { const t = q.toLowerCase(); docs = docs.filter((d) => d.name.toLowerCase().includes(t) || (d.preview || '').toLowerCase().includes(t)); }

  const del = async (d, e) => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar "${d.name}"?`)) return;
    await post('/api/docs/delete', { path: d.path });
    reload();
  };

  return (
    <>
      <PageHead title="Documentos" sub={`${data.docs.length} archivos · ${data.path}`} />
      <div class="toolbar">
        {TYPES.map((t) => <button class={`chip small filter-chip ${type === t ? 'on' : ''}`} onClick={() => setType(t)} key={t}>{t}</button>)}
        <div class="search"><input placeholder="Buscar…" value={q} onInput={(e) => setQ(e.target.value)} /></div>
      </div>

      {docs.length === 0 ? (
        <div class="card"><div class="muted">No hay documentos{type !== 'todos' ? ` de tipo ${type}` : ''}. Guardá archivos en <span class="mono">{data.path}</span> y aparecen acá al instante.</div></div>
      ) : (
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
          {docs.map((d) => (
            <div class="card" key={d.path} style="cursor:pointer;display:flex;flex-direction:column;gap:8px" onClick={() => setOpen(d)}>
              <div class="spread">
                <span class="msr" style="color:var(--gold)">{ICON[d.type] || 'draft'}</span>
                <button class="chip small" style="color:var(--err)" onClick={(e) => del(d, e)}><span class="msr" style="font-size:14px">delete</span></button>
              </div>
              <div>
                <div class="title ellipsis" style="font-size:13px">{d.name}</div>
                <div class="muted" style="font-size:11px">{d.type} · {fmtSize(d.size)} · {rel(new Date(d.mtime).toISOString())}</div>
              </div>
              {d.type === 'image'
                ? <img src={`/api/docs/raw?path=${encodeURIComponent(d.path)}`} style="width:100%;height:90px;object-fit:cover;border-radius:8px" />
                : <div class="muted" style="font-size:11.5px;max-height:56px;overflow:hidden">{d.preview || <i>sin preview</i>}</div>}
            </div>
          ))}
        </div>
      )}

      {open && <Viewer doc={open} docs={data.docs} ttsAvailable={ttsAvailable} onClose={() => setOpen(null)} onReload={reload} />}
    </>
  );
}

const audioPathFor = (path) => path.replace(/\.(md|markdown|txt)$/i, '') + '.mp3';

function Viewer({ doc, docs, ttsAvailable, onClose, onReload }) {
  const [content, setContent] = useState(null);
  const [genState, setGenState] = useState('idle'); // idle | busy | error
  const isText = ['markdown', 'text', 'data', 'html'].includes(doc.type);
  if (isText && content === null) {
    get(`/api/docs/read?path=${encodeURIComponent(doc.path)}`).then((r) => setContent(r.ok ? r.content : `(no se pudo leer: ${r.error})`)).catch(() => setContent('(error)'));
  }
  const canNarrate = ['markdown', 'text'].includes(doc.type);
  const audioDoc = canNarrate ? docs.find((d) => d.path === audioPathFor(doc.path)) : null;

  const generateAudio = async () => {
    setGenState('busy');
    const r = await post('/api/docs/tts', { path: doc.path });
    if (r.ok) { setGenState('idle'); onReload(); } else { setGenState('error'); }
  };

  return (
    <div onClick={onClose} style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:grid;place-items:center;padding:24px">
      <div onClick={(e) => e.stopPropagation()} class="card" style="max-width:900px;width:100%;max-height:86vh;overflow:auto;box-shadow:var(--shadow)">
        <div class="spread" style="margin-bottom:12px;position:sticky;top:0">
          <div><h3>{doc.name}</h3><span class="muted mono" style="font-size:11px">{doc.path}</span></div>
          <button class="chip" onClick={onClose}><span class="msr" style="font-size:16px">close</span></button>
        </div>
        {canNarrate && ttsAvailable && (
          <div style="margin-bottom:12px">
            {audioDoc ? (
              <audio controls style="width:100%" src={`/api/docs/raw?path=${encodeURIComponent(audioDoc.path)}`} />
            ) : (
              <button class="chip small" disabled={genState === 'busy'} onClick={generateAudio}>
                <span class="msr" style="font-size:14px">headphones</span>
                {genState === 'busy' ? 'Generando audio…' : 'Generar audio'}
              </button>
            )}
            {genState === 'error' && <div class="muted" style="color:var(--err);font-size:11.5px;margin-top:4px">No se pudo generar el audio.</div>}
          </div>
        )}
        {doc.type === 'image' && <img src={`/api/docs/raw?path=${encodeURIComponent(doc.path)}`} style="max-width:100%;border-radius:var(--radius-m)" />}
        {doc.type === 'pdf' && <embed src={`/api/docs/raw?path=${encodeURIComponent(doc.path)}`} type="application/pdf" style="width:100%;height:70vh;border-radius:var(--radius-m)" />}
        {doc.type === 'audio' && <audio controls style="width:100%" src={`/api/docs/raw?path=${encodeURIComponent(doc.path)}`} />}
        {doc.type === 'html' && content != null && <iframe srcDoc={content} sandbox="" style="width:100%;height:65vh;border:1px solid var(--hairline);border-radius:var(--radius-m);background:#fff" />}
        {doc.type === 'markdown' && content != null && <Markdown text={content} />}
        {(doc.type === 'text' || doc.type === 'data') && content != null && <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:14px;border-radius:var(--radius-m)">{content}</pre>}
        {isText && content === null && <div class="muted">cargando…</div>}
        {doc.type === 'other' && <div class="muted">Sin visor para este tipo. <a href={`/api/docs/raw?path=${encodeURIComponent(doc.path)}`} target="_blank" rel="noreferrer">Descargar</a></div>}
      </div>
    </div>
  );
}
