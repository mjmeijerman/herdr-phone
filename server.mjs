#!/usr/bin/env node
// herdr-phone — mobile-first web UI for the Herdr sessions on this machine.
//
// One process: the page, the API, and the gates. Zero npm dependencies; only
// node:http, node:child_process, node:crypto, node:fs.
//
// Data comes from the tools that already exist here: `herdr-app ls` (spaces and
// tabs), `hc ls` (live terminals), `hc read` (screen), `hc send`, `hc keys`,
// `hc interrupt`. Nothing is added to those sources and nothing is written back
// except the token file.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 7455;
export const COOKIE_NAME = 'hp';
export const MAX_BODY = 16 * 1024;
export const MAX_TEXT = 400;
export const KEYS = ['enter', 'esc', 'ctrl+c', 'ctrl+d', 'tab', 'up', 'down', 'left', 'right', 'backspace', 'space'];
// Herdr addresses look like t19b, t1d4, t1dp: a leading t, then base36. Anything
// else -- a slash, a semicolon, a shell metacharacter -- never reaches argv.
export const TERMINAL_RE = /^t[0-9a-z]{2,40}$/;

// ---------------------------------------------------------------- config paths

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'herdr-phone');
}

export function tokenPath() {
  return join(configDir(), 'token');
}

// ------------------------------------------------------------------- the token

const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Read the token, or create one (32 hex chars, mode 0600) on first run.
 * Returns the token string. Never logs it.
 */
export async function ensureToken(file = tokenPath()) {
  try {
    const found = (await readFile(file, 'utf8')).trim();
    if (TOKEN_RE.test(found)) {
      await chmod(file, 0o600).catch(() => {});
      return found;
    }
  } catch {
    // missing or unreadable: generate below
  }
  const token = randomBytes(16).toString('hex');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, token + '\n', { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return token;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/** Constant-time token compare (equal-length digests, so length does not leak). */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The cookie holds sha256(token), never the token itself. */
export function cookieValue(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// ------------------------------------------------------------ destructive gate

const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*)(\s+-[a-zA-Z]*[rf][a-zA-Z]*)*\s+\S/i, // rm -rf, rm -fr, rm -r -f
  /--force\b/i, // the force flag
  /\bgit\s+push\b[^\n]*\s-[a-zA-Z]*f\b/i, // git push -f
  /\bdrop\s+(table|database|schema|index|user)\b/i, // DROP
];

/** Why a send needs a second tap: 'long', 'destructive', or null. */
export function confirmReason(text) {
  if (typeof text !== 'string') return null;
  if (text.length > MAX_TEXT) return 'long';
  for (const re of DESTRUCTIVE) if (re.test(text)) return 'destructive';
  return null;
}

// ------------------------------------------------------------------ process io

/** Default runner: no shell, argv only, bounded output, hard timeout. */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message) });
      return;
    }
    const limit = opts.limit ?? 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(-1);
    }, opts.timeout ?? 8000);
    child.stdout?.on('data', (d) => {
      if (stdout.length < limit) stdout += d;
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < limit) stderr += d;
    });
    child.on('error', (err) => {
      stderr += String(err && err.message);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

// ------------------------------------------------------------------- rendering

// Strip ANSI/OSC sequences and stray control characters before the screen
// travels to a phone. Keeps \n and \t.
const ESC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function cleanScreen(raw) {
  return String(raw)
    .replace(ESC, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trimEnd();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- the grouping

/** Section order on the page, and the order `agents` is sorted in. */
const STATUS_RANK = { working: 0, done: 1, idle: 2, finished: 3 };

/** The basename of a cwd, for a row that has one line of room. */
export function cwdBase(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (cwd === '/' || cwd === '\\') return cwd;
  const base = basename(cwd.replace(/[\\/]+$/, ''));
  return base === '' ? null : base;
}

/** When did this terminal last change? `hc` reports whichever ms field it has. */
function activityOf(t) {
  for (const key of ['recent_status_ms', 'program_started_ms', 'started_ms', 'created_ms', 'updated_ms']) {
    if (Number.isFinite(t[key])) return t[key];
  }
  return 0;
}

/** `where` is "space / tab"; used when herdr-app ls is missing. */
function fromWhere(t) {
  const [space, tab] = String(t.where ?? '').split(' / ');
  return { space: (space || '').trim() || null, tab: (tab || '').trim() || null, label: null };
}

function agentRow(t, status, names) {
  const where = names.get(t.address) ?? fromWhere(t);
  return {
    space: where.space ?? null,
    tab: where.tab ?? null,
    address: t.address,
    agent: t.agent ?? null,
    label: where.label ?? null,
    status,
    turn: Number.isFinite(t.turn) ? t.turn : null,
    cwdBase: cwdBase(t.cwd),
  };
}

function statusOf(t) {
  if (t.status === 'working') return 'working';
  if (t.status === 'done') return 'done';
  return 'idle';
}

/** Newest activity first inside one status group; address keeps it stable. */
function compareAgents(a, b, liveByAddress) {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  const at = activityOf(liveByAddress.get(a.address) ?? {});
  const bt = activityOf(liveByAddress.get(b.address) ?? {});
  if (at !== bt) return bt - at;
  const turn = (b.turn ?? -1) - (a.turn ?? -1);
  if (turn !== 0) return turn;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/**
 * Turn the terminal lists into what the page draws: one flat `agents` array
 * (working first, then done, then idle, newest activity first inside a group)
 * plus the counts for the chips and the section headers.
 */
export function groupAgents(live, finished, names = new Map()) {
  const liveByAddress = new Map(live.map((t) => [t.address, t]));
  const groups = { working: 0, done: 0, idle: 0, finished: 0 };
  const agents = [];
  for (const t of live) {
    const status = statusOf(t);
    groups[status] += 1;
    agents.push(agentRow(t, status, names));
  }
  const gone = [];
  for (const t of finished) {
    if (liveByAddress.has(t.address)) continue; // --all repeats the live ones
    gone.push(agentRow(t, 'finished', names));
  }
  groups.finished = gone.length;
  agents.sort((a, b) => compareAgents(a, b, liveByAddress));
  gone.sort((a, b) => compareAgents(a, b, liveByAddress));
  return { groups, agents, finished: gone };
}

/**
 * Merge `herdr-app ls` (spaces, tabs, terminal ids) with `hc ls` (live state)
 * into one list shaped for the page. If herdr-app is unreachable, rebuild the
 * space/tab tree from hc's `where` field ("space / tab") so the page still works.
 */
export async function readTabs(exec, opts = {}) {
  const problems = [];
  const [appRes, hcRes, allRes] = await Promise.all([
    exec('herdr-app', ['ls'], { timeout: 5000 }).catch((err) => ({ code: -1, stderr: String(err) })),
    exec('hc', ['ls'], { timeout: 5000 }).catch((err) => ({ code: -1, stderr: String(err) })),
    exec('hc', ['ls', '--all'], { timeout: 8000 }).catch((err) => ({ code: -1, stderr: String(err) })),
  ]);

  const hcJson = hcRes.code === 0 ? parseJson(hcRes.stdout) : null;
  if (!hcJson || !Array.isArray(hcJson.terminals)) problems.push('hc ls');
  const live = new Map();
  for (const t of hcJson?.terminals ?? []) {
    if (t && typeof t.address === 'string') live.set(t.address, t);
  }

  const appJson = appRes.code === 0 ? parseJson(appRes.stdout) : null;
  if (!appJson || !Array.isArray(appJson.spaces)) problems.push('herdr-app ls');

  const withLive = (address) => {
    const t = live.get(address) ?? {};
    const status = t.status === 'working' ? 'working' : t.status === 'done' ? 'done' : 'idle';
    return {
      address,
      agent: t.agent ?? null,
      cwd: t.cwd ?? null,
      state: t.state ?? null,
      status,
      working: status === 'working',
      turn: Number.isFinite(t.turn) ? t.turn : null,
    };
  };

  const spaces = [];
  for (const space of appJson?.spaces ?? []) {
    const tabs = [];
    for (const tab of space?.tabs ?? []) {
      const terminals = [];
      for (const term of tab?.terminals ?? []) {
        const address = term?.terminal ?? term?.address;
        if (typeof address !== 'string' || !TERMINAL_RE.test(address)) continue;
        terminals.push({ ...withLive(address), app: term?.app ?? null, label: term?.name ?? null });
      }
      tabs.push({ name: String(tab?.name ?? 'untitled'), active: Boolean(tab?.active), terminals });
    }
    spaces.push({ name: String(space?.name ?? 'untitled'), active: Boolean(space?.active), tabs });
  }

  if (problems.includes('herdr-app ls')) {
    // Fallback: herdr keeps the space and tab name in `where`, "space / tab".
    spaces.length = 0;
    const order = [];
    const bySpace = new Map();
    for (const t of hcJson?.terminals ?? []) {
      if (!t || !TERMINAL_RE.test(String(t.address))) continue;
      const [spaceName, tabName] = String(t.where ?? '').split(' / ');
      const sName = (spaceName || 'terminals').trim();
      const tName = (tabName || sName).trim();
      if (!bySpace.has(sName)) {
        bySpace.set(sName, new Map());
        order.push(sName);
      }
      const tabs = bySpace.get(sName);
      if (!tabs.has(tName)) tabs.set(tName, []);
      tabs.get(tName).push(withLive(t.address));
    }
    for (const sName of order) {
      const tabs = [];
      for (const [tName, terminals] of bySpace.get(sName)) {
        tabs.push({ name: tName, active: terminals.some((t) => t.working), terminals });
      }
      spaces.push({ name: sName, active: tabs.some((t) => t.active), tabs });
    }
  }

  // Finished terminals live only in `hc ls --all`; when that call fails, fall
  // back to the count hc keeps in its own summary.
  const allJson = allRes.code === 0 ? parseJson(allRes.stdout) : null;
  const finished = [];
  for (const t of allJson?.terminals ?? []) {
    if (t && TERMINAL_RE.test(String(t.address))) finished.push(t);
  }
  if (!allJson) finished.length = 0;

  const names = new Map();
  for (const space of spaces) {
    for (const tab of space.tabs) {
      for (const term of tab.terminals) {
        names.set(term.address, { space: space.name, tab: tab.name, label: term.label ?? null });
      }
    }
  }

  const liveList = [...live.values()].filter((t) => TERMINAL_RE.test(String(t.address)));
  const { groups, agents, finished: goneRows } = groupAgents(liveList, finished, names);
  if (!allJson) groups.finished = Math.max(0, Number(hcJson?.hidden_finished) || 0);

  return {
    ok: true,
    at: new Date().toISOString(),
    problems,
    live: live.size,
    spaces,
    groups,
    agents: opts.all ? agents.concat(goneRows) : agents,
  };
}

// --------------------------------------------------------------------- the app

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const empty = (res, status) => {
  res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
  res.end();
};

/** Empty body 401 — the spec's gate, no hints for a scanner. */
const unauthorized = (res) => empty(res, 401);

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve({ tooBig: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ text: '' }));
  });
}

/**
 * Build the request handler.
 * @param {object} opts  token, exec (injectable runner), log (bool)
 */
export function createApp(opts = {}) {
  const exec = opts.exec ?? runCommand;
  const token = opts.token;
  if (!token) throw new Error('createApp needs a token');
  const hp = cookieValue(token);
  const log = opts.log ?? false;

  const authorized = (req) => {
    const auth = req.headers?.authorization;
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m && tokenMatches(m[1].trim(), token)) return true;
    }
    const fromCookie = readCookie(req.headers?.cookie, COOKIE_NAME);
    return typeof fromCookie === 'string' && tokenMatches(fromCookie, hp);
  };

  const hcArgs = (terminal) => {
    if (typeof terminal !== 'string' || !TERMINAL_RE.test(terminal)) return null;
    return terminal;
  };

  const handler = async (req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${HOST}:${DEFAULT_PORT}`);
    const path = url.pathname;
    let status = 500;
    try {
      status = await route({ req, res, method, url, path });
    } catch (err) {
      status = 500;
      send(res, 500, { error: 'internal', detail: String(err && err.message).slice(0, 200) });
    } finally {
      if (log) {
        // Path only: never the query string, never a header.
        console.log(`${new Date().toISOString()} ${method} ${path} ${status} ${Date.now() - started}ms`);
      }
    }
  };

  async function route({ req, res, method, url, path }) {
    if (path === '/' && (method === 'GET' || method === 'HEAD')) {
      const html = PAGE;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : html);
      return 200;
    }

    if (path === '/manifest.webmanifest' && method === 'GET') {
      send(
        res,
        200,
        {
          name: 'herdr-phone',
          short_name: 'herdr',
          start_url: '/',
          display: 'standalone',
          background_color: '#0b0d10',
          theme_color: '#0b0d10',
        },
        { 'Content-Type': 'application/manifest+json' },
      );
      return 200;
    }

    if (path === '/login' && method === 'POST') {
      const body = await readBody(req);
      const parsed = body.text ? parseJson(body.text) : null;
      const given = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
      if (!tokenMatches(given, token)) {
        unauthorized(res);
        return 401;
      }
      res.writeHead(204, {
        'Set-Cookie': `${COOKIE_NAME}=${hp}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        'Content-Length': 0,
        'Cache-Control': 'no-store',
      });
      res.end();
      return 204;
    }

    if (path === '/logout' && method === 'POST') {
      res.writeHead(204, {
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        'Content-Length': 0,
        'Cache-Control': 'no-store',
      });
      res.end();
      return 204;
    }

    if (!path.startsWith('/api/')) {
      empty(res, 404);
      return 404;
    }

    if (!authorized(req)) {
      unauthorized(res);
      return 401;
    }

    if (path === '/api/tabs' && method === 'GET') {
      // ?all=1 is the only way finished terminals reach `agents`.
      const all = url.searchParams.get('all') === '1';
      const tabs = await readTabs(exec, { all });
      send(res, 200, tabs);
      return 200;
    }

    if (path === '/api/screen' && method === 'GET') {
      const terminal = hcArgs(url.searchParams.get('terminal'));
      if (!terminal) {
        send(res, 400, { error: 'bad_terminal' });
        return 400;
      }
      const out = await exec('hc', ['read', terminal], { timeout: 8000 });
      if (out.code !== 0) {
        send(res, 502, { error: 'hc_read_failed', terminal, detail: String(out.stderr ?? '').trim().slice(0, 300) });
        return 502;
      }
      send(res, 200, { terminal, at: new Date().toISOString(), screen: cleanScreen(out.stdout ?? '') });
      return 200;
    }

    if (path === '/api/send' && method === 'POST') {
      const body = await readBody(req);
      if (body.tooBig) {
        empty(res, 413);
        return 413;
      }
      const parsed = body.text ? parseJson(body.text) : null;
      const terminal = hcArgs(parsed?.terminal);
      const text = typeof parsed?.text === 'string' ? parsed.text : null;
      if (!terminal || text === null) {
        send(res, 400, { error: 'bad_request' });
        return 400;
      }
      const reason = confirmReason(text);
      if (reason && parsed?.confirm !== true) {
        // 428: the payload is right, the second tap is missing.
        send(res, 428, { error: 'confirm_required', reason, confirm: true });
        return 428;
      }
      const out = await exec('hc', ['send', terminal, text], { timeout: 10000 });
      if (out.code !== 0) {
        send(res, 502, { error: 'hc_send_failed', terminal, detail: String(out.stderr ?? '').trim().slice(0, 300) });
        return 502;
      }
      send(res, 200, { ok: true, terminal, bytes: Buffer.byteLength(text), confirmed: Boolean(reason) });
      return 200;
    }

    if (path === '/api/keys' && method === 'POST') {
      const body = await readBody(req);
      const parsed = body.text ? parseJson(body.text) : null;
      const terminal = hcArgs(parsed?.terminal);
      const keys = Array.isArray(parsed?.keys) ? parsed.keys : typeof parsed?.keys === 'string' ? parsed.keys.split(/\s+/) : null;
      if (!terminal || !keys || keys.length === 0 || keys.length > 8) {
        send(res, 400, { error: 'bad_request' });
        return 400;
      }
      const bad = keys.find((k) => !KEYS.includes(String(k).toLowerCase()));
      if (bad !== undefined) {
        send(res, 400, { error: 'bad_key', allowed: KEYS });
        return 400;
      }
      const out = await exec('hc', ['keys', terminal, keys.map((k) => String(k).toLowerCase()).join(' ')], {
        timeout: 8000,
      });
      if (out.code !== 0) {
        send(res, 502, { error: 'hc_keys_failed', terminal, detail: String(out.stderr ?? '').trim().slice(0, 300) });
        return 502;
      }
      send(res, 200, { ok: true, terminal, keys });
      return 200;
    }

    if (path === '/api/interrupt' && method === 'POST') {
      const body = await readBody(req);
      const parsed = body.text ? parseJson(body.text) : null;
      const terminal = hcArgs(parsed?.terminal);
      if (!terminal) {
        send(res, 400, { error: 'bad_request' });
        return 400;
      }
      const out = await exec('hc', ['interrupt', terminal], { timeout: 8000 });
      if (out.code !== 0) {
        send(res, 502, { error: 'hc_interrupt_failed', terminal, detail: String(out.stderr ?? '').trim().slice(0, 300) });
        return 502;
      }
      send(res, 200, { ok: true, terminal });
      return 200;
    }

    empty(res, 404);
    return 404;
  }

  return { handler, cookie: hp };
}

/** Bind, but only on loopback. Never 0.0.0.0, never a LAN address. */
export function listen(app, port = DEFAULT_PORT, host = HOST) {
  if (host !== HOST && host !== 'localhost') {
    return Promise.reject(new Error(`refusing to bind ${host}: herdr-phone listens on ${HOST} only`));
  }
  return new Promise((resolve, reject) => {
    const server = createServer(app.handler);
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port, host: HOST });
    });
  });
}

export async function start(opts = {}) {
  const token = opts.token ?? (await ensureToken(opts.tokenPath ?? tokenPath()));
  const app = createApp({ exec: opts.exec, token, log: opts.log ?? true });
  const bound = await listen(app, opts.port ?? DEFAULT_PORT);
  return { ...bound, tokenPath: opts.tokenPath ?? tokenPath(), token };
}

function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`bad --port ${argv[i + 1]}`);
      return value;
    }
    if (arg.startsWith('--port=')) {
      const value = Number(arg.slice(7));
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`bad --port ${arg.slice(7)}`);
      return value;
    }
  }
  const env = process.env.PORT;
  if (env === undefined || env === '') return DEFAULT_PORT;
  const value = Number(env);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`bad PORT ${env}`);
  return value;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= 22)) {
    console.error(`herdr-phone needs Node 22 or newer (Node 26 is what it is tested on); this is ${process.version}`);
    process.exit(1);
  }
  const port = parsePort(process.argv.slice(2));
  start({ port })
    .then(({ port: bound, tokenPath: file }) => {
      console.log(`herdr-phone listening on http://${HOST}:${bound}`);
      console.log(`token file: ${file} (mode 600, never printed, never in a URL)`);
      const stop = () => {
        console.log('herdr-phone stopping');
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      console.error(`herdr-phone failed to start: ${err && err.message}`);
      process.exit(1);
    });
}

// -------------------------------------------------------------------- the page

// Static shell only: no token, no data. Everything below is fetched over
// /api/* with the hp cookie or a Bearer header.
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/manifest.webmanifest">
<title>herdr-phone</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14181d;
    --panel-2: #1b2027;
    --line: #262c34;
    --fg: #dfe5ec;
    --dim: #8b98a6;
    --live: #3ddc84;
    --idle: #4d5763;
    --warn: #ff5d5d;
    --app-h: 100dvh;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    height: var(--app-h);
    display: flex;
    flex-direction: column;
    font: 16px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
    padding-bottom: env(safe-area-inset-bottom);
  }
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
  header .spacer { flex: 1; }
  header .clock { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
  button {
    font: inherit;
    color: var(--fg);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    min-height: 44px;
    min-width: 44px;
    padding: 0 12px;
    touch-action: manipulation;
  }
  button:active { background: #2b3340; }
  button[disabled] { opacity: .45; }
  nav {
    flex: 0 1 auto;
    max-height: 40dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    border-bottom: 1px solid var(--line);
    overscroll-behavior: contain;
  }
  .chips {
    flex: 0 0 auto;
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: 0 0 auto;
    min-height: 34px;
    min-width: 44px;
    padding: 0 12px;
    font-size: 13px;
    white-space: nowrap;
    border-radius: 999px;
    color: var(--dim);
  }
  .chip .n { font-variant-numeric: tabular-nums; opacity: .8; margin-left: 4px; }
  .chip[aria-pressed="true"] { background: #2b3340; color: var(--fg); border-color: #3a4553; }
  .group > h2 {
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0;
    padding: 6px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .08em;
    color: var(--dim);
    font-weight: 600;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .group:first-child > h2 { border-top: 0; }
  .group > h2 .count { color: var(--fg); margin-left: 2px; }
  .group[data-status="working"] > h2 { color: var(--live); }
  .agent {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 4px 8px 4px 12px;
    background: transparent;
    border: 0;
    border-top: 1px solid #191e24;
    border-radius: 0;
    text-align: left;
    color: var(--fg);
    touch-action: manipulation;
  }
  .agent[aria-current="true"] { background: #1d2630; }
  .agent .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .agent .name { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent .meta {
    font-size: 11px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent .read { flex: 0 0 auto; min-height: 34px; min-width: 56px; font-size: 12px; padding: 0 10px; }
  .finished {
    display: block;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    text-align: left;
    font-size: 13px;
    color: var(--dim);
    background: transparent;
    border: 0;
    border-top: 1px solid var(--line);
    border-radius: 0;
  }
  .empty { padding: 12px; color: var(--dim); font-size: 13px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--idle); flex: 0 0 auto; }
  .dot.working { background: var(--live); animation: pulse 1.6s ease-in-out infinite; }
  .dot.done { background: #2f9e63; }
  .dot.finished { background: #3a424c; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  main {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    background: #06080a;
  }
  main .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    font-size: 12px;
    color: var(--dim);
  }
  main .bar .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
  main .bar .spacer { flex: 1; }
  main .bar button { min-height: 32px; min-width: 44px; font-size: 12px; padding: 0 10px; }
  #out {
    flex: 1;
    margin: 0;
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
  #out.nowrap { white-space: pre; overflow-wrap: normal; }
  #out.empty { color: var(--dim); font-family: inherit; font-size: 13px; white-space: normal; }
  footer {
    flex: 0 0 auto;
    position: sticky;
    bottom: 0;
    z-index: 5;
    background: var(--panel);
    border-top: 1px solid var(--line);
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  }
  .keys { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; }
  .keys button { flex: 0 0 auto; font-size: 13px; }
  .keys button.stop { color: var(--warn); border-color: #4a2226; }
  .sendrow { display: flex; gap: 6px; }
  #text {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    font-size: 16px;           /* 16px keeps iOS from zooming on focus */
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 10px 12px;
    color: var(--fg);
    background: #0e1216;
    border: 1px solid var(--line);
    border-radius: 10px;
    resize: none;
  }
  #send { min-width: 76px; font-weight: 600; }
  #send.armed { background: var(--warn); border-color: var(--warn); color: #140708; }
  .hint { font-size: 11px; color: var(--dim); padding: 2px 2px 0; min-height: 0; }
  .hint.warn { color: var(--warn); }
  #login {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(6, 8, 10, .96);
    z-index: 10;
    padding: 24px;
  }
  #login.show { display: flex; }
  #login form { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 10px; }
  #login h2 { font-size: 16px; margin: 0; }
  #login p { font-size: 13px; color: var(--dim); margin: 0; }
  #login input {
    min-height: 48px;
    font-size: 16px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: #0e1216;
    color: var(--fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .row { display: flex; gap: 8px; }
</style>
</head>
<body>
<header>
  <h1>herdr-phone</h1>
  <span class="spacer"></span>
  <span class="clock" id="clock"></span>
  <button id="refresh" aria-label="Refresh sessions">&#8635;</button>
</header>

<div class="chips" id="chips" role="group" aria-label="Filter agents">
  <button class="chip" data-filter="all" aria-pressed="true">All<span class="n">0</span></button>
  <button class="chip" data-filter="working" aria-pressed="false">Working<span class="n">0</span></button>
  <button class="chip" data-filter="done" aria-pressed="false">Done<span class="n">0</span></button>
  <button class="chip" data-filter="idle" aria-pressed="false">Idle<span class="n">0</span></button>
</div>

<nav id="list" aria-label="Agents by status">
  <div class="empty">Loading agents&hellip;</div>
</nav>

<main>
  <div class="bar">
    <span class="addr" id="addr">no terminal</span>
    <span id="termstate"></span>
    <span class="spacer"></span>
    <button id="wrap">wrap</button>
  </div>
  <pre id="out" class="empty">Pick a tab above to watch its terminal.</pre>
</main>

<footer>
  <div class="keys">
    <button data-key="esc">esc</button>
    <button data-key="ctrl+c">^C</button>
    <button data-key="enter">&#9166;</button>
    <button id="interrupt" class="stop">stop</button>
  </div>
  <div class="sendrow">
    <input id="text" type="text" inputmode="text" autocomplete="off" autocapitalize="off"
           autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="type to this terminal">
    <button id="send">Send</button>
  </div>
  <div class="hint" id="hint"></div>
</footer>

<div id="login">
  <form id="loginform">
    <h2>Unlock herdr-phone</h2>
    <p>Paste the token from <code>~/.config/herdr-phone/token</code>.</p>
    <input id="token" type="password" autocomplete="current-password" placeholder="32 hex characters">
    <div class="row">
      <button type="submit" id="unlock" style="flex:1">Unlock</button>
    </div>
    <p id="loginerr"></p>
  </form>
</div>

<script>
(function () {
  'use strict';
  var state = {
    terminal: null, data: null, groups: { working: 0, done: 0, idle: 0, finished: 0 },
    filter: 'all', all: false, renderedKey: '',
    timer: null, poll: null, armed: null, armTimer: null, busy: false
  };
  var el = {
    list: document.getElementById('list'),
    chips: document.getElementById('chips'),
    out: document.getElementById('out'),
    addr: document.getElementById('addr'),
    termstate: document.getElementById('termstate'),
    clock: document.getElementById('clock'),
    refbtn: document.getElementById('refresh'),
    wrap: document.getElementById('wrap'),
    text: document.getElementById('text'),
    send: document.getElementById('send'),
    hint: document.getElementById('hint'),
    interrupt: document.getElementById('interrupt'),
    login: document.getElementById('login'),
    loginform: document.getElementById('loginform'),
    loginerr: document.getElementById('loginerr'),
    token: document.getElementById('token')
  };

  // --- viewport: keep the input above the iOS keyboard (dvh + visualViewport)
  function fit() {
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fit);
    window.visualViewport.addEventListener('scroll', fit);
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) {
        showLogin();
        throw new Error('unauthorized');
      }
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        if (!res.ok) {
          var err = new Error((data && (data.error || data.detail)) || ('http ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function showLogin() {
    el.login.classList.add('show');
    setTimeout(function () { el.token.focus(); }, 50);
  }
  function hideLogin() {
    el.login.classList.remove('show');
    el.token.value = '';
    el.loginerr.textContent = '';
  }

  el.loginform.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = el.token.value.trim();
    if (!value) return;
    el.loginerr.textContent = '';
    fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value })
    }).then(function (res) {
      if (res.status === 204) {
        hideLogin();
        el.token.value = '';
        loadTabs();
      } else {
        el.loginerr.textContent = 'That token was refused.';
        el.token.value = '';
      }
    }).catch(function () { el.loginerr.textContent = 'Network error.'; });
  });

  // --- agents
  function loadTabs() {
    // ?all=1 is asked for only after the "N finished" line is tapped.
    return api('/api/tabs' + (state.all ? '?all=1' : '')).then(function (data) {
      state.data = Array.isArray(data.agents) ? data.agents : [];
      state.groups = data.groups || { working: 0, done: 0, idle: 0, finished: 0 };
      renderAgents();
      paintChips();
      document.getElementById('clock').textContent = new Date(data.at).toTimeString().slice(0, 5);
    }).catch(function (err) {
      if (err.message !== 'unauthorized' && !state.data) {
        el.list.innerHTML = '<div class="empty" style="color:#ff5d5d">Agent list failed: ' +
          esc(err.message) + '</div>';
      }
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SECTIONS = ['working', 'done', 'idle'];
  var TITLES = { working: 'Working', done: 'Done', idle: 'Idle', finished: 'Finished' };

  function paintChips() {
    var g = state.groups;
    var counts = { all: g.working + g.done + g.idle, working: g.working, done: g.done, idle: g.idle };
    Array.prototype.forEach.call(el.chips.querySelectorAll('.chip'), function (chip) {
      var key = chip.getAttribute('data-filter');
      chip.setAttribute('aria-pressed', key === state.filter ? 'true' : 'false');
      var n = chip.querySelector('.n');
      if (n) n.textContent = String(counts[key] || 0);
    });
  }

  function rowHtml(a) {
    var name = a.label || a.agent || a.tab || a.address;
    var where = [a.space, a.tab].filter(Boolean).join(' / ');
    var meta = [];
    if (a.agent && a.agent !== name) meta.push(a.agent);
    if (where && where !== name) meta.push(where);
    if (a.turn !== null && a.turn !== undefined) meta.push('turn ' + a.turn);
    if (a.cwdBase) meta.push(a.cwdBase);
    if (!meta.length) meta.push(a.address);
    return '<div class="agent" role="button" tabindex="0" data-terminal="' + esc(a.address) + '"' +
      ' data-status="' + esc(a.status) + '"' +
      (a.address === state.terminal ? ' aria-current="true"' : '') +
      ' title="' + esc(a.address + ' \u00b7 ' + (where || a.address)) + '">' +
      '<span class="dot ' + esc(a.status) + '"></span>' +
      '<span class="who"><span class="name">' + esc(name) + '</span>' +
      '<span class="meta">' + esc(meta.join(' \u00b7 ')) + '</span></span>' +
      '<button class="read" data-terminal="' + esc(a.address) + '">Read</button>' +
      '</div>';
  }

  /**
   * Draw the sections. force repaints after a chip tap; otherwise identical
   * poll data leaves the DOM alone, so nothing moves under the thumb.
   */
  function renderAgents(force) {
    var agents = state.data || [];
    var key = JSON.stringify([state.filter, state.all, state.groups, agents]);
    if (!force && key === state.renderedKey) return;
    state.renderedKey = key;

    var nav = el.list;
    var top = nav.scrollTop;
    var html = '';
    var shown = 0;

    SECTIONS.forEach(function (status) {
      if (state.filter !== 'all' && state.filter !== status) return;
      var rows = agents.filter(function (a) { return a.status === status; });
      if (!rows.length) return;
      shown += rows.length;
      html += '<section class="group" data-status="' + status + '">' +
        '<h2>' + TITLES[status] + ' <span class="count">' + rows.length + '</span></h2>' +
        rows.map(rowHtml).join('') + '</section>';
    });

    if (state.all && state.filter === 'all') {
      var gone = agents.filter(function (a) { return a.status === 'finished'; });
      if (gone.length) {
        shown += gone.length;
        html += '<section class="group" data-status="finished">' +
          '<h2>' + TITLES.finished + ' <span class="count">' + gone.length + '</span></h2>' +
          gone.map(rowHtml).join('') + '</section>';
      }
    }

    if (!state.all) {
      var n = state.groups.finished || 0;
      html += '<button class="finished" id="finished" data-expand="1"' + (n ? '' : ' disabled') + '>' +
        n + ' finished' + (n ? ' \u00b7 tap to show' : '') + '</button>';
    }

    if (!shown && !state.all && !(state.groups.finished > 0)) {
      html = '<div class="empty">No agents reported.</div>';
    } else if (!shown && !state.all) {
      html += '<div class="empty">Nothing ' + esc(state.filter) + ' right now.</div>';
    }

    nav.innerHTML = html;
    nav.scrollTop = top;
  }

  function setFilter(filter) {
    if (state.filter === filter) return;
    state.filter = filter;
    paintChips();
    renderAgents(true);
  }

  el.chips.addEventListener('click', function (ev) {
    var chip = ev.target.closest('.chip');
    if (!chip) return;
    setFilter(chip.getAttribute('data-filter'));
  });

  el.list.addEventListener('click', function (ev) {
    var expand = ev.target.closest('[data-expand]');
    if (expand) {
      if (expand.disabled) return;
      state.all = true;
      loadTabs();
      return;
    }
    var row = ev.target.closest('.agent');
    if (!row) return;
    var terminal = row.getAttribute('data-terminal');
    if (terminal) select(terminal);
  });

  el.list.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var row = ev.target.closest && ev.target.closest('.agent');
    if (!row) return;
    ev.preventDefault();
    var terminal = row.getAttribute('data-terminal');
    if (terminal) select(terminal);
  });

  function select(terminal) {
    state.terminal = terminal;
    el.addr.textContent = terminal;
    el.out.classList.remove('empty');
    el.out.textContent = '';
    Array.prototype.forEach.call(el.list.querySelectorAll('.agent'), function (row) {
      row.setAttribute('aria-current', row.getAttribute('data-terminal') === terminal ? 'true' : 'false');
    });
    clearTimeout(state.poll);
    pollScreen(true);
  }

  function pollScreen(now) {
    clearTimeout(state.poll);
    if (!state.terminal) return;
    var term = state.terminal;
    var started = Date.now();
    api('/api/screen?terminal=' + encodeURIComponent(term)).then(function (data) {
      if (term !== state.terminal) return;
      paintScreen(data.screen || '');
      el.termstate.textContent = 'updated ' + new Date(data.at).toTimeString().slice(0, 8);
    }).catch(function (err) {
      if (err.status && err.status !== 401) el.termstate.textContent = 'read failed (' + err.status + ')';
      else if (!err.status) el.termstate.textContent = 'offline';
    }).then(function () {
      if (term !== state.terminal) return;
      var wait = Math.max(300, 2000 - (Date.now() - started));
      state.poll = setTimeout(function () { pollScreen(false); }, wait);
    });
  }

  function paintScreen(text) {
    var node = el.out;
    if (!text) {
      node.textContent = '(empty screen)';
      return;
    }
    var atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
    if (node.textContent !== text) node.textContent = text;
    if (atBottom) node.scrollTop = node.scrollHeight;
  }

  function scheduleTabs() {
    clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (document.visibilityState === 'visible') loadTabs();
    }, 5000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      loadTabs();
      if (state.terminal) pollScreen(true);
    }
  });

  // --- sending
  function hint(text, warn) {
    el.hint.textContent = text || '';
    el.hint.className = 'hint' + (warn ? ' warn' : '');
  }

  function arm(reason) {
    clearTimeout(state.armTimer);
    state.armed = true;
    el.send.classList.add('armed');
    el.send.textContent = 'Tap again';
    hint(reason === 'long'
      ? 'Long message (over 400 characters). Tap again to send it.'
      : 'That looks destructive. Tap again to send it.', true);
    state.armTimer = setTimeout(disarm, 6000);
  }

  function disarm() {
    clearTimeout(state.armTimer);
    state.armed = null;
    el.send.classList.remove('armed');
    el.send.textContent = 'Send';
    hint('');
  }

  function submitSend() {
    if (!state.terminal) { hint('Pick a tab first.', true); return; }
    var text = el.text.value;
    if (!text) { hint('Nothing to send.', true); return; }
    if (state.busy) return;
    var body = { terminal: state.terminal, text: text };
    if (state.armed) body.confirm = true;
    state.busy = true;
    el.send.disabled = true;
    api('/api/send', { method: 'POST', body: body }).then(function (data) {
      el.text.value = '';
      disarm();
      hint('sent ' + data.bytes + ' bytes');
      pollScreen(true);
    }).catch(function (err) {
      if (err.status === 428) {
        arm(err.data && err.data.reason);
      } else if (err.status === 401) {
        // login overlay is already up
      } else {
        hint('send failed: ' + err.message, true);
      }
    }).then(function () {
      state.busy = false;
      el.send.disabled = false;
    });
  }

  el.send.addEventListener('click', submitSend);
  el.text.addEventListener('input', function () {
    if (state.armed) disarm();
    else hint(el.text.value.length > 400 ? el.text.value.length + ' characters \u2014 needs a second tap' : '');
  });
  el.text.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitSend();
    }
  });

  document.querySelectorAll('.keys button[data-key]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!state.terminal) { hint('Pick a tab first.', true); return; }
      api('/api/keys', { method: 'POST', body: { terminal: state.terminal, keys: [btn.getAttribute('data-key')] } })
        .then(function () { pollScreen(true); })
        .catch(function (err) { if (err.status !== 401) hint('key failed: ' + err.message, true); });
    });
  });

  el.interrupt.addEventListener('click', function () {
    if (!state.terminal) return;
    api('/api/interrupt', { method: 'POST', body: { terminal: state.terminal } })
      .then(function () { hint('interrupted'); pollScreen(true); })
      .catch(function (err) { if (err.status !== 401) hint('interrupt failed: ' + err.message, true); });
  });

  el.refbtn.addEventListener('click', function () { loadTabs(); if (state.terminal) pollScreen(true); });

  el.wrap.addEventListener('click', function () {
    var raw = el.out.classList.toggle('nowrap');
    el.wrap.textContent = raw ? 'wrap' : 'nowrap';
  });

  loadTabs().then(function () {
    // ?t=t19b preselects a terminal, so one tab can be bookmarked on a phone.
    var wanted = null;
    try { wanted = new URLSearchParams(location.search).get('t'); } catch (e) { wanted = null; }
    if (wanted && /^t[0-9a-z]{2,40}$/.test(wanted)) select(wanted);
  });
  scheduleTabs();
})();
</script>
</body>
</html>
`;
