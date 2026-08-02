# Inteligencia de proyectos Git

Agent OS analiza repositorios locales para producir sugerencias de ingeniería
accionables. La fuente primaria es `CODE_PROJECTS_ROOT` (por defecto `~/code`),
y sólo se inspeccionan sus directorios directos que sean repositorios Git.

## Seguridad y sincronización

- El inventario usa comandos de lectura (`status`, `log`, `rev-parse`, etc.).
- **Nunca** hace `pull`, `checkout`, `merge`, commits ni edita el árbol de
  trabajo.
- El botón **Actualizar remoto** ejecuta únicamente `git fetch --prune origin`.
  Es una acción manual: actualiza referencias remotas sin tocar la rama local.
- Cada repo puede incluirse o excluirse del contexto de sugerencias. El fetch
  automático es opt-in, corre cada 24 h por defecto y sólo alcanza los repos
  incluidos.
- Repositorios que no estén ya en la carpeta local no se clonan. Si se quiere
  trabajar con mirrors, deben habilitarse explícitamente en una fase posterior.

## Datos que se usan

Por cada repositorio se recolectan rama, upstream, rama principal indicada por
`origin/HEAD`, distancia ahead/behind, cambios locales, último commit y presencia de README, `docs/`, CONTRIBUTING y
CHANGELOG. Al generador se le pasa sólo un resumen de esos datos, no el contenido
del código ni rutas privadas fuera de la raíz configurada.

## Revisión de código

La revisión de código tiene una bandeja propia, separada de las sugerencias
personales del agente. Genera hallazgos técnicos (calidad, riesgos, pruebas,
documentación y salud Git), nunca propuestas de producto o nuevas
funcionalidades. No crea tareas ni modifica repositorios: cada hallazgo se
confirma o descarta manualmente.

El scheduler la ejecuta cada 7 días por defecto. Se controla con
`code_review_enabled` (default `1`) y `code_review_interval_days` (default `7`).
La primera ejecución puede lanzarse desde **Revisión de código**.

## Ejecución aprobada

Al usar **Ejecutar con coder** sobre una tarea de proyecto, Agent OS crea un
worktree en `CODE_PROJECT_WORKTREES_ROOT` (por defecto
`~/code/.agent-os-worktrees`) y una rama `codex/agentos-<tarea>`, basada en la
rama principal remota cuando está disponible. La ruta se deja como comentario en
Kanban antes de despachar el coder. La tarea debe conservar los checkpoints de
validación y documentación; si faltan, Agent OS no la despacha.

El repo se identifica mediante el campo `Repo:` de la tarea; no depende del
catálogo de proyectos de Hermes, que puede usar nombres distintos.

Al completar la tarea desde Agent OS, el gate verifica que el worktree esté
limpio, que `git diff --check` no reporte errores, y que los comentarios o la
tarea registren `Resultado de validación: …`. Si se cambió código, también exige
un archivo de documentación modificado o la justificación
`Documentación: no aplica: …`.
