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

## Secciones (17)

| Sección | Qué hace | Escrituras |
|---|---|---|
| Inicio | resumen agregado + logo ASCII de Hermes | — |
| Chat | conversar con el agente (`hermes chat`, continuidad por perfil) | ✓ |
| Buscador | FTS de sesiones + memorias + skills + docs | — |
| Mission Control | objetivos: brief, roles, progreso, estado (`agentos.db`) | ✓ CRUD |
| Dreaming | morning brief desde el output del cron `daily-digest` | — |
| Conexiones | gateways, canales, MCP por perfil | — |
| Pantheon | personas (`SOUL.md`+`config.yaml`) + skills (`SKILL.md`+`.usage.json`) | — |
| Analytics | uso de skills, skills muertas, ROI de tiempo/plata | — |
| Code Graph | grafo de dependencias (imports) de proyectos en `~/code` | — |
| Costos | Claude+OpenRouter (lee `metrics.db` del dashboard) + alertas | ✓ presupuesto |
| Crons | jobs + historial; crear/pausar/reanudar/ejecutar/eliminar | ✓ |
| Kanban | tablero multi-board; crear/comentar/completar/bloquear/archivar | ✓ |
| Aprobaciones | HITL (requiere gateway `:8642`; muestra cómo habilitarlo) | — |
| Documentos | carpeta `~/agent-os-docs` reflejada, preview/filtro/borrar | ✓ borrar |
| Memoria | `MEMORY.md`/`USER.md` editables + Obsidian Tier 2/3 (read) | ✓ Tier 1 |
| Secretos | bóveda bws — solo nombres, nunca valores | — |
| Onboarding | detección de software + config de ROI | ✓ settings |

Las lecturas iteran `(default) + profiles/*`. Ningún sqlite de Hermes se abre en
escritura; toda mutación pasa por el CLI `hermes`.

**Notas honestas:** el chat corre el agente completo vía CLI (no streaming — el
gateway `:8642` no está habilitado). La cola HITL real y el chat con streaming
necesitan habilitar ese gateway. La parte del "code graph" que reduce tokens del
agente (repo externo del video) necesita su URL para integrarse; la vista visual
del grafo ya está.

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
