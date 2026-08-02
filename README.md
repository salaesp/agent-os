# Agent OS

Capa visual y control seguro sobre el agente. **Agnóstico**: hoy lee/escribe contra
Hermes vía un `AgentAdapter`; mañana se implementa `OpenClawAdapter` con la misma
superficie y el resto no cambia. **No depende de `hermes-webui`** (se puede desinstalar).

## Arquitectura

```
Preact+Vite (app/)  ──/api/*──►  Node zero-dep (src/)  ──►  AgentAdapter
                                  (API neutral)              └─ HermesAdapter
                                                                ├─ lee: ~/.hermes (JSON/MD + sqlite RO)
                                                                ├─ escribe: CLI `hermes` (fase posterior)
                                                                └─ chat: gateway :8642 (fase posterior)
```

- **Backend** (`src/`): `node:http` + `node:sqlite` (read-only), sin dependencias.
  Requiere Node ≥ 22.5. El adapter es lo único acoplado al agente.
- **Frontend** (`app/`): Preact + Vite, Material 3 (tokens reusados del minipc-dashboard).
- **Puerto**: `8082` (env `PORT`).

## Secciones (18)

| Sección | Qué hace | Escrituras |
|---|---|---|
| Inicio | resumen agregado + logo ASCII de Hermes | — |
| Chat | conversar con el agente (`hermes chat`, continuidad por perfil) | ✓ |
| Consola | terminal real (xterm.js) con **Claude Code** corriendo en un workspace | ✓ shell de Claude |
| Buscador | FTS de sesiones + memorias + skills + docs | — |
| Mission Control | objetivos: brief, roles, progreso, estado (`agentos.db`) | ✓ CRUD |
| Dreaming | morning brief desde el output del cron `daily-digest` | — |
| Conexiones | gateways, canales, MCP por perfil | — |
| Pantheon | personas (`SOUL.md`+`config.yaml`) + skills (`SKILL.md`+`.usage.json`) | — |
| Analytics | uso de skills, skills muertas, ROI de tiempo/plata | — |
| Code Graph | grafo de dependencias e inventario Git seguro de proyectos en `~/code` | `fetch` manual |
| Costos | Claude+OpenRouter (lee `metrics.db` del dashboard) + alertas | ✓ presupuesto |
| Crons | jobs + historial; crear/pausar/reanudar/ejecutar/eliminar | ✓ |
| Kanban | tablero multi-board; crear/comentar/completar/bloquear/archivar | ✓ |
| Aprobaciones | HITL (requiere gateway `:8642`; muestra cómo habilitarlo) | — |
| Documentos | carpeta `~/agent-os-docs` reflejada, preview/filtro/borrar | ✓ borrar |
| Memoria | `MEMORY.md`/`USER.md` editables + Obsidian Tier 2/3 (read) | ✓ Tier 1 · ✓ vault `rem/` |
| Secretos | bóveda bws — solo nombres, nunca valores | — |
| Onboarding | detección de software + config de ROI | ✓ settings |

Las lecturas iteran `(default) + profiles/*`. Ningún sqlite de Hermes se abre en
escritura; toda mutación pasa por el CLI `hermes`.

El nav agrupa las secciones en cinco: **Agente** (Inicio, Chat, Consola),
**Proactividad** (Sugerencias, Dreaming), **Planificación** (Mission Control,
Kanban, Crons), **Memoria** (Perfil, Obsidian) y **Sistema** (Conexiones,
Pantheon, Costos). En mobile el sidebar pasa a barra inferior y los grupos se
disuelven (`display: contents`), quedando solo el orden de los íconos.

## Rastro de decisiones y consolidación REM

Dos tablas en `agentos.db` (`decisions`, `runs`) registran **por qué** el Agent OS
propuso cada cosa —la fórmula de score completa, la evidencia y el contexto que
entró—, qué hiciste con eso, y cada invocación del CLI con su duración y error.
`parent_id` encadena sueño → sugerencia → decisión tuya; `GET /api/decisions?chain=<id>`
la devuelve entera. Los candidatos en modo `store` y los descartados por score,
que antes no dejaban rastro en ningún lado, ahora también quedan.
Spec completa en `docs/decision-trail.md`.

`src/rem.js` cierra el día como último paso del bundle nocturno: consolida el día
anterior (hechos desde la base, prosa por un único pass tool-free que puede fallar
sin tumbar la nota) y lo escribe en `<vault>/rem/YYYY-MM-DD.md`. Reescritura
completa, nunca append — así no se repite el `daily/2026-07-07.md` con los headings
duplicados. También ingiere las decisiones humanas de `decisions/YYYY-MM.md` al
mismo ledger, y purga el rastro más viejo que `rem_retention_days` (90).

> **Es la única escritura al vault**, acotada por whitelist de prefijo resuelto a
> `rem/`: `rem/../living/identity.md` se rechaza. El resto del vault (`living/`,
> `daily/`, `decisions/`, `mama/`) sigue siendo estrictamente de lectura — lo
> escribe Hermes por su cuenta.

Settings: `auto_rem_enabled` (default `1`), `rem_retention_days` (default `90`).
A mano: `POST /api/rem/run` (opcional `{"day":"YYYY-MM-DD"}`).

**Notas honestas:** el chat corre el agente completo vía CLI (no streaming — el
gateway `:8642` no está habilitado). La cola HITL real y el chat con streaming
necesitan habilitar ese gateway. La parte del "code graph" que reduce tokens del
agente (repo externo del video) necesita su URL para integrarse; la vista visual
del grafo ya está.

## Proyectos Git y sugerencias de código

Code Graph también muestra salud Git de los repositorios locales y permite
actualizar sus referencias remotas con `git fetch --prune origin`. Nunca hace
`pull`, checkout o cambios de archivos automáticamente. El motor de Sugerencias
recibe un resumen de rama, cambios locales, distancia con el upstream, último
commit y presencia de documentación; las sugerencias de código se crean como
tareas Kanban y deben incluir validación y actualización de documentación cuando
corresponda. Ver [`PROJECT_INTELLIGENCE.md`](PROJECT_INTELLIGENCE.md).

Configuración: `CODE_PROJECTS_ROOT` (por defecto `CODE_GRAPH_ROOT` o `~/code`),
`CODE_PROJECT_WORKTREES_ROOT`, y los settings `project_suggestions_enabled`
(default `1`), `project_auto_fetch_enabled` (default `0`) y
`project_fetch_interval_h` (default `24`). Al disparar un coder para una tarea
de proyecto, se crea un worktree aislado con una rama `codex/agentos-…`; el
checklist de tests y documentación bloquea el despacho si no está presente.

## Consola (Claude Code por web)

Terminal real en el browser, sin ssh. `src/terminal.js` levanta **una sesión tmux por
workspace** con `claude` adentro y le engancha un PTY por cada pestaña abierta:

```
xterm.js ──SSE (/api/term/attach)──► script -qfec "tmux attach" ──► tmux agentos-<ws> ──► claude
         ──POST (/api/term/input)──►
```

- **Persistente**: refrescás la página (o cerrás el browser) y Claude sigue donde estaba.
  `KillMode=process` en el unit hace que sobreviva también a un `restart` del Agent OS.
- **Zero-dep en el server**: el PTY lo da `script` (util-linux); tmux pone la persistencia.
  No hace falta `node-pty`.
- **El tamaño va por el PTY, no por `resize-window`.** El PTY de `script` nace *sin*
  tamaño y tmux lo asume 80x24: entonces le manda al cliente solo el recorte de 80x24
  de la ventana y la consola se ve cortada, por más grande que sea la ventana. Por eso
  el attach hace `stty rows/cols` con la medida del browser antes del `tmux attach`, y
  cada resize posterior es un `stty -F <pty del cliente>` (el tty se resuelve por
  `/proc/<pid>/task/<pid>/children` → `fd/0`). tmux queda en `window-size latest`.
- **Dos detalles del lado del browser**, ambos medidos en Chromium headless por CDP
  (`--remote-debugging-port` + `Runtime.evaluate`), no a ojo:
  la altura de la tarjeta se **mide** (`innerHeight − top − padding-bottom de .content`)
  porque un `calc(100vh - N)` a ojo deja la consola unos px por debajo del contenedor; y
  la barra de scroll de xterm se oculta, porque ocupa ~15px que FitAddon no descuenta al
  calcular columnas y la última columna de texto termina dibujada **debajo** de la barra.
  Del redondeo sub-carácter se encarga `trimOverflowingColumn()`: mide lo dibujado y saca
  una columna si se pasa (sumar padding de holgura no sirve — la relación es en diente de
  sierra y puede empeorar).
- **Alcance acotado**: el proceso de la sesión es `claude`, no una shell. Los workspaces
  son una allowlist — subdirectorios directos de `CODE_GRAPH_ROOT` (`~/code`) más el
  propio Agent OS; un `workspace` que no esté en esa lista se rechaza.
- Envs: `CLAUDE_BIN` (default `~/.local/bin/claude`), `CODE_GRAPH_ROOT`.

> Ojo con la superficie: quien llegue al puerto maneja un Claude con permisos de
> escritura sobre esas carpetas. Por eso el server sigue bindeando solo a `127.0.0.1`
> y a la IP de Tailscale — nunca `0.0.0.0`.

## Desarrollo

```bash
# Backend (API en :8082)
node --experimental-sqlite src/server.js

# Frontend (dev con proxy a la API, en :5173)
cd app && npm install && npm run dev

# Build de producción (sale a app/dist, que el backend sirve)
cd app && npm run build
```

## Servicio (systemd --user)

```bash
cp deploy/agent-os.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-os.service
```
