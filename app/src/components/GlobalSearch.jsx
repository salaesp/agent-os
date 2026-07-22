import { useState, useEffect, useRef } from 'preact/hooks';
import { get } from '../api.js';
import { go } from '../route.js';
import { personaLabel } from '../persona.js';

// Búsqueda global en la titlebar: sesiones · memorias · skills · documentos.
export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => {
      get(`/api/search?q=${encodeURIComponent(q.trim())}`).then((r) => { setRes(r); setOpen(true); }).catch(() => setRes(null));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    addEventListener('mousedown', onDoc);
    return () => removeEventListener('mousedown', onDoc);
  }, []);

  const nav = (fn) => { fn(); setOpen(false); setQ(''); setRes(null); };
  const total = res ? res.sessions.length + res.memories.length + res.skills.length + res.docs.length : 0;

  return (
    <div ref={boxRef} style="position:relative;flex:1;max-width:520px;margin:0 8px">
      <div style="display:flex;align-items:center;gap:8px;background:var(--panel-2);border:1px solid var(--hairline);border-radius:var(--radius-full);padding:5px 12px">
        <span class="msr" style="font-size:17px;color:var(--text-3)">search</span>
        <input value={q} onInput={(e) => setQ(e.target.value)} onFocus={() => res && setOpen(true)}
          placeholder="Buscar en todo…" style="flex:1;border:none;background:none;color:inherit;font:inherit;outline:none;font-size:13px" />
        {q && <span class="msr" style="font-size:16px;color:var(--text-3);cursor:pointer" onClick={() => { setQ(''); setRes(null); }}>close</span>}
      </div>

      {open && res && (
        <div class="card" style="position:absolute;top:44px;left:0;right:0;z-index:60;max-height:70vh;overflow:auto;box-shadow:var(--shadow);padding:8px">
          {total === 0 && <div class="muted" style="padding:12px">Sin resultados para «{res.q}».</div>}
          {res.sessions.length > 0 && <Group icon="forum" title="Conversaciones">
            {res.sessions.slice(0, 6).map((s, i) => <Item key={i} onClick={() => nav(() => go('chat', { session: s.sessionId, profile: s.profile }))}
              main={s.title} sub={s.snippet} chip={personaLabel(s.profile)} />)}
          </Group>}
          {res.skills.length > 0 && <Group icon="auto_awesome" title="Skills">
            {res.skills.slice(0, 6).map((s) => <Item key={s.name} onClick={() => nav(() => go('pantheon', { skill: s.name }))}
              main={s.name} sub={s.description} chips={(s.profiles || []).map(personaLabel)} />)}
          </Group>}
          {res.memories.length > 0 && <Group icon="neurology" title="Memorias">
            {res.memories.map((m, i) => <Item key={i} onClick={() => nav(() => go('profile'))} main={`${personaLabel(m.profile)} · ${m.which}`} sub={m.snippet} />)}
          </Group>}
          {res.docs.length > 0 && <Group icon="folder" title="Documentos">
            {res.docs.map((d) => <Item key={d.path} onClick={() => nav(() => go('obsidian'))} main={d.name} sub={d.preview} chip={d.type} />)}
          </Group>}
        </div>
      )}
    </div>
  );
}

function Group({ icon, title, children }) {
  return (
    <div style="margin-bottom:6px">
      <div class="row" style="padding:6px 8px 2px;font-size:11px"><span class="msr" style="font-size:14px;color:var(--gold)">{icon}</span><b class="muted">{title}</b></div>
      {children}
    </div>
  );
}
function Item({ main, sub, chip, chips, onClick }) {
  return (
    <div class="list-row" style="cursor:pointer;padding:8px 10px;background:transparent" onClick={onClick}>
      <div class="grow" style="min-width:0">
        <div class="title ellipsis" style="font-size:12.5px">{main}</div>
        {sub && <div class="muted ellipsis" style="font-size:11px">{sub}</div>}
      </div>
      {chip && <span class="chip small">{chip}</span>}
      {chips && <div class="wrap">{chips.map((c) => <span class="chip small" key={c}>{c}</span>)}</div>}
    </div>
  );
}
