import { useState } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, Dot, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';

export function Crons() {
  const { data, error, loading, reload } = useApi('/api/crons', 20000);
  const [open, setOpen] = useState(null);
  const [history, setHistory] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [creating, setCreating] = useState(false);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Crons" /><ErrorBox error={error} /></>;

  const loadHistory = async (c) => {
    const key = `${c.profile}|${c.id}`;
    if (!history[key]) {
      try {
        const h = await get(`/api/crons/history?profile=${encodeURIComponent(c.profile)}&id=${encodeURIComponent(c.id)}`);
        setHistory((m) => ({ ...m, [key]: h }));
      } catch { setHistory((m) => ({ ...m, [key]: [] })); }
    }
  };

  const toggle = (c) => {
    const key = `${c.profile}|${c.id}`;
    if (open === key) { setOpen(null); return; }
    setOpen(key); loadHistory(c);
  };

  const act = async (c, action) => {
    if (action === 'remove' && !confirm(`¿Eliminar el cron "${c.name || c.id}"?`)) return;
    setBusy(`${c.profile}|${c.id}|${action}`); setMsg(null);
    try {
      await post('/api/crons/action', { profile: c.profile, id: c.id, action });
      setMsg({ ok: true, text: `${action} · ${c.name || c.id}` });
      setHistory({}); reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(null); }
  };

  return (
    <>
      <PageHead title="Crons" sub={`${data.length} jobs · ${data.filter((c) => c.enabled).length} habilitados`}>
        <button class="chip" onClick={() => setCreating((v) => !v)}><span class="msr" style="font-size:16px">add</span>Nuevo</button>
      </PageHead>

      {creating && <CreateForm profiles={[...new Set(data.map((c) => c.profile))]} onDone={(m) => { setCreating(false); setMsg(m); setHistory({}); reload(); }} />}
      {msg && <div class="card" style={`margin-bottom:12px;border-color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}><span class="mono" style="font-size:12px">{msg.ok ? '✓ ' : '✕ '}{msg.text}</span></div>}

      <div class="list">
        {data.map((c) => {
          const key = `${c.profile}|${c.id}`;
          const h = history[key];
          const isBusy = (a) => busy === `${key}|${a}`;
          return (
            <div key={key}>
              <div class="list-row" style="cursor:pointer" onClick={() => toggle(c)}>
                <Dot state={c.lastStatus || (c.enabled ? 'scheduled' : 'paused')} />
                <div class="grow">
                  <div class="title">{c.name || '(sin nombre)'} {c.noAgent && <span class="chip small">script</span>} {!c.enabled && <span class="chip small">pausado</span>}</div>
                  <div class="muted" style="font-size:12px">
                    <span class="mono">{c.schedule}</span> · {c.profile}
                    {' · '}<span class="mono">{c.model || 'modelo del perfil'}</span>
                    {c.skills.length > 0 && <> · skills: {c.skills.join(', ')}</>}
                  </div>
                </div>
                <div class="muted" style="font-size:11px;text-align:right">
                  <div>próx: {rel(c.nextRunAt)}</div>
                  <div>últ: {rel(c.lastRunAt)} {c.lastStatus === 'error' && <span style="color:var(--err)">·err</span>}</div>
                </div>
                <span class="msr">{open === key ? 'expand_less' : 'expand_more'}</span>
              </div>
              {open === key && (
                <div class="card" style="margin:2px 0 8px;background:var(--panel-2)">
                  {(c.prompt || c.script) && (
                    <div style="margin-bottom:12px">
                      <div class="lbl muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Qué hace</div>
                      {c.prompt && <div style="font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere">{c.prompt}</div>}
                      <div class="wrap" style={c.prompt ? 'margin-top:8px' : ''}>
                        {c.script && <span class="chip small mono" title="Script previo: su stdout se inyecta en el prompt (o es el job entero en modo script)">script: {c.script}</span>}
                        {c.workdir && <span class="chip small mono" title="Directorio de trabajo">{c.workdir}</span>}
                      </div>
                    </div>
                  )}
                  <CronModel c={c} onDone={(m) => { setMsg(m); if (m?.ok) { setHistory({}); reload(); } }} />
                  <div class="wrap" style="margin-bottom:10px">
                    {c.deliver && <span class="chip small">deliver: {c.deliver}</span>}
                    {c.completed != null && <span class="chip small">{c.completed} corridas</span>}
                  </div>
                  <div class="wrap" style="margin-bottom:12px">
                    <button class="chip" disabled={!!busy} onClick={() => act(c, 'run')}><span class="msr" style="font-size:15px">play_arrow</span>{isBusy('run') ? '…' : 'Ejecutar'}</button>
                    {c.enabled
                      ? <button class="chip" disabled={!!busy} onClick={() => act(c, 'pause')}><span class="msr" style="font-size:15px">pause</span>{isBusy('pause') ? '…' : 'Pausar'}</button>
                      : <button class="chip" disabled={!!busy} onClick={() => act(c, 'resume')}><span class="msr" style="font-size:15px">resume</span>{isBusy('resume') ? '…' : 'Reanudar'}</button>}
                    <button class="chip" disabled={!!busy} style="color:var(--err)" onClick={() => act(c, 'remove')}><span class="msr" style="font-size:15px">delete</span>{isBusy('remove') ? '…' : 'Eliminar'}</button>
                  </div>
                  {c.lastError && <div class="mono" style="color:var(--err);font-size:12px;margin-bottom:8px">{c.lastError}</div>}
                  <div class="lbl muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Historial de corridas</div>
                  {!h ? <div class="muted" style="font-size:12px">cargando…</div> : (
                    h.length === 0 ? <div class="muted" style="font-size:12px">Sin corridas archivadas.</div> :
                    <RunHistory profile={c.profile} id={c.id} runs={h.slice(0, 12)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// Modelo del cron: chip con el modelo efectivo + edición inline (ModelPicker).
// Sin modelo propio, el job hereda el default del perfil.
function CronModel({ c, onDone }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async ({ model, provider }) => {
    setBusy(true);
    try {
      const r = await post('/api/crons/model', { profile: c.profile, id: c.id, model, provider });
      setEditing(false);
      onDone({ ok: true, text: `${c.name || c.id} · ${r.stdout || 'modelo actualizado'}` });
    } catch (e) { onDone({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  return (
    <div style="margin-bottom:10px">
      <div class="wrap">
        <span class="chip small mono">{c.model || 'modelo del perfil'}</span>
        {c.provider && <span class="chip small">{c.provider}</span>}
        {!editing && (
          <button class="chip small" onClick={() => setEditing(true)}>
            <span class="msr" style="font-size:14px">edit</span>modelo
          </button>
        )}
      </div>
      {editing && (
        <div style="margin-top:8px;max-width:520px">
          <ModelPicker model={c.model} provider={c.provider} inherit busy={busy} onSave={save} onCancel={() => setEditing(false)} />
        </div>
      )}
    </div>
  );
}

// Historial de corridas: cada ejecución es un item visual con preview de qué pasó.
function RunHistory({ profile, id, runs }) {
  const [open, setOpen] = useState(null);
  const [out, setOut] = useState({});
  const view = async (file) => {
    if (open === file) { setOpen(null); return; }
    setOpen(file);
    if (!out[file]) {
      try {
        const r = await get(`/api/crons/output?profile=${encodeURIComponent(profile)}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`);
        setOut((m) => ({ ...m, [file]: r.ok ? r : { response: '(no se pudo leer)' } }));
      } catch { setOut((m) => ({ ...m, [file]: { response: '(error)' } })); }
    }
  };
  return (
    <div class="list">
      {runs.map((r) => {
        const o = out[r.file];
        const preview = o ? (o.response || o.scriptOutput || o.raw || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        return (
          <div key={r.file}>
            <div class="list-row" style="cursor:pointer;padding:9px 12px;background:var(--panel-2)" onClick={() => view(r.file)}>
              <span class="msr" style="font-size:16px;color:var(--gold)">history</span>
              <div class="grow">
                <div style="font-size:12.5px;font-weight:500">{r.runAt.replace('_', ' ')}</div>
                {preview && <div class="muted ellipsis" style="font-size:11px">{preview}</div>}
              </div>
              <span class="msr" style="font-size:16px">{open === r.file ? 'expand_less' : 'expand_more'}</span>
            </div>
            {open === r.file && (
              <div style="background:var(--panel);border:1px solid var(--hairline);padding:10px 14px;border-radius:var(--radius-m);margin:2px 0 6px;max-height:340px;overflow:auto">
                {!o ? <div class="muted" style="font-size:12px">cargando…</div>
                  : <Markdown text={o.response || o.raw || '(sin contenido)'} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CreateForm({ profiles, onDone }) {
  const [f, setF] = useState({ profile: profiles[0] || '(default)', schedule: '', name: '', prompt: '', deliver: 'local' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    if (!f.schedule.trim()) { onDone({ ok: false, text: 'schedule requerido (ej: 0 9 * * * o 30m)' }); return; }
    if (!f.prompt.trim()) { onDone({ ok: false, text: 'Hermes exige un prompt (o una skill) además del schedule' }); return; }
    setBusy(true);
    try {
      const r = await post('/api/crons/create', f);
      onDone({ ok: true, text: r.stdout?.split('\n')[0] || 'cron creado' });
    } catch (e) { onDone({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div class="card" style="margin-bottom:14px">
      <h3>Nuevo cron</h3>
      <div style="display:grid;gap:10px;margin-top:12px">
        <div class="row">
          <span class="muted" style="font-size:12px">Perfil:</span>
          <div class="seg">
            {profiles.map((p) => (
              <button class={f.profile === p ? 'on' : ''} onClick={() => setF((s) => ({ ...s, profile: p }))} key={p}>{p}</button>
            ))}
          </div>
        </div>
        <div class="search"><input placeholder="Schedule — 0 9 * * *  ó  30m  ó  every 2h" value={f.schedule} onInput={set('schedule')} /></div>
        <div class="search"><input placeholder="Nombre (opcional)" value={f.name} onInput={set('name')} /></div>
        <div class="search"><input placeholder="Prompt / instrucción (requerido)" value={f.prompt} onInput={set('prompt')} /></div>
        <div class="row">
          <span class="muted" style="font-size:12px">Entrega:</span>
          <div class="seg">
            {['local', 'origin', 'discord', 'slack', 'telegram'].map((d) => (
              <button class={f.deliver === d ? 'on' : ''} onClick={() => setF((s) => ({ ...s, deliver: d }))} key={d}>{d}</button>
            ))}
          </div>
        </div>
        <div class="wrap">
          <button class="chip filter-chip on" disabled={busy} onClick={submit}>{busy ? 'Creando…' : 'Crear cron'}</button>
          <button class="chip" disabled={busy} onClick={() => onDone(null)}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
