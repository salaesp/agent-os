import { useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, rel } from '../components/ui.jsx';

const CAT = { workflow: { icon: 'work', label: 'Workflow' }, vida: { icon: 'favorite', label: 'Vida' }, aprendizaje: { icon: 'school', label: 'Aprendizaje' } };
const MODE = { push: 'empuje', queue: 'cola', store: 'silenciosa' };
// Motivos de descarte (espejo de DISMISS_REASONS en src/suggestions.js). El motivo
// decide cuánto se bloquea el tema y si castiga o no a la categoría.
const REASONS = [
  { key: 'done', icon: 'task_alt', label: 'Ya lo hice', tip: 'buena sugerencia, pero llegó tarde — no baja la categoría' },
  { key: 'not_interested', icon: 'do_not_disturb_on', label: 'No me interesa', tip: 'el tema no te interesa — baja la categoría' },
  { key: 'wrong', icon: 'error', label: 'No aplica', tip: 'partía de algo falso — no lo vuelve a plantear de otra forma' },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.key, r.label]));

function actionPreview(s) {
  const p = s.action_payload || {};
  switch (s.action_type) {
    case 'cron': case 'reminder': return `crea cron «${p.name || s.title}» (${p.schedule || '?'})`;
    case 'kanban': return `crea tarea «${p.title || s.title}»`;
    case 'memory': return `anota en ${p.which === 'memory' ? 'MEMORY.md' : 'USER.md'}`;
    case 'goal': return `crea objetivo «${p.title || s.title}»`;
    case 'profile': return `agrega a tu perfil: «${p.value || ''}»`;
    case 'goal_progress': return `actualiza el objetivo «${p.goalTitle || ''}» → ${p.progress}%`;
    case 'skill_learn': return `corre /learn en Hermes: «${String(p.request || '').slice(0, 80)}…»`;
    default: return null;
  }
}

export function Suggestions() {
  const { data, error, loading, reload } = useApi('/api/suggestions', 20000);
  const [gen, setGen] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [asking, setAsking] = useState(null); // id de la sugerencia que está eligiendo motivo de descarte
  const [whyId, setWhyId] = useState(null); // id de la sugerencia con el "¿Por qué?" abierto
  const [selected, setSelected] = useState(new Set()); // ids marcados para la bandeja de decisiones en lote

  if (loading) return <Loading />;
  if (error) return <><PageHead title="Sugerencias" /><ErrorBox error={error} /></>;

  const setCfg = async (key, value) => { await post('/api/settings/set', { key, value }); reload(); };
  const clearInbox = async () => {
    if (!confirm('¿Vaciar el inbox de sugerencias? (se preservan tus señales negativas)')) return;
    await post('/api/suggestions/clear', { scope: 'all' }); reload();
  };
  const testPush = async () => {
    setMsg(null);
    try { await post('/api/push/test', { channel: data.delivery?.channel }); setMsg({ ok: true, text: `test enviado a ${data.delivery?.channel}` }); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  const sendBrief = async () => {
    setMsg(null);
    try { const r = await post('/api/suggestions/brief', {}); setMsg({ ok: true, text: `brief enviado (${r.sent} sugerencias)` }); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  };

  const generate = async () => {
    setGen(true); setMsg(null);
    try { const r = await post('/api/suggestions/generate', {}); setMsg({ ok: true, text: `${r.created} sugerencia(s) nuevas` }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setGen(false); }
  };
  const LABEL = { apply: 'aplicada ✓', dismiss: 'descartada', snooze: 'pospuesta', restore: 'restaurada — de vuelta en el inbox' };
  const act = async (id, kind, reason) => {
    setBusyId(id + kind); setMsg(null);
    try {
      await post(`/api/suggestions/${kind}`, { id, reason });
      setMsg({ ok: true, text: LABEL[kind] || 'listo' });
      reload();
      return true;
    } catch (e) { setMsg({ ok: false, text: e.message }); return false; }
    finally { setBusyId(null); }
  };
  const dismiss = async (s, reason) => {
    setAsking(null);
    if (await act(s.id, 'dismiss', reason)) setMsg({ ok: true, text: `descartada · ${REASON_LABEL[reason].toLowerCase()}` });
  };

  const toggleSel = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const batchAct = async (kind) => {
    const ids = [...selected];
    setBusyId('batch'); setMsg(null);
    try {
      const r = kind === 'apply'
        ? await post('/api/suggestions/apply-batch', { ids })
        : await post('/api/suggestions/dismiss-batch', { ids, reason: 'not_interested' });
      setMsg({ ok: true, text: kind === 'apply' ? `${r.applied} aplicada(s)${r.failed ? ` · ${r.failed} con error` : ''}` : `${r.dismissed} descartada(s)` });
      setSelected(new Set());
      reload();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusyId(null); }
  };

  const toggleAuto = async () => {
    await post('/api/settings/set', { key: 'auto_suggest_enabled', value: data.auto?.enabled ? '0' : '1' });
    reload();
  };

  const active = data.suggestions.filter((s) => s.status === 'new');
  const decided = data.suggestions.filter((s) => s.status !== 'new').slice(0, 10);

  return (
    <>
      <PageHead title="Sugerencias" sub={`${active.length} pendientes · proactividad con tu OK`}>
        <div class="wrap">
          <button class="chip" onClick={() => setShowCfg((v) => !v)}><span class="msr" style="font-size:16px">tune</span>Entrega</button>
          {active.length > 0 && <button class="chip" onClick={clearInbox}><span class="msr" style="font-size:16px">delete_sweep</span>Vaciar</button>}
          <button class="chip filter-chip on" disabled={gen} onClick={generate} style="padding:8px 16px">
            <span class="msr" style={`font-size:17px;${gen ? 'animation:spin 1s linear infinite' : ''}`}>{gen ? 'progress_activity' : 'lightbulb'}</span>
            {gen ? 'Pensando…' : 'Pensá algo para mí'}
          </button>
        </div>
      </PageHead>

      {showCfg && data.delivery && (
        <div class="card" style="margin-bottom:12px">
          <h3 style="margin-bottom:10px">Entrega proactiva</h3>
          <div class="spread" style="padding:8px 0;border-bottom:1px solid var(--hairline)">
            <div><b style="font-size:13px">Push a un canal</b><div class="muted" style="font-size:11px">empuja lo urgente (score alto) por Discord/Slack/Telegram</div></div>
            <button class={`chip filter-chip ${data.delivery.pushEnabled ? 'on' : ''}`} onClick={() => setCfg('push_enabled', data.delivery.pushEnabled ? '0' : '1')}>{data.delivery.pushEnabled ? 'ON' : 'OFF'}</button>
          </div>
          <div class="spread" style="padding:10px 0;border-bottom:1px solid var(--hairline)">
            <span class="muted" style="font-size:12px">Canal</span>
            <div class="seg">{['discord', 'slack', 'telegram'].map((c) => <button class={data.delivery.channel === c ? 'on' : ''} onClick={() => setCfg('push_channel', c)} key={c}>{c}</button>)}</div>
          </div>
          <div class="spread" style="padding:10px 0;border-bottom:1px solid var(--hairline)">
            <div><span class="muted" style="font-size:12px">Presupuesto</span> <span class="muted" style="font-size:11px">· {data.delivery.pushedToday}/{data.delivery.budget} hoy</span></div>
            <div class="seg">{[3, 4, 5].map((n) => <button class={data.delivery.budget === n ? 'on' : ''} onClick={() => setCfg('push_budget', String(n))} key={n}>{n}/día</button>)}</div>
          </div>
          <div class="spread" style="padding:10px 0">
            <div><b style="font-size:13px">Brief diario</b><div class="muted" style="font-size:11px">un solo resumen a la mañana ({data.auto?.nightlyHour}h) con la cola</div></div>
            <button class={`chip filter-chip ${data.delivery.briefEnabled ? 'on' : ''}`} onClick={() => setCfg('brief_enabled', data.delivery.briefEnabled ? '0' : '1')}>{data.delivery.briefEnabled ? 'ON' : 'OFF'}</button>
          </div>
          <div class="wrap" style="margin-top:8px">
            <button class="chip" onClick={testPush}><span class="msr" style="font-size:14px">send</span>Probar push</button>
            <button class="chip" onClick={sendBrief}><span class="msr" style="font-size:14px">wb_sunny</span>Enviar brief ahora</button>
          </div>
          <div class="muted" style="font-size:11px;margin-top:8px">Empieza en OFF a propósito — activá el push cuando confirmes el canal correcto (empuja a tu canal real de Hermes).</div>
        </div>
      )}
      {data.auto && (
        <div class="card" style="margin-bottom:12px;padding:12px 16px">
          <div class="spread">
            <div class="row" style="font-size:12.5px">
              <span class="msr" style={`color:var(--${data.auto.enabled ? 'ok' : 'text-3'})`}>{data.auto.enabled ? 'motion_photos_on' : 'motion_photos_off'}</span>
              <b>Automático {data.auto.enabled ? 'ON' : 'OFF'}</b>
              <span class="muted">· de noche ({data.auto.nightlyHour}h) y en límites de tarea · {data.auto.genToday}/{data.auto.dailyCap} hoy{data.auto.lastGenAt ? ` · última ${rel(data.auto.lastGenAt)}` : ''}</span>
            </div>
            <button class={`chip filter-chip ${data.auto.enabled ? 'on' : ''}`} onClick={toggleAuto}>{data.auto.enabled ? 'Desactivar' : 'Activar'}</button>
          </div>
        </div>
      )}
      {gen && <div class="card" style="margin-bottom:12px"><div class="muted">El agente está analizando tu contexto (sesiones, kanban, objetivos, memoria, digest) para proponerte cosas. Puede tardar un rato…</div></div>}
      {msg && <div class="card" style={`margin-bottom:12px;border-color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}><span class="mono" style="font-size:12px">{msg.ok ? '✓ ' : '✕ '}{msg.text}</span></div>}

      {active.length === 0 && !gen && (
        <div class="card"><div class="muted">No hay sugerencias pendientes. Tocá <b>«Pensá algo para mí»</b> y el agente te propone mejoras concretas de trabajo, hábitos y aprendizaje — cada una con su porqué y un botón para aplicarla.</div></div>
      )}

      {selected.size > 0 && (
        <div class="card" style="margin-bottom:12px;position:sticky;top:8px;z-index:5;border-color:var(--gold)">
          <div class="spread">
            <b style="font-size:13px">{selected.size} seleccionada{selected.size > 1 ? 's' : ''}</b>
            <div class="wrap">
              <button class="chip filter-chip on" disabled={busyId === 'batch'} onClick={() => batchAct('apply')}>{busyId === 'batch' ? '…' : 'Aplicar seleccionadas'}</button>
              <button class="chip" disabled={busyId === 'batch'} onClick={() => batchAct('dismiss')}>Descartar seleccionadas</button>
              <button class="chip" disabled={busyId === 'batch'} onClick={() => setSelected(new Set())}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr));align-items:start">
        {active.map((s) => {
          const cat = CAT[s.category] || CAT.workflow;
          const prev = actionPreview(s);
          return (
            <div class="card" key={s.id}>
              <div class="spread" style="margin-bottom:6px">
                <div class="wrap">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSel(s.id)} title="seleccionar para la bandeja en lote" style="margin-right:2px" />
                  <span class="chip small"><span class="msr" style="font-size:14px;color:var(--gold)">{cat.icon}</span>{cat.label}</span>
                  {s.exploratory ? <span class="chip small" style="color:var(--gold)" title="hace rato que no te propongo esto"><span class="msr" style="font-size:13px">explore</span>explorar</span> : null}
                </div>
                <div class="wrap"><span class="chip small" title="score">{s.score}</span><span class="chip small">{MODE[s.mode] || s.mode}</span></div>
              </div>
              <h3 style="margin:2px 0 6px">{s.title}</h3>
              {s.rationale && (
                <button
                  class="chip small"
                  style="margin-bottom:8px"
                  onClick={() => setWhyId(whyId === s.id ? null : s.id)}
                  title="ver por qué el agente propuso esto"
                >
                  <span class="msr" style="font-size:13px">{whyId === s.id ? 'expand_less' : 'help'}</span>¿Por qué?
                </button>
              )}
              {whyId === s.id && (
                <div class="muted" style="font-size:12.5px;margin-bottom:8px">
                  {s.rationale}{s.source ? ` (fuente: ${s.source})` : ''}
                </div>
              )}
              {prev && <div class="chip small" style="margin-bottom:12px"><span class="msr" style="font-size:13px">bolt</span>{prev}</div>}
              {asking === s.id ? (
                <div>
                  <div class="muted" style="font-size:11.5px;margin-bottom:6px">¿Por qué la descartás? Con eso aprendo — no es lo mismo «ya lo hice» que «no me interesa».</div>
                  <div class="wrap">
                    {REASONS.map((r) => (
                      <button class="chip" key={r.key} title={r.tip} disabled={!!busyId} onClick={() => dismiss(s, r.key)}>
                        <span class="msr" style="font-size:14px">{r.icon}</span>{r.label}
                      </button>
                    ))}
                    <button class="chip" disabled={!!busyId} onClick={() => setAsking(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div class="wrap">
                  {s.action_type !== 'none' && <button class="chip filter-chip on" disabled={!!busyId} onClick={() => act(s.id, 'apply')}>{busyId === s.id + 'apply' ? '…' : 'Aplicar'}</button>}
                  <button class="chip" disabled={!!busyId} onClick={() => setAsking(s.id)}>Descartar</button>
                  <button class="chip" disabled={!!busyId} onClick={() => act(s.id, 'snooze')}>Después</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {decided.length > 0 && (
        <div style="margin-top:22px">
          <h3 style="margin-bottom:10px">Recientes</h3>
          <div class="list">
            {decided.map((s) => (
              <div class="list-row" key={s.id}>
                <span class="chip small">{s.status === 'applied' ? '✓ aplicada' : s.status === 'dismissed' ? `✕ ${REASON_LABEL[s.dismiss_reason] || 'descartada'}` : '⏳ después'}</span>
                <div class="grow"><span class="title" style="font-size:13px">{s.title}</span></div>
                {(s.status === 'dismissed' || s.status === 'snoozed') && (
                  <button class="chip small" disabled={!!busyId} onClick={() => act(s.id, 'restore')} title="volver a agregarla al inbox y desbloquearla"><span class="msr" style="font-size:14px">restore</span>Restaurar</button>
                )}
                <span class="muted" style="font-size:11px">{s.decided_at ? rel(s.decided_at) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
