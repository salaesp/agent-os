// Configuración central del Agent OS. Todo sobreescribible por entorno (systemd).
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

// IP de Tailscale (interfaz tailscale0, o rango CGNAT 100.x). Para bindear ahí.
function tailscaleIp() {
  const e = env('TAILSCALE_IP', null);
  if (e) return e;
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (!/tailscale|tun/i.test(name)) continue;
    for (const a of ifs[name] || []) if (a.family === 'IPv4') return a.address;
  }
  for (const name of Object.keys(ifs)) for (const a of ifs[name] || []) if (a.family === 'IPv4' && a.address.startsWith('100.')) return a.address;
  return null;
}

const TS_IP = tailscaleIp();

export const config = {
  port: Number(env('PORT', 8082)),
  // Seguridad: por defecto NO escuchar en 0.0.0.0. Bindear a localhost + Tailscale.
  // HOST override fuerza un único host (compat). Sin override → bindHosts (dual).
  host: env('HOST', null),
  tailscaleIp: TS_IP,
  bindHosts: [...new Set(['127.0.0.1', TS_IP].filter(Boolean))],

  // Raíz del agente actual (Hermes). El adapter es el único que la conoce.
  hermesDir: env('HERMES_DIR', join(HOME, '.hermes')),
  // Binario del CLI `hermes` (para las escrituras). Absoluto para no depender del PATH.
  hermesBin: env('HERMES_BIN', join(HOME, '.local', 'bin', 'hermes')),
  // Vault de Obsidian: memoria Tier 2/3 del agente (living/, daily/, decisions/).
  obsidianVault: env('OBSIDIAN_VAULT_PATH', join(HOME, 'obsidian-vault')),
  // Costos: se leen read-only del sqlite que ya mantiene el minipc-dashboard
  // (claude_usage, claude_plan, openrouter_usage). Sin duplicar el polling.
  metricsDbPath: env('METRICS_DB', join(HOME, 'code', 'minipc-dashboard', 'data', 'metrics.db')),
  // Carpeta de documentos/artifacts que se refleja en el dashboard (dentro del proyecto).
  docsDir: env('DOCS_DIR', join(import.meta.dirname, '..', 'docs')),
  // Code graph: raíz donde buscar proyectos (dirs con package.json).
  codeGraphRoot: env('CODE_GRAPH_ROOT', join(HOME, 'code')),
  // Inventario Git: repos locales a analizar. No se clona ni se hace pull;
  // CODE_PROJECTS_ROOT permite separarlo del Code Graph si hiciera falta.
  projectsRoot: env('CODE_PROJECTS_ROOT', env('CODE_GRAPH_ROOT', join(HOME, 'code'))),
  // Worktrees aislados para tareas de código aprobadas. Se crea uno por tarea
  // sólo al despachar el coder; la carpeta oculta no entra al inventario.
  projectWorktreesRoot: env('CODE_PROJECT_WORKTREES_ROOT', join(env('CODE_PROJECTS_ROOT', env('CODE_GRAPH_ROOT', join(HOME, 'code'))), '.agent-os-worktrees')),
  // Consola web: binario de Claude Code que se levanta dentro del workspace elegido.
  claudeBin: env('CLAUDE_BIN', join(HOME, '.local', 'bin', 'claude')),

  // Estado PROPIO del Agent OS (objetivos, alertas, índice de docs, roi). Separado
  // de los sqlite de Hermes. (Se usa a partir de la fase de escrituras.)
  dbPath: env('DB_PATH', join(import.meta.dirname, '..', 'data', 'agentos.db')),

  // Frontend Preact+Vite compilado. Antes del primer build no existe (API igual anda).
  publicDir: env('PUBLIC_DIR', join(import.meta.dirname, '..', 'app', 'dist')),

  // Cache de lecturas del adapter (ms). Evita releer archivos en cada request.
  cacheTtlMs: Number(env('CACHE_TTL_MS', 5000)),

  // Bitwarden Secrets Manager (solo lectura de NOMBRES para la bóveda). Opcional.
  bwsAccessToken: env('BWS_ACCESS_TOKEN', null),
  bwsBin: env('BWS_BIN', join(HOME, '.local', 'bin', 'bws')),

  // API key de OpenRouter para TTS (audio de research). Override manual opcional
  // por entorno — el camino normal es resolverla en vivo desde Bitwarden
  // (secrets.js::getSecretValue), no pegarla acá en texto plano.
  openrouterApiKey: env('OPENROUTER_API_KEY', null),

  // Gateway API OpenAI-compatible de Hermes (para el chat, fase posterior).
  gatewayApiUrl: env('HERMES_GATEWAY_API', 'http://127.0.0.1:8642'),
  gatewayApiKey: env('API_SERVER_KEY', null),

  // URL pública desde la que se accede al dashboard (para links de un-click en
  // notificaciones push). Sin override, se arma con la IP de Tailscale.
  publicUrl: env('PUBLIC_URL', TS_IP ? `http://${TS_IP}:${Number(env('PORT', 8082))}` : null),
};
