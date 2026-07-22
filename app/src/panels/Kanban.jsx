import { useState } from 'preact/hooks';
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
    try { await post(path, body); setMsg({ ok: true, text: okText }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const action = (t, a) => {
    if (a === 'archive' && !confirm(`¿Archivar "${t.title || t.id}"?`)) return;
    mutate('/api/kanban/action', { profile: '(default)', board: t.board, id: t.id, action: a }, `${a} · ${t.title || t.id}`);
  };
  const comment = (t) => {
    const text = prompt(`Comentario para "${t.title || t.id}":`);
    if (text) mutate('/api/kanban/comment', { profile: '(default)', board: t.board, id: t.id, text }, 'comentario agregado');
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
                  <div key={t.id}>
                    <div class="list-row" style="background:var(--panel-2);padding:10px 12px;cursor:pointer" onClick={() => setOpen(open === t.id ? null : t.id)}>
                      <div class="grow">
                        <div class="title ellipsis" style="font-size:13px">{t.title || t.id}</div>
                        <div class="muted" style="font-size:11px">
                          {board === 'todos' && <span class="mono">{t.board}</span>} {t.assignee ? `· ${t.assignee}` : ''} · {rel(t.completedAt || t.createdAt)}
                        </div>
                      </div>
                      <span class="msr" style="font-size:16px">{open === t.id ? 'expand_less' : 'more_horiz'}</span>
                    </div>
                    {open === t.id && (
                      <div class="wrap" style="padding:8px 4px 10px">
                        {t.status !== 'done' && <button class="chip small" disabled={busy} onClick={() => action(t, 'complete')}><span class="msr" style="font-size:14px">check</span>Completar</button>}
                        {t.status !== 'blocked' ? <button class="chip small" disabled={busy} onClick={() => action(t, 'block')}><span class="msr" style="font-size:14px">block</span>Bloquear</button>
                          : <button class="chip small" disabled={busy} onClick={() => action(t, 'unblock')}><span class="msr" style="font-size:14px">lock_open</span>Desbloquear</button>}
                        <button class="chip small" disabled={busy} onClick={() => comment(t)}><span class="msr" style="font-size:14px">comment</span>Comentar</button>
                        <button class="chip small" disabled={busy} style="color:var(--err)" onClick={() => action(t, 'archive')}><span class="msr" style="font-size:14px">archive</span></button>
                      </div>
                    )}
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
