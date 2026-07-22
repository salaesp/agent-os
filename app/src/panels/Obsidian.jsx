import { useState } from 'preact/hooks';
import { get, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const TIER = { living: 'Tier 2', daily: 'Tier 3', decisions: 'decisiones', mama: 'enfermero' };

export function Obsidian() {
  const { data, error, loading } = useApi('/api/obsidian');
  const [fkey, setFkey] = useState(null);
  const [open, setOpen] = useState(null);
  const [content, setContent] = useState({});

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Obsidian" /><ErrorBox error={error} /></>;
  if (!data?.ok) return <><PageHead title="Obsidian" /><div class="card"><div class="muted">No hay vault de Obsidian configurado.</div></div></>;

  const folders = [];
  if (data.rootFiles.length) folders.push({ key: '_root', label: 'raíz', files: data.rootFiles });
  for (const [name, files] of Object.entries(data.groups)) folders.push({ key: name, label: name, tier: TIER[name], files });
  const cur = folders.find((f) => f.key === fkey) || folders[0];

  const view = async (file) => {
    if (open === file.rel) { setOpen(null); return; }
    setOpen(file.rel);
    if (!content[file.rel]) {
      try { const r = await get(`/api/obsidian/file?path=${encodeURIComponent(file.rel)}`); setContent((m) => ({ ...m, [file.rel]: r.ok ? r.text : '(no se pudo leer)' })); }
      catch { setContent((m) => ({ ...m, [file.rel]: '(error)' })); }
    }
  };

  return (
    <>
      <PageHead title="Obsidian" sub="Memoria extendida del agente (Tier 2/3) — solo lectura" />
      <div class="toolbar">
        {folders.map((f) => (
          <button class={`chip small filter-chip ${(cur?.key) === f.key ? 'on' : ''}`} onClick={() => { setFkey(f.key); setOpen(null); }} key={f.key}>
            {f.label} <span style="opacity:.6">{f.files.length}</span>{f.tier ? <span class="muted" style="margin-left:5px;font-size:10px">{f.tier}</span> : ''}
          </button>
        ))}
      </div>
      <div class="list">
        {cur?.files.length ? cur.files.map((f) => (
          <div key={f.rel}>
            <div class="list-row" style="cursor:pointer" onClick={() => view(f)}>
              <span class="msr" style="font-size:16px;color:var(--gold)">description</span>
              <div class="grow"><span class="title" style="font-size:13px">{f.name}</span></div>
              <span class="muted mono" style="font-size:11px">{fmtBytes(f.bytes)} · {rel(new Date(f.mtime).toISOString())}</span>
              <span class="msr">{open === f.rel ? 'expand_less' : 'expand_more'}</span>
            </div>
            {open === f.rel && (
              <div style="background:var(--panel-2);padding:6px 14px;border-radius:var(--radius-m);margin:2px 0 8px;max-height:360px;overflow:auto">
                {content[f.rel] ? <Markdown text={content[f.rel]} /> : <div class="muted">cargando…</div>}
              </div>
            )}
          </div>
        )) : <div class="muted" style="padding:12px">Carpeta vacía.</div>}
      </div>
      <div class="muted" style="font-size:11px;margin-top:8px">Lo gestiona la promoción de memoria de Hermes. El Agent OS solo lo muestra.</div>
    </>
  );
}
