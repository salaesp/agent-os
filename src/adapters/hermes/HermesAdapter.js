// HermesAdapter — implementa AgentAdapter contra un Hermes local instalado en
// config.hermesDir. LECTURAS: archivos JSON/MD + sqlite en modo read-only.
// Itera (default) + profiles/*, patrón validado en minipc-dashboard/collectors/hermes.js.
// No abre ningún sqlite en escritura ni depende de hermes-webui (:8787).
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { writeFile, copyFile, stat, readdir, rename, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { AgentAdapter } from '../AgentAdapter.js';
import {
  readText, readJson, listDirs, listEntries,
  parseFrontmatter, extractModel, excerpt,
} from '../../util.js';

const DEFAULT_MEM_CAP = 2200;
const DEFAULT_USER_CAP = 1375;
const CRON_ACTIONS = new Set(['pause', 'resume', 'run', 'remove']);
const KANBAN_ACTIONS = new Set(['complete', 'block', 'unblock', 'archive']);
const ID_RE = /^[\w-]+$/;
// Sources de gateway: sus sesiones se agrupan por canal (chat_id) para no fragmentar
// una misma conversación (ej. un DM de Slack) en muchos hilos/sesiones.
// Ids de modelo tipo "org/nombre-v1.2:tag" (openrouter) o "gpt-5.4" (copilot).
const MODEL_RE = /^[\w.\-/:]{1,120}$/;
const GATEWAY_SOURCES = new Set(['slack', 'discord', 'telegram', 'whatsapp', 'whatsapp_cloud', 'signal', 'mattermost', 'matrix', 'feishu', 'wecom', 'weixin', 'sms', 'dingtalk', 'bluebubbles', 'homeassistant', 'email', 'msgraph_webhook']);

function readSqlite(path, fn) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

// Truncado de args para el registro de ejecuciones: los prompts pueden pesar
// varios KB y no queremos el ledger lleno de texto del modelo.
const ARG_CAP = 400;
const trimArgv = (args) => (args || []).map((a) => {
  const s = String(a);
  return s.length > ARG_CAP ? `${s.slice(0, ARG_CAP)}…(+${s.length - ARG_CAP})` : s;
});

// Un path REL está dentro de ROOT si resuelve a root mismo o a algo bajo root/.
// `full.startsWith(root)` no alcanza: "/x/vault-otro" empieza con "/x/vault".
function insideRoot(root, rel) {
  if (!root || !rel || typeof rel !== 'string') return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return (full === base || full.startsWith(base + sep)) ? full : null;
}

export class HermesAdapter {
  // `hooks` inyecta la telemetría de ejecuciones ({startRun, endRun}). Se pasa
  // por constructor a propósito: el adapter no importa el estado propio del
  // Agent OS (db.js) y esa separación se mantiene.
  constructor(dir, bin = 'hermes', vault = null, hooks = {}) {
    this.dir = dir;
    this.bin = bin;
    this.vault = vault;
    this.hooks = hooks;
    this.name = 'hermes';
  }

  // HERMES_HOME que selecciona el perfil: default → dir raíz; otros → profiles/<name>.
  _home(profile) {
    return (!profile || profile === '(default)') ? this.dir : join(this.dir, 'profiles', profile);
  }

  // Ejecuta el CLI `hermes` (sin shell → sin inyección). Nunca lanza: devuelve
  // {ok, stdout, stderr, code}. Es la ÚNICA vía de escritura hacia el agente.
  // OJO: el CLI a veces sale con código 0 aunque falle (imprime "Failed…"/"Error…"
  // en stdout), así que `ok` también inspecciona el texto.
  // Cada corrida queda registrada vía hooks (kind/argv/modelo/duración/error).
  // El registro es best-effort: si la telemetría falla, la ejecución sigue.
  _run(profile, args, { timeout = 90_000, kind = null, trigger = 'api' } = {}) {
    const mi = args.indexOf('-m');
    const runId = this.hooks.startRun?.({
      kind: kind || String(args[0] || 'other'),
      profile: profile || '(default)',
      argv: trimArgv(args),
      model: mi >= 0 ? args[mi + 1] : null,
      trigger,
    }) ?? null;
    const t0 = Date.now();
    return new Promise((done) => {
      execFile(this.bin, args, {
        env: {
          ...process.env,
          HERMES_HOME: this._home(profile),
          NODE_NO_WARNINGS: '1',
          PATH: `${join(this.dir, '..', '.local', 'bin')}:${process.env.PATH || ''}`,
        },
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        const softFail = /^(failed\b|error\b|error:)/im.test(out);
        const r = { ok: !err && !softFail, code: err?.code ?? 0, stdout: out, stderr: (stderr || '').trim() };
        this.hooks.endRun?.(runId, {
          ms: Date.now() - t0,
          ok: r.ok,
          code: r.code,
          // El softFail no deja err de execFile: sin esto una falla del CLI con
          // exit 0 quedaba registrada como error vacío.
          err: r.ok ? null : (err?.message || r.stderr || out.slice(0, 200) || 'soft-fail'),
          out_chars: out.length,
        });
        done(r);
      });
    });
  }

  // --- Escrituras: crons ---
  async cronAction(profile, id, action) {
    if (!CRON_ACTIONS.has(action)) return { ok: false, stderr: `acción inválida: ${action}` };
    if (!id || !/^[\w-]+$/.test(id)) return { ok: false, stderr: 'id inválido' };
    return this._run(profile, ['cron', action, id]);
  }

  async cronCreate(profile, { schedule, prompt, name, deliver, skills = [] }) {
    if (!schedule) return { ok: false, stderr: 'schedule requerido' };
    const args = ['cron', 'create', String(schedule)];
    if (prompt) args.push(String(prompt));
    if (name) args.push('--name', String(name));
    if (deliver) args.push('--deliver', String(deliver));
    for (const s of (skills || [])) args.push('--skill', String(s));
    return this._run(profile, args);
  }

  // Cambia el modelo/provider de UN cron. El CLI no lo expone (`cron edit` no tiene
  // --model y el flag global -m no persiste — verificado), así que editamos
  // cron/jobs.json igual que lo hace el propio Hermes: backup + escritura atómica
  // (tmp + rename). `model` vacío/null → hereda el default del perfil.
  async cronSetModel(profile, id, { model, provider } = {}) {
    if (!id || !ID_RE.test(id)) return { ok: false, stderr: 'id inválido' };
    const m = String(model ?? '').trim() || null;
    const pr = String(provider ?? '').trim() || null;
    if (m && !MODEL_RE.test(m)) return { ok: false, stderr: 'nombre de modelo inválido' };
    if (pr && !/^[\w-]{1,40}$/.test(pr)) return { ok: false, stderr: 'provider inválido' };
    const file = join(this._home(profile), 'cron', 'jobs.json');
    const data = await readJson(file);
    if (!data?.jobs) return { ok: false, stderr: 'no se pudo leer cron/jobs.json' };
    const job = data.jobs.find((j) => j.id === id);
    if (!job) return { ok: false, stderr: `cron ${id} inexistente en ${profile}` };
    job.model = m;
    job.provider = m ? pr : null; // sin modelo propio, el provider tampoco aplica
    try {
      await copyFile(file, `${file}.agentos.bak`).catch(() => {});
      const tmp = `${file}.agentos.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, file);
      return { ok: true, stdout: m ? `modelo → ${m}${pr ? ` (${pr})` : ''}` : 'modelo → heredado del perfil' };
    } catch (e) {
      return { ok: false, stderr: e.message };
    }
  }

  // Cambia el modelo default de un perfil (persona) vía `hermes config set`
  // bajo el HERMES_HOME del perfil (verificado que escribe el config.yaml correcto).
  async setPersonaModel(profile, { model, provider } = {}) {
    const m = String(model ?? '').trim();
    const pr = String(provider ?? '').trim();
    if (!m || !MODEL_RE.test(m)) return { ok: false, stderr: 'modelo requerido/inválido' };
    if (pr && !/^[\w-]{1,40}$/.test(pr)) return { ok: false, stderr: 'provider inválido' };
    const r = await this._run(profile, ['config', 'set', 'model.default', m], { timeout: 30_000 });
    if (!r.ok) return { ok: false, stderr: r.stderr || r.stdout };
    if (pr) {
      const r2 = await this._run(profile, ['config', 'set', 'model.provider', pr], { timeout: 30_000 });
      if (!r2.ok) return { ok: false, stderr: `modelo seteado pero falló el provider: ${r2.stderr || r2.stdout}` };
    }
    return { ok: true, stdout: `${profile}: modelo default → ${m}${pr ? ` (${pr})` : ''}` };
  }

  // Mixture of Agents: presets configurados (referencias en paralelo + agregador).
  // MoA es un provider VIRTUAL de Hermes: se usa con provider=moa y model=<preset>,
  // así que los presets entran al picker de modelos como un grupo más. La fuente
  // es `hermes moa list` (incluye el preset built-in "default" que no está en
  // config.yaml). Cacheado ~60s: el CLI tarda unos segundos.
  async getMoa() {
    const c = this._moaCache;
    if (c && Date.now() - c.ts < 60_000) return c.val;
    const r = await this._run('(default)', ['moa', 'list'], { timeout: 30_000 });
    const t = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
    const val = { ok: r.ok && !!t, defaultPreset: null, presets: [] };
    if (val.ok) {
      val.defaultPreset = (t.match(/^Default:\s*(\S+)/m) || [])[1] || null;
      let cur = null;
      for (const line of t.split('\n')) {
        // Cabecera de preset: "* nombre" (el default) o "  nombre" (el resto).
        // Un único token [\w-]+ — las demás líneas tienen ':', dígitos o espacios.
        const p = line.match(/^(?:\*\s+|\s{0,4})([\w-]+)\s*$/);
        if (p) { cur = { name: p[1], references: [], aggregator: null }; val.presets.push(cur); continue; }
        if (!cur) continue;
        const ref = line.match(/^\s+\d+\.\s+(\S+)/);
        if (ref) { cur.references.push(ref[1]); continue; }
        const ag = line.match(/^\s+Aggregator:\s*(\S+)/);
        if (ag) cur.aggregator = ag[1];
      }
    }
    this._moaCache = { ts: Date.now(), val };
    return val;
  }

  // Crea o reemplaza un preset MoA. `hermes moa configure` es interactivo (no
  // sirve desde acá), así que escribimos el bloque moa: de config.yaml con el
  // formato documentado. Red de seguridad: backup + escritura atómica + verificar
  // con `hermes moa list` que el CLI reconozca el preset; si no, rollback.
  async moaSavePreset({ name, references, aggregator } = {}) {
    const nm = String(name || '').trim();
    if (!/^[\w-]{1,40}$/.test(nm)) return { ok: false, stderr: 'nombre de preset inválido (letras/números/guiones)' };
    const refs = (Array.isArray(references) ? references : [])
      .map((r) => ({ provider: String(r?.provider || '').trim(), model: String(r?.model || '').trim() }));
    const ag = { provider: String(aggregator?.provider || '').trim(), model: String(aggregator?.model || '').trim() };
    if (!refs.length || refs.length > 8) return { ok: false, stderr: 'elegí entre 1 y 8 modelos de referencia' };
    for (const x of [...refs, ag]) {
      if (!/^[\w-]{1,40}$/.test(x.provider) || x.provider === 'moa') return { ok: false, stderr: `provider inválido: "${x.provider}"` };
      if (!MODEL_RE.test(x.model)) return { ok: false, stderr: `modelo inválido: "${x.model}"` };
    }
    const file = join(this.dir, 'config.yaml');
    const text = await readText(file);
    if (text == null) return { ok: false, stderr: 'no se pudo leer config.yaml' };
    const bak = `${file}.agentos-moa.bak`;
    try {
      await copyFile(file, bak);
      const tmp = `${file}.agentos.tmp`;
      await writeFile(tmp, upsertMoaPreset(text, nm, refs, ag), 'utf8');
      await rename(tmp, file);
    } catch (e) { return { ok: false, stderr: e.message }; }
    this._moaCache = null;
    const check = await this.getMoa();
    if (!check.ok || !check.presets.some((p) => p.name === nm)) {
      try { await copyFile(bak, file); } catch { /* el backup queda en disco */ }
      this._moaCache = null;
      return { ok: false, stderr: 'Hermes no reconoció el preset escrito — config.yaml restaurado del backup' };
    }
    return { ok: true, stdout: `preset "${nm}" guardado (${refs.length} referencia${refs.length > 1 ? 's' : ''} + agregador)` };
  }

  async moaDeletePreset(name) {
    const nm = String(name || '').trim();
    if (!/^[\w-]{1,40}$/.test(nm)) return { ok: false, stderr: 'nombre inválido' };
    const r = await this._run('(default)', ['moa', 'delete', nm], { timeout: 30_000 });
    this._moaCache = null;
    return { ok: r.ok, stdout: r.stdout, stderr: r.ok ? null : (r.stderr || r.stdout) };
  }

  // Modelos disponibles para el picker: la cache del selector de Hermes
  // (provider_models_cache.json) + los presets MoA (provider virtual) + los que
  // ya están en uso (crons/personas), así el dropdown nunca "pierde" un modelo.
  async getModels() {
    const cacheFile = await readJson(join(this.dir, 'provider_models_cache.json'));
    const providers = [];
    for (const [name, v] of Object.entries(cacheFile || {})) {
      const models = (v?.models || []).filter((x) => typeof x === 'string');
      if (models.length) providers.push({ name, models: models.sort() });
    }
    let moa = null;
    try {
      moa = await this.getMoa();
      if (moa.ok && moa.presets.length) {
        providers.push({ name: 'moa', models: moa.presets.map((p) => p.name) });
      }
    } catch { /* best-effort */ }
    const inUse = new Set();
    try {
      for (const c of await this.getCrons()) if (c.model) inUse.add(`${c.provider || ''}|${c.model}`);
      for (const p of await this.getPersonas()) if (p.model) inUse.add(`${p.provider || ''}|${p.model}`);
      for (const key of inUse) {
        const [prov, model] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        const bucket = providers.find((x) => x.name === (prov || 'openrouter'));
        if (bucket && !bucket.models.includes(model)) bucket.models.push(model);
        else if (!bucket) providers.push({ name: prov || 'openrouter', models: [model] });
      }
    } catch { /* best-effort */ }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    for (const p of providers) p.models.sort();
    return { ok: providers.length > 0, providers, moa: moa?.ok ? moa : null };
  }

  // --- Chat one-shot con el agente (vía CLI, sin depender del gateway :8642) ---
  // `--continue <name>` mantiene una conversación persistente por nombre. Corre el
  // agente COMPLETO (con herramientas), así que puede tardar y ejecutar acciones.
  async chat(profile, message, { sessionId, model } = {}) {
    if (!message || !String(message).trim()) return { ok: false, stderr: 'mensaje vacío' };
    const args = ['chat', '-q', String(message), '-Q'];
    if (sessionId && ID_RE.test(sessionId)) args.push('--resume', sessionId);
    if (model) args.push('-m', String(model));
    const r = await this._run(profile, args, { timeout: 240_000 });
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
    // Si era sesión nueva, devolver el id recién creado para poder retomarla.
    let sid = sessionId;
    if (!sid) sid = this._latestSessionId(profile);
    return { ok: true, response: r.stdout, sessionId: sid };
  }

  // Pass generador dirigido (para el motor de sugerencias): manda un prompt que
  // pide JSON y devuelve el texto crudo. Tool-free por instrucción del prompt.
  async generateRawSuggestions(prompt, { model, timeout = 240_000 } = {}) {
    // Tool-free (`-t ''`): pass dirigido y determinista, sin herramientas → más barato,
    // más rápido y sin riesgo de efectos secundarios mientras "piensa".
    const args = ['chat', '-q', String(prompt), '-Q', '-t', ''];
    if (model) args.push('-m', String(model));
    const r = await this._run('(default)', args, { timeout });
    return { ok: r.ok, text: r.stdout, error: r.ok ? null : (r.stderr || r.stdout) };
  }

  // --- /learn headless (skill-scout) ---
  // El slash-command /learn de Hermes no es magia de sesión: en TODAS sus
  // superficies (cli_commands_mixin, gateway/run, tui_gateway) es literalmente
  // build_learn_prompt(texto) inyectado como un turno normal del agente. Acá se
  // replica eso: prompt canónico del propio Hermes (vía el python del venv, así
  // los estándares de autoría siempre están al día) → `chat -q` con toolsets.
  buildLearnPrompt(request) {
    const py = join(this.dir, 'hermes-agent', 'venv', 'bin', 'python');
    const code = 'import sys\nfrom agent.learn_prompt import build_learn_prompt\nsys.stdout.write(build_learn_prompt(sys.argv[1]))';
    return new Promise((resolve) => {
      execFile(py, ['-c', code, String(request)], {
        cwd: join(this.dir, 'hermes-agent'), timeout: 20_000, maxBuffer: 1024 * 1024,
      }, (err, stdout) => {
        if (!err && stdout && stdout.includes('[/learn]')) return resolve(stdout);
        // Fallback si cambia el layout del paquete: prompt mínimo propio (menor
        // calidad de autoría, pero no bloquea el flujo).
        resolve(`[/learn] The user wants you to learn a reusable skill from the request below, and save it.\n\nTHE REQUEST:\n${request}\n\nGather whatever the request points to using your tools, then author ONE well-structured SKILL.md and save it via the skill_manage tool (action="create").`);
      });
    });
  }

  // Corre el /learn completo headless y devuelve qué skills aparecieron. Un diff
  // vacío con salida ok también es éxito: el agente pudo patchear una existente.
  async learnSkill(profile, request, { timeout = 600_000 } = {}) {
    if (!request || !String(request).trim()) return { ok: false, error: 'request vacío' };
    const snapshot = async () => new Set((await this.getSkills()).skills.map((s) => `${s.category}/${s.name}`));
    const before = await snapshot();
    const prompt = await this.buildLearnPrompt(String(request));
    const r = await this._run(profile, ['chat', '-q', prompt, '-Q', '-t', 'skills,file,web,terminal'], { timeout });
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
    const newSkills = [...(await snapshot())].filter((k) => !before.has(k));
    return { ok: true, newSkills, updatedExisting: newSkills.length === 0, response: r.stdout };
  }

  // Investigación con herramientas reales (web/file/terminal) — a diferencia de
  // generateRawSuggestions (tool-free a propósito), esto SÍ puede buscar y leer.
  // Lo usa investigator.js para procesar tareas del board "research".
  async research(profile, prompt, { timeout = 400_000 } = {}) {
    if (!prompt || !String(prompt).trim()) return { ok: false, error: 'prompt vacío' };
    const r = await this._run(profile, ['chat', '-q', String(prompt), '-Q', '-t', 'skills,file,web,terminal'], { timeout });
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
    return { ok: true, text: r.stdout };
  }

  // Push a un canal sin pasar por el LLM (entrega proactiva).
  async pushMessage(platform, text) {
    if (!platform || !text) return { ok: false, stderr: 'plataforma y texto requeridos' };
    const r = await this._run('(default)', ['send', '--to', String(platform), String(text)]);
    return { ok: r.ok, output: r.stdout, error: r.ok ? null : (r.stderr || r.stdout) };
  }

  _latestSessionId(profile) {
    const p = (!profile || profile === '(default)') ? this.dir : join(this.dir, 'profiles', profile);
    return readSqlite(join(p, 'state.db'), (db) =>
      db.prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1').get()?.id) || null;
  }

  // Lista sesiones recientes (con mensajes) del perfil, para retomar.
  async getSessions(profile, limit = 40) {
    const p = (!profile || profile === '(default)') ? this.dir : join(this.dir, 'profiles', profile);
    const rows = readSqlite(join(p, 'state.db'), (db) => db.prepare(
      `SELECT s.id, s.title, s.source, s.chat_id, s.chat_type, s.started_at, s.message_count, s.cwd,
              (SELECT content FROM messages WHERE session_id = s.id AND role='user'
                 AND content IS NOT NULL AND content != '' ORDER BY id LIMIT 1) AS first_user
       FROM sessions s WHERE s.message_count > 0 ORDER BY s.started_at DESC`).all());
    // Las generaciones internas del propio Agent OS (sugerencias, dreaming) corren
    // vía CLI con cwd = raíz del proyecto; se excluyen para no ensuciar el listado.
    const selfCwd = process.cwd();
    // Agrupar: gateway → por canal (chat_id); resto → por sesión. Filas ya vienen
    // ordenadas por fecha desc, así el primero de cada grupo es el más reciente.
    const map = new Map();
    for (const r of rows || []) {
      if (r.source === 'cli' && r.cwd === selfCwd) continue;
      const grouped = GATEWAY_SOURCES.has(r.source) && r.chat_id;
      const key = grouped ? `chan:${r.source}:${r.chat_id}` : r.id;
      const snippet = (r.first_user || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      // Conversación (humano ↔ agente) vs tarea automática (cli/cron programáticos).
      const kind = (grouped || r.source === 'api_server') ? 'chat' : 'task';
      const e = map.get(key);
      if (!e) {
        map.set(key, {
          id: key, grouped: !!grouped, kind, source: r.source || null, chatType: r.chat_type || null,
          startedAt: r.started_at || null, messageCount: r.message_count ?? 0, threads: 1,
          preview: r.title || snippet || null,
        });
      } else { e.messageCount += (r.message_count ?? 0); e.threads++; }
    }
    return [...map.values()].slice(0, limit);
  }

  // Mensajes (user/assistant) de una conversación. Acepta un id de sesión o un id de
  // canal agrupado ("chan:source:chatId") → junta todos los hilos del canal.
  async getSessionMessages(profile, sessionId, limit = 250) {
    const p = (!profile || profile === '(default)') ? this.dir : join(this.dir, 'profiles', profile);
    const mapRows = (rows) => (rows || []).map((r) => ({ role: r.role, text: r.content, ts: r.timestamp }));
    if (String(sessionId || '').startsWith('chan:')) {
      const parts = String(sessionId).split(':');
      const source = parts[1]; const chatId = parts.slice(2).join(':');
      if (!source || !chatId) return [];
      const rows = readSqlite(join(p, 'state.db'), (db) => db.prepare(
        `SELECT m.role, m.content, m.timestamp FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.source = ? AND s.chat_id = ? AND m.role IN ('user','assistant')
           AND m.content IS NOT NULL AND m.content != '' ORDER BY m.id DESC LIMIT ?`).all(source, chatId, limit));
      return mapRows((rows || []).reverse());
    }
    if (!ID_RE.test(sessionId || '')) return [];
    const rows = readSqlite(join(p, 'state.db'), (db) => db.prepare(
      `SELECT role, content, timestamp FROM messages
       WHERE session_id = ? AND role IN ('user','assistant') AND content IS NOT NULL AND content != ''
       ORDER BY id LIMIT ?`).all(sessionId, limit));
    return mapRows(rows);
  }

  // --- Escrituras: kanban (board-aware; --board es flag global del subcomando) ---
  // SIEMPRE explícito, incluso para "default": sin --board el CLI usa el board
  // ACTUAL (el de `kanban boards switch`, que puede ser cualquiera), así que
  // omitirlo mandaba la acción al board equivocado — o fallaba con "no such
  // task" — cada vez que el board actual no era el default.
  _kb(board, rest) {
    return ['kanban', '--board', String(board || 'default'), ...rest];
  }

  async kanbanCreate(profile, { title, body, assignee, priority, project, triage, board }) {
    if (!title) return { ok: false, stderr: 'título requerido' };
    const rest = ['create', String(title)];
    if (body) rest.push('--body', String(body));
    if (assignee) rest.push('--assignee', String(assignee));
    if (priority != null && priority !== '') rest.push('--priority', String(priority));
    if (project) rest.push('--project', String(project));
    if (triage) rest.push('--triage');
    return this._run(profile, this._kb(board, rest));
  }

  // Detalle COMPLETO de una tarea. Hermes ya lo arma todo junto (task, comments,
  // events, runs, parents, children), así que no hace falta rearmar los joins
  // contra el sqlite del board — que además cambia de path según el board.
  async kanbanShow(profile, id, board) {
    if (!ID_RE.test(id || '')) return { ok: false, error: 'id inválido' };
    const r = await this._run(profile, this._kb(board, ['show', '--json', String(id)]));
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout };
    try {
      // El CLI puede anteponer líneas de arranque (ej. "Bitwarden: applied N
      // secrets") antes del JSON → recortar desde la primera llave.
      const s = r.stdout.indexOf('{');
      const e = r.stdout.lastIndexOf('}');
      if (s < 0 || e <= s) throw new Error('sin JSON en la salida');
      return { ok: true, ...JSON.parse(r.stdout.slice(s, e + 1)) };
    } catch (err) {
      return { ok: false, error: `no se pudo parsear la salida: ${err.message}` };
    }
  }

  // Log crudo del worker que ejecutó la tarea. Es EFÍMERO: muchas tareas no
  // tienen archivo (rotado o nunca generado) → `ok:false` es un caso normal.
  async kanbanLog(profile, id, board, tail = 200) {
    if (!ID_RE.test(id || '')) return { ok: false, error: 'id inválido' };
    const n = Math.max(1, Math.min(2000, Number(tail) || 200));
    const r = await this._run(profile, this._kb(board, ['log', '--tail', String(n), String(id)]));
    return r.ok ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr || r.stdout || 'sin log' };
  }

  async kanbanComment(profile, id, text, board) {
    if (!ID_RE.test(id || '')) return { ok: false, stderr: 'id inválido' };
    if (!text) return { ok: false, stderr: 'comentario vacío' };
    return this._run(profile, this._kb(board, ['comment', id, String(text)]));
  }

  async kanbanAction(profile, id, action, opts = {}) {
    if (!KANBAN_ACTIONS.has(action)) return { ok: false, stderr: `acción inválida: ${action}` };
    if (!ID_RE.test(id || '')) return { ok: false, stderr: 'id inválido' };
    const rest = [action, id];
    if (action === 'complete' && opts.summary) rest.push('--summary', String(opts.summary));
    return this._run(profile, this._kb(opts.board, rest));
  }

  async _profiles() {
    const profiles = [{ name: '(default)', path: this.dir }];
    for (const e of await listDirs(join(this.dir, 'profiles'))) {
      profiles.push({ name: e.name, path: join(this.dir, 'profiles', e.name) });
    }
    return profiles;
  }

  // --- Conexiones (gateways + canales + MCP) ---
  async getConnections() {
    const profiles = await this._profiles();
    const connections = [];
    for (const p of profiles) {
      const gw = await readJson(join(p.path, 'gateway_state.json'));
      const dir = await readJson(join(p.path, 'channel_directory.json'));
      const cfg = await readText(join(p.path, 'config.yaml'));
      connections.push({
        profile: p.name,
        gateway: gw ? {
          state: gw.gateway_state || null,
          pid: gw.pid || null,
          active_agents: gw.active_agents ?? null,
          platforms: gw.platforms
            ? Object.fromEntries(Object.entries(gw.platforms).map(([k, v]) => [k, typeof v === 'string' ? v : v?.state || null]))
            : {},
        } : null,
        channels: dir?.platforms ? Object.keys(dir.platforms) : [],
        mcp: extractMcpServers(cfg),
      });
    }
    return { ok: connections.some((c) => c.gateway), profiles: profiles.map((p) => p.name), connections };
  }

  // --- Personas ---
  async getPersonas() {
    const profiles = await this._profiles();
    const out = [];
    for (const p of profiles) {
      const soul = await readText(join(p.path, 'SOUL.md'));
      const cfg = await readText(join(p.path, 'config.yaml'));
      const { model, provider } = extractModel(cfg);
      out.push({
        profile: p.name,
        name: p.name === '(default)' ? 'default' : p.name,
        model, provider,
        toolsets: extractCliToolsets(cfg),
        hasHooks: /^hooks:/m.test(cfg || ''),
        soulExcerpt: excerpt(soul, 45),
      });
    }
    return out;
  }

  // --- Skills (Pantheon): árbol category/skill + .usage.json ---
  async getSkills() {
    const root = join(this.dir, 'skills');
    const usage = (await readJson(join(root, '.usage.json'))) || {};
    const skills = [];
    const categories = [];
    for (const cat of await listDirs(root)) {
      if (cat.name.startsWith('.')) continue;
      categories.push(cat.name);
      const catDir = join(root, cat.name);
      for (const sk of await listDirs(catDir)) {
        const md = await readText(join(catDir, sk.name, 'SKILL.md'));
        if (md === null) continue;
        const fm = parseFrontmatter(md);
        const u = usage[fm.name || sk.name] || usage[sk.name] || {};
        skills.push({
          category: cat.name,
          name: fm.name || sk.name,
          description: fm.description || '',
          tags: fm.tags || [],
          version: fm.version || null,
          useCount: u.use_count ?? 0,
          viewCount: u.view_count ?? 0,
          lastUsedAt: u.last_used_at ?? null,
          pinned: !!u.pinned,
          state: u.state || 'active',
        });
      }
    }
    skills.sort((a, b) => (b.useCount - a.useCount) || a.name.localeCompare(b.name));
    return { skills, categories: categories.sort() };
  }

  // Skills de TODOS los perfiles (default + profiles/*), dedup por categoría/nombre,
  // con la lista de perfiles que la tienen. Cacheado ~60s (lee ~450 archivos).
  async getSkillsAllProfiles() {
    const c = this._skillsIdxCache;
    if (c && Date.now() - c.ts < 60_000) return c.val;
    const profiles = await this._profiles();
    const map = new Map();
    for (const p of profiles) {
      const root = join(p.path, 'skills');
      const usage = (await readJson(join(root, '.usage.json'))) || {};
      for (const cat of await listDirs(root)) {
        if (cat.name.startsWith('.')) continue;
        for (const sk of await listDirs(join(root, cat.name))) {
          const md = await readText(join(root, cat.name, sk.name, 'SKILL.md'));
          if (md === null) continue;
          const fm = parseFrontmatter(md);
          const name = fm.name || sk.name;
          const key = `${cat.name}/${name}`;
          const u = usage[name] || usage[sk.name] || {};
          let e = map.get(key);
          if (!e) { e = { category: cat.name, name, description: fm.description || '', tags: fm.tags || [], useCount: 0, profiles: [] }; map.set(key, e); }
          if (!e.profiles.includes(p.name)) e.profiles.push(p.name);
          e.useCount = Math.max(e.useCount, u.use_count ?? 0);
          if (!e.description && fm.description) e.description = fm.description;
        }
      }
    }
    const val = [...map.values()];
    this._skillsIdxCache = { ts: Date.now(), val };
    return val;
  }

  // --- Crons ---
  async getCrons() {
    const profiles = await this._profiles();
    const crons = [];
    for (const p of profiles) {
      const j = await readJson(join(p.path, 'cron', 'jobs.json'));
      for (const job of j?.jobs || []) {
        crons.push({
          profile: p.name,
          id: job.id,
          name: job.name,
          schedule: job.schedule?.display || job.schedule_display || job.schedule?.expr || '',
          scheduleKind: job.schedule?.kind || null,
          enabled: job.enabled,
          state: job.state || null,
          noAgent: !!job.no_agent,
          prompt: job.prompt || null,
          script: job.script || null,
          workdir: job.workdir || null,
          model: job.model || null,
          provider: job.provider || null,
          skills: job.skills || (job.skill ? [job.skill] : []),
          deliver: job.deliver || null,
          nextRunAt: job.next_run_at || null,
          lastRunAt: job.last_run_at || null,
          lastStatus: job.last_status || null,
          lastError: job.last_error || null,
          completed: job.repeat?.completed ?? null,
        });
      }
    }
    crons.sort((a, b) => (a.nextRunAt || '￿').localeCompare(b.nextRunAt || '￿'));
    return crons;
  }

  async getCronHistory(profile, id) {
    const p = (await this._profiles()).find((x) => x.name === profile);
    if (!p) return [];
    const dir = join(p.path, 'cron', 'output', id);
    const entries = await listEntries(dir);
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => ({ file: e.name, runAt: e.name.replace(/\.md$/, '') }))
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  // Lee el contenido de un archivo de output de cron (validado, sin traversal).
  async getCronOutput(profile, id, file) {
    if (!ID_RE.test(id || '') || !/^[\w.-]+\.md$/.test(file || '')) return { ok: false };
    const p = (await this._profiles()).find((x) => x.name === profile);
    if (!p) return { ok: false };
    const md = await readText(join(p.path, 'cron', 'output', id, file));
    if (md === null) return { ok: false };
    return { ok: true, ...splitCronOutput(md) };
  }

  // Dreaming: último output del/los cron(s) tipo daily-digest (el "morning brief").
  async getDreaming() {
    const crons = await this.getCrons();
    const digests = crons.filter((c) =>
      /digest|dream|brief|resumen|consolidaci/i.test(`${c.name} ${c.skills.join(' ')}`));
    const briefs = [];
    for (const c of digests) {
      const hist = await this.getCronHistory(c.profile, c.id);
      if (!hist.length) continue;
      const latest = hist[0];
      const out = await this.getCronOutput(c.profile, c.id, latest.file);
      briefs.push({
        profile: c.profile, id: c.id, name: c.name,
        runAt: latest.runAt.replace('_', ' '), lastStatus: c.lastStatus,
        response: out.response || out.raw || '',
        history: hist.slice(0, 10),
      });
    }
    briefs.sort((a, b) => (b.runAt || '').localeCompare(a.runAt || ''));
    return { ok: briefs.length > 0, briefs };
  }

  // --- Kanban + proyectos ---
  // El kanban es cross-perfil y se guarda POR BOARD: el board "default" en
  // ~/.hermes/kanban.db, y el resto en ~/.hermes/kanban/boards/<slug>/kanban.db.
  async _boards() {
    const boards = [{ slug: 'default', path: join(this.dir, 'kanban.db') }];
    for (const d of await listDirs(join(this.dir, 'kanban', 'boards'))) {
      boards.push({ slug: d.name, path: join(this.dir, 'kanban', 'boards', d.name, 'kanban.db') });
    }
    return boards;
  }

  async getKanban() {
    const boards = await this._boards();
    const projMap = {};
    const projects = readSqlite(join(this.dir, 'projects.db'), (db) =>
      db.prepare('SELECT id, slug, name, icon, color FROM projects WHERE archived = 0').all());
    for (const pr of projects || []) projMap[pr.id] = pr;

    const byStatus = {};
    const tasks = [];
    for (const b of boards) {
      const rows = readSqlite(b.path, (db) =>
        db.prepare(`SELECT id, title, status, assignee, priority, project_id, created_at, completed_at
                    FROM tasks ORDER BY created_at DESC LIMIT 500`).all());
      for (const r of rows || []) {
        byStatus[r.status || 'sin estado'] = (byStatus[r.status || 'sin estado'] || 0) + 1;
        tasks.push({
          board: b.slug,
          id: r.id,
          title: r.title,
          status: r.status || null,
          assignee: r.assignee || null,
          priority: r.priority ?? null,
          project: projMap[r.project_id]?.name || r.project_id || null,
          createdAt: r.created_at || null,
          completedAt: r.completed_at || null,
        });
      }
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return { total, byStatus, tasks, projects: Object.values(projMap), boards: boards.map((b) => b.slug) };
  }

  // --- Memoria (MEMORY.md / USER.md / SOUL.md) ---
  async getMemory() {
    const profiles = await this._profiles();
    const out = [];
    for (const p of profiles) {
      const cfg = await readText(join(p.path, 'config.yaml'));
      const memCap = intFrom(cfg, /memory_char_limit:\s*(\d+)/) ?? DEFAULT_MEM_CAP;
      const userCap = intFrom(cfg, /user_char_limit:\s*(\d+)/) ?? DEFAULT_USER_CAP;
      const memory = await readText(join(p.path, 'memories', 'MEMORY.md'));
      const user = await readText(join(p.path, 'memories', 'USER.md'));
      const soul = await readText(join(p.path, 'SOUL.md'));
      if (memory === null && user === null && soul === null) continue;
      out.push({
        profile: p.name,
        memory: { text: memory || '', used: (memory || '').length, cap: memCap },
        user: { text: user || '', used: (user || '').length, cap: userCap },
        soul: { text: soul || '' },
      });
    }
    return out;
  }

  // --- Escritura de memoria Tier 1 (MEMORY.md / USER.md) ---
  // Es un archivo de texto del agente (no sqlite). Respeta el tope de caracteres
  // y hace backup previo. `which` ∈ {memory, user}.
  async writeMemory(profile, which, text) {
    const file = which === 'user' ? 'USER.md' : which === 'memory' ? 'MEMORY.md' : null;
    if (!file) return { ok: false, stderr: 'destino inválido (memory|user)' };
    const p = (await this._profiles()).find((x) => x.name === profile);
    if (!p) return { ok: false, stderr: 'perfil inexistente' };
    const cfg = await readText(join(p.path, 'config.yaml'));
    const cap = which === 'user'
      ? (intFrom(cfg, /user_char_limit:\s*(\d+)/) ?? DEFAULT_USER_CAP)
      : (intFrom(cfg, /memory_char_limit:\s*(\d+)/) ?? DEFAULT_MEM_CAP);
    const body = String(text ?? '');
    if (body.length > cap) return { ok: false, stderr: `excede el tope: ${body.length}/${cap} caracteres` };
    const target = join(p.path, 'memories', file);
    try {
      await copyFile(target, `${target}.agentos.bak`).catch(() => {}); // backup best-effort
      await writeFile(target, body, 'utf8');
      return { ok: true, stdout: `${file} guardado (${body.length}/${cap})`, used: body.length, cap };
    } catch (e) {
      return { ok: false, stderr: e.message };
    }
  }

  // --- Obsidian (memoria Tier 2/3, SOLO LECTURA, navegable) ---
  // Devuelve el árbol por carpeta top-level (listados con tamaño, sin leer todo).
  // El contenido se pide por archivo con getObsidianFile().
  async getObsidian() {
    if (!this.vault) return { ok: false, error: 'sin vault configurado' };
    const groups = {};
    const rootFiles = [];
    // Archivos .md en la raíz del vault.
    for (const e of await listEntries(this.vault)) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const st = await statSafe(join(this.vault, e.name));
        rootFiles.push({ name: e.name.replace(/\.md$/, ''), rel: e.name, bytes: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
      }
    }
    // Carpetas top-level (living, daily, decisions, mama, …) — .md recursivo, cota.
    for (const d of await listDirs(this.vault)) {
      if (d.name.startsWith('.')) continue;
      const files = await walkMd(this.vault, d.name, 400);
      files.sort((a, b) => b.mtime - a.mtime);
      groups[d.name] = files;
    }
    const total = rootFiles.length + Object.values(groups).reduce((a, f) => a + f.length, 0);
    return { ok: total > 0, path: this.vault, rootFiles: rootFiles.sort((a, b) => a.name.localeCompare(b.name)), groups, total };
  }

  // Lee un archivo del vault (validado dentro del vault, solo .md).
  async getObsidianFile(rel) {
    if (!this.vault) return { ok: false };
    if (!rel || !rel.endsWith('.md')) return { ok: false, error: 'path inválido' };
    const full = insideRoot(this.vault, rel);
    if (!full) return { ok: false, error: 'fuera del vault' };
    const text = await readText(full);
    if (text == null) return { ok: false, error: 'no se pudo leer' };
    return { ok: true, rel, text };
  }

  // --- Única escritura permitida al vault: la carpeta rem/ ------------------
  // El vault es memoria Tier 2/3 y sigue siendo read-only salvo por este
  // namespace propio del Agent OS. daily/, decisions/, living/ y mama/ los
  // escribe Hermes por su cuenta; pisarlos desde acá es cómo se duplicaron los
  // headings de daily/2026-07-07.md. La whitelist es de PREFIJO RESUELTO, así
  // que "rem/../living/identity.md" tampoco pasa.
  async writeObsidian(rel, text) {
    if (!this.vault) return { ok: false, error: 'sin vault configurado' };
    if (!rel || !rel.endsWith('.md')) return { ok: false, error: 'path inválido' };
    const remRoot = join(resolve(this.vault), 'rem');
    const full = insideRoot(remRoot, rel.startsWith('rem/') ? rel.slice(4) : rel);
    if (!full || !rel.startsWith('rem/')) return { ok: false, error: 'solo se puede escribir en rem/' };
    const body = String(text ?? '');
    try {
      await mkdir(remRoot, { recursive: true });
      // Sin backup .bak a propósito (a diferencia de cronSetModel/writeMemory,
      // que tocan estado de Hermes): esta nota es salida nuestra, regenerable e
      // idempotente, y el vault se replica por SyncThing — un .bak por corrida
      // es basura que se sincroniza a todas las máquinas.
      const tmp = `${full}.agentos.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, full);                                     // escritura atómica
      return { ok: true, rel, path: full, bytes: Buffer.byteLength(body) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- Dreaming cockpit (journey / insights / curator) ---
  // Star Map: skills+memorias aprendidas en el tiempo.
  async getJourney() {
    const r = await this._run('(default)', ['journey', '--json'], { timeout: 30_000 });
    if (!r.ok || !r.stdout) return { ok: false, nodes: [] };
    try {
      const j = JSON.parse(r.stdout);
      const nodes = (j.nodes || []).map((n) => ({
        id: n.id, label: n.label || n.id, kind: n.kind, category: n.category || null,
        ts: n.timestamp || null, useCount: n.useCount ?? 0, state: n.state || 'active',
        createdBy: n.createdBy || null, pinned: !!n.pinned,
      })).filter((n) => n.ts).sort((a, b) => a.ts - b.ts);
      return { ok: true, nodes };
    } catch { return { ok: false, nodes: [] }; }
  }

  // Insights: reflexión analítica sobre las sesiones (texto formateado).
  async getInsights(days = 7) {
    const r = await this._run('(default)', ['insights', '--days', String(Number(days) || 7)], { timeout: 45_000 });
    const text = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    return { ok: !!text, days, text };
  }

  // Estado del curator (el loop de consolidación/auto-skills).
  async getCurator() {
    const r = await this._run('(default)', ['curator', 'status'], { timeout: 30_000 });
    const t = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (!t) return { ok: false };
    const grab = (re) => (t.match(re) || [])[1]?.trim() || null;
    return {
      ok: true,
      enabled: /curator:\s*ENABLED/i.test(t),
      consolidate: /consolidate:\s*on/i.test(t),
      runs: Number(grab(/runs:\s*(\d+)/)) || 0,
      lastRun: grab(/last run:\s*(.+)/),
      lastSummary: grab(/last summary:\s*(.+)/),
      interval: grab(/interval:\s*(.+)/),
      totalSkills: Number(grab(/agent-created skills:\s*(\d+)/)) || 0,
      active: Number(grab(/active\s+(\d+)/)) || 0,
      stale: Number(grab(/stale\s+(\d+)/)) || 0,
      archived: Number(grab(/archived\s+(\d+)/)) || 0,
      raw: t.trim(),
    };
  }

  // "Soñar ahora": dispara una review del curator (con consolidación LLM opcional).
  async curatorRun(consolidate = true) {
    const args = ['curator', 'run', '--sync'];
    if (consolidate) args.push('--consolidate');
    const r = await this._run('(default)', args, { timeout: 300_000 });
    return { ok: r.ok, output: r.stdout, error: r.ok ? null : (r.stderr || r.stdout) };
  }

  // Encender/apagar la consolidación persistente (config del agente).
  async setConsolidate(on) {
    const r = await this._run('(default)', ['config', 'set', 'curator.consolidate', on ? 'true' : 'false'], { timeout: 30_000 });
    return { ok: r.ok, on, output: r.stdout, error: r.ok ? null : (r.stderr || r.stdout) };
  }

  // --- HITL / aprobaciones ---
  // Hermes no persiste una cola de aprobaciones: son inline (TTY/gateway). Una vista
  // real necesita el gateway API :8642 habilitado. Reportamos disponibilidad honesta.
  async getApprovals() {
    if (!this.gatewayUrl) return { available: false, reason: 'sin gateway configurado' };
    try {
      const res = await fetch(`${this.gatewayUrl}/health`, {
        signal: AbortSignal.timeout(2000),
        headers: this.gatewayKey ? { Authorization: `Bearer ${this.gatewayKey}` } : {},
      });
      if (!res.ok) return { available: false, reason: `gateway API respondió HTTP ${res.status}`, pending: [] };
      // Alcanzable: intentar listar runs con aprobación pendiente (best-effort).
      return { available: true, pending: [], note: 'gateway API alcanzable; sin runs pendientes de aprobación' };
    } catch {
      return { available: false, reason: 'gateway API :8642 no está habilitado', pending: [] };
    }
  }

  // --- Buscador global (sesiones FTS + memorias + skills) ---
  async search(query, limit = 8) {
    const q = String(query || '').trim();
    if (q.length < 2) return { sessions: [], memories: [], skills: [] };
    const ftsQ = `"${q.replace(/"/g, '""')}"`; // phrase match, a prueba de sintaxis
    const profiles = await this._profiles();

    // Sesiones (FTS sobre messages, uniendo a sessions para el título).
    const sessions = [];
    for (const p of profiles) {
      const rows = readSqlite(join(p.path, 'state.db'), (db) => db.prepare(
        `SELECT m.session_id AS sid, m.role, m.timestamp AS ts,
                snippet(messages_fts, 0, '«', '»', '…', 8) AS snip,
                s.title, s.source
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         LEFT JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQ, limit));
      for (const r of rows || []) sessions.push({
        profile: p.name, sessionId: r.sid, role: r.role, ts: r.ts,
        snippet: r.snip, title: r.title || r.source || 'sesión',
      });
    }

    // Memorias (Tier 1 + SOUL) por substring, case-insensitive.
    const memories = [];
    const needle = q.toLowerCase();
    for (const p of profiles) {
      for (const [which, file] of [['MEMORY', 'MEMORY.md'], ['USER', 'USER.md']]) {
        const t = await readText(join(p.path, 'memories', file));
        if (t && t.toLowerCase().includes(needle)) {
          const i = t.toLowerCase().indexOf(needle);
          memories.push({ profile: p.name, which, snippet: t.slice(Math.max(0, i - 40), i + 80).trim() });
        }
      }
    }

    // Skills de TODOS los perfiles, por nombre/descripción/tags.
    const allSkills = await this.getSkillsAllProfiles();
    const skillHits = allSkills.filter((s) =>
      s.name.toLowerCase().includes(needle) ||
      (s.description || '').toLowerCase().includes(needle) ||
      (s.tags || []).some((t) => t.toLowerCase().includes(needle)))
      .sort((a, b) => b.useCount - a.useCount).slice(0, 12);

    return { sessions: sessions.slice(0, 25), memories, skills: skillHits };
  }

  // --- Resumen para la home ---
  async getOverview() {
    const [conn, crons, kanban, skillsData] = await Promise.all([
      this.getConnections(), this.getCrons(), this.getKanban(), this.getSkills(),
    ]);
    const gwUp = conn.connections.filter((c) => c.gateway?.state === 'running').length;
    const platforms = {};
    for (const c of conn.connections) {
      for (const [name, st] of Object.entries(c.gateway?.platforms || {})) {
        platforms[name] = platforms[name] || st;
      }
    }
    const skillsUsed = skillsData.skills.filter((s) => s.useCount > 0).length;
    return {
      profiles: conn.profiles,
      gateways: { total: conn.connections.length, running: gwUp },
      platforms,
      crons: { total: crons.length, enabled: crons.filter((c) => c.enabled).length },
      kanban: { total: kanban.total, byStatus: kanban.byStatus },
      skills: { total: skillsData.skills.length, used: skillsUsed, categories: skillsData.categories.length },
    };
  }
}

// --- helpers de parsing acotado ---

function intFrom(text, re) {
  if (!text) return null;
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

async function statSafe(p) {
  try { return await stat(p); } catch { return null; }
}

// Camina un subdir del vault y devuelve .md con rel relativo a `root` (cota `limit`).
async function walkMd(root, subdir, limit = 400) {
  const out = [];
  async function rec(dir) {
    if (out.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.name.endsWith('.md')) {
        const st = await statSafe(full);
        out.push({ name: e.name.replace(/\.md$/, ''), rel: full.slice(root.length + 1), bytes: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
      }
    }
  }
  await rec(join(root, subdir));
  return out;
}

// Divide un output de cron (# Cron Job … ## Prompt … ## Script Output … ## Response)
// en secciones. `response` es lo que se entregó (el morning brief).
function splitCronOutput(md) {
  const out = { raw: md };
  const lines = md.split('\n');
  let cur = '_head';
  const buf = { _head: [] };
  for (const l of lines) {
    const h = l.match(/^##\s+(.+)$/);
    if (h) { cur = h[1].trim().toLowerCase(); buf[cur] = []; continue; }
    (buf[cur] = buf[cur] || []).push(l);
  }
  const get = (k) => (buf[k] || []).join('\n').trim();
  out.prompt = get('prompt');
  out.scriptOutput = get('script output');
  out.response = get('response');
  return out;
}

const indentOf = (line) => line.length - line.trimStart().length;
const clean = (s) => s.trim().replace(/^["']|["']$/g, '');

// Devuelve las líneas de un bloque top-level `key:` (las líneas indentadas que le
// siguen, hasta la próxima línea sin indentación). Line-based, sin regex anidada.
function blockLines(yaml, key) {
  const lines = (yaml || '').split('\n');
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (indentOf(l) === 0) break; // fin del bloque
    out.push(l);
  }
  return out;
}

// Extrae la lista `cli:` bajo platform_toolsets:, sea inline `[a, b]` o bloque `- a`.
function extractCliToolsets(yaml) {
  const lines = blockLines(yaml, 'platform_toolsets');
  const idx = lines.findIndex((l) => /^\s+cli:/.test(l));
  if (idx < 0) return [];
  const inline = lines[idx].match(/cli:\s*\[(.*)\]/);
  if (inline) return inline[1].split(',').map(clean).filter(Boolean);
  // formato bloque: items `- name` más indentados que `cli:`
  const base = indentOf(lines[idx]);
  const items = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= base) break;
    const it = lines[i].match(/^\s*-\s*(.+)$/);
    if (it) items.push(clean(it[1]));
  }
  return items;
}

// Genera las líneas YAML de un preset MoA con la indentación de las claves de preset.
function moaPresetLines(name, refs, ag, keyIndent) {
  const i = ' '.repeat(keyIndent);
  const out = [`${i}${name}:`, `${i}  reference_models:`];
  for (const r of refs) out.push(`${i}    - provider: ${r.provider}`, `${i}      model: ${r.model}`);
  out.push(`${i}  aggregator:`, `${i}    provider: ${ag.provider}`, `${i}    model: ${ag.model}`, `${i}  enabled: true`);
  return out;
}

// Inserta o reemplaza `moa.presets.<name>` en el texto de config.yaml. Line-based
// (sin lib de YAML): preserva default_preset, otros presets y el resto del archivo.
// Los valores llegan validados (nombre [\w-]+, modelos MODEL_RE) — sin inyección.
function upsertMoaPreset(text, name, refs, ag) {
  const lines = text.split('\n');
  const isBlank = (l) => l.trim() === '';
  const moaStart = lines.findIndex((l) => l.startsWith('moa:'));
  if (moaStart < 0) {
    return `${text.replace(/\s*$/, '')}\n\nmoa:\n  presets:\n${moaPresetLines(name, refs, ag, 4).join('\n')}\n`;
  }
  let moaEnd = moaStart + 1;
  while (moaEnd < lines.length && (isBlank(lines[moaEnd]) || indentOf(lines[moaEnd]) > 0)) moaEnd++;
  let presetsIdx = -1;
  for (let i = moaStart + 1; i < moaEnd; i++) if (/^\s+presets:\s*$/.test(lines[i])) { presetsIdx = i; break; }
  if (presetsIdx < 0) {
    lines.splice(moaEnd, 0, '  presets:', ...moaPresetLines(name, refs, ag, 4));
    return lines.join('\n');
  }
  const pIndent = indentOf(lines[presetsIdx]);
  let keyIndent = pIndent + 2, sawChild = false;
  let tStart = -1, tEnd = -1, lastChild = presetsIdx;
  for (let i = presetsIdx + 1; i < moaEnd; i++) {
    if (isBlank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind <= pIndent) break; // se terminó el bloque presets
    if (!sawChild) { keyIndent = ind; sawChild = true; }
    if (ind === keyIndent) {
      if (tStart >= 0 && tEnd < 0) tEnd = i; // primera clave después del target
      if (new RegExp(`^\\s*${name}:\\s*$`).test(lines[i])) tStart = i;
    }
    lastChild = i;
  }
  const block = moaPresetLines(name, refs, ag, keyIndent);
  if (tStart >= 0) {
    lines.splice(tStart, (tEnd < 0 ? lastChild + 1 : tEnd) - tStart, ...block);
  } else {
    lines.splice(lastChild + 1, 0, ...block);
  }
  return lines.join('\n');
}

// Extrae servidores MCP del bloque mcp_servers:. Cada server es una clave anidada.
// Devuelve [{name, url, auth, enabled}]. Line-based.
function extractMcpServers(yaml) {
  const lines = blockLines(yaml, 'mcp_servers');
  if (!lines.length) return [];
  // indentación de las claves de servidor = la menor indentación no vacía del bloque
  const indents = lines.filter((l) => l.trim()).map(indentOf);
  const keyIndent = Math.min(...indents);
  const servers = [];
  let cur = null;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const ind = indentOf(l);
    if (ind === keyIndent) {
      const k = l.match(/^\s*([A-Za-z0-9_-]+):/);
      if (k) { cur = { name: k[1], url: null, auth: null, enabled: false }; servers.push(cur); }
    } else if (cur) {
      const u = l.match(/url:\s*(.+)/); if (u) cur.url = clean(u[1]);
      const a = l.match(/Authorization:\s*(.+)/); if (a) cur.auth = a[1].trim();
      if (/enabled:\s*true/.test(l)) cur.enabled = true;
    }
  }
  return servers;
}
