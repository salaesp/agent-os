import { useState, useEffect } from 'preact/hooks';
import { post, useApi } from '../api.js';
import { PageHead, Loading, ErrorBox } from '../components/ui.jsx';
import { personaLabel } from '../persona.js';

const LISTS = [
  ['interests', 'Intereses', 'temas que te importan'],
  ['traits', 'Rasgos / estilo', 'cómo sos, cómo te gusta comunicarte'],
  ['workingPatterns', 'Patrones de trabajo', 'tus rutinas, horarios, hábitos'],
  ['goalsFocus', 'Foco de objetivos', 'en qué querés que insista el agente'],
];
const CATLBL = { workflow: '🛠️ Workflow', vida: '🌱 Vida', aprendizaje: '📚 Aprendizaje' };
const TREND = { rising: 'subiendo', falling: 'bajando', stable: 'estable' };

export function Profile() {
  const { data, error, loading, reload } = useApi('/api/profile');
  const prefs = useApi('/api/preferences');
  const inbox = useApi('/api/suggestions', 15000);
  const memory = useApi('/api/memory');
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [learning, setLearning] = useState(false);
  const [showDrift, setShowDrift] = useState(false);
  const [memProfile, setMemProfile] = useState('(default)');
  const [memTab, setMemTab] = useState('memory');

  useEffect(() => { if (data) setF({ ...data }); }, [data]);
  if (loading || !f) return <Loading />;
  if (error) return <><PageHead title="Perfil" /><ErrorBox error={error} /></>;

  const setList = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }));
  const save = async () => { setBusy(true); setSaved(false); try { await post('/api/profile', f); setSaved(true); reload(); } finally { setBusy(false); } };
  const learn = async () => { setLearning(true); try { await post('/api/profile/learn', {}); inbox.reload(); } catch { /* */ } finally { setLearning(false); } };
  const decide = async (id, kind) => { await post(`/api/suggestions/${kind}`, { id }); inbox.reload(); reload(); };

  const proposals = (inbox.data?.suggestions || []).filter((s) => s.action_type === 'profile' && s.status === 'new');
  const mem = (memory.data || []).find((m) => m.profile === memProfile) || {};
  const memProfiles = (memory.data || []).map((m) => m.profile);

  return (
    <>
      <PageHead title="Perfil" sub="Lo que el agente sabe de vos. Aprende solo; vos corregís.">
        <button class="chip" disabled={learning} onClick={learn} title="el agente aprende solo de noche; esto lo fuerza ahora">
          <span class="msr" style={`font-size:15px;${learning ? 'animation:spin 1s linear infinite' : ''}`}>{learning ? 'progress_activity' : 'refresh'}</span>
          {learning ? 'Aprendiendo…' : 'Actualizar'}
        </button>
      </PageHead>

      {proposals.length > 0 && (
        <div class="card" style="margin-bottom:14px;border-color:var(--accent)">
          <h3 style="margin-bottom:4px">El agente aprendió esto de vos <span class="chip small">{proposals.length}</span></h3>
          <div class="muted" style="font-size:12px;margin-bottom:10px">Lo infirió de tus conversaciones — aceptá lo que sea cierto.</div>
          <div class="list">
            {proposals.map((s) => (
              <div class="list-row" key={s.id}>
                <div class="grow"><div class="title" style="font-size:13px">{s.action_payload?.value}</div><div class="muted" style="font-size:11px">{s.action_payload?.field} · {s.rationale}</div></div>
                <div class="wrap"><button class="chip small filter-chip on" onClick={() => decide(s.id, 'apply')}>Aceptar</button><button class="chip small" onClick={() => decide(s.id, 'dismiss')}>Rechazar</button></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <h3 style="margin-bottom:10px">Lo que sabe de vos</h3>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr));align-items:start">
        {LISTS.map(([k, label, hint]) => (
          <div class="card" key={k}>
            <h3>{label}</h3>
            <div class="muted" style="font-size:11px;margin:2px 0 8px">{hint} · uno por línea</div>
            <textarea value={(f[k] || []).join('\n')} onInput={setList(k)}
              style="width:100%;min-height:100px;resize:vertical;font-family:var(--font);font-size:13px;padding:10px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
          </div>
        ))}
      </div>
      <div class="card" style="margin-top:14px">
        <h3>Notas libres</h3>
        <textarea value={f.notes || ''} onInput={(e) => setF((s) => ({ ...s, notes: e.target.value }))}
          style="width:100%;min-height:80px;resize:vertical;font-family:var(--font);font-size:13px;padding:10px;border-radius:var(--radius-m);background:var(--panel-2);color:inherit;border:1px solid var(--hairline);margin-top:8px" />
      </div>
      <div class="wrap" style="margin-top:14px;align-items:center">
        <button class="chip filter-chip on" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button>
        {saved && <span class="mono" style="font-size:11px;color:var(--ok)">✓ guardado</span>}
      </div>

      {(f.negativeSignals || []).length > 0 && (
        <div class="card" style="margin-top:14px">
          <h3>Lo que descartaste <span class="muted" style="font-weight:400;font-size:12px">(las viejas se olvidan a los ~60 días)</span></h3>
          <div class="wrap" style="margin-top:8px">{f.negativeSignals.map((n, i) => <span class="chip small" key={i}>✕ {typeof n === 'string' ? n : n.text}</span>)}</div>
        </div>
      )}

      {/* Memoria cruda del agente — SOLO LECTURA */}
      {(memory.data || []).length > 0 && (
        <div class="card" style="margin-top:22px">
          <div class="spread" style="margin-bottom:10px">
            <h3>Memoria del agente <span class="muted" style="font-weight:400;font-size:12px">(cruda, solo lectura)</span></h3>
            <div class="seg">
              {memProfiles.map((p) => <button class={memProfile === p ? 'on' : ''} onClick={() => setMemProfile(p)} key={p}>{personaLabel(p)}</button>)}
            </div>
          </div>
          <div class="seg" style="margin-bottom:10px">
            {[['memory', 'MEMORY'], ['user', 'USER'], ['soul', 'SOUL']].map(([k, l]) => <button class={memTab === k ? 'on' : ''} onClick={() => setMemTab(k)} key={k}>{l}</button>)}
          </div>
          {memTab !== 'soul' && mem[memTab] && (
            <div class="muted mono" style="font-size:11px;margin-bottom:6px">{mem[memTab].used}/{mem[memTab].cap} caracteres</div>
          )}
          <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:12px;border-radius:var(--radius-m);margin:0;max-height:320px;overflow:auto">{mem[memTab]?.text || '(vacío)'}</pre>
        </div>
      )}

      {/* Drift de preferencias — detalle escondido (opera por detrás) */}
      {prefs.data?.ok && prefs.data.total > 0 && (
        <div class="card" style="margin-top:14px">
          <button class="row" style="width:100%;justify-content:space-between" onClick={() => setShowDrift((v) => !v)}>
            <b style="font-size:14px">Preferencias aprendidas (detalle)</b>
            <span class="msr">{showDrift ? 'expand_less' : 'expand_more'}</span>
          </button>
          {showDrift && (
            <div style="margin-top:12px">
              <div class="muted" style="font-size:11.5px;margin-bottom:10px">Opera por detrás ajustando qué te sugiere. Esto es solo el detalle.</div>
              {Object.entries(prefs.data.categories).map(([c, x]) => (
                <div key={c} class="spread" style="font-size:12.5px;margin-bottom:6px">
                  <span>{CATLBL[c] || c}</span>
                  <span class="muted mono" style="font-size:11px">afinidad {Math.round(x.affinity * 100)}% · {TREND[x.trend]} · {x.n} dec.</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
