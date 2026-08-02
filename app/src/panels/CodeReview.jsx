import { useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';

const LEVEL = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--text-3)' };

export function CodeReview() {
  const { data, error, loading, reload } = useApi('/api/code-review', 20000);
  const { data: kanban } = useApi('/api/kanban', 30000);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [boards, setBoards] = useState({});
  if (loading) return <Loading />;
  if (error) return <><PageHead title="Revisión de código" /><ErrorBox error={error} /></>;
  const active = data.findings.filter((f) => f.status === 'new');
  const history = data.findings.filter((f) => f.status !== 'new');
  const eventsByFinding = (data.events || []).reduce((all, event) => ({ ...all, [event.finding_id]: [...(all[event.finding_id] || []), event] }), {});
  const run = async () => {
    setRunning(true); setMsg(null);
    try { const r = await post('/api/code-review/generate', {}); setMsg(`${r.created} hallazgo(s) nuevo(s)`); reload(); }
    catch (e) { setMsg(e.message); } finally { setRunning(false); }
  };
  const decide = async (id, status) => {
    setBusy(id); try { await post('/api/code-review/status', { id, status }); reload(); } finally { setBusy(null); }
  };
  const createTask = async (finding) => {
    setBusy(finding.id); setMsg(null);
    try {
      const board = boards[finding.id] || 'default';
      await post('/api/code-review/create-task', { id: finding.id, board });
      setMsg(`Tarea creada en «${board}»`); reload();
    } catch (e) { setMsg(e.message); } finally { setBusy(null); }
  };
  const boardOptions = kanban?.boards?.length ? kanban.boards : ['default'];
  return <>
    <PageHead title="Revisión de código" sub={`${active.length} hallazgo(s) abierto(s) · mantenimiento técnico, no producto`}>
      <div class="wrap"><button class="chip filter-chip on" disabled={running} onClick={run}><span class="msr">{running ? 'progress_activity' : 'fact_check'}</span>{running ? 'Revisando…' : 'Revisar ahora'}</button></div>
    </PageHead>
    <div class="card" style="margin-bottom:12px">
      <div class="muted" style="font-size:12px">Corre automáticamente cada {data.schedule.intervalDays} días sobre los proyectos incluidos. No modifica código ni propone funcionalidades; cada hallazgo puede convertirse manualmente en una tarea del board que elijas.{data.schedule.lastAt ? ` Última revisión: ${rel(data.schedule.lastAt)}.` : ''}</div>
    </div>
    {msg && <div class="card" style="margin-bottom:12px">{msg}</div>}
    {!data.findings.length && <div class="empty"><span class="msr">verified</span><b>Sin hallazgos todavía</b><span>Podés lanzar la primera revisión cuando quieras.</span></div>}
    {active.length > 0 && <div class="list">{active.map((f) => <FindingCard key={f.id} f={f} events={eventsByFinding[f.id]} boards={boards} setBoards={setBoards} boardOptions={boardOptions} busy={busy} createTask={createTask} decide={decide} />)}</div>}
    {history.length > 0 && <><h3 style="margin:18px 0 9px">Historial</h3><div class="list">{history.map((f) => <FindingCard key={f.id} f={f} events={eventsByFinding[f.id]} />)}</div></>}
  </>;
}

const STATUS = { task_created: 'tarea creada', done: 'ya realizado', dismissed: 'descartado', acknowledged: 'visto' };
function FindingCard({ f, events = [], boards, setBoards, boardOptions, busy, createTask, decide }) {
  const open = f.status === 'new';
  return <div class="card" style={`opacity:${open ? 1 : .65}`}>
    <div class="spread" style="align-items:flex-start"><div><div class="wrap"><b>{f.title}</b><span class="chip small" style={`color:${LEVEL[f.severity] || LEVEL.medium}`}>{f.severity}</span>{!open && <span class="chip small">{STATUS[f.status] || f.status}</span>}</div><div class="muted mono" style="font-size:11px;margin-top:5px">{f.project} · {f.branch || 'sin rama'}</div></div>{open && <div class="wrap"><select value={boards[f.id] || 'default'} onChange={(e) => setBoards((x) => ({ ...x, [f.id]: e.currentTarget.value }))} style="max-width:130px"><option value="default">default</option>{boardOptions.filter((b) => b !== 'default').map((b) => <option value={b} key={b}>{b}</option>)}</select><button class="chip small filter-chip on" disabled={busy === f.id} onClick={() => createTask(f)}><span class="msr" style="font-size:14px">add_task</span>Crear tarea</button><button class="chip small" disabled={busy === f.id} onClick={() => decide(f.id, 'done')}>Ya lo hice</button><button class="chip small" disabled={busy === f.id} onClick={() => decide(f.id, 'dismissed')}>Descartar</button></div>}</div>
    <div style="font-size:13px;margin-top:12px"><b>Qué se encontró</b><div style="margin-top:3px">{f.title}</div></div>
    {f.rationale && <div style="font-size:13px;margin-top:10px"><b>Por qué importa</b><div style="margin-top:3px">{f.rationale}</div></div>}
    {f.evidence && <div class="muted" style="font-size:12px;margin-top:10px"><b>Evidencia observada:</b> {f.evidence}</div>}
    <div class="muted" style="font-size:12px;margin-top:7px"><b>Qué revisar:</b> {f.next_step || 'Validar la evidencia y decidir si corresponde tratarlo como tarea técnica.'}</div>
    {f.task_created_at && <div class="muted" style="font-size:12px;margin-top:8px"><span class="msr" style="font-size:14px;vertical-align:-2px">task_alt</span> Tarea creada en «{f.task_board}»</div>}
    {events.length > 0 && <div class="muted" style="font-size:11px;margin-top:10px">{events.slice().reverse().map((e) => <div key={e.id}>{STATUS[e.action] || (e.action === 'found' ? 'detectado' : e.action)} · {rel(e.created_at)}{e.board ? ` · ${e.board}` : ''}</div>)}</div>}
  </div>;
}
