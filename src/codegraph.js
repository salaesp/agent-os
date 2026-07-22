// Code graph: construye el grafo de dependencias (imports) de un proyecto JS/TS.
// Parte "vista visual integrada": nodos = archivos, aristas = imports relativos.
// (La parte de "menos tokens para el agente" del video requiere el repo externo
// específico; esto entrega el grafo navegable, self-contained.)
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.js';

const SKIP = new Set(['node_modules', 'dist', '.git', '.worktrees', 'vendor', 'build', '.next', 'coverage']);
const EXTS = ['.js', '.jsx', '.mjs', '.ts', '.tsx'];
const IMPORT_RE = /(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;

async function walk(dir, root, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (EXTS.includes(extname(e.name))) out.push(full);
  }
}

async function resolveImport(fromFile, spec, files) {
  const base = resolve(dirname(fromFile), spec);
  const cands = [base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => join(base, 'index' + x))];
  for (const c of cands) if (files.has(c)) return c;
  return null;
}

export async function listProjects() {
  const roots = [config.codeGraphRoot || join(homedir(), 'code')];
  const projects = [];
  for (const r of roots) {
    let entries;
    try { entries = await readdir(r, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      try { await stat(join(r, e.name, 'package.json')); projects.push({ name: e.name, path: join(r, e.name) }); } catch { /* sin package.json */ }
    }
  }
  return { ok: true, projects };
}

export async function buildGraph(projectPath) {
  const root = resolve(projectPath || '');
  if (!root || !root.startsWith(resolve(join(homedir(), 'code')))) return { ok: false, error: 'path fuera de ~/code' };
  const fileList = [];
  await walk(root, root, fileList);
  if (fileList.length > 1200) fileList.length = 1200; // cota defensiva
  const files = new Set(fileList);

  const nodes = new Map(); // id(rel) -> {id, dir, imports, importedBy}
  const edges = [];
  const idOf = (f) => relative(root, f);
  for (const f of fileList) nodes.set(idOf(f), { id: idOf(f), dir: relative(root, dirname(f)) || '.', imports: 0, importedBy: 0 });

  for (const f of fileList) {
    let text; try { text = await readFile(f, 'utf8'); } catch { continue; }
    const from = idOf(f);
    IMPORT_RE.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = IMPORT_RE.exec(text))) {
      const target = await resolveImport(f, m[1], files);
      if (!target) continue;
      const to = idOf(target);
      if (to === from || seen.has(to)) continue;
      seen.add(to);
      edges.push({ from, to });
      nodes.get(from).imports++;
      nodes.get(to).importedBy++;
    }
  }

  const nodeArr = [...nodes.values()];
  const hubs = [...nodeArr].sort((a, b) => b.importedBy - a.importedBy).slice(0, 8).filter((n) => n.importedBy > 0);
  return { ok: true, root, files: nodeArr.length, edgeCount: edges.length, nodes: nodeArr, edges, hubs };
}
