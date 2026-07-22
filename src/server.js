// Servidor HTTP nativo del Agent OS: API neutral /api/* (vía AgentAdapter) +
// estáticos del frontend Preact+Vite. Zero-dep. El adapter es el único acoplado
// al agente; este archivo no sabe nada de Hermes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { HermesAdapter } from './adapters/hermes/HermesAdapter.js';
import { listGoals, createGoal, updateGoal, deleteGoal, allSettings, setSetting, getProfile, setProfile, clearSuggestions, deleteSuggestion } from './db.js';
import { getInbox, generateSuggestions, applySuggestion, dismissSuggestion, snoozeSuggestion, restoreSuggestion, sendMorningBrief } from './suggestions.js';
import { learnProfile } from './profile-learner.js';
import { generateDreams } from './dreamer.js';
import { listDreams, setDreamStatus } from './db.js';
import { startScheduler } from './scheduler.js';
import { computeAffinity } from './preferences.js';
import { getSecrets } from './secrets.js';
import { getCosts } from './costs.js';
import { listDocs, readDoc, rawDoc, deleteDoc } from './docs.js';
import { detectSoftware } from './onboarding.js';
import { listProjects, buildGraph } from './codegraph.js';

const adapter = new HermesAdapter(config.hermesDir, config.hermesBin, config.obsidianVault);
adapter.gatewayUrl = config.gatewayApiUrl;
adapter.gatewayKey = config.gatewayApiKey;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Cache simple por clave con TTL (evita releer archivos en cada request).
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < config.cacheTtlMs) return hit.val;
  const val = await fn();
  cache.set(key, { ts: Date.now(), val });
  return val;
}

// Lee y parsea un body JSON (límite defensivo). Devuelve {} si vacío/ inválido.
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 256 * 1024) { req.destroy(); resolve({}); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Rutas GET neutrales → método del adapter. Todas cacheadas por TTL.
const ROUTES = {
  '/api/overview': () => adapter.getOverview(),
  '/api/connections': () => adapter.getConnections(),
  '/api/personas': () => adapter.getPersonas(),
  '/api/skills': () => adapter.getSkills(),
  '/api/crons': () => adapter.getCrons(),
  '/api/models': () => adapter.getModels(),
  '/api/kanban': () => adapter.getKanban(),
  '/api/memory': () => adapter.getMemory(),
  '/api/obsidian': () => adapter.getObsidian(),
  '/api/dreaming': () => adapter.getDreaming(),
  '/api/dreaming/journey': () => adapter.getJourney(),
  '/api/dreaming/curator': () => adapter.getCurator(),
  '/api/approvals': () => adapter.getApprovals(),
  '/api/secrets': () => getSecrets(),
  '/api/costs': () => getCosts(),
  '/api/settings': () => allSettings(),
  '/api/software': () => detectSoftware(),
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(config.publicDir, rel));
  if (!full.startsWith(config.publicDir)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback: si no es un asset con extensión, servir index.html.
    if (!extname(full)) {
      try {
        const idx = await readFile(join(config.publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(idx);
      } catch { /* sin build todavía */ }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // Salud
    if (path === '/api/health') return sendJson(res, { ok: true, agent: adapter.name, ts: Date.now() });

    // --- Chat con STREAMING (Elem 4): proxya el SSE del gateway :8642 (OpenAI-compat).
    // 10x más rápido que el CLI. El frontend cae al /api/chat (CLI) si esto no está. ---
    if (req.method === 'POST' && path === '/api/chat/stream') {
      const body = await readBody(req);
      if (!config.gatewayApiKey) return sendJson(res, { error: 'gateway :8642 no configurado' }, 503);
      try {
        const up = await fetch(`${config.gatewayApiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.gatewayApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: body.messages || [], stream: true }),
          signal: AbortSignal.timeout(240_000),
        });
        if (!up.ok || !up.body) return sendJson(res, { error: `gateway HTTP ${up.status}` }, 502);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        for await (const chunk of up.body) res.write(chunk);
        res.end();
      } catch (e) {
        if (!res.headersSent) sendJson(res, { error: e.message }, 502); else res.end();
      }
      return;
    }

    // --- Escrituras (POST) → CLI del agente. Limpian la cache para reflejo inmediato. ---
    if (req.method === 'POST' && path.startsWith('/api/')) {
      const body = await readBody(req);
      if (path === '/api/crons/action') {
        const r = await adapter.cronAction(body.profile, body.id, body.action);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/crons/create') {
        const r = await adapter.cronCreate(body.profile, body);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/crons/model') {
        const r = await adapter.cronSetModel(body.profile, body.id, body);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/personas/model') {
        const r = await adapter.setPersonaModel(body.profile, body);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/kanban/create') {
        const r = await adapter.kanbanCreate(body.profile, body);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/kanban/comment') {
        const r = await adapter.kanbanComment(body.profile, body.id, body.text, body.board);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/kanban/action') {
        const r = await adapter.kanbanAction(body.profile, body.id, body.action, body);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/chat') {
        const r = await adapter.chat(body.profile, body.message, { sessionId: body.sessionId, model: body.model });
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/dreaming/run') {
        const r = await adapter.curatorRun(body.consolidate !== false);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/dreaming/consolidate') {
        const r = await adapter.setConsolidate(!!body.on);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      // Proactividad
      if (path === '/api/suggestions/generate') { const r = await generateSuggestions(adapter); cache.clear(); return sendJson(res, r, r.ok ? 200 : 400); }
      if (path === '/api/suggestions/apply') { const r = await applySuggestion(adapter, body.id); cache.clear(); return sendJson(res, r, r.ok ? 200 : 400); }
      if (path === '/api/suggestions/dismiss') { cache.clear(); return sendJson(res, dismissSuggestion(body.id, body.reason)); }
      if (path === '/api/suggestions/snooze') { cache.clear(); return sendJson(res, snoozeSuggestion(body.id)); }
      if (path === '/api/suggestions/restore') { cache.clear(); return sendJson(res, restoreSuggestion(body.id)); }
      if (path === '/api/suggestions/clear') { cache.clear(); return sendJson(res, clearSuggestions(body.scope || 'all')); }
      if (path === '/api/suggestions/delete') { cache.clear(); return sendJson(res, deleteSuggestion(body.id)); }
      if (path === '/api/suggestions/brief') { const r = await sendMorningBrief(adapter, { force: true }); cache.clear(); return sendJson(res, r, r.ok ? 200 : 400); }
      if (path === '/api/push/test') {
        const r = await adapter.pushMessage(body.channel || 'discord', body.text || '🔔 Test de entrega proactiva del Agent OS — podés ignorar este mensaje.');
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      if (path === '/api/profile') { cache.clear(); return sendJson(res, setProfile(body || {})); }
      if (path === '/api/profile/learn') { const r = await learnProfile(adapter); cache.clear(); return sendJson(res, r, r.ok ? 200 : (r.busy ? 409 : 400)); }
      if (path === '/api/dreams/generate') { const r = await generateDreams(adapter); cache.clear(); return sendJson(res, r, r.ok ? 200 : (r.busy ? 409 : 400)); }
      if (path === '/api/dreams/action') { cache.clear(); return sendJson(res, setDreamStatus(body.id, body.status === 'saved' ? 'saved' : 'dismissed')); }
      if (path === '/api/memory/write') {
        const r = await adapter.writeMemory(body.profile, body.which, body.text);
        cache.clear();
        return sendJson(res, r, r.ok ? 200 : 400);
      }
      // Mission Control (datos propios del Agent OS, no del agente).
      if (path === '/api/goals/create') return sendJson(res, createGoal(body));
      if (path === '/api/goals/update') {
        const g = updateGoal(body.id, body);
        return g ? sendJson(res, g) : sendJson(res, { error: 'no existe' }, 404);
      }
      if (path === '/api/goals/delete') return sendJson(res, deleteGoal(body.id));
      if (path === '/api/docs/delete') { const r = await deleteDoc(body.path); cache.clear(); return sendJson(res, r, r.ok ? 200 : 400); }
      if (path === '/api/settings/set') {
        if (!body.key) return sendJson(res, { error: 'key requerida' }, 400);
        const r = setSetting(body.key, body.value ?? '');
        cache.clear();
        return sendJson(res, r);
      }
      return sendJson(res, { error: 'not found' }, 404);
    }

    // Mission Control (lectura, sin cache: es barato y local).
    if (path === '/api/goals') return sendJson(res, listGoals());

    // Proactividad: inbox de sugerencias + perfil de usuario
    if (path === '/api/suggestions') return sendJson(res, getInbox());
    if (path === '/api/profile') return sendJson(res, getProfile());
    if (path === '/api/preferences') return sendJson(res, computeAffinity());
    if (path === '/api/skills/all') return sendJson(res, { skills: await adapter.getSkillsAllProfiles() });
    if (path === '/api/dreams') return sendJson(res, { dreams: listDreams() });

    // Sesiones de chat (para retomar conversaciones)
    if (path === '/api/sessions') return sendJson(res, await adapter.getSessions(url.searchParams.get('profile') || '(default)'));
    if (path === '/api/sessions/messages') {
      return sendJson(res, await adapter.getSessionMessages(url.searchParams.get('profile') || '(default)', url.searchParams.get('id')));
    }

    // Buscador global (sesiones + memorias + skills + documentos)
    if (path === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return sendJson(res, { q, sessions: [], memories: [], skills: [], docs: [] });
      const [agent, docsList] = await Promise.all([adapter.search(q), listDocs()]);
      const needle = q.toLowerCase();
      const docs = (docsList.docs || []).filter((d) =>
        d.name.toLowerCase().includes(needle) || (d.preview || '').toLowerCase().includes(needle)).slice(0, 12);
      return sendJson(res, { q, ...agent, docs });
    }

    // Code graph
    if (path === '/api/codegraph/projects') return sendJson(res, await listProjects());
    if (path === '/api/codegraph') return sendJson(res, await buildGraph(url.searchParams.get('path')));

    // Documentos
    if (path === '/api/docs') return sendJson(res, await listDocs());
    if (path === '/api/docs/read') return sendJson(res, await readDoc(url.searchParams.get('path')));
    if (path === '/api/docs/raw') {
      const r = await rawDoc(url.searchParams.get('path'));
      if (!r) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': r.mime, 'Cache-Control': 'no-store' });
      return res.end(r.data);
    }

    // Historial de un cron: /api/crons/history?profile=(default)&id=xxxx
    if (path === '/api/crons/history') {
      const profile = url.searchParams.get('profile');
      const id = url.searchParams.get('id');
      if (!profile || !id) return sendJson(res, { error: 'profile e id requeridos' }, 400);
      return sendJson(res, await adapter.getCronHistory(profile, id));
    }
    if (path === '/api/obsidian/file') {
      return sendJson(res, await adapter.getObsidianFile(url.searchParams.get('path')));
    }
    if (path === '/api/dreaming/insights') {
      return sendJson(res, await adapter.getInsights(url.searchParams.get('days') || 7));
    }
    if (path === '/api/crons/output') {
      const profile = url.searchParams.get('profile');
      const id = url.searchParams.get('id');
      const file = url.searchParams.get('file');
      return sendJson(res, await adapter.getCronOutput(profile, id, file));
    }

    // Rutas neutrales cacheadas
    if (ROUTES[path]) {
      const data = await cached(path, ROUTES[path]);
      return sendJson(res, data);
    }

    if (path.startsWith('/api/')) return sendJson(res, { error: 'not found' }, 404);

    return serveStatic(req, res, path);
  } catch (e) {
    console.error('[server]', e);
    sendJson(res, { error: 'internal', message: e.message }, 500);
  }
};

// Seguridad: bindear a localhost + Tailscale (no 0.0.0.0). HOST override fuerza uno solo.
const hosts = config.host ? [config.host] : (config.bindHosts.length ? config.bindHosts : ['127.0.0.1']);
let schedulerStarted = false;
for (const h of hosts) {
  createServer(handler).listen(config.port, h, () => {
    console.log(`Agent OS escuchando en http://${h}:${config.port}`);
    if (!schedulerStarted) {
      schedulerStarted = true;
      console.log(`  Agente: ${adapter.name}  ·  HERMES_DIR=${config.hermesDir}  ·  Frontend: ${config.publicDir}`);
      startScheduler(adapter); // proactividad automática (Fase 2), una sola vez
    }
  });
}
