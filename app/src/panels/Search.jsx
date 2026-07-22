import { useState, useEffect } from 'preact/hooks';
import { get } from '../api.js';
import { PageHead, rel } from '../components/ui.jsx';
import { go } from '../route.js';

export function Search() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    setLoading(true);
    const t = setTimeout(() => {
      get(`/api/search?q=${encodeURIComponent(q.trim())}`)
        .then(setRes).catch(() => setRes(null)).finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const total = res ? res.sessions.length + res.memories.length + res.skills.length + res.docs.length : 0;

  return (
    <>
      <PageHead title="Buscador" sub="Sesiones · memorias · skills · documentos — tocá un resultado para abrirlo" />
      <div class="search" style="margin-bottom:18px">
        <input autofocus placeholder="Buscar en todo lo que el agente sabe…" value={q} onInput={(e) => setQ(e.target.value)}
          style="font-size:15px;padding:12px 18px" />
      </div>

      {loading && <div class="muted">buscando…</div>}
      {res && !loading && total === 0 && <div class="card"><div class="muted">Sin resultados para «{res.q}».</div></div>}

      {res && res.sessions.length > 0 && (
        <Section title="Conversaciones" icon="forum" count={res.sessions.length}>
          {res.sessions.map((s, i) => (
            <Row key={i} onClick={() => go('chat', { session: s.sessionId, profile: s.profile })}>
              <div class="grow">
                <div class="title" style="font-size:13px">{s.title} <span class="chip small">{s.profile}</span> <span class="muted" style="font-weight:400">· {s.role}</span></div>
                <div class="muted" style="font-size:12px">{s.snippet}</div>
              </div>
              <span class="muted" style="font-size:11px">{s.ts ? rel(typeof s.ts === 'number' ? new Date(s.ts * (s.ts < 1e12 ? 1000 : 1)).toISOString() : s.ts) : ''}</span>
            </Row>
          ))}
        </Section>
      )}
      {res && res.memories.length > 0 && (
        <Section title="Memorias" icon="neurology" count={res.memories.length}>
          {res.memories.map((m, i) => (
            <Row key={i} onClick={() => go('memory')}><div class="grow"><span class="chip small">{m.profile} · {m.which}</span> <span class="muted" style="font-size:12px">…{m.snippet}…</span></div></Row>
          ))}
        </Section>
      )}
      {res && res.skills.length > 0 && (
        <Section title="Skills" icon="auto_awesome" count={res.skills.length}>
          {res.skills.map((s) => (
            <Row key={s.category + '/' + s.name} onClick={() => go('pantheon', { skill: s.name })}>
              <div class="grow">
                <div class="title" style="font-size:13px">{s.name} <span class="muted" style="font-weight:400;font-size:12px">· {s.category}</span></div>
                <div class="muted" style="font-size:12px">{s.description}</div>
                {s.profiles?.length > 0 && <div class="muted" style="font-size:10px;margin-top:2px">perfiles: {s.profiles.join(', ')}</div>}
              </div>
              <span class="chip small">{s.useCount}×</span>
            </Row>
          ))}
        </Section>
      )}
      {res && res.docs.length > 0 && (
        <Section title="Documentos" icon="folder" count={res.docs.length}>
          {res.docs.map((d) => (
            <Row key={d.path} onClick={() => go('docs', { doc: d.path })}>
              <div class="grow"><span class="title" style="font-size:13px">{d.name}</span> <span class="muted" style="font-size:12px">{d.preview}</span></div>
              <span class="chip small">{d.type}</span>
            </Row>
          ))}
        </Section>
      )}
    </>
  );
}

function Row({ onClick, children }) {
  return (
    <div class="list-row" style="cursor:pointer" onClick={onClick}>
      {children}
      <span class="msr" style="font-size:16px;color:var(--text-3)">chevron_right</span>
    </div>
  );
}

function Section({ title, icon, count, children }) {
  return (
    <div style="margin-bottom:20px">
      <div class="row" style="margin-bottom:8px"><span class="msr" style="color:var(--gold)">{icon}</span><b>{title}</b><span class="chip small">{count}</span></div>
      <div class="list">{children}</div>
    </div>
  );
}
