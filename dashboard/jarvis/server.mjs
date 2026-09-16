#!/usr/bin/env node
/**
 * JARVIS dashboard server — serves dashboard/jarvis on the LAN and gives the page
 * REAL data with no keys in the browser.
 *
 *   node server.mjs            # http://0.0.0.0:9150  (LAN: http://<NODE_LAN_IP>:9150)
 *
 * Configuration: process.env > <repo>/.env > derived defaults (lib/config.mjs).
 * Start it from a plain shell, not from inside a Claude Code terminal.
 *
 * Routes (all JSON unless noted):
 *   GET  /                      the dashboard (static files from this folder; lib/, tests/, server.mjs are never served)
 *   GET  /api/config            where things live, computed for the caller's host
 *   ANY  /api/omni/<path>       proxy -> OmniRoute /v1/<path> with OMNI_ROUTE_API_KEY from the repo .env
 *   GET  /api/agents            every loadable skill (SKILL.md frontmatter) — live directory read
 *   GET  /api/nodes             god's-eye view: both LAN nodes, every service identity-probed (lib/nodes.mjs)
 *   GET  /api/business           read-only Date App/Emergent + CRM/marketing aggregates (lib/emergent-crm.mjs)
 *   GET  /api/vault/graph       Obsidian vault notes + [[wikilinks]] as nodes/links
 *   GET  /api/vault/note?p=     one note's markdown (path relative to the vault)
 *   GET  /api/vault/status      is the Obsidian Local REST API answering on :27123 (identity checked)
 *   GET  /api/house             FABLE'S SENTRY snapshot (real service state, identity-checked)
 *   GET  /api/avatars           rendered avatar PNGs in ops/avatar/out
 *   GET  /avatars/<file>        those PNGs
 *   GET  /api/claude/status     Claude CLI bridge capability (lib/bridge-routes.mjs; local-only unless DASHBOARD_BRIDGE_TOKEN)
 *   POST /api/claude/chat       headless `claude -p` streamed as Server-Sent Events
 *   POST /api/claude/stop       kill the running bridge child
 *   POST /api/launch/claude     open the official Claude CLI in a console on this host
 *   GET  /api/ollama/tags       local Ollama models
 *   POST /api/ollama/chat       local Ollama chat streamed as Server-Sent Events
 *   GET  /health                {service:"airi-dashboard"}  <- identity string for the wall
 *
 * Zero dependencies. Secrets are read from .env at request time and never logged or returned.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { resolveConfig, resolveVault, readEnvFile } from './lib/config.mjs';
import { probeAll } from './lib/nodes.mjs';
import { businessSnapshot } from './lib/emergent-crm.mjs';
import { resolveClaudeBinary, killTree, PERMISSION_MODES, PERSONAS } from './lib/claude-bridge.mjs';
import { handleBridgeRoutes } from './lib/bridge-routes.mjs';
import { hostname } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// process.env > <repo>/.env > derived defaults (lib/config.mjs). The repo root is this checkout.
const CFG = resolveConfig({ here: HERE });
const REPO = CFG.repo;
const PORT = CFG.port;
const LAN_IP = CFG.lanIp;
const OMNI = CFG.omni;
// Vault resolution self-heals across machines: a configured path that does not exist
// (e.g. a Sabertooth path on Alienware) is skipped in favour of an existing candidate.
const VAULT_CFG = resolveVault({ env: process.env, readEnv: readEnvFile, envFile: CFG.envFile, candidates: [join(REPO, 'Antigravity'), 'C:\\DREAM\\AlienwareDream'] });
const VAULT = VAULT_CFG.path;
const VAULT_NAME = VAULT_CFG.name;
const SENTRY = CFG.sentry; // Fable's Sentry lives on Sabertooth unless FABLES_SENTRY_URL says otherwise
const OBSIDIAN_REST = 'http://127.0.0.1:27123';
// Skills tree: the classic .agents/skills layout when present, else this repo's skills/ folder.
const SKILLS = [join(REPO, '.agents', 'skills'), join(REPO, 'skills')].find((d) => existsSync(d)) || join(REPO, 'skills');
const AVATARS = join(REPO, 'ops', 'avatar', 'out');
const STARTED_AT = new Date().toISOString(); // the House restarts this server when server.mjs is newer

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };

// Secrets are read from the .env at request time and never logged or returned.
function envValue(name) {
  return process.env[name] || readEnvFile(CFG.envFile)[name] || readEnvFile(join(REPO, '.env'))[name] || '';
}

function businessEnv() {
  return { ...readEnvFile(join(REPO, '.env')), ...readEnvFile(CFG.envFile), ...process.env };
}

// ── skills = agents (live directory read; --hash clones are Paperclip copies, skipped) ──
function agents() {
  if (!existsSync(SKILLS)) return [];
  const out = [];
  for (const d of readdirSync(SKILLS)) {
    if (/--[0-9a-f]{6,}$/.test(d)) continue;
    const f = join(SKILLS, d, 'SKILL.md');
    if (!existsSync(f)) continue;
    let name = d, description = '';
    try {
      const head = readFileSync(f, 'utf8').slice(0, 4000);
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
      if (fm) {
        const n = /^name:\s*(.+)$/m.exec(fm[1]); if (n) name = n[1].trim().replace(/^"|"$/g, '');
        const ds = /^description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:|\s*$)/m.exec(fm[1]);
        if (ds) description = ds[1].replace(/^[>|]-?\s*/, '').replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
      }
    } catch {}
    const category = d.startsWith('agency-') ? 'agency'
      : d.startsWith('dateapp-') ? 'date app'
      : d.startsWith('hermes-') ? 'hermes'
      : d.startsWith('paperclip') ? 'paperclip (parked)'
      : d.startsWith('azure-') || d.startsWith('microsoft-') || d.startsWith('entra-') || d.startsWith('appinsights') ? 'azure'
      : /market|growth|seo|social|content|affiliate|copy|devrel|preorder|revenue/.test(d) ? 'marketing'
      : /judge|orchestrat|house|sabretooth|mission|omniroute|fables|self-improving|ceo|status-card|issue-triage|doc-maint|workspace-memory|para-memory|planning|verification|requesting|finishing|executing|writing-plans|subagent|dispatching|using-git|systematic|tdd|test-driven|brainstorm|find-skills|skill-creator|create-skills|caveman|adhd|reflection/.test(d) ? 'ops + method'
      : /game|unreal|godot|unity|dream|motion/.test(d) ? 'game + design'
      : /supabase|payments|browser|agent-reach|miyo|obsidian|openviking|system-connector|webapp|ui-ux|sleek|21st/.test(d) ? 'tools'
      : 'other';
    out.push({ id: d, name, description, category, path: `.agents/skills/${d}/SKILL.md` });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Obsidian vault graph (notes + wikilinks), cached 60 s ─────────────────────
let graphCache = { at: 0, data: null };
function walk(dir, base, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else if (e.name.toLowerCase().endsWith('.md')) acc.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
}
function vaultGraph() {
  if (Date.now() - graphCache.at < 60000 && graphCache.data) return graphCache.data;
  if (!existsSync(VAULT)) return { ok: false, error: 'vault not found: ' + VAULT, nodes: [], links: [] };
  const files = [];
  walk(VAULT, VAULT, files);
  const byName = new Map();
  const nodes = files.map((rel) => {
    const name = rel.replace(/\.md$/i, '');
    const short = name.split('/').pop();
    const folder = name.includes('/') ? name.split('/')[0] : '(root)';
    const n = { id: name, label: short, group: folder, out: 0, in: 0 };
    byName.set(name.toLowerCase(), n);
    if (!byName.has(short.toLowerCase())) byName.set(short.toLowerCase(), n);
    return n;
  });
  const links = [];
  const seen = new Set();
  for (const rel of files) {
    const src = byName.get(rel.replace(/\.md$/i, '').toLowerCase());
    let txt; try { txt = readFileSync(join(VAULT, rel), 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const target = byName.get(m[1].trim().replace(/\.md$/i, '').toLowerCase());
      if (!target || target === src) continue;
      const key = src.id + '\u0000' + target.id;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: src.id, target: target.id });
      src.out++; target.in++;
    }
  }
  const data = { ok: true, vault: VAULT, name: VAULT_NAME, notes: nodes.length, wikilinks: links.length,
    orphans: nodes.filter((n) => n.in + n.out === 0).length, nodes, links, at: new Date().toISOString() };
  graphCache = { at: Date.now(), data };
  return data;
}
function vaultNote(rel) {
  const full = resolve(VAULT, rel.endsWith('.md') ? rel : rel + '.md');
  if (!full.startsWith(resolve(VAULT) + sep)) return { ok: false, error: 'outside the vault' };
  if (!existsSync(full)) return { ok: false, error: 'not found' };
  return { ok: true, path: rel, markdown: readFileSync(full, 'utf8').slice(0, 200000) };
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function getJson(url, ms = 20000, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { status: r.status, json: j, text }; }
  catch (e) { return { status: 0, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
function readBody(req) { return new Promise((res) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => res(Buffer.concat(b))); }); }
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveStatic(res, rel) {
  const full = resolve(HERE, '.' + rel);
  if (!full.startsWith(resolve(HERE) + sep) && full !== resolve(HERE)) return send(res, 403, { error: 'forbidden' });
  if (!existsSync(full) || statSync(full).isDirectory()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(full));
}

// ── server ────────────────────────────────────────────────────────────────────
// Bridge + Ollama routes (lib/bridge-routes.mjs) run first: no wildcard CORS, origin-checked, local-only by default.
const BRIDGE_DEPS = { cfg: CFG, envValue, spawn, killTree: (child) => killTree(child, { spawn }), resolveBinary: () => resolveClaudeBinary(), fetch: globalThis.fetch };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (await handleBridgeRoutes(req, res, BRIDGE_DEPS)) return;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }

  if (p === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0d1117"/><circle cx="16" cy="16" r="9" fill="none" stroke="#58a6ff" stroke-width="3"/><circle cx="16" cy="16" r="3" fill="#3fb950"/></svg>'); }
  if (p === '/health') return send(res, 200, { status: 'ok', service: 'airi-dashboard', port: PORT, startedAt: STARTED_AT });

  if (p === '/api/config') {
    const host = (req.headers.host || '').replace(/:\d+$/, '') || LAN_IP;
    return send(res, 200, {
      host, lanIp: LAN_IP, omniRoute: OMNI, omniProxy: '/api/omni',
      missionControl: CFG.missionControl, hermesDashboard: `http://${host}:9119/`, sentry: SENTRY + '/',
      vault: { path: VAULT, name: VAULT_NAME, rest: OBSIDIAN_REST },
      claude: {
        chat: '/api/claude/chat', status: '/api/claude/status', launch: '/api/launch/claude',
        command: 'claude -p --output-format stream-json (headless, account auth)',
        note: 'Chat streams from the official Claude CLI on ' + (CFG.nodeName || hostname()) + '. Loopback callers only unless DASHBOARD_BRIDGE_TOKEN is set in .env. The launch button opens an interactive window on this host.',
        personas: Object.keys(PERSONAS), permissionModes: PERMISSION_MODES,
      },
      at: new Date().toISOString(),
    });
  }

  if (p.startsWith('/api/omni/')) {
    const key = envValue('OMNI_ROUTE_API_KEY');
    if (!key) return send(res, 503, { error: 'AUTH MISSING: OMNI_ROUTE_API_KEY not in ' + CFG.envFile });
    const target = OMNI + p.slice('/api/omni'.length) + url.search;
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 300000);
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const r = await fetch(target, { method: req.method, headers: { authorization: 'Bearer ' + key, 'content-type': req.headers['content-type'] || 'application/json' }, body, signal: c.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      return res.end(buf);
    } catch (e) { return send(res, 502, { error: 'OmniRoute unreachable: ' + String(e.message || e) }); }
    finally { clearTimeout(t); }
  }

  if (p === '/api/agents') { const a = agents(); return send(res, 200, { count: a.length, source: SKILLS, agents: a, at: new Date().toISOString() }); }
  // God's-eye view: every LAN service probed with an identity check (lib/nodes.mjs). No sample data.
  if (p === '/api/nodes') return send(res, 200, await probeAll({ timeoutMs: 3000 }));
  // Business telemetry is read-only and summarized server-side. No lead PII or credentials leave this process.
  if (p === '/api/business') return send(res, 200, await businessSnapshot({ env: businessEnv(), timeoutMs: 5000 }));
  if (p === '/api/vault/graph') return send(res, 200, vaultGraph());
  if (p === '/api/vault/note') return send(res, 200, vaultNote(url.searchParams.get('p') || ''));
  if (p === '/api/vault/status') {
    const r = await getJson(OBSIDIAN_REST + '/', 5000);
    const up = r.status === 200 && /Obsidian Local REST API/.test(r.text || '');
    return send(res, 200, { up, state: up ? 'UP' : (r.status ? 'WRONG SERVICE' : 'DOWN'), detail: up ? 'identity ok' : (r.error || 'HTTP ' + r.status), url: OBSIDIAN_REST });
  }
  if (p === '/api/house') {
    const r = await getJson(SENTRY + '/api/status', 120000);
    if (!r.json) return send(res, 200, { up: false, state: 'DOWN', detail: r.error || ('HTTP ' + r.status), sentry: SENTRY });
    return send(res, 200, { up: true, state: 'UP', sentry: SENTRY, ...r.json });
  }
  if (p === '/api/avatars') {
    const files = existsSync(AVATARS) ? readdirSync(AVATARS).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).map((f) => ({ file: f, url: '/avatars/' + encodeURIComponent(f), bytes: statSync(join(AVATARS, f)).size, modified: statSync(join(AVATARS, f)).mtime.toISOString() })) : [];
    return send(res, 200, { dir: AVATARS, count: files.length, files });
  }
  if (p.startsWith('/avatars/')) {
    const f = decodeURIComponent(p.slice('/avatars/'.length));
    const full = resolve(AVATARS, f);
    if (!full.startsWith(resolve(AVATARS) + sep) || !existsSync(full)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream' });
    return res.end(readFileSync(full));
  }

  if (p === '/' || p === '/index.html') return serveStatic(res, '/index.html');
  if (p.startsWith('/api/')) return send(res, 404, { error: 'no such route' });
  return serveStatic(res, p);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`AIRI dashboard on http://0.0.0.0:${PORT}  (LAN: http://${LAN_IP}:${PORT})  omni=${OMNI}  vault=${VAULT}`);
});
