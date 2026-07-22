import { useState, useEffect } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';

export function Memory() {
  const mem = useApi('/api/memory');
  const obs = useApi('/api/obsidian');
  if (mem.loading) return <Loading />;
  if (mem.error) return <><PageHead title="Memoria" /><ErrorBox error={mem.error} /></>;

  return (
    <>
      <PageHead title="Memoria" sub="Tier 1 editable (MEMORY.md · USER.md) + Tier 2/3 en Obsidian" />
      {mem.data.map((m) => <ProfileMemory key={m.profile} m={m} reload={mem.reload} />)}
      {obs.data?.ok && <Obsidian o={obs.data} />}
    </>
  );
}

function ProfileMemory({ m, reload }) {
  const [tab, setTab] = useState('memory');
  const editable = tab !== 'soul';
  const cur = m[tab];
  const [text, setText] = useState(cur.text);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Al cambiar de tab/perfil, resetear el buffer editable.
  useEffect(() => { setText(cur.text); setMsg(null); }, [tab, m.profile]);

  const over = editable && text.length > cur.cap;
  const dirty = editable && text !== cur.text;
  const pct = editable && cur.cap ? Math.min(100, Math.round((text.length / cur.cap) * 100)) : 0;
  const barCls = pct >= 90 || over ? 'err' : pct >= 75 ? 'warn' : '';

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await post('/api/memory/write', { profile: m.profile, which: tab, text });
      setMsg({ ok: true, text: 'Guardado (backup .agentos.bak creado)' });
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div class="card" style="margin-bottom:16px">
      <div class="spread" style="margin-bottom:10px">
        <h3>{m.profile}</h3>
        <div class="seg">
          {[['memory', 'MEMORY'], ['user', 'USER'], ['soul', 'SOUL']].map(([k, l]) => (
            <button class={tab === k ? 'on' : ''} onClick={() => setTab(k)} key={k}>{l}</button>
          ))}
        </div>
      </div>

      {editable && (
        <>
          <div class="spread" style="font-size:12px;margin-bottom:4px">
            <b>{tab === 'memory' ? 'MEMORY.md' : 'USER.md'}</b>
            <span class="muted mono" style={over ? 'color:var(--err)' : ''}>{text.length}/{cur.cap} · {pct}%</span>
          </div>
          <div class="bar" style="margin-bottom:8px"><i class={barCls} style={`width:${Math.min(100, pct)}%`} /></div>
          <textarea value={text} onInput={(e) => setText(e.target.value)}
            style="width:100%;min-height:220px;resize:vertical;font-family:var(--mono);font-size:12px;padding:12px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
          <div class="wrap" style="margin-top:10px;align-items:center">
            <button class="chip filter-chip on" disabled={!dirty || over || busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button>
            {dirty && <button class="chip" disabled={busy} onClick={() => setText(cur.text)}>Descartar</button>}
            <span class="muted" style="font-size:11px">Las entradas se separan con «§». No superes el tope.</span>
            {msg && <span class="mono" style={`font-size:12px;color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}>{msg.ok ? '✓ ' : '✕ '}{msg.text}</span>}
          </div>
        </>
      )}
      {!editable && (
        <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:12px;border-radius:var(--radius-m);margin:0;max-height:340px;overflow:auto">{cur.text || '(vacío)'}</pre>
      )}
    </div>
  );
}

function fmtBytes(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }

function Obsidian({ o }) {
  // Carpetas: "raíz" (rootFiles) + cada grupo. Etiquetas Tier según nombre conocido.
  const folders = [];
  if (o.rootFiles.length) folders.push({ key: '_root', label: 'raíz', files: o.rootFiles });
  const TIER = { living: 'Tier 2', daily: 'Tier 3', decisions: 'decisiones', mama: 'enfermero' };
  for (const [name, files] of Object.entries(o.groups)) folders.push({ key: name, label: name, tier: TIER[name], files });

  const [fkey, setFkey] = useState(folders[0]?.key);
  const [open, setOpen] = useState(null);
  const [content, setContent] = useState({});

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
    <div class="card" style="margin-top:22px">
      <div class="spread">
        <h3><span class="msr" style="font-size:18px;vertical-align:-3px;color:var(--gold)">database</span> Obsidian — memoria extendida (solo lectura)</h3>
        <span class="chip small mono">{o.path}</span>
      </div>
      <div class="toolbar" style="margin-top:12px">
        {folders.map((f) => (
          <button class={`chip small filter-chip ${fkey === f.key ? 'on' : ''}`} onClick={() => { setFkey(f.key); setOpen(null); }} key={f.key}>
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
      <div class="muted" style="font-size:11px;margin-top:8px">Lo gestiona la promoción de memoria de Hermes (persistent-knowledge). El Agent OS solo lo muestra.</div>
    </div>
  );
}
