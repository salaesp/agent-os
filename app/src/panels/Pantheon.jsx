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
  const [q, setQ] = useState(routeParam('skill') || '');
  const [cat, setCat] = useState('todas');
  const [persona, setPersona] = useState('todas');
  const [onlyUsed, setOnlyUsed] = useState(false);

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

      {curator.data?.ok && <CuratorCard c={curator.data} reload={curator.reload} />}

      <h3 style="margin:26px 0 10px">Skills</h3>
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
