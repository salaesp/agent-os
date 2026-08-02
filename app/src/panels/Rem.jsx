import { useState } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';

// REM no es un cron de Hermes: es el último paso del bundle nocturno in-process
// (src/scheduler.js), que escribe <vault>/rem/YYYY-MM-DD.md. Este panel reusa
// /api/obsidian (ya agrupa por carpeta) en vez de un endpoint propio de listado.
export function Rem() {
  const { data, error, loading, reload } = useApi('/api/obsidian');
  const { data: settings, reload: reloadCfg } = useApi('/api/settings', 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [open, setOpen] = useState(null);
  const [content, setContent] = useState({});

  if (loading) return <Loading />;
  if (error) return <><PageHead title="REM" /><ErrorBox error={error} /></>;
  if (!data?.ok) return <><PageHead title="REM" /><div class="card"><div class="muted">No hay vault de Obsidian configurado — REM necesita un vault para escribir sus notas.</div></div></>;

  const days = data.groups?.rem || [];
  const autoOn = (settings?.auto_rem_enabled ?? '1') === '1';
  const retention = Number(settings?.rem_retention_days || '90');
  const toggleAuto = async () => {
    await post('/api/settings/set', { key: 'auto_rem_enabled', value: autoOn ? '0' : '1' });
    reloadCfg();
  };
  const setCfg = async (key, value) => { await post('/api/settings/set', { key, value }); reloadCfg(); };

  const runNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await post('/api/rem/run', {}); setMsg(r.ok ? `${r.day} → ${r.rel}${r.degraded ? ' (sin síntesis)' : ''}` : (r.error || 'no se pudo correr')); reload(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const view = async (f) => {
    if (open === f.rel) { setOpen(null); return; }
    setOpen(f.rel);
    if (!content[f.rel]) {
      try { const r = await get(`/api/obsidian/file?path=${encodeURIComponent(f.rel)}`); setContent((m) => ({ ...m, [f.rel]: r.ok ? r.text : '(no se pudo leer)' })); }
      catch { setContent((m) => ({ ...m, [f.rel]: '(error)' })); }
    }
  };

  return (
    <>
      <PageHead title="REM" sub="Consolidación nocturna del día — decisiones, sueños, pendientes">
        <button class="chip filter-chip on" disabled={busy} onClick={runNow} style="padding:8px 16px">
          <span class="msr" style={`font-size:17px;${busy ? 'animation:spin 1s linear infinite' : ''}`}>{busy ? 'progress_activity' : 'nightlight'}</span>
          {busy ? 'Consolidando…' : 'Correr REM ahora'}
        </button>
      </PageHead>

      <div class="card" style="margin-bottom:12px;padding:12px 16px">
        <div class="spread">
          <div class="row" style="font-size:12.5px">
            <span class="msr" style={`color:var(--${autoOn ? 'ok' : 'text-3'})`}>{autoOn ? 'motion_photos_on' : 'motion_photos_off'}</span>
            <b>Automático {autoOn ? 'ON' : 'OFF'}</b>
            <span class="muted">· último paso del bundle nocturno, cierra el día anterior · retención {retention}d</span>
          </div>
          <div class="wrap">
            <button class="chip small" onClick={() => setShowCfg((v) => !v)}>
              <span class="msr" style="font-size:14px">{showCfg ? 'expand_less' : 'tune'}</span>{showCfg ? 'ocultar' : 'ajustar'}
            </button>
            <button class={`chip filter-chip ${autoOn ? 'on' : ''}`} onClick={toggleAuto}>{autoOn ? 'Desactivar' : 'Activar'}</button>
          </div>
        </div>
        {showCfg && (
          <>
            <div class="spread" style="padding:10px 0 0;margin-top:10px;border-top:1px solid var(--hairline)">
              <span class="muted" style="font-size:12px">Retención (decisiones y corridas viejas se purgan)</span>
              <div class="seg">{[30, 60, 90, 180].map((n) => <button class={retention === n ? 'on' : ''} onClick={() => setCfg('rem_retention_days', String(n))} key={n}>{n}d</button>)}</div>
            </div>
            <div class="muted" style="font-size:11px;padding:6px 0 0">La hora la define el bundle nocturno (mismo ajuste que Sugerencias/Dreaming). Las notas de <span class="mono">rem/*.md</span> en el vault no se purgan, solo las filas de decisiones/corridas en la base.</div>
          </>
        )}
      </div>

      {msg && <div class="card" style="margin-bottom:12px"><span class="mono" style="font-size:12px">{msg}</span></div>}

      {days.length === 0 && (
        <div class="card"><div class="muted">Todavía no hay ninguna consolidación. Tocá <b>«Correr REM ahora»</b> o esperá al bundle nocturno.</div></div>
      )}

      <div class="list">
        {days.map((f) => (
          <div key={f.rel}>
            <div class="list-row" style="cursor:pointer" onClick={() => view(f)}>
              <span class="msr" style="font-size:16px;color:var(--gold)">nightlight</span>
              <div class="grow"><span class="title" style="font-size:13px">{f.name}</span></div>
              <span class="muted mono" style="font-size:11px">{rel(new Date(f.mtime).toISOString())}</span>
              <span class="msr">{open === f.rel ? 'expand_less' : 'expand_more'}</span>
            </div>
            {open === f.rel && (
              <div style="background:var(--panel-2);padding:6px 14px;border-radius:var(--radius-m);margin:2px 0 8px;max-height:420px;overflow:auto">
                {content[f.rel] ? <Markdown text={content[f.rel]} /> : <div class="muted">cargando…</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
