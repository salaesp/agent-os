// Gestor de documentos: refleja los archivos de config.docsDir en el dashboard.
// Cualquier cosa que el agente (o vos) guarden ahí aparece con preview/filtro/
// borrado. Validación estricta contra path traversal.
import { readdir, readFile, stat, unlink, mkdir } from 'node:fs/promises';
import { join, extname, relative, resolve, sep } from 'node:path';
import { config } from './config.js';

await mkdir(config.docsDir, { recursive: true }).catch(() => {});
const ROOT = resolve(config.docsDir);

const TYPE_BY_EXT = {
  '.html': 'html', '.htm': 'html',
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.log': 'text',
  '.json': 'data', '.csv': 'data', '.yaml': 'data', '.yml': 'data', '.tsv': 'data',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.svg': 'image', '.webp': 'image',
  '.pdf': 'pdf',
};
const typeOf = (name) => TYPE_BY_EXT[extname(name).toLowerCase()] || 'other';
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf',
};

// Resuelve un path relativo de forma segura DENTRO de ROOT. null si escapa.
function safe(rel) {
  if (!rel) return null;
  const full = resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

export async function listDocs() {
  let entries;
  try { entries = await readdir(ROOT, { withFileTypes: true, recursive: true }); }
  catch { return { ok: false, path: ROOT, docs: [] }; }
  const docs = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith('.')) continue;
    const dir = e.parentPath || e.path || ROOT;
    const full = join(dir, e.name);
    let st; try { st = await stat(full); } catch { continue; }
    const rel = relative(ROOT, full);
    const type = typeOf(e.name);
    let preview = null;
    if (['markdown', 'text', 'data', 'html'].includes(type) && st.size < 512 * 1024) {
      const t = await readFile(full, 'utf8').catch(() => '');
      preview = t.replace(/^---[\s\S]*?---/, '').replace(/[#>*`_]/g, '').trim().slice(0, 160);
    }
    docs.push({ name: e.name, path: rel, type, size: st.size, mtime: st.mtimeMs, preview });
  }
  docs.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, path: ROOT, docs };
}

export async function readDoc(rel) {
  const full = safe(rel);
  if (!full) return { ok: false, error: 'path inválido' };
  const type = typeOf(full);
  if (!['markdown', 'text', 'data', 'html'].includes(type)) return { ok: false, error: 'no es texto' };
  const content = await readFile(full, 'utf8').catch(() => null);
  if (content == null) return { ok: false, error: 'no se pudo leer' };
  return { ok: true, type, content };
}

// Sirve bytes crudos (imágenes/pdf) para <img>/<embed>.
export async function rawDoc(rel) {
  const full = safe(rel);
  if (!full) return null;
  const data = await readFile(full).catch(() => null);
  if (!data) return null;
  return { data, mime: MIME[extname(full).toLowerCase()] || 'application/octet-stream' };
}

export async function deleteDoc(rel) {
  const full = safe(rel);
  if (!full) return { ok: false, error: 'path inválido' };
  try { await unlink(full); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
