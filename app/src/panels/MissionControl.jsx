import { useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';

const STATUSES = ['active', 'paused', 'done'];
const STATUS_ES = { active: 'activo', paused: 'en pausa', done: 'logrado', archived: 'archivado' };

export function MissionControl() {
  const { data, error, loading, reload } = useApi('/api/goals', 30000);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ideating, setIdeating] = useState(null); // id del objetivo en ideación
  const [msg, setMsg] = useState(null);

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Mission Control" /><ErrorBox error={error} /></>;

  const mutate = async (path, body) => {
    setBusy(true);
    try { await post(path, body); reload(); } finally { setBusy(false); }
  };

  // Ideación divergente: varias pasadas del modelo con ángulos distintos sobre el
  // objetivo. Tarda (minutos), y lo que sale cae en Sugerencias listo para aplicar.
  const ideate = async (g) => {
    setIdeating(g.id); setMsg(null);
    try {
      const r = await post('/api/ideate', { goalId: g.id });
      setMsg({ ok: true, text: `${r.created} idea(s) sobre «${r.goal}» → mirá Sugerencias (ángulos: ${(r.frames || []).join(', ')})` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setIdeating(null); }
  };

  return (
    <>
      <PageHead title="Mission Control" sub={`${data.length} objetivos · ${data.filter((g) => g.status === 'active').length} activos`}>
        <button class="chip" onClick={() => setCreating((v) => !v)}><span class="msr" style="font-size:16px">add</span>Nuevo objetivo</button>
      </PageHead>

      {creating && <GoalForm onCancel={() => setCreating(false)} onSubmit={async (f) => { await mutate('/api/goals/create', f); setCreating(false); }} />}
      {ideating && <div class="card" style="margin-bottom:12px"><div class="muted">Pensando el objetivo desde varios ángulos a la vez (regulador, biólogo, speedrunner…). Son varias pasadas del modelo: puede tardar unos minutos.</div></div>}
      {msg && <div class="card" style={`margin-bottom:12px;border-color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}><span class="mono" style="font-size:12px">{msg.ok ? '✓ ' : '✕ '}{msg.text}</span></div>}

      {data.length === 0 && !creating && (
        <div class="card"><div class="muted">Todavía no hay objetivos. Creá uno de mediano plazo (semanas): definí el brief, tu rol, el rol del agente y seguí el progreso.</div></div>
      )}

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
        {data.map((g) => <GoalCard key={g.id} g={g} busy={busy} mutate={mutate} ideate={ideate} ideating={ideating} />)}
      </div>
    </>
  );
}

function GoalCard({ g, busy, mutate, ideate, ideating }) {
  const [edit, setEdit] = useState(false);
  const [closing, setClosing] = useState(false);
  const [outcomeDraft, setOutcomeDraft] = useState('');
  const pctCls = g.progress >= 100 ? '' : g.progress >= 60 ? '' : 'warn';

  if (edit) return <div class="card"><GoalForm goal={g} onCancel={() => setEdit(false)} onSubmit={async (f) => { await mutate('/api/goals/update', { id: g.id, ...f }); setEdit(false); }} /></div>;

  const setStatus = (s) => {
    if (s === 'done' && g.status !== 'done') { setOutcomeDraft(g.outcome || ''); setClosing(true); return; }
    mutate('/api/goals/update', { id: g.id, status: s });
  };
  const confirmDone = async () => {
    await mutate('/api/goals/update', { id: g.id, status: 'done', outcome: outcomeDraft.trim() });
    setClosing(false);
  };

  return (
    <div class="card">
      <div class="spread">
        <h3>{g.title}</h3>
        <span class="chip small">{STATUS_ES[g.status] || g.status}</span>
      </div>
      {g.brief && <div class="muted" style="font-size:13px;margin:6px 0 10px">{g.brief}</div>}

      <div style="margin:10px 0">
        <div class="spread" style="font-size:12px;margin-bottom:6px"><b>Progreso</b><span class="muted mono">{g.progress}%</span></div>
        <input class="progress-range" type="range" min="0" max="100" value={g.progress} disabled={busy}
          onChange={(e) => mutate('/api/goals/update', { id: g.id, progress: e.target.value })}
          style={`--pct:${g.progress}%`} />
      </div>

      {(g.my_role || g.agent_role) && (
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 12px">
          <div><div class="lbl" style="font-size:10px;text-transform:uppercase;color:var(--text-3)">Vos</div><div style="font-size:12.5px">{g.my_role || '—'}</div></div>
          <div><div class="lbl" style="font-size:10px;text-transform:uppercase;color:var(--gold)">Agente</div><div style="font-size:12.5px">{g.agent_role || '—'}</div></div>
        </div>
      )}
      {g.target_date && <div class="muted" style="font-size:11px;margin-bottom:10px">🎯 meta: {g.target_date}</div>}

      {g.status === 'done' && g.outcome && (
        <div style="margin:6px 0 12px;padding:10px 12px;border-radius:var(--radius-m);background:var(--panel-2);border:1px solid var(--hairline)">
          <div class="lbl" style="font-size:10px;text-transform:uppercase;color:var(--ok)">Conclusión{g.done_at ? ` · ${g.done_at.slice(0, 10)}` : ''}</div>
          <div style="font-size:12.5px;margin-top:4px;white-space:pre-wrap">{g.outcome}</div>
        </div>
      )}

      {closing && (
        <div style="margin:6px 0 12px">
          <div class="lbl" style="font-size:10px;text-transform:uppercase;color:var(--ok);margin-bottom:4px">¿Cuál fue el resultado?</div>
          <textarea value={outcomeDraft} onInput={(e) => setOutcomeDraft(e.target.value)} placeholder="Conclusión / outcome — qué se logró, qué quedó pendiente, aprendizajes"
            style="width:100%;min-height:70px;resize:vertical;font-size:12.5px;padding:10px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
          <div class="wrap" style="margin-top:6px">
            <button class="chip filter-chip on" disabled={busy} onClick={confirmDone}>Marcar logrado</button>
            <button class="chip" disabled={busy} onClick={() => setClosing(false)}>Cancelar</button>
          </div>
        </div>
      )}

      <div class="wrap">
        <div class="seg">
          {STATUSES.map((s) => (
            <button class={g.status === s ? 'on' : ''} disabled={busy} onClick={() => setStatus(s)} key={s}>{STATUS_ES[s]}</button>
          ))}
        </div>
        {g.status === 'active' && (
          <button class="chip" disabled={busy || !!ideating} onClick={() => ideate(g)}
            title="Pensar este objetivo desde varios ángulos distintos y dejar las mejores ideas en Sugerencias">
            <span class="msr" style={`font-size:14px;color:var(--gold);${ideating === g.id ? 'animation:spin 1s linear infinite' : ''}`}>{ideating === g.id ? 'progress_activity' : 'neurology'}</span>
            {ideating === g.id ? 'Pensando…' : 'Ideas'}
          </button>
        )}
        <button class="chip" disabled={busy} onClick={() => setEdit(true)}><span class="msr" style="font-size:14px">edit</span></button>
        <button class="chip" disabled={busy} style="color:var(--err)" onClick={() => { if (confirm(`¿Eliminar "${g.title}"?`)) mutate('/api/goals/delete', { id: g.id }); }}><span class="msr" style="font-size:14px">delete</span></button>
      </div>
    </div>
  );
}

function GoalForm({ goal, onSubmit, onCancel }) {
  const [f, setF] = useState({
    title: goal?.title || '', brief: goal?.brief || '',
    my_role: goal?.my_role || '', agent_role: goal?.agent_role || '', target_date: goal?.target_date || '',
    ...(goal ? { outcome: goal.outcome || '' } : {}),
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async () => {
    if (!f.title.trim()) return;
    setBusy(true);
    try { await onSubmit(f); } finally { setBusy(false); }
  };
  return (
    <div class={goal ? '' : 'card'} style={goal ? '' : 'margin-bottom:14px'}>
      {!goal && <h3>Nuevo objetivo</h3>}
      <div style="display:grid;gap:10px;margin-top:10px">
        <div class="search"><input placeholder="Título del objetivo (ej: sumar 1000 subs)" value={f.title} onInput={set('title')} /></div>
        <div class="search"><input placeholder="Brief — qué se busca y por qué" value={f.brief} onInput={set('brief')} /></div>
        {/* min-width:0 — .search trae min-width:180px y en columnas de ~140px
            (card de 320px) desbordaría la tarjeta. */}
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
          <div class="search" style="min-width:0"><input placeholder="Tu rol" value={f.my_role} onInput={set('my_role')} /></div>
          <div class="search" style="min-width:0"><input placeholder="Rol del agente" value={f.agent_role} onInput={set('agent_role')} /></div>
        </div>
        <label style="font-size:12px;color:var(--text-2)">Fecha meta (opcional)
          <div class="search" style="margin-top:4px"><input type="date" value={f.target_date} onInput={set('target_date')} /></div>
        </label>
        {goal && (
          <label style="font-size:12px;color:var(--text-2)">Conclusión / outcome
            <textarea value={f.outcome} onInput={set('outcome')} placeholder="Qué se logró, qué quedó pendiente, aprendizajes"
              style="width:100%;min-height:60px;resize:vertical;font-size:12.5px;padding:10px;margin-top:4px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
          </label>
        )}
        <div class="wrap">
          <button class="chip filter-chip on" disabled={busy} onClick={submit}>{busy ? 'Guardando…' : (goal ? 'Guardar' : 'Crear objetivo')}</button>
          <button class="chip" disabled={busy} onClick={onCancel}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
