// Dispara el pipeline coder→reviewer para UNA tarea puntual, sin esperar al
// tick del gateway. `hermes kanban dispatch` no tiene filtro por task-id, así
// que la única forma de acotarlo a esta tarea es: asignarla al perfil que la
// va a ejecutar, promoverla a ready si hace falta, y forzar un tick de a 1.
// El resto (branch, `claude -p`, PR, tests, merge) vive en los perfiles
// `coder`/`reviewer` de Hermes y en el cron `kanban-pr-autocomplete` — acá no
// se duplica esa lógica, sólo se la despierta ahora en vez de a la noche.
const running = new Set();

export async function runTaskNow(adapter, { board, id, profile = 'coder' }) {
  if (!id) return { ok: false, error: 'id requerido' };
  const key = `${board || 'default'}:${id}`;
  if (running.has(key)) return { ok: false, busy: true, error: 'ya se disparó esta tarea, esperá el resultado' };
  running.add(key);
  try {
    const a = await adapter.kanbanAssign('(default)', id, profile, board);
    if (!a.ok) return { ok: false, error: a.stderr || a.stdout || 'no se pudo asignar al coder' };
    await adapter.kanbanPromote('(default)', id, board); // best-effort: no-op si ya estaba ready/running
    const d = await adapter.kanbanDispatch('(default)', board, { max: 1 });
    if (!d.ok) return { ok: false, error: d.stderr || d.stdout || 'no se pudo disparar el dispatcher' };
    return { ok: true, info: 'coder disparado — abre rama + PR; se mergea a main solo si pasa la revisión y los tests' };
  } finally {
    running.delete(key);
  }
}
