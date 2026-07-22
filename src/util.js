// Utilidades compartidas (zero-dep). Ninguna lanza: devuelven null/[] ante error.
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson(path) {
  const t = await readText(path);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Lista subdirectorios (Dirent) de un directorio. [] si no existe.
export async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch { return []; }
}

export async function listEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch { return []; }
}

// Ejecuta un comando y devuelve stdout (o null si falla). Nunca lanza.
export async function run(cmd, args = [], opts = {}) {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024, ...opts });
    return stdout;
  } catch (e) {
    return e.stdout ?? null;
  }
}

// --- Parsers mínimos (evitan una dependencia de YAML) ---

// Extrae el frontmatter YAML de un SKILL.md/DESCRIPTION.md (bloque entre --- ... ---)
// y devuelve pares clave: valor de PRIMER nivel + un puñado de campos conocidos.
// No es un parser YAML completo: cubre lo que necesitamos (name, description, version,
// tags, related_skills). Devuelve {} si no hay frontmatter.
export function parseFrontmatter(md) {
  if (!md) return {};
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!m) return {};
  const block = m[1];
  const out = {};
  // claves de primer nivel: `key: value`
  const kv = /^([A-Za-z0-9_]+):[ \t]*(.*)$/gm;
  let mm;
  while ((mm = kv.exec(block))) {
    const key = mm[1];
    let val = mm[2].trim();
    if (val === '' || val === '|' || val === '>') continue; // bloques/anidados: ignoramos
    // listas inline [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      out[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      out[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  // tags anidados bajo metadata.hermes.tags: [ ... ]
  const tags = block.match(/tags:\s*\[([^\]]*)\]/);
  if (tags && !out.tags) {
    out.tags = tags[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return out;
}

// Devuelve el primer valor `default:` dentro de un bloque `model:` de un config.yaml
// y el `provider:`. Regex acotada a las primeras líneas del bloque.
export function extractModel(yaml) {
  if (!yaml) return { model: null, provider: null };
  const block = yaml.match(/^model:\s*\n((?:[ \t]+.*\n?)+)/m);
  const body = block ? block[1] : yaml;
  const def = body.match(/^[ \t]+default:[ \t]*(.+)$/m);
  const prov = body.match(/^[ \t]+provider:[ \t]*(.+)$/m);
  return {
    model: def ? def[1].trim().replace(/^["']|["']$/g, '') : null,
    provider: prov ? prov[1].trim().replace(/^["']|["']$/g, '') : null,
  };
}

// Primer título/heading o primeras N palabras de un markdown (para preview de SOUL.md).
export function excerpt(md, words = 40) {
  if (!md) return '';
  const clean = md.replace(/^---[\s\S]*?---\s*/m, '').replace(/[#>*_`]/g, '').trim();
  const w = clean.split(/\s+/).slice(0, words);
  return w.join(' ') + (clean.split(/\s+/).length > words ? '…' : '');
}
