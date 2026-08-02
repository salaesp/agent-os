// Worktrees efímeros por tarea de código. Se crean SÓLO al ejecutar una tarea
// aprobada: generar una sugerencia o crear Kanban no toca ningún repositorio.
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { listGitProjects } from './projects.js';

const execFileP = promisify(execFile);
const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const baseRef = (project) => project.primaryBranch || (project.branch && project.branch !== '(detached)' ? project.branch : project.head || 'HEAD');

async function git(dir, args) {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', dir, ...args], { timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) { return { ok: false, error: String(error.stderr || error.message || '').trim() }; }
}

// Idempotente: si la rama ya tiene worktree, devuelve el mismo. Si existe como
// branch suelta, se rehúsa a adivinar su estado en vez de sobrescribirla.
export async function prepareTaskWorktree({ projectName, taskId }) {
  if (!projectName || !taskId) return { ok: false, error: 'project y taskId requeridos' };
  const all = await listGitProjects();
  const project = all.projects?.find((p) => p.name === projectName);
  if (!project) return { ok: false, error: `proyecto no permitido: ${projectName}` };
  const branch = `codex/agentos-${slug(taskId)}`;
  const safeName = `${slug(project.name)}-${slug(taskId)}`;
  const root = resolve(config.projectWorktreesRoot);
  const path = join(root, safeName);
  const listed = await git(project.path, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return listed;
  const blocks = listed.stdout.split('\n\n');
  const existing = blocks.find((b) => b.includes(`branch refs/heads/${branch}`));
  if (existing) {
    const line = existing.split('\n').find((l) => l.startsWith('worktree '));
    return { ok: true, reused: true, branch, path: line?.slice(9) || path, base: baseRef(project) };
  }
  const branchExists = await git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (branchExists.ok) return { ok: false, error: `la rama ${branch} ya existe sin worktree asociado; revisala antes de reutilizarla` };
  await mkdir(root, { recursive: true });
  const base = baseRef(project);
  const created = await git(project.path, ['worktree', 'add', '-b', branch, path, base]);
  if (!created.ok) return created;
  return { ok: true, reused: false, branch, path, base };
}

// Gate de cierre para tareas de código: el worktree debe estar limpio, sin
// errores de whitespace, con una evidencia de validación y documentación
// actualizada (o una justificación explícita de que no aplica).
export async function verifyTaskWorktree({ projectName, taskId, completionText = '' }) {
  const all = await listGitProjects();
  const project = all.projects?.find((p) => p.name === projectName);
  if (!project) return { ok: false, error: `proyecto no permitido: ${projectName}` };
  const path = join(resolve(config.projectWorktreesRoot), `${slug(project.name)}-${slug(taskId)}`);
  const top = await git(path, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, error: 'no existe un worktree preparado para esta tarea', path };
  const [status, whitespace] = await Promise.all([
    git(path, ['status', '--porcelain']),
    git(path, ['diff', '--check', 'HEAD']),
  ]);
  if (!status.ok || !whitespace.ok) return { ok: false, error: status.error || whitespace.error || 'no se pudo verificar el worktree', path };
  if (status.stdout) return { ok: false, error: 'el worktree tiene cambios sin commit', path };
  if (whitespace.stdout) return { ok: false, error: `git diff --check encontró errores: ${whitespace.stdout}`, path };
  const base = baseRef(project);
  const files = await git(path, ['diff', '--name-only', `${base}...HEAD`]);
  if (!files.ok) return { ok: false, error: files.error || 'no se pudo leer el diff', path };
  const changed = files.stdout ? files.stdout.split('\n').filter(Boolean) : [];
  const docsChanged = changed.some((f) => /(^|\/)(README|CHANGELOG|CONTRIBUTING)(\.|$)|^docs\//i.test(f));
  const codeChanged = changed.some((f) => !/(^|\/)(README|CHANGELOG|CONTRIBUTING)(\.|$)|^docs\//i.test(f));
  const text = String(completionText || '');
  const validationRecorded = /resultado de validaci[oó]n\s*:/i.test(text);
  const docsWaived = /documentaci[oó]n\s*:\s*no aplica\s*:/i.test(text);
  if (!validationRecorded) return { ok: false, error: 'falta registrar «Resultado de validación: …» en la tarea o comentarios', path, changed };
  if (codeChanged && !docsChanged && !docsWaived) return { ok: false, error: 'se modificó código sin documentación ni justificación «Documentación: no aplica: …»', path, changed };
  return { ok: true, path, base, changed, docsChanged, validationRecorded, docsWaived };
}
