// Bóveda de secretos — vista SOLO LECTURA de NOMBRES desde Bitwarden Secrets
// Manager (bws). NUNCA expone valores: descarta el campo `value` del JSON.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// Categoriza un secreto por el nombre de su clave (heurística).
function categorize(key) {
  const k = key.toLowerCase();
  if (/openrouter/.test(k)) return /manage|mgmt|admin|activity/.test(k) ? 'openrouter-mgmt' : 'openrouter';
  if (/github|gh_/.test(k)) return 'github';
  if (/slack/.test(k)) return 'slack';
  if (/discord/.test(k)) return 'discord';
  if (/telegram/.test(k)) return 'telegram';
  if (/google|gmail|oauth/.test(k)) return 'google';
  if (/netlify/.test(k)) return 'netlify';
  if (/anthropic|claude/.test(k)) return 'anthropic';
  if (/openai|codex/.test(k)) return 'openai';
  if (/gastienzo|gasto/.test(k)) return 'gastienzo';
  if (/webui|password|secret/.test(k)) return 'auth';
  return 'otros';
}

function resolveToken() {
  if (config.bwsAccessToken) return { token: config.bwsAccessToken, source: 'env' };
  // Fallback: leer BWS_ACCESS_TOKEN del .env de Hermes (token de máquina, RO).
  try {
    const env = readFileSync(join(config.hermesDir, '.env'), 'utf8');
    const m = env.match(/^BWS_ACCESS_TOKEN=(.+)$/m);
    if (m) return { token: m[1].trim().replace(/^["']|["']$/g, ''), source: 'hermes/.env' };
  } catch { /* sin .env */ }
  return { token: null, source: null };
}

// `bws secret list -o json` crudo (SÍ trae `value`) — privado, solo para los
// dos consumidores de abajo. Nunca se devuelve tal cual hacia afuera.
function runBwsList() {
  return new Promise((resolve) => {
    const { token, source } = resolveToken();
    if (!token) return resolve({ ok: false, error: 'sin BWS_ACCESS_TOKEN', source, list: [] });
    // Sin '--color','no' acá: config.bwsBin es un wrapper (~/.hermes/bin/bws)
    // que ya lo fuerza — pasarlo de nuevo duplica el flag y bws lo rechaza.
    execFile(config.bwsBin, ['secret', 'list', '-o', 'json'],
      { env: { ...process.env, BWS_ACCESS_TOKEN: token, NO_COLOR: '1' }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: 'bws falló (¿CLI o token?)', source, list: [] });
        // Defensa: bws 2.0.0 puede colorear con ANSI aún en pipe → limpiar antes de parsear.
        const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
        let arr;
        try { arr = JSON.parse(clean); } catch { return resolve({ ok: false, error: 'salida no-JSON', source, list: [] }); }
        resolve({ ok: true, source, list: arr });
      });
  });
}

export async function getSecrets() {
  const r = await runBwsList();
  if (!r.ok) return { ok: false, error: r.error, secrets: [] };
  // Mapear SIN el valor. Dedup por key+projectId.
  const seen = new Set();
  const secrets = [];
  for (const s of r.list) {
    const projectId = s.projectId || s.project_id || null;
    const dedup = `${s.key}|${projectId}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    secrets.push({ id: s.id, key: s.key, category: categorize(s.key || ''), projectId, note: s.note || null });
  }
  secrets.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
  return { ok: true, source: r.source, count: secrets.length, secrets };
}

// Valor REAL de un secreto puntual — uso interno server-side únicamente
// (nunca expuesto por ninguna ruta HTTP). Cachea 5 min para no pegarle a
// `bws` en cada uso (mismo TTL default que usa Hermes de su lado).
const VALUE_CACHE_TTL_MS = 5 * 60 * 1000;
const valueCache = new Map(); // `${tokenFingerprint}|${key}` -> { value, ts }

export async function getSecretValue(key) {
  const { token } = resolveToken();
  if (!token) return null;
  const cacheKey = `${token.slice(-8)}|${key}`;
  const hit = valueCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < VALUE_CACHE_TTL_MS) return hit.value;

  const r = await runBwsList();
  if (!r.ok) return null;
  const match = r.list.find((s) => s.key === key);
  const value = match ? match.value : null;
  valueCache.set(cacheKey, { value, ts: Date.now() });
  return value;
}
