// Inventario Git de sólo lectura. Los repositorios locales son la fuente de
// verdad: nunca hace checkout, pull ni escribe en el árbol de trabajo. `fetch`
// existe como acción explícita para actualizar las referencias remotas.
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve, sep } from 'node:path';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

const execFileP = promisify(execFile);
const ROOT = resolve(config.projectsRoot);
const DOC_NAMES = ['README.md', 'README', 'docs', 'CONTRIBUTING.md', 'CHANGELOG.md'];

function enabledNames() {
  const raw = getSetting('project_enabled_names', '');
  if (!raw) return null; // compat: los repos existentes arrancan habilitados.
  try { const a = JSON.parse(raw); return Array.isArray(a) ? new Set(a.map(String)) : null; } catch { return null; }
}

function isInsideRoot(path) {
  const full = resolve(path || '');
  return full !== ROOT && full.startsWith(ROOT + sep);
}

async function git(dir, args, { timeout = 8_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', dir, ...args], {
      timeout, maxBuffer: 512 * 1024, windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || '').trim(), stderr: String(error.stderr || error.message || '').trim() };
  }
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }

function parseStatus(raw) {
  let staged = 0, modified = 0, untracked = 0, conflicts = 0;
  // porcelain v1: cada entrada comienza con XY; renombres agregan una segunda
  // línea de ruta, que no comienza con XY y se ignora correctamente acá.
  for (const line of raw.split('\n')) {
    if (!/^(?:.. |\?\? |!! )/.test(line)) continue;
    const xy = line.slice(0, 2);
    if (xy === '??') { untracked++; continue; }
    if (xy.includes('U')) conflicts++;
    if (xy[0] !== ' ' && xy[0] !== '?') staged++;
    if (xy[1] !== ' ' && xy[1] !== '?') modified++;
  }
  return { staged, modified, untracked, conflicts, dirty: staged + modified + untracked > 0 };
}

async function inspectProject(path) {
  const [top, branch, status, remote, upstream, defaultBranch, head, log] = await Promise.all([
    git(path, ['rev-parse', '--show-toplevel']),
    git(path, ['branch', '--show-current']),
    git(path, ['status', '--porcelain=v1']),
    git(path, ['remote', 'get-url', 'origin']),
    git(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    git(path, ['rev-parse', '--short', 'HEAD']),
    git(path, ['log', '-1', '--format=%h%x1f%s%x1f%cI']),
  ]);
  if (!top.ok) return null;
  const root = top.stdout;
  const upstreamName = upstream.ok ? upstream.stdout : null;
  let ahead = 0, behind = 0, primaryAhead = 0, primaryBehind = 0;
  if (upstreamName) {
    const counts = await git(path, ['rev-list', '--left-right', '--count', `HEAD...${upstreamName}`]);
    if (counts.ok) [ahead, behind] = counts.stdout.split(/\s+/).map((x) => Number(x) || 0);
  }
  // origin/HEAD identifica la rama principal sin asumir main/master. Si la
  // referencia todavía no existe, se omite hasta que el usuario haga fetch.
  const primary = defaultBranch.ok ? defaultBranch.stdout : null;
  if (primary) {
    const counts = await git(path, ['rev-list', '--left-right', '--count', `HEAD...${primary}`]);
    if (counts.ok) [primaryAhead, primaryBehind] = counts.stdout.split(/\s+/).map((x) => Number(x) || 0);
  }
  const [short = '', subject = '', committedAt = ''] = log.ok ? log.stdout.split('\x1f') : [];
  const docs = Object.fromEntries(await Promise.all(DOC_NAMES.map(async (name) => [name, await exists(join(root, name))])));
  const changes = parseStatus(status.stdout || '');
  return {
    name: relative(ROOT, root) || root.split(sep).pop(), path: root, branch: branch.stdout || '(detached)',
    upstream: upstreamName, primaryBranch: primary, remote: remote.ok ? remote.stdout : null, head: head.stdout || short || null,
    lastCommit: subject ? { short, subject, committedAt } : null, ahead, behind, primaryAhead, primaryBehind, changes,
    docs: { readme: docs['README.md'] || docs.README, docsDir: docs.docs, contributing: docs['CONTRIBUTING.md'], changelog: docs['CHANGELOG.md'] },
  };
}

export async function listGitProjects() {
  let entries;
  try { entries = await readdir(ROOT, { withFileTypes: true }); } catch { return { ok: false, root: ROOT, projects: [], error: `no se pudo leer ${ROOT}` }; }
  const enabled = enabledNames();
  const projects = (await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => inspectProject(join(ROOT, e.name))))).filter(Boolean);
  for (const project of projects) project.enabled = enabled ? enabled.has(project.name) : true;
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true, root: ROOT, projects,
    autoFetch: getSetting('project_auto_fetch_enabled', '0') === '1',
    fetchIntervalH: Number(getSetting('project_fetch_interval_h', '24')),
    lastFetchAt: getSetting('project_last_fetch_at', null),
  };
}

// Contexto deliberadamente breve para el LLM: evidencia útil, sin contenido de
// archivos ni paths de trabajo sensibles. Sólo se incluyen repos configurados.
export async function projectSuggestionContext(limit = 12) {
  const all = await listGitProjects();
  if (!all.ok) return { root: all.root, projects: [] };
  return {
    root: all.root,
    projects: all.projects.filter((p) => p.enabled).slice(0, limit).map((p) => ({
      name: p.name, branch: p.branch, upstream: p.upstream, primaryBranch: p.primaryBranch,
      ahead: p.ahead, behind: p.behind, primaryAhead: p.primaryAhead, primaryBehind: p.primaryBehind,
      dirty: p.changes.dirty, changes: p.changes, lastCommit: p.lastCommit,
      docs: p.docs, hasRemote: !!p.remote,
    })),
  };
}

export async function fetchProject(path) {
  if (!isInsideRoot(path)) return { ok: false, error: 'repositorio fuera de CODE_PROJECTS_ROOT' };
  const before = await inspectProject(path);
  if (!before) return { ok: false, error: 'no es un repositorio Git válido' };
  if (!before.remote) return { ok: false, error: 'el repositorio no tiene remoto origin' };
  const r = await git(before.path, ['fetch', '--prune', 'origin'], { timeout: 60_000 });
  if (!r.ok) return { ok: false, error: r.stderr || 'git fetch falló' };
  const project = await inspectProject(before.path);
  return { ok: true, project, message: 'Referencias remotas actualizadas; no se hizo pull ni checkout.' };
}

export async function setProjectEnabled(path, enabled) {
  if (!isInsideRoot(path)) return { ok: false, error: 'repositorio fuera de CODE_PROJECTS_ROOT' };
  const project = await inspectProject(path);
  if (!project) return { ok: false, error: 'no es un repositorio Git válido' };
  const list = enabledNames() || new Set((await listGitProjects()).projects.filter((p) => p.enabled).map((p) => p.name));
  if (enabled) list.add(project.name); else list.delete(project.name);
  setSetting('project_enabled_names', JSON.stringify([...list].sort()));
  return { ok: true, name: project.name, enabled: !!enabled };
}

export async function syncEnabledProjects() {
  const all = await listGitProjects();
  if (!all.ok) return all;
  const results = [];
  for (const project of all.projects.filter((p) => p.enabled && p.remote)) results.push({ name: project.name, ...(await fetchProject(project.path)) });
  return { ok: results.every((r) => r.ok), synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
