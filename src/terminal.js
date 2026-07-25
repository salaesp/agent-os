// Consola web: una terminal real (PTY) corriendo `claude` dentro de un workspace.
// Zero-dep, como el resto del server. La persistencia la pone tmux: la sesión vive
// en el server, así que refrescar la página (o cerrar el browser) no mata a Claude.
//
// Arquitectura:
//   tmux new-session -d -s agentos-<ws> -c <dir> claude   ← el proceso, persistente
//   script -qfec "tmux attach -t ..." /dev/null           ← PTY por cada cliente web
//   stdout del attach → SSE (base64)   ·   POST /input → stdin del attach
//
// El PTY hace falta porque `tmux attach` exige un tty y Node no puede abrir uno sin
// una dependencia nativa (node-pty). `script` ya viene con util-linux.
import { spawn, execFile } from 'node:child_process';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const PREFIX = 'agentos-';
const MAX_INPUT = 64 * 1024;
const clampCols = (n, d) => Math.min(Math.max(Number(n) || d, 20), 500);
const clampRows = (n, d) => Math.min(Math.max(Number(n) || d, 5), 200);

function tmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// --- Workspaces: carpetas donde se puede levantar un Claude ---------------------
// Allowlist estricta: solo subdirectorios directos de CODE_GRAPH_ROOT (~/code) más
// el propio Agent OS. El id se valida siempre contra esta lista, así un id armado a
// mano no puede escaparse a otra ruta.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const selfDir = join(import.meta.dirname, '..');

export async function listWorkspaces() {
  const root = config.codeGraphRoot;
  const out = new Map();
  const add = (path) => { const id = slug(basename(path)); if (id) out.set(id, { id, name: basename(path), path }); };
  add(selfDir);
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { /* sin ~/code */ }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const path = join(root, e.name);
    // readdir con withFileTypes no resuelve symlinks: Dirent.isDirectory() da
    // false para un symlink aunque apunte a una carpeta real (ej. ~/code/juli-app
    // -> /home/juli/code/juli-app). Para esos casos hay que resolver con stat().
    if (e.isDirectory()) add(path);
    else if (e.isSymbolicLink()) {
      const target = await stat(path).catch(() => null);
      if (target?.isDirectory()) add(path);
    }
  }
  return [...out.values()].sort((a, b) => (a.path === selfDir ? -1 : b.path === selfDir ? 1 : a.name.localeCompare(b.name)));
}

async function resolveWorkspace(id) {
  return (await listWorkspaces()).find((w) => w.id === id) || null;
}

// --- Sesiones tmux --------------------------------------------------------------
const sessionName = (id) => PREFIX + id;

async function sessionAlive(name) {
  return (await tmux(['has-session', '-t', name])).ok;
}

// Crea la sesión si no existe. Devuelve {ok, created} o {ok:false, error}.
async function ensureSession(ws, cols, rows) {
  const name = sessionName(ws.id);
  if (await sessionAlive(name)) return { ok: true, created: false };

  const c = clampCols(cols, 120);
  const r = clampRows(rows, 34);
  const created = await tmux([
    'new-session', '-d', '-s', name, '-c', ws.path, '-x', String(c), '-y', String(r),
    '-e', 'TERM=xterm-256color', '-e', `AGENTOS_WORKSPACE=${ws.name}`,
    config.claudeBin,
  ]);
  if (!created.ok) return { ok: false, error: created.stderr || 'no se pudo crear la sesión tmux' };

  // Que se vea como una terminal pelada, no como tmux:
  //  · status off    → sin barra verde abajo
  //  · prefix None   → Ctrl+B llega a Claude, no lo come tmux
  //  · escape-time 0 → Esc instantáneo (Claude lo usa para interrumpir)
  // El tamaño NO se toca acá: lo manda el PTY de cada cliente (ver attachStream) y
  // tmux ajusta la ventana al último que se redimensionó (`window-size latest`, el
  // default). Probamos `window-size manual` + `resize-window` y no sirve: tmux le
  // manda al cliente solo el recorte que entra en SU terminal, así que la ventana
  // puede medir 170 columnas y vos igual ves 80.
  await tmux(['set-option', '-t', name, 'status', 'off']);
  await tmux(['set-option', '-t', name, 'prefix', 'None']);
  await tmux(['set-option', '-t', name, 'prefix2', 'None']);
  await tmux(['set-option', '-t', name, 'default-terminal', 'xterm-256color']);
  await tmux(['set-option', '-s', 'escape-time', '0']);
  return { ok: true, created: true };
}

export async function getSessions() {
  const r = await tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{window_width}x#{window_height}']);
  if (!r.ok || !r.stdout) return { sessions: [] };
  const sessions = r.stdout.split('\n').filter((l) => l.startsWith(PREFIX)).map((l) => {
    const [name, created, attached, size] = l.split('\t');
    return { id: name.slice(PREFIX.length), createdAt: Number(created) * 1000, viewers: Number(attached), size };
  });
  return { sessions };
}

export async function killSession(id) {
  const ws = await resolveWorkspace(id);
  if (!ws) return { ok: false, error: 'workspace desconocido' };
  const name = sessionName(id);
  for (const [token, c] of clients) if (c.id === id) { c.child.kill('SIGKILL'); clients.delete(token); }
  const r = await tmux(['kill-session', '-t', name]);
  return { ok: true, killed: r.ok };
}

// Redimensionar = cambiar el tamaño del PTY de ESTE cliente. El ioctl le manda un
// SIGWINCH al cliente tmux, que le avisa al server, que reajusta la ventana y
// redibuja — el mismo camino que cuando estirás una terminal de verdad.
export async function resizeSession(token, cols, rows) {
  const c = clampCols(cols, 120);
  const r = clampRows(rows, 34);
  const client = clients.get(token);
  if (!client) return { ok: false, error: 'sesión de vista caducada' };
  const tty = await client.tty;
  if (!tty) return { ok: false, error: 'no se pudo resolver el PTY del cliente' };
  const done = await new Promise((resolve) => {
    execFile('stty', ['-F', tty, 'rows', String(r), 'cols', String(c)], { timeout: 5000 }, (err) => {
      resolve({ ok: !err, cols: c, rows: r });
    });
  });
  // Redibujo completo para este cliente: sin esto pueden quedar restos del tamaño
  // anterior en las filas que ya no existen.
  if (done.ok) await tmux(['refresh-client', '-t', tty]);
  return done;
}

// El PTY del cliente es el stdin del proceso que `script` dejó adentro (el `exec`
// hace que ese hijo único sea el propio `tmux attach`). Sin esto habría que meter
// node-pty solo para poder llamar a TIOCSWINSZ.
async function resolveTty(pid) {
  for (let i = 0; i < 40; i++) { // el hijo tarda unos ms en existir
    try {
      const kids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      for (const k of kids) {
        const tty = await readlink(`/proc/${k}/fd/0`).catch(() => null);
        if (tty && tty.startsWith('/dev/pts/')) return tty;
      }
    } catch { return null; } // el proceso ya murió
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

// --- Clientes conectados (un PTY `script` por pestaña abierta) -------------------
const clients = new Map(); // token → { id, child }

export function writeInput(token, dataB64) {
  const c = clients.get(token);
  if (!c) return { ok: false, error: 'sesión de vista caducada' };
  const buf = Buffer.from(String(dataB64 || ''), 'base64');
  if (!buf.length) return { ok: true };
  if (buf.length > MAX_INPUT) return { ok: false, error: 'input demasiado grande' };
  c.child.stdin.write(buf);
  return { ok: true };
}

// Abre el stream SSE: adjunta un PTY nuevo a la sesión tmux y bombea su salida.
// El primer evento es {type:'ready', token} — el token es lo que el browser usa
// después para mandar teclas a ESTE attach.
export async function attachStream(req, res, { workspace, cols, rows }) {
  const ws = await resolveWorkspace(workspace);
  if (!ws) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'workspace desconocido' }));
  }
  const started = await ensureSession(ws, cols, rows);
  if (!started.ok) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: started.error }));
  }
  const name = sessionName(ws.id);
  // `script` nos da el tty que tmux attach necesita. -f: flush inmediato (sin esto
  // la salida sale a borbotones). -q: sin banner. -e: propaga el exit code.
  //
  // El `stty` NO es decorativo: el PTY de script nace SIN tamaño, tmux lo asume
  // 80x24 y le manda al cliente solo el recorte de 80x24 de la ventana. Eso se ve
  // exactamente como una consola cortada. Acá le damos el tamaño real del browser
  // antes de que tmux lo lea, y el `exec` deja al cliente tmux como único hijo de
  // `script` (así resolveTty() encuentra su PTY para los resize posteriores).
  // (El nombre de sesión va a un shell, pero slug() lo restringe a [a-z0-9-].)
  const attachCmd = `stty rows ${clampRows(rows, 34)} cols ${clampCols(cols, 120)} 2>/dev/null; exec tmux attach -t ${name}`;
  const child = spawn('script', ['-qfec', attachCmd, '/dev/null'], {
    cwd: ws.path,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const token = randomUUID();
  // La promesa del tty se resuelve una vez y queda cacheada en el registro: los
  // resize del browser no pagan el paseo por /proc cada vez.
  clients.set(token, { id: ws.id, child, tty: resolveTty(child.pid) });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, payload) => { try { res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); } catch { /* cliente ido */ } };
  send('ready', { token, workspace: ws.id, path: ws.path, fresh: started.created });

  child.stdout.on('data', (b) => send('out', { b64: b.toString('base64') }));
  child.stderr.on('data', (b) => send('out', { b64: b.toString('base64') }));

  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* ignore */ } }, 20_000);
  const cleanup = () => {
    clearInterval(ka);
    clients.delete(token);
    if (!child.killed) child.kill('SIGKILL'); // solo cierra ESTE attach; tmux sigue vivo
  };
  child.on('exit', () => { send('exit', {}); cleanup(); try { res.end(); } catch { /* ignore */ } });
  req.on('close', cleanup);
  req.on('error', cleanup);
}
