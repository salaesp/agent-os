import { useEffect, useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, Dot, rel } from '../components/ui.jsx';

const ORDER = ['triage', 'todo', 'backlog', 'ready', 'running', 'blocked', 'done', 'archived'];
const sortStatus = (a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
};

export function Kanban() {
  const { data, error, loading, reload } = useApi('/api/kanban', 20000);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [board, setBoard] = useState('todos');
  const [hideArchived, setHideArchived] = useState(true);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Kanban" /><ErrorBox error={error} /></>;

  const boards = data.boards || ['default'];
  let tasks = data.tasks;
  if (board !== 'todos') tasks = tasks.filter((t) => t.board === board);
  if (hideArchived) tasks = tasks.filter((t) => t.status !== 'archived');

  const statuses = [...new Set(tasks.map((t) => t.status || 'sin estado'))].sort(sortStatus);
  const byStatus = Object.fromEntries(statuses.map((s) => [s, tasks.filter((t) => (t.status || 'sin estado') === s)]));

  const mutate = async (path, body, okText) => {
    setBusy(true); setMsg(null);
    try { await post(path, body); setMsg({ ok: true, text: okText }); reload(); return true; }
    catch (e) { setMsg({ ok: false, text: e.message }); return false; }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Kanban" sub={`${data.total} tareas · ${boards.length} boards · ${data.projects.length} proyectos`}>
        <button class="chip" onClick={() => setCreating((v) => !v)}><span class="msr" style="font-size:16px">add</span>Nueva tarea</button>
      </PageHead>

      {creating && <TaskForm boards={boards} onDone={(m) => { setCreating(false); setMsg(m); reload(); }} />}
      {msg && <div class="card" style={`margin-bottom:12px;border-color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}><span class="mono" style="font-size:12px">{msg.ok ? '✓ ' : '✕ '}{msg.text}</span></div>}

      <div class="toolbar">
        <button class={`chip small filter-chip ${board === 'todos' ? 'on' : ''}`} onClick={() => setBoard('todos')}>todos</button>
        {boards.map((b) => <button class={`chip small filter-chip ${board === b ? 'on' : ''}`} onClick={() => setBoard(b)} key={b}>{b}</button>)}
        <div style="flex:1" />
        <label class="row" style="font-size:12px;cursor:pointer"><input type="checkbox" checked={hideArchived} onChange={(e) => setHideArchived(e.target.checked)} /> ocultar archivadas</label>
      </div>

      {open && <TaskModal task={open} busy={busy} mutate={mutate} onClose={() => setOpen(null)} />}

      {tasks.length === 0 ? <div class="muted">Sin tareas.</div> : (
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));align-items:start">
          {statuses.map((s) => (
            <div class="card" key={s} style="padding:14px">
              <div class="spread" style="margin-bottom:10px">
                <div class="row"><Dot state={s} /><b>{s}</b></div>
                <span class="chip small">{byStatus[s].length}</span>
              </div>
              <div class="list">
                {byStatus[s].map((t) => (
                  <div class="list-row" key={t.id} style="background:var(--panel-2);padding:10px 12px;cursor:pointer" onClick={() => setOpen(t)}>
                    <div class="grow">
                      <div class="title ellipsis" style="font-size:13px">{t.title || t.id}</div>
                      <div class="muted" style="font-size:11px">
                        {board === 'todos' && <span class="mono">{t.board}</span>} {t.assignee ? `· ${t.assignee}` : ''} · {rel(t.completedAt || t.createdAt)}
                      </div>
                    </div>
                    <span class="msr" style="font-size:16px">chevron_right</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- Detalle de una tarea -------------------------------------------------
// Todo el payload lo arma Hermes (`kanban show --json`): task, comments, events,
// runs y links. Las acciones viven ACÁ adentro, no en la lista.
const EVENT_ES = {
  created: 'creada', linked: 'vinculada', claimed: 'tomada', spawned: 'worker lanzado',
  heartbeat: 'latido', commented: 'comentada', blocked: 'bloqueada', unblocked: 'desbloqueada',
  completed: 'completada', archived: 'archivada', promoted: 'promovida', assigned: 'asignada',
  decomposed: 'descompuesta', block_loop_detected: 'loop de bloqueo detectado', respawn_guarded: 'respawn frenado',
};
const RUN_STATE = { done: 'ok', running: 'run', blocked: 'warn', crashed: 'err', timed_out: 'err', failed: 'err', released: '' };

function Field({ label, children }) {
  return (
    <div style="margin-top:14px">
      <div class="lbl" style="font-size:10px;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">{label}</div>
      {children}
    </div>
  );
}

function TaskModal({ task, busy, mutate, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('detalle');
  const [log, setLog] = useState(null);
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState('');
  const [n, setN] = useState(0);

  const req = { profile: '(default)', board: task.board, id: task.id };
  useEffect(() => {
    let alive = true;
    setErr(null);
    post('/api/kanban/show', req)
      .then((r) => alive && setD(r))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [task.id, task.board, n]);

  const refresh = () => setN((x) => x + 1);
  const act = async (a) => {
    if (a === 'archive' && !confirm(`¿Archivar "${task.title || task.id}"?`)) return;
    if (await mutate('/api/kanban/action', { ...req, action: a }, `${a} · ${task.title || task.id}`)) {
      if (a === 'archive') onClose(); else refresh();
    }
  };
  const sendComment = async () => {
    if (!draft.trim()) return;
    if (await mutate('/api/kanban/comment', { ...req, text: draft }, 'comentario agregado')) {
      setDraft(''); setCommenting(false); refresh();
    }
  };
  const loadLog = async () => {
    setLog('cargando…');
    try { const r = await post('/api/kanban/log', { ...req, tail: 400 }); setLog(r.text || '(vacío)'); }
    catch (e) { setLog(`(sin log para esta tarea: ${e.message})`); }
  };

  const t = d?.task || task;
  const runs = d?.runs || [];
  const comments = d?.comments || [];
  const events = d?.events || [];
  const TABS = [
    ['detalle', 'description', null],
    ['ejecuciones', 'play_circle', runs.length],
    ['comentarios', 'comment', comments.length],
    ['historial', 'history', events.length],
  ];

  return (
    <div onClick={onClose} style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:grid;place-items:center;padding:24px">
      <div onClick={(e) => e.stopPropagation()} class="card" style="max-width:900px;width:100%;max-height:86vh;overflow:auto;box-shadow:var(--shadow)">
        <div class="spread" style="margin-bottom:10px">
          <div style="min-width:0">
            <h3 style="margin-bottom:4px">{t.title || t.id}</h3>
            <div class="wrap">
              <span class="chip small"><Dot state={t.status} />{t.status || 'sin estado'}</span>
              <span class="chip small mono">{task.board}</span>
              <span class="chip small mono">{t.id}</span>
              {t.assignee && <span class="chip small">{t.assignee}</span>}
              {t.priority != null && <span class="chip small">P{t.priority}</span>}
            </div>
          </div>
          <button class="chip" onClick={onClose}><span class="msr" style="font-size:16px">close</span></button>
        </div>

        <div class="wrap" style="padding-bottom:10px;border-bottom:1px solid var(--hairline)">
          {t.status !== 'done' && <button class="chip small" disabled={busy} onClick={() => act('complete')}><span class="msr" style="font-size:14px">check</span>Completar</button>}
          {t.status !== 'blocked'
            ? <button class="chip small" disabled={busy} onClick={() => act('block')}><span class="msr" style="font-size:14px">block</span>Bloquear</button>
            : <button class="chip small" disabled={busy} onClick={() => act('unblock')}><span class="msr" style="font-size:14px">lock_open</span>Desbloquear</button>}
          <button class="chip small" disabled={busy} onClick={() => setCommenting((v) => !v)}><span class="msr" style="font-size:14px">comment</span>Comentar</button>
          <button class="chip small" disabled={busy} style="color:var(--err)" onClick={() => act('archive')}><span class="msr" style="font-size:14px">archive</span>Archivar</button>
        </div>

        {commenting && (
          <div style="margin-top:12px">
            <textarea value={draft} onInput={(e) => setDraft(e.target.value)} placeholder="Escribí un comentario para la tarea…"
              style="width:100%;min-height:70px;resize:vertical;font-size:12.5px;padding:10px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
            <div class="wrap" style="margin-top:6px">
              <button class="chip small filter-chip on" disabled={busy || !draft.trim()} onClick={sendComment}>Comentar</button>
              <button class="chip small" disabled={busy} onClick={() => { setCommenting(false); setDraft(''); }}>Cancelar</button>
            </div>
          </div>
        )}

        {err && <div class="card" style="margin-top:12px;border-color:var(--err)"><span class="mono" style="font-size:12px">✕ {err}</span></div>}
        {!d && !err && <div class="muted" style="margin-top:14px">cargando detalle…</div>}

        {d && (
          <>
            <div class="toolbar" style="margin-top:12px">
              {TABS.map(([k, icon, count]) => (
                <button class={`chip small filter-chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)} key={k}>
                  <span class="msr" style="font-size:14px">{icon}</span>{k}{count ? ` ${count}` : ''}
                </button>
              ))}
            </div>

            {tab === 'detalle' && (
              <div>
                <Field label="Descripción">
                  {t.body
                    ? <div style="font-size:13px;white-space:pre-wrap">{t.body}</div>
                    : <div class="muted" style="font-size:12.5px">(sin descripción)</div>}
                </Field>
                {d.latest_summary && <Field label="Último resumen"><div style="font-size:12.5px;white-space:pre-wrap">{d.latest_summary}</div></Field>}
                {t.result && <Field label="Resultado"><div style="font-size:12.5px;white-space:pre-wrap">{t.result}</div></Field>}
                {t.last_failure_error && (
                  <Field label={`Último error${t.consecutive_failures ? ` (${t.consecutive_failures} fallos seguidos)` : ''}`}>
                    <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11.5px;background:var(--panel-2);padding:12px;border-radius:var(--radius-m);color:var(--err)">{t.last_failure_error}</pre>
                  </Field>
                )}
                <Field label="Datos">
                  <div class="wrap" style="font-size:11.5px">
                    <span class="chip small">creada {rel(t.created_at)}</span>
                    {t.started_at && <span class="chip small">arrancó {rel(t.started_at)}</span>}
                    {t.completed_at && <span class="chip small">terminó {rel(t.completed_at)}</span>}
                    {t.skills && <span class="chip small mono">skills: {t.skills}</span>}
                    {t.workspace_path && <span class="chip small mono ellipsis" style="max-width:100%">{t.workspace_path}</span>}
                  </div>
                </Field>
                {(d.parents?.length > 0 || d.children?.length > 0) && (
                  <Field label="Vínculos">
                    <div class="wrap" style="font-size:11.5px">
                      {(d.parents || []).map((p) => <span class="chip small mono" key={p}>↑ {p}</span>)}
                      {(d.children || []).map((c) => <span class="chip small mono" key={c}>↓ {c}</span>)}
                    </div>
                  </Field>
                )}
              </div>
            )}

            {tab === 'ejecuciones' && (
              <div style="margin-top:12px">
                {runs.length === 0 ? <div class="muted" style="font-size:12.5px">Esta tarea todavía no se ejecutó.</div> : (
                  <div class="list">
                    {runs.map((r) => {
                      const meta = typeof r.metadata === 'string' ? safeJson(r.metadata) : (r.metadata || {});
                      return (
                        <div class="list-row" key={r.id} style="display:block;background:var(--panel-2);padding:12px">
                          <div class="spread" style="margin-bottom:6px">
                            <div class="wrap">
                              <span class="chip small"><Dot state={RUN_STATE[r.status] || ''} />{r.status}{r.outcome && r.outcome !== r.status ? ` · ${r.outcome}` : ''}</span>
                              {r.profile && <span class="chip small mono">{r.profile}</span>}
                              {r.step_key && <span class="chip small">{r.step_key}</span>}
                            </div>
                            <span class="muted" style="font-size:11px">{rel(r.ended_at || r.started_at)}</span>
                          </div>
                          {r.summary && <div style="font-size:12.5px;white-space:pre-wrap;margin-bottom:6px">{r.summary}</div>}
                          {r.error && <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11px;color:var(--err);margin-bottom:6px">{String(r.error).slice(0, 800)}</pre>}
                          <div class="wrap" style="font-size:11px">
                            {meta.pr_url && <a class="chip small" href={meta.pr_url} target="_blank" rel="noreferrer"><span class="msr" style="font-size:13px">merge</span>PR #{meta.pr_number || ''}</a>}
                            {meta.branch && <span class="chip small mono">{meta.branch}</span>}
                            {meta.commit && <span class="chip small mono">{String(meta.commit).slice(0, 8)}</span>}
                            {meta.tests_run != null && <span class="chip small">tests {meta.tests_passed ?? '?'}/{meta.tests_run}</span>}
                            {Array.isArray(meta.changed_files) && meta.changed_files.length > 0 && <span class="chip small">{meta.changed_files.length} archivos</span>}
                            {meta.worker_session_id && <span class="chip small mono" title="sesión del worker">{meta.worker_session_id}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style="margin-top:12px">
                  <button class="chip small" onClick={loadLog}><span class="msr" style="font-size:14px">terminal</span>Ver log del worker</button>
                  <div class="muted" style="font-size:11px;margin-top:4px">Los logs son efímeros — muchas tareas ya no lo tienen.</div>
                  {log && <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11px;background:var(--panel-2);padding:12px;border-radius:var(--radius-m);margin-top:8px;max-height:40vh;overflow:auto">{log}</pre>}
                </div>
              </div>
            )}

            {tab === 'comentarios' && (
              <div style="margin-top:12px">
                {comments.length === 0 ? <div class="muted" style="font-size:12.5px">Sin comentarios.</div> : (
                  <div class="list">
                    {comments.map((c) => (
                      <div class="list-row" key={c.id} style="display:block;background:var(--panel-2);padding:12px">
                        <div class="spread" style="margin-bottom:4px">
                          <span class="chip small">{c.author || 'anónimo'}</span>
                          <span class="muted" style="font-size:11px">{rel(c.created_at)}</span>
                        </div>
                        <div style="font-size:12.5px;white-space:pre-wrap">{c.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'historial' && (
              <div style="margin-top:12px">
                {events.length === 0 ? <div class="muted" style="font-size:12.5px">Sin eventos.</div> : (
                  <div class="list">
                    {[...events].reverse().map((e) => (
                      <div class="list-row" key={e.id} style="padding:8px 12px">
                        <span class="chip small">{EVENT_ES[e.kind] || e.kind}</span>
                        <div class="grow muted mono ellipsis" style="font-size:11px">{payloadLine(e.payload)}</div>
                        <span class="muted" style="font-size:11px">{rel(e.created_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
// El payload de un evento es JSON libre: mostrar una línea legible, sin llaves.
function payloadLine(p) {
  const o = typeof p === 'string' ? safeJson(p) : (p || {});
  const parts = Object.entries(o).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.join(' · ').slice(0, 200);
}

function TaskForm({ boards, onDone }) {
  const [f, setF] = useState({ board: boards[0], title: '', body: '', assignee: '', priority: '', triage: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    if (!f.title.trim()) { onDone({ ok: false, text: 'título requerido' }); return; }
    setBusy(true);
    try { const r = await post('/api/kanban/create', { profile: '(default)', ...f }); onDone({ ok: true, text: (r.stdout || 'tarea creada').split('\n')[0] }); }
    catch (e) { onDone({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div class="card" style="margin-bottom:14px">
      <h3>Nueva tarea</h3>
      <div style="display:grid;gap:10px;margin-top:12px">
        <div class="row">
          <span class="muted" style="font-size:12px">Board:</span>
          <div class="seg" style="flex-wrap:wrap">{boards.map((b) => <button class={f.board === b ? 'on' : ''} onClick={() => setF((s) => ({ ...s, board: b }))} key={b}>{b}</button>)}</div>
        </div>
        <div class="search"><input placeholder="Título" value={f.title} onInput={set('title')} /></div>
        <div class="search"><input placeholder="Descripción / opening post (opcional)" value={f.body} onInput={set('body')} /></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="search"><input placeholder="Asignar a (perfil)" value={f.assignee} onInput={set('assignee')} /></div>
          <div class="search"><input placeholder="Prioridad (nº)" value={f.priority} onInput={set('priority')} /></div>
        </div>
        <label class="row" style="font-size:12.5px"><input type="checkbox" checked={f.triage} onChange={(e) => setF((s) => ({ ...s, triage: e.target.checked }))} /> Mandar a triage (un specifier la desarrolla)</label>
        <div class="wrap">
          <button class="chip filter-chip on" disabled={busy} onClick={submit}>{busy ? 'Creando…' : 'Crear tarea'}</button>
          <button class="chip" disabled={busy} onClick={() => onDone(null)}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
