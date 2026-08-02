// Dispara un perfil de trabajo para UNA tarea puntual, sin esperar al
// tick del gateway. `hermes kanban dispatch` no tiene filtro por task-id, así
// que la única forma de acotarlo a esta tarea es: asignarla al perfil que la
// va a ejecutar, promoverla a ready si hace falta, y forzar un tick de a 1.
// El resto (investigación o implementación directa con OpenAI, branch, PR y
// tests) vive en los perfiles de Hermes y sus automatizaciones — acá
// no se duplica esa lógica, sólo se la despierta ahora en vez de a la noche.
import { prepareTaskWorktree } from './project-worktrees.js';
const running = new Set();

export async function runTaskNow(adapter, { board, id, profile = 'coder' }) {
  if (!id) return { ok: false, error: 'id requerido' };
  if (!['coder', 'researcher'].includes(profile)) return { ok: false, error: 'perfil de ejecución inválido' };
  const key = `${board || 'default'}:${id}`;
  if (running.has(key)) return { ok: false, busy: true, error: 'ya se disparó esta tarea, esperá el resultado' };
  running.add(key);
  try {
    // Las tareas creadas desde sugerencias de código llevan `project`. Antes de
    // entregarlas al coder, materializamos un worktree con su propia rama y
    // dejamos instrucciones visibles para el worker. Tareas sin proyecto
    // conservan el comportamiento previo.
    const detail = await adapter.kanbanShow('(default)', id, board);
    const task = detail.task || detail;
    const body = String(task?.body || task?.description || '');
    // Repo es metadata portable en el body: no dependemos de que el catálogo
    // de proyectos de Hermes tenga el mismo nombre que ~/code/<repo>.
    const project = body.match(/^Repo:\s*([^\n\r]+)/im)?.[1]?.trim() || null;
    let worktree = null;
    if (project) {
      if (!/\bdocumentaci[oó]n\s*:/i.test(body) || !/\b(validaci[oó]n|tests?)\s*:/i.test(body)) {
        return { ok: false, error: 'la tarea de código no tiene el checklist de validación y documentación requerido' };
      }
      worktree = await prepareTaskWorktree({ projectName: project, taskId: id });
      if (!worktree.ok) return { ok: false, error: worktree.error || 'no se pudo preparar el worktree' };
      const note = `Agent OS preparó el worktree aislado para esta tarea.\n\nRuta: ${worktree.path}\nRama: ${worktree.branch}\nBase: ${worktree.base}\n\nAntes de proponer merge: ejecutar la validación indicada y actualizar o justificar explícitamente la Documentación.`;
      const comment = await adapter.kanbanComment('(default)', id, note, board);
      if (!comment.ok) return { ok: false, error: comment.stderr || comment.error || 'no se pudo registrar el worktree en Kanban' };
    }
    const a = await adapter.kanbanAssign('(default)', id, profile, board);
    if (!a.ok) return { ok: false, error: a.stderr || a.stdout || `no se pudo asignar a ${profile}` };
    await adapter.kanbanPromote('(default)', id, board); // best-effort: no-op si ya estaba ready/running
    const d = await adapter.kanbanDispatch('(default)', board, { max: 1 });
    if (!d.ok) return { ok: false, error: d.stderr || d.stdout || 'no se pudo disparar el dispatcher' };
    return { ok: true, info: profile === 'coder'
      ? `coder disparado con OpenAI${worktree ? ` en ${worktree.branch}` : ''} — revisión, tests y documentación son obligatorios antes de proponer merge`
      : 'researcher disparado con OpenAI — dejará los hallazgos como comentarios en Kanban' };
  } finally {
    running.delete(key);
  }
}
