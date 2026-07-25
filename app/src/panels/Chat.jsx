import { useState, useRef, useEffect } from 'preact/hooks';
import { get, post, useApi } from '../api.js';
import { PageHead, rel } from '../components/ui.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { routeParam } from '../route.js';
import { personaLabel } from '../persona.js';

export function Chat() {
  const personas = useApi('/api/personas');
  const [profile, setProfile] = useState('(default)');
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [loadingHist, setLoadingHist] = useState(false);
  const [convosOpen, setConvosOpen] = useState(false);
  const endRef = useRef(null);
  const midRef = useRef(0);
  const nextId = () => ++midRef.current;

  const profiles = personas.data?.map((p) => p.profile) || ['(default)'];

  const loadSessions = (prof) => get(`/api/sessions?profile=${encodeURIComponent(prof)}`).then(setSessions).catch(() => setSessions([]));
  useEffect(() => { loadSessions(profile); }, [profile]);
  useEffect(() => { if (msgs.length) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [msgs, busy]);

  useEffect(() => {
    const sid = routeParam('session'); const prof = routeParam('profile');
    if (sid) { const p = prof || '(default)'; setProfile(p); openSession({ id: sid }, p); }
  }, []);

  const newConversation = () => { if (busy) return; setActiveId(null); setMsgs([]); setConvosOpen(false); };

  const openSession = async (s, prof = profile) => {
    if (busy) return;
    setActiveId(s.id); setLoadingHist(true); setMsgs([]); setConvosOpen(false);
    try {
      const rows = await get(`/api/sessions/messages?profile=${encodeURIComponent(prof)}&id=${encodeURIComponent(s.id)}`);
      setMsgs(rows.map((m) => ({ id: nextId(), role: m.role === 'assistant' ? 'agent' : 'user', text: m.text })));
    } catch { setMsgs([]); }
    finally { setLoadingHist(false); }
  };

  const streamChat = async (history) => {
    const res = await fetch('/api/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }),
    }).catch(() => null);
    if (!res || !res.ok || !res.body) return false;
    const aid = nextId();
    setMsgs((m) => [...m, { id: aid, role: 'agent', text: '' }]);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const push = (delta) => setMsgs((m) => m.map((x) => (x.id === aid ? { ...x, text: x.text + delta } : x)));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { const j = JSON.parse(payload); const d = j.choices?.[0]?.delta?.content; if (d) push(d); } catch { /* keep-alive */ }
      }
    }
    setMsgs((m) => m.map((x) => (x.id === aid && !x.text ? { ...x, text: '(sin respuesta)' } : x)));
    return true;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const history = msgs.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }));
    history.push({ role: 'user', content: text });
    setMsgs((m) => [...m, { id: nextId(), role: 'user', text }]);
    setBusy(true);
    try {
      const streamed = await streamChat(history);
      if (!streamed) {
        const r = await post('/api/chat', { profile, message: text, sessionId: activeId });
        setMsgs((m) => [...m, { id: nextId(), role: 'agent', text: r.response || '(sin respuesta)' }]);
        if (r.sessionId && r.sessionId !== activeId) { setActiveId(r.sessionId); loadSessions(profile); }
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: nextId(), role: 'agent', text: `⚠️ ${e.message}`, error: true }]);
    } finally { setBusy(false); }
  };

  const convoTitle = (s) => s.preview || `${personaLabel(s.source)} · ${s.startedAt ? relTs(s.startedAt) : ''}`;

  const tasksCount = sessions.filter((s) => s.kind === 'task').length;
  const convoList = (
    <>
      <button class="chat-new" disabled={busy} onClick={newConversation}><span class="msr" style="font-size:18px">add</span>Nueva conversación</button>
      <select class="chat-persona" value={profile} disabled={busy} onChange={(e) => { setProfile(e.target.value); newConversation(); }}>
        {profiles.map((p) => <option value={p} key={p}>{personaLabel(p)}</option>)}
      </select>
      {tasksCount > 0 && (
        <button class={`chat-tasks-toggle ${showTasks ? 'on' : ''}`} disabled={busy} onClick={() => setShowTasks((v) => !v)}>
          <span class="msr" style="font-size:15px">{showTasks ? 'visibility_off' : 'bolt'}</span>
          {showTasks ? 'Ocultar tareas' : `Ver tareas (${tasksCount})`}
        </button>
      )}
      <div class="chat-convos">
        {(() => { const shown = sessions.filter((s) => showTasks || s.kind !== 'task'); return <>
        {shown.length === 0 && <div class="muted" style="font-size:12px;padding:8px">Sin conversaciones.</div>}
        {shown.map((s) => (
          <button class={`chat-convo ${activeId === s.id ? 'active' : ''}`} disabled={busy} onClick={() => openSession(s)} key={s.id}>
            <div class="row" style="gap:6px;margin-bottom:2px">
              {s.source && <span class={`src-chip src-${s.source}`}>{srcLabel(s.source)}</span>}
              <span class="t" style="flex:1">{convoTitle(s)}</span>
            </div>
            <div class="m">{s.messageCount} msgs{s.grouped && s.threads > 1 ? ` · ${s.threads} hilos` : ''}{s.startedAt ? ` · ${relTs(s.startedAt)}` : ''}</div>
          </button>
        ))}
        </>; })()}
      </div>
    </>
  );

  return (
    <>
      <PageHead title="Chat" sub={busy ? 'el agente está respondiendo…' : `hablando con ${personaLabel(profile)}`}>
        <button class="chip show-mobile" onClick={() => setConvosOpen(true)}>
          <span class="msr" style="font-size:16px">forum</span>Conversaciones{sessions.length > 0 ? ` (${sessions.length})` : ''}
        </button>
      </PageHead>
      <div class="chat-layout">
        <aside class="chat-sidebar">{convoList}</aside>

        {convosOpen && (
          <div class="sheet-scrim" onClick={() => setConvosOpen(false)}>
            <div class="sheet-panel" onClick={(e) => e.stopPropagation()}>
              <div class="sheet-grabber" />
              <div class="spread" style="margin-bottom:10px">
                <h3 style="margin:0">Conversaciones</h3>
                <button class="chip" onClick={() => setConvosOpen(false)}><span class="msr" style="font-size:16px">close</span></button>
              </div>
              {convoList}
            </div>
          </div>
        )}

        <div class="chat-main card" style="display:flex;flex-direction:column;padding:0;overflow:hidden">
          <div style="flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:14px">
            {loadingHist && <div class="center" style="min-height:auto;margin:auto"><span class="msr" style="animation:spin 1s linear infinite">progress_activity</span></div>}
            {!loadingHist && msgs.length === 0 && (
              <div class="center" style="min-height:auto;margin:auto;text-align:center">
                <div><span class="msr" style="font-size:40px;color:var(--gold)">forum</span><div class="muted" style="margin-top:8px">{activeId ? 'Conversación vacía.' : `Nueva conversación con ${personaLabel(profile)}. Escribí un mensaje.`}</div></div>
              </div>
            )}
            {msgs.map((m) => (
              <div key={m.id} style={`max-width:80%;${m.role === 'user' ? 'align-self:flex-end' : 'align-self:flex-start'}`}>
                <div style={`padding:10px 14px;border-radius:14px;${m.role === 'user'
                  ? 'background:var(--accent);color:#1b1b1d;border-bottom-right-radius:4px'
                  : `background:var(--panel-2);border-bottom-left-radius:4px;${m.error ? 'border:1px solid var(--err)' : ''}`}`}>
                  {m.role === 'user' ? <span style="white-space:pre-wrap">{m.text}</span> : <Markdown text={m.text} />}
                </div>
              </div>
            ))}
            {busy && <div style="align-self:flex-start" class="row muted"><span class="msr" style="animation:spin 1s linear infinite;font-size:18px">progress_activity</span> el agente está pensando…</div>}
            <div ref={endRef} />
          </div>
          <div style="border-top:1px solid var(--hairline);padding:12px;display:flex;gap:10px;background:var(--panel)">
            <input value={input} onInput={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={busy ? 'esperá la respuesta…' : `Mensaje a ${personaLabel(profile)}…`} disabled={busy}
              style="flex:1;padding:11px 15px;border-radius:var(--radius-full);font:inherit;background:var(--panel-2);color:inherit;border:1px solid var(--hairline)" />
            <button class="chip filter-chip on" disabled={busy || !input.trim()} onClick={send} style="padding:0 18px"><span class="msr" style="font-size:18px">send</span></button>
          </div>
        </div>
      </div>
    </>
  );
}

const SRC_LABELS = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', whatsapp: 'WhatsApp', whatsapp_cloud: 'WhatsApp', signal: 'Signal', matrix: 'Matrix', email: 'Email', sms: 'SMS', cli: 'CLI', api: 'API', gateway: 'Gateway' };
function srcLabel(s) { return SRC_LABELS[s] || (s ? s[0].toUpperCase() + s.slice(1) : ''); }

function relTs(ts) {
  const n = Number(ts);
  if (!n) return '';
  const iso = new Date(n < 1e12 ? n * 1000 : n).toISOString();
  return rel(iso);
}
