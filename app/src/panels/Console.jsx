// Consola: terminal real (xterm.js) atada a un `claude` que corre en el server
// dentro de un tmux persistente. Refrescar la página no lo mata: te reconectás a
// la misma sesión, con el scrollback y el prompt donde lo dejaste.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { get, post } from '../api.js';
import { PageHead } from '../components/ui.jsx';
import { routeParam } from '../route.js';

const LAST_WS = 'agentos.console.workspace';

// Paleta alineada con el tema del Agent OS (el dorado es el acento de la casa).
function themeFor(mode) {
  const dark = mode !== 'light';
  return dark
    ? { background: '#1b1b1d', foreground: '#f2f2f4', cursor: '#ffb000', selectionBackground: 'rgba(255,176,0,.28)',
        black: '#2a2a2d', red: '#ff6b6b', green: '#7ddf87', yellow: '#ffb000', blue: '#6fb3ff',
        magenta: '#d99bff', cyan: '#6fe3e1', white: '#f2f2f4', brightBlack: '#79797f', brightRed: '#ff9090',
        brightGreen: '#a2f0aa', brightYellow: '#ffd700', brightBlue: '#9dcbff', brightMagenta: '#e9c2ff',
        brightCyan: '#a5f2f0', brightWhite: '#ffffff' }
    : { background: '#ffffff', foreground: '#1d1d1f', cursor: '#c97e00', selectionBackground: 'rgba(201,126,0,.20)',
        black: '#1d1d1f', red: '#c62828', green: '#2e7d32', yellow: '#c97e00', blue: '#1565c0',
        magenta: '#7b1fa2', cyan: '#00838f', white: '#e9e9ec', brightBlack: '#8e8e93', brightRed: '#e53935',
        brightGreen: '#43a047', brightYellow: '#f9a825', brightBlue: '#1e88e5', brightMagenta: '#8e24aa',
        brightCyan: '#00acc1', brightWhite: '#1d1d1f' };
}

export function Console() {
  const [workspaces, setWorkspaces] = useState([]);
  const [ws, setWs] = useState(routeParam('ws') || localStorage.getItem(LAST_WS) || '');
  const [status, setStatus] = useState('idle'); // idle | connecting | live | ended | error
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null); // { path, fresh }
  const [nonce, setNonce] = useState(0);   // fuerza reconexión

  const hostRef = useRef(null);
  const cardRef = useRef(null);
  const wsRef = useRef(ws); // el ResizeObserver se monta una vez: necesita leer el actual
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const tokenRef = useRef(null);
  const outBuf = useRef('');
  const flushT = useRef(null);
  const fitT = useRef(null);
  const sentSize = useRef('');
  const [dims, setDims] = useState('');

  useEffect(() => {
    get('/api/term/workspaces').then((r) => {
      const list = r.workspaces || [];
      setWorkspaces(list);
      if (!list.some((w) => w.id === ws)) setWs(list[0]?.id || '');
    }).catch((e) => setError(e.message));
  }, []);

  // Teclas → server. Se agrupan en ventanas de 10ms para no mandar un POST por
  // pulsación cuando pegás un bloque de texto.
  const flush = () => {
    flushT.current = null;
    const data = outBuf.current;
    outBuf.current = '';
    if (!data || !tokenRef.current) return;
    const bytes = new TextEncoder().encode(data);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b); // sin spread: un paste grande revienta la pila
    const b64 = btoa(bin);
    post('/api/term/input', { token: tokenRef.current, data: b64 }).catch(() => {
      setStatus('ended'); // el attach murió (server reiniciado) → hay que reconectar
    });
  };

  // Altura de la tarjeta = lo que queda de viewport, medido. Un `calc(100vh - N)`
  // a ojo no sirve: hay que descontar el encabezado (que cambia de alto según el
  // texto) y el padding inferior de `.content`, o la consola termina unos píxeles
  // por debajo del fondo y aparece un scroll mínimo en el contenedor.
  const sizeCard = () => {
    const el = cardRef.current;
    if (!el || !el.parentElement) return;
    // `+ scrollY` para que la medida no dependa de dónde está el scroll.
    const top = el.getBoundingClientRect().top + window.scrollY;
    // Si medimos antes de que el layout esté asentado sale top≈0, la tarjeta queda
    // más alta que el viewport y el texto se va por debajo del contenedor. El
    // titlebar solo ya mide 46px, así que cualquier cosa menor es una medición mala.
    if (top < 46) return;
    const padBottom = parseFloat(getComputedStyle(el.parentElement).paddingBottom) || 0;
    const px = `${Math.round(Math.max(320, window.innerHeight - top - padBottom))}px`;
    if (el.style.height !== px) el.style.height = px; // idempotente: no realimenta al observer
  };

  // FitAddon divide el ancho disponible por un ancho de carácter que difiere en
  // decimales del que termina dibujando el renderer, así que a veces se pasa por
  // una fracción de columna y la última queda recortada contra el borde. Sumar
  // padding "de holgura" no sirve: la relación es en diente de sierra y puede
  // empeorar. Se mide lo dibujado y, si excede, se saca una columna.
  const trimOverflowingColumn = () => {
    const term = termRef.current;
    const box = term?.element;                       // el div .xterm: es el que recorta
    const screen = box?.querySelector('.xterm-screen');
    if (!box || !screen) return;
    if (screen.getBoundingClientRect().width > box.clientWidth + 0.5 && term.cols > 20) {
      term.resize(term.cols - 1, term.rows);
    }
  };

  // Remide todo y propaga el tamaño final al PTY del server. Es lo que mantiene
  // alineado el ancho de Claude con el del contenedor: si el PTY es más chico que
  // xterm, tmux manda solo el recorte que entra y la consola se ve cortada.
  // Si el stream todavía no dio el token, el tamaño ya viaja en la URL del attach.
  const applyFit = (force = false) => {
    const term = termRef.current;
    if (!term || !fitRef.current) return;
    clearTimeout(fitT.current);
    fitT.current = setTimeout(() => {
      sizeCard();
      try { fitRef.current.fit(); } catch { return; } // panel oculto: sin dimensiones
      trimOverflowingColumn();
      const size = `${term.cols}x${term.rows}`;
      setDims(size);
      if (!force && size === sentSize.current) return;
      sentSize.current = size;
      if (tokenRef.current) post('/api/term/resize', { token: tokenRef.current, cols: term.cols, rows: term.rows }).catch(() => {});
    }, force ? 0 : 80);
  };

  // Monta la terminal una sola vez.
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const mode = document.documentElement.getAttribute('data-theme') || 'dark';
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: themeFor(mode),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    term.onData((d) => {
      outBuf.current += d;
      if (!flushT.current) flushT.current = setTimeout(flush, 10);
    });
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => applyFit());
    ro.observe(hostRef.current);
    addEventListener('resize', applyFit);
    // El primer fit() cae antes de que el layout y la fuente estén asentados, así
    // que mide de menos. Remedimos cuando la fuente termina de cargar.
    document.fonts?.ready.then(() => applyFit(true)).catch(() => {});
    // Doble rAF: el primer frame aún no tiene el encabezado posicionado, y medir
    // ahí da una tarjeta más alta que el viewport.
    requestAnimationFrame(() => requestAnimationFrame(() => applyFit(true)));
    return () => {
      ro.disconnect(); removeEventListener('resize', applyFit);
      clearTimeout(fitT.current); term.dispose(); termRef.current = null;
    };
  }, []);

  useEffect(() => { wsRef.current = ws; }, [ws]);

  // Conecta el stream cada vez que cambia el workspace (o pedís reconectar).
  // Ojo: nada de tocar el hash acá — App renderiza el panel con key={hash} y
  // cualquier cambio de ruta remontaría la terminal entera.
  useEffect(() => {
    const term = termRef.current;
    if (!ws || !term) return;
    localStorage.setItem(LAST_WS, ws);
    term.reset();
    setStatus('connecting'); setError(null); setInfo(null);
    tokenRef.current = null;

    // Medir ANTES de abrir el stream: estos cols/rows son los que estrenan la
    // sesión tmux si todavía no existe.
    try { fitRef.current?.fit(); } catch { /* ignore */ }
    const es = new EventSource(`/api/term/attach?workspace=${encodeURIComponent(ws)}&cols=${term.cols}&rows=${term.rows}`);
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ready') {
        tokenRef.current = m.token;
        setInfo({ path: m.path, fresh: m.fresh });
        setStatus('live');
        term.focus();
        // Una sesión ya viva puede venir del tamaño de otra pantalla (el celular,
        // por ejemplo): la forzamos a esta ventana. El resize-window de tmux le
        // manda SIGWINCH a Claude, que redibuja solo — no hace falta un Ctrl+L
        // (que además borraría la pantalla).
        applyFit(true);
      } else if (m.type === 'out') {
        term.write(Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0)));
      } else if (m.type === 'exit') {
        setStatus('ended');
      }
    };
    es.onerror = () => { setStatus((s) => (s === 'live' ? 'ended' : 'error')); };
    return () => { es.close(); tokenRef.current = null; };
  }, [ws, nonce]);

  const restart = async () => {
    if (!confirm('Reiniciar Claude en este workspace. Se pierde la conversación en curso. ¿Seguir?')) return;
    await post('/api/term/kill', { workspace: ws }).catch(() => {});
    setNonce((n) => n + 1);
  };

  const label = { idle: '—', connecting: 'conectando…', live: 'en vivo', ended: 'desconectado', error: 'error' }[status];

  return (
    <>
      <PageHead title="Consola" sub={info?.path ? `claude · ${info.path}` : 'Claude Code corriendo en el server'}>
        <div class="row" style="gap:8px">
          <select class="chat-persona" style="margin:0;width:auto" value={ws} onChange={(e) => setWs(e.target.value)}>
            {workspaces.map((w) => <option value={w.id} key={w.id}>{w.name}</option>)}
          </select>
          <button class="chip" onClick={() => setNonce((n) => n + 1)} title="Reconectar la vista (no toca la sesión)">
            <span class="msr" style="font-size:16px">refresh</span>Reconectar
          </button>
          <button class="chip" onClick={restart} title="Matar la sesión y arrancar un Claude limpio">
            <span class="msr" style="font-size:16px">restart_alt</span>Reiniciar
          </button>
        </div>
      </PageHead>

      <div class="card" ref={cardRef} style="padding:0;overflow:hidden;display:flex;flex-direction:column;min-height:320px">
        <div class="row" style="gap:8px;padding:7px 12px;border-bottom:1px solid var(--hairline);font-size:12px">
          <span class={`dot ${status === 'live' ? 'ok' : status === 'connecting' ? 'warn' : status === 'idle' ? '' : 'err'}`} />
          <span class="muted">{label}</span>
          {info?.fresh && <span class="muted">· sesión nueva</span>}
          <span style="flex:1" />
          <span class="muted mono">{dims.replace('x', '×')}</span>
        </div>
        {error && <div class="muted" style="padding:10px 12px;color:var(--err)">{error}</div>}
        {status === 'ended' && (
          <div class="row" style="gap:10px;padding:8px 12px;border-bottom:1px solid var(--hairline);background:var(--panel-2)">
            <span class="muted" style="font-size:12px">Se cortó la vista. La sesión puede seguir viva en el server.</span>
            <button class="chip filter-chip on" onClick={() => setNonce((n) => n + 1)}>Reconectar</button>
          </div>
        )}
        <div class="console-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
      </div>
    </>
  );
}
