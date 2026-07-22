import { useState } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox, Dot } from '../components/ui.jsx';
import { routeParam } from '../route.js';
import { personaLabel } from '../persona.js';
import { ModelPicker } from '../components/ModelPicker.jsx';

export function Pantheon() {
  const personas = useApi('/api/personas');
  const skillsApi = useApi('/api/skills/all');
  const curator = useApi('/api/dreaming/curator');
  const models = useApi('/api/models');
  const [q, setQ] = useState(routeParam('skill') || '');
  const [cat, setCat] = useState('todas');
  const [persona, setPersona] = useState('todas');
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [scouting, setScouting] = useState(false);
  const [scoutMsg, setScoutMsg] = useState(null);

  const scout = async () => {
    setScouting(true); setScoutMsg(null);
    try {
      const r = await post('/api/skills/scout', {});
      setScoutMsg({ ok: true, text: r.created ? `${r.created} candidato(s) a skill en el inbox de Sugerencias` : 'sin flujos repetidos nuevos' });
    } catch (e) { setScoutMsg({ ok: false, text: e.message }); }
    finally { setScouting(false); }
  };

  if (personas.loading || skillsApi.loading) return <Loading />;
  if (skillsApi.error) return <><PageHead title="Pantheon" /><ErrorBox error={skillsApi.error} /></>;

  const skills = skillsApi.data.skills || [];
  const cats = ['todas', ...[...new Set(skills.map((s) => s.category))].sort()];
  const personaOpts = ['todas', ...[...new Set(skills.flatMap((s) => s.profiles || []))]];

  let list = skills;
  if (cat !== 'todas') list = list.filter((s) => s.category === cat);
  if (persona !== 'todas') list = list.filter((s) => (s.profiles || []).includes(persona));
  if (onlyUsed) list = list.filter((s) => s.useCount > 0);
  if (q) {
    const t = q.toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().includes(t) || (s.description || '').toLowerCase().includes(t) || (s.tags || []).some((x) => x.toLowerCase().includes(t)));
  }
  list = [...list].sort((a, b) => b.useCount - a.useCount);

  return (
    <>
      <PageHead title="Pantheon" sub={`${personas.data?.length || 0} personas · ${skills.length} skills`} />

      <h3 style="margin:0 0 10px">Personas</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
        {(personas.data || []).map((p) => (
          <div class="card" key={p.profile}>
            <div class="spread">
              <h3>{personaLabel(p.profile)}</h3>
              {p.hasHooks && <span class="chip small"><span class="msr" style="font-size:14px">bolt</span>hooks</span>}
            </div>
            <PersonaModel p={p} reload={personas.reload} />
            <div class="muted" style="font-size:12px">{p.soulExcerpt || '—'}</div>
            {p.toolsets?.length > 0 && <div class="muted" style="font-size:11px;margin-top:10px">{p.toolsets.length} toolsets</div>}
          </div>
        ))}
      </div>

      {models.data?.moa && <MoaCard moa={models.data.moa} providers={models.data.providers || []} reload={models.reload} />}

      {curator.data?.ok && <CuratorCard c={curator.data} reload={curator.reload} />}

      <div class="spread" style="margin:26px 0 10px">
        <h3 style="margin:0">Skills</h3>
        <button class="chip small" disabled={scouting} onClick={scout} title="Busca flujos repetidos en tus conversaciones y propone convertirlos en skills (/learn)">
          <span class="msr" style="font-size:14px">travel_explore</span>{scouting ? 'Buscando…' : 'Buscar candidatos a skill'}
        </button>
      </div>
      {scoutMsg && <div class="mono" style={`font-size:11px;margin-bottom:8px;color:${scoutMsg.ok ? 'var(--ok)' : 'var(--err)'}`}>{scoutMsg.ok ? '✓ ' : '✕ '}{scoutMsg.text}</div>}
      <div class="toolbar">
        <div class="seg">
          {['todas', 'usadas'].map((k) => <button class={onlyUsed === (k === 'usadas') ? 'on' : ''} onClick={() => setOnlyUsed(k === 'usadas')} key={k}>{k}</button>)}
        </div>
        <div class="search"><input placeholder="Buscar skill, tag…" value={q} onInput={(e) => setQ(e.target.value)} /></div>
      </div>
      <div class="wrap" style="margin-bottom:8px">
        <span class="muted" style="font-size:11px;align-self:center">persona:</span>
        {personaOpts.map((p) => <button class={`chip small filter-chip ${persona === p ? 'on' : ''}`} onClick={() => setPersona(p)} key={p}>{p === 'todas' ? 'todas' : personaLabel(p)}</button>)}
      </div>
      <div class="wrap" style="margin-bottom:14px">
        {cats.map((c) => <button class={`chip small filter-chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)} key={c}>{c}</button>)}
      </div>

      <div class="list">
        {list.map((s) => (
          <div class="list-row" key={s.category + '/' + s.name}>
            <span class="chip small" title="usos">{s.useCount}×</span>
            <div class="grow">
              <div class="title">{s.name}</div>
              <div class="muted ellipsis" style="font-size:12px">{s.description}</div>
            </div>
            <div class="wrap" style="max-width:200px;justify-content:flex-end">
              {(s.profiles || []).map((p) => <span class="chip small" key={p}>{personaLabel(p)}</span>)}
            </div>
          </div>
        ))}
        {list.length === 0 && <div class="muted" style="padding:20px">Sin resultados.</div>}
      </div>
    </>
  );
}

// Mixture of Agents: presets del provider virtual "moa". Cada preset combina
// modelos de referencia (opinan en paralelo, sin tools) + un agregador (actúa).
// Se usan eligiendo el preset como modelo con provider moa — en cualquier
// persona o cron desde el mismo picker de modelos. Crear/editar escribe el
// bloque moa: de config.yaml (backend valida con `hermes moa list` + rollback).
function MoaCard({ moa, providers, reload }) {
  const [editing, setEditing] = useState(null); // null | preset | {} (nuevo)
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const del = async (p) => {
    if (!confirm(`¿Borrar el preset "${p.name}"?`)) return;
    setBusy(true); setMsg(null);
    try { const r = await post('/api/moa/delete', { name: p.name }); setMsg({ ok: true, text: r.stdout || 'borrado' }); reload(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div class="card" style="margin-top:16px">
      <div class="spread" style="margin-bottom:10px">
        <h3><span class="msr" style="font-size:18px;vertical-align:-3px;color:var(--gold)">hub</span> Mixture of Agents <span class="muted" style="font-weight:400;font-size:12px">— referencias opinan, el agregador actúa</span></h3>
        <button class="chip small" disabled={busy} onClick={() => { setEditing(editing && !editing.name ? null : {}); setMsg(null); }}>
          <span class="msr" style="font-size:14px">add</span>Nuevo preset
        </button>
      </div>
      {msg && <div class="mono" style={`font-size:11px;margin-bottom:8px;color:${msg.ok ? 'var(--ok)' : 'var(--err)'}`}>{msg.ok ? '✓ ' : '✕ '}{msg.text}</div>}
      {editing && (
        <MoaForm providers={providers} initial={editing.name ? editing : null}
          onDone={(m) => { setEditing(null); if (m) setMsg(m); if (m?.ok) reload(); }} />
      )}
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
        {moa.presets.map((p) => (
          <div style="padding:10px 12px;background:var(--panel-2);border-radius:var(--radius-m)" key={p.name}>
            <div class="spread">
              <b style="font-size:13px">{p.name}</b>
              <span class="chip small mono">moa/{p.name}</span>
            </div>
            <div class="muted" style="font-size:11px;margin:8px 0 4px;text-transform:uppercase">Referencias</div>
            <div class="wrap">
              {p.references.map((r) => <span class="chip small mono" key={r}>{r}</span>)}
              {p.references.length === 0 && <span class="muted" style="font-size:12px">—</span>}
            </div>
            <div class="muted" style="font-size:11px;margin:8px 0 4px;text-transform:uppercase">Agregador</div>
            {p.aggregator && <span class="chip small mono">{p.aggregator}</span>}
            <div class="wrap" style="margin-top:10px">
              <button class="chip small" disabled={busy} onClick={() => { setEditing(p); setMsg(null); }}><span class="msr" style="font-size:14px">edit</span>editar</button>
              <button class="chip small" disabled={busy} style="color:var(--err)" onClick={() => del(p)}><span class="msr" style="font-size:14px">delete</span></button>
            </div>
          </div>
        ))}
      </div>
      <div class="muted" style="font-size:11px;margin-top:10px">
        Para usar un preset: editá el modelo de una persona o un cron y elegilo en el grupo "moa".
      </div>
    </div>
  );
}

// Form de preset MoA: N referencias + 1 agregador, opciones desde /api/models
// (sin el grupo moa — un preset no puede referenciar otro preset).
function MoaForm({ providers, initial, onDone }) {
  const provs = providers.filter((p) => p.name !== 'moa');
  const toVal = (s) => { const i = (s || '').indexOf(':'); return i > 0 ? `${s.slice(0, i)}|${s.slice(i + 1)}` : ''; };
  const parse = (v) => { const i = v.indexOf('|'); return { provider: v.slice(0, i), model: v.slice(i + 1) }; };
  const [name, setName] = useState(initial?.name || '');
  const [refs, setRefs] = useState(initial?.references?.length ? initial.references.map(toVal) : ['']);
  const [ag, setAg] = useState(initial ? toVal(initial.aggregator) : '');
  const [busy, setBusy] = useState(false);
  const setRef = (i, v) => setRefs((r) => r.map((x, j) => (j === i ? v : x)));

  const Sel = ({ value, onChange, placeholder }) => (
    <div class="search">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={busy}>
        <option value="" disabled>{placeholder}</option>
        {provs.map((p) => (
          <optgroup label={p.name} key={p.name}>
            {p.models.map((m) => <option value={`${p.name}|${m}`} key={m}>{m}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post('/api/moa/save', {
        name, references: refs.filter(Boolean).map(parse), aggregator: ag ? parse(ag) : null,
      });
      onDone({ ok: true, text: r.stdout || 'preset guardado' });
    } catch (e) { onDone({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };
  const valid = name.trim() && refs.some(Boolean) && ag;

  return (
    <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:12px;background:var(--panel-2);border-radius:var(--radius-m);margin-bottom:12px">
      <div class="search"><input placeholder="Nombre del preset — ej: razonadores" value={name} disabled={busy || !!initial} onInput={(e) => setName(e.target.value)} /></div>
      <div class="muted" style="font-size:11px;text-transform:uppercase">Referencias (opinan en paralelo)</div>
      {refs.map((v, i) => (
        <div class="row" key={i} style="min-width:0">
          <div class="grow" style="min-width:0"><Sel value={v} onChange={(x) => setRef(i, x)} placeholder="elegí un modelo…" /></div>
          {refs.length > 1 && <button class="chip small" disabled={busy} onClick={() => setRefs((r) => r.filter((_, j) => j !== i))}><span class="msr" style="font-size:14px">close</span></button>}
        </div>
      ))}
      {refs.length < 8 && <div><button class="chip small" disabled={busy} onClick={() => setRefs((r) => [...r, ''])}><span class="msr" style="font-size:14px">add</span>agregar referencia</button></div>}
      <div class="muted" style="font-size:11px;text-transform:uppercase">Agregador (actúa y usa las tools)</div>
      <Sel value={ag} onChange={setAg} placeholder="elegí el agregador…" />
      <div class="wrap">
        <button class="chip filter-chip on" disabled={busy || !valid} onClick={submit}>{busy ? 'Guardando…' : (initial ? 'Guardar cambios' : 'Crear preset')}</button>
        <button class="chip" disabled={busy} onClick={() => onDone(null)}>Cancelar</button>
      </div>
    </div>
  );
}

// Modelo default de la persona: chips + edición inline. Escribe el
// model.default/provider del config.yaml del perfil vía `hermes config set`.
function PersonaModel({ p, reload }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async ({ model, provider }) => {
    setBusy(true); setErr(null);
    try {
      await post('/api/personas/model', { profile: p.profile, model, provider });
      setEditing(false);
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div style="margin:6px 0 10px">
      <div class="wrap">
        <span class="chip small mono">{p.model || 'modelo por defecto'}</span>
        {p.provider && <span class="chip small">{p.provider}</span>}
        {!editing && (
          <button class="chip small" onClick={() => setEditing(true)} title="Cambiar modelo default">
            <span class="msr" style="font-size:14px">edit</span>
          </button>
        )}
      </div>
      {editing && (
        <div style="margin-top:8px">
          <ModelPicker model={p.model} provider={p.provider} busy={busy} onSave={save} onCancel={() => { setEditing(false); setErr(null); }} />
        </div>
      )}
      {err && <div class="mono" style="color:var(--err);font-size:11px;margin-top:6px">{err}</div>}
    </div>
  );
}

function CuratorCard({ c, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const toggle = async () => { setBusy(true); try { await post('/api/dreaming/consolidate', { on: !c.consolidate }); reload(); } finally { setBusy(false); } };
  const run = async () => {
    setBusy(true); setMsg(null);
    try { const r = await post('/api/dreaming/run', { consolidate: true }); setMsg((r.output || 'listo').split('\n').filter(Boolean).slice(-2).join(' · ')); reload(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div class="card" style="margin-top:16px">
      <div class="spread" style="margin-bottom:10px">
        <h3><span class="msr" style="font-size:18px;vertical-align:-3px;color:var(--gold)">recycling</span> Curator <span class="muted" style="font-weight:400;font-size:12px">— el agente poda y consolida sus propias skills</span></h3>
        <span class="chip small"><Dot state={c.enabled ? 'ok' : 'paused'} />{c.enabled ? 'activo' : 'pausado'}</span>
      </div>
      <div class="wrap" style="margin-bottom:12px">
        <span class="chip small">{c.totalSkills} skills del agente</span>
        <span class="chip small">activas {c.active}</span>
        <span class="chip small">stale {c.stale}</span>
        <span class="chip small">archivadas {c.archived}</span>
        <span class="chip small">cada {c.interval}</span>
      </div>
      <div class="spread" style="padding:10px 12px;background:var(--panel-2);border-radius:var(--radius-m)">
        <div><b style="font-size:13px">Consolidación LLM</b><div class="muted" style="font-size:11px">fusiona/poda skills solapadas</div></div>
        <div class="wrap">
          <button class="chip small" disabled={busy} onClick={run}><span class="msr" style="font-size:14px">play_arrow</span>Correr ahora</button>
          <button class={`chip filter-chip ${c.consolidate ? 'on' : ''}`} disabled={busy} onClick={toggle}>{c.consolidate ? 'ON' : 'OFF'}</button>
        </div>
      </div>
      {msg && <div class="muted mono" style="font-size:11px;margin-top:8px">{msg}</div>}
      {c.lastSummary && <div class="muted mono" style="font-size:11px;margin-top:8px">última: {c.lastSummary} · {c.lastRun}</div>}
    </div>
  );
}
