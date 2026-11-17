#!/usr/bin/env node
// CI-only runtime verification of the desktop app on Linux (Ubuntu 24.04).
//
// Launches the real Electron binary (unpackaged, from desktop/node_modules)
// with the production sandbox configuration, then drives it over the Chrome
// DevTools Protocol to check what the unit tests and simulations cannot:
//
//   * renderers really run inside the Chromium sandbox (seccomp filter active)
//   * the session token is not on any process command line
//   * the dashboard preload loads under `sandbox: true` and its bridge works
//   * the dashboard is signed in at boot and the session can be refreshed
//   * a reopened dashboard window initialises the same way
//   * the popover preload loads and its IPC round trip works
//   * a negative control (`--no-sandbox`) is correctly detected as unsandboxed
//
// No dependencies: Node 22's built-in WebSocket and fetch speak CDP. The
// debugging port is bound to 127.0.0.1 on a throwaway CI runner and is never
// enabled by the app itself. This file never runs as part of the app.
//
// Usage (under a display, e.g. xvfb-run -a): node linux-runtime.mjs
// Env: VERIFY_OUT_DIR (artifacts/logs), VERIFY_CDP_PORT (default 9222).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOKEN_KEY = 'freellmapi_dashboard_token';

// ---------------------------------------------------------------- pure helpers
// Exported so they can be tested without Electron.

export function parseProcStatus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

export function parseCmdline(raw) {
  return raw.split('\0').filter(Boolean);
}

// A Chromium process inside the Linux sandbox has a seccomp filter (mode 2)
// and no_new_privs set. An unsandboxed renderer shows Seccomp: 0.
export function isSandboxedStatus(status) {
  return status.Seccomp === '2' && status.NoNewPrivs === '1';
}

export function isRenderer(proc) {
  return proc.args.includes('--type=renderer');
}

export function findTokenLeaks(procs, token) {
  return procs.filter((p) =>
    p.args.some((a) => a.includes('--freeapi-token') || (token && token.length >= 16 && a.includes(token))),
  );
}

// ------------------------------------------------------------------ /proc scan

export function readProcs() {
  const procs = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = parseCmdline(fs.readFileSync(`/proc/${name}/cmdline`, 'utf8'));
      if (args.length === 0) continue;
      const status = parseProcStatus(fs.readFileSync(`/proc/${name}/status`, 'utf8'));
      procs.push({ pid: Number(name), args, status });
    } catch {
      // process went away or is unreadable
    }
  }
  return procs;
}

// ------------------------------------------------------------------- CDP client

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`websocket error for ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation failed');
    }
    return r.result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}`);
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const all = await res.json();
  return all.filter((t) => t.type === 'page');
}

const isDashboardTarget = (t) => /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url);
const isPopoverTarget = (t) => t.url.startsWith('file://') && t.url.includes('popover.html');

// ----------------------------------------------------------------- app launching

function launchElectron({ electronBin, desktopDir, env, args, logFile, detached = true }) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(electronBin, [desktopDir, ...args], {
    cwd: desktopDir,
    env,
    detached,
    stdio: ['ignore', out, out],
  });
  child.exitPromise = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
  return child;
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const done = await Promise.race([child.exitPromise, sleep(10000).then(() => null)]);
  if (done === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await Promise.race([child.exitPromise, sleep(5000)]);
  }
}

// ------------------------------------------------------------------- result log

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  --  ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function writeSummary(outDir) {
  const lines = [
    '## Desktop Linux runtime verification',
    '',
    '| Result | Check | Detail |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
  ];
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n')); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------- the checks

async function dashboardChecks(label, port, target, expectedVersion, outDir) {
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await waitFor(() => cdp.eval(`document.readyState === 'complete'`), 60000, `${label} document load`);

    await check(`${label}: preload bridge present`, async () => {
      const b = await cdp.eval(`({
        desktop: window.__FREEAPI_DESKTOP__,
        platform: window.__FREEAPI_PLATFORM__,
        session: typeof window.__FREEAPI_SESSION__,
        version: window.__FREEAPI_VERSION__,
      })`);
      if (b.desktop !== true) throw new Error(`__FREEAPI_DESKTOP__=${b.desktop}`);
      if (b.platform !== 'linux') throw new Error(`__FREEAPI_PLATFORM__=${b.platform}`);
      if (b.session !== 'function') throw new Error(`__FREEAPI_SESSION__ is ${b.session}`);
      if (b.version !== expectedVersion) throw new Error(`__FREEAPI_VERSION__=${b.version}, expected ${expectedVersion}`);
      return `platform=linux version=${b.version}`;
    });

    await check(`${label}: renderer is context-isolated`, async () => {
      const g = await cdp.eval(`({ req: typeof require, proc: typeof process, buf: typeof Buffer })`);
      if (g.req !== 'undefined' || g.proc !== 'undefined' || g.buf !== 'undefined') {
        throw new Error(`Node globals leaked into the page: ${JSON.stringify(g)}`);
      }
      return 'require/process/Buffer are undefined in the page';
    });

    let token = '';
    await check(`${label}: session token seeded at boot and accepted`, async () => {
      token = await cdp.eval(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) || ''`);
      if (token.length < 16) throw new Error(`token missing or too short (length ${token.length})`);
      const status = await cdp.eval(`fetch('/api/auth/status', { headers: { Authorization: 'Bearer ' + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) } }).then((r) => r.json())`);
      if (status.authenticated !== true) throw new Error(`/api/auth/status -> ${JSON.stringify(status)}`);
      return `authenticated as ${status.email}`;
    });

    await check(`${label}: dashboard renders signed in (no login form)`, async () => {
      await sleep(3000);
      const ui = await cdp.eval(`({
        password: !!document.querySelector('input[type="password"]'),
        rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
      })`);
      if (ui.password) throw new Error('a password input is on screen (login form shown)');
      if (ui.rootChildren < 1) throw new Error(`#root has ${ui.rootChildren} children`);
      return `root children=${ui.rootChildren}`;
    });

    await check(`${label}: session refresh via the bridge`, async () => {
      const first = await cdp.eval(`window.__FREEAPI_SESSION__()`);
      const second = await cdp.eval(`window.__FREEAPI_SESSION__()`);
      for (const t of [first, second]) {
        if (typeof t !== 'string' || t.length < 16) throw new Error('bridge returned no token');
      }
      const status = await cdp.eval(`fetch('/api/auth/status', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(second)} } }).then((r) => r.json())`);
      if (status.authenticated !== true) throw new Error(`refreshed token rejected: ${JSON.stringify(status)}`);
      return 'two refresh calls returned an accepted token';
    });

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
      fs.writeFileSync(path.join(outDir, `${label.replace(/\W+/g, '-')}-dashboard.png`), Buffer.from(shot.data, 'base64'));
    } catch { /* screenshots are best effort */ }

    return token;
  } finally {
    cdp.close();
  }
}

async function popoverChecks(target, outDir) {
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await waitFor(() => cdp.eval(`document.readyState === 'complete'`), 30000, 'popover document load');

    await check('popover: preload bridge and IPC round trip', async () => {
      const keys = await cdp.eval(`window.freeapi ? Object.keys(window.freeapi).sort() : null`);
      if (!keys) throw new Error('window.freeapi is missing (popover preload did not load)');
      for (const k of ['snapshot', 'openDashboard', 'copyBaseUrl', 'quit']) {
        if (!keys.includes(k)) throw new Error(`window.freeapi.${k} missing`);
      }
      const snap = await cdp.eval(`window.freeapi.snapshot().then((s) => (s && typeof s === 'object') ? Object.keys(s).length : -1)`);
      if (snap < 0) throw new Error('snapshot() did not return an object');
      return `bridge keys: ${keys.join(',')}; snapshot has ${snap} fields`;
    });

    await check('popover: isolated and has no session bridge', async () => {
      const g = await cdp.eval(`({ req: typeof require, proc: typeof process, session: typeof window.__FREEAPI_SESSION__ })`);
      if (g.req !== 'undefined' || g.proc !== 'undefined') throw new Error(`Node globals leaked: ${JSON.stringify(g)}`);
      if (g.session !== 'undefined') throw new Error('popover exposes __FREEAPI_SESSION__');
      return 'no Node globals, no session bridge';
    });

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
      fs.writeFileSync(path.join(outDir, 'popover.png'), Buffer.from(shot.data, 'base64'));
    } catch { /* screenshots are best effort */ }
  } finally {
    cdp.close();
  }
}

function sandboxChecks(label, electronDist, token) {
  const procs = readProcs();
  const electronProcs = procs.filter((p) => p.args[0] && p.args[0].startsWith(electronDist));
  const renderers = electronProcs.filter(isRenderer);

  record(`${label}: renderers run inside the Chromium sandbox`, (() => {
    if (renderers.length === 0) return false;
    return renderers.every((p) => isSandboxedStatus(p.status) && !p.args.includes('--no-sandbox'));
  })(), renderers.length === 0
    ? 'no --type=renderer processes found'
    : renderers.map((p) => `pid ${p.pid}: Seccomp=${p.status.Seccomp} NoNewPrivs=${p.status.NoNewPrivs}${p.args.includes('--no-sandbox') ? ' --no-sandbox' : ''}`).join('; '));

  const leaks = findTokenLeaks(procs, token);
  record(`${label}: session token is on no process command line`, leaks.length === 0,
    leaks.length === 0 ? `scanned ${procs.length} processes` : `leaked in pid(s) ${leaks.map((p) => p.pid).join(',')}`);

  return renderers;
}

// -------------------------------------------------------------------------- main

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktopDir = path.resolve(here, '../..');
  const outDir = path.resolve(process.env.VERIFY_OUT_DIR ?? path.join(os.tmpdir(), 'desktop-verify'));
  const port = Number(process.env.VERIFY_CDP_PORT ?? 9222);
  fs.mkdirSync(outDir, { recursive: true });

  const desktopRequire = createRequire(path.join(desktopDir, 'package.json'));
  const electronBin = desktopRequire('electron');
  const electronDist = path.dirname(electronBin);
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version;
  const electronVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(desktopRequire.resolve('electron/package.json')), 'package.json'), 'utf8')).version;

  console.log(`electron ${electronVersion} at ${electronBin}`);
  console.log(`desktop version ${expectedVersion}, output ${outDir}`);

  const sandboxStat = fs.statSync(path.join(electronDist, 'chrome-sandbox'));
  console.log(`chrome-sandbox mode ${(sandboxStat.mode & 0o7777).toString(8)} uid ${sandboxStat.uid}`);

  await check('electron major version is 38', async () => {
    if (!electronVersion.startsWith('38.')) throw new Error(`electron ${electronVersion}`);
    return electronVersion;
  });

  await check('chrome-sandbox is root-owned setuid (production configuration)', async () => {
    if (sandboxStat.uid !== 0 || (sandboxStat.mode & 0o4000) === 0) {
      throw new Error(`mode ${(sandboxStat.mode & 0o7777).toString(8)} uid ${sandboxStat.uid}`);
    }
    return 'mode 4755 owned by root';
  });

  const makeEnv = (cfgDir) => ({
    ...process.env,
    HOME: cfgDir,
    XDG_CONFIG_HOME: path.join(cfgDir, 'config'),
    ELECTRON_ENABLE_LOGGING: '1',
    FREEAPI_SHOT: 'hold',
  });

  const cfgA = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-verify-a-'));
  const logA = path.join(outDir, 'app-main.log');
  const debugArgs = (p) => [`--remote-debugging-port=${p}`, '--remote-allow-origins=*'];
  let app;
  let secondInstance;
  try {
    app = launchElectron({ electronBin, desktopDir, env: makeEnv(cfgA), args: debugArgs(port), logFile: logA });
    console.log(`launched electron pid ${app.pid}`);

    // With a tray, FREEAPI_SHOT=hold opens the popover and then the dashboard.
    // Without one, nothing opens on its own and the dashboard is opened below
    // through the second-instance path.
    let targets = [];
    try {
      targets = await waitFor(async () => {
        const t = await listTargets(port);
        return t.some(isDashboardTarget) || t.some(isPopoverTarget) ? t : null;
      }, 60000, 'the first app window');
    } catch (err) {
      console.log(`no window opened on launch: ${err.message}`);
    }
    await sleep(6000); // SHOT=hold opens the dashboard a few seconds after the popover
    targets = await listTargets(port).catch(() => targets);

    let dashboard = targets.find(isDashboardTarget);
    const popover = targets.find(isPopoverTarget);

    const startSecondInstance = () => {
      secondInstance = launchElectron({
        electronBin,
        desktopDir,
        env: makeEnv(cfgA),
        args: [],
        logFile: path.join(outDir, 'app-second-instance.log'),
      });
    };

    if (!dashboard) {
      console.log('dashboard not open yet; opening it through the second-instance path');
      startSecondInstance();
      dashboard = await waitFor(async () => (await listTargets(port)).find(isDashboardTarget), 60000, 'the dashboard window');
    }

    record('popover window opened (tray available)', !!popover,
      popover ? popover.url : 'no popover page: the tray did not build on this runner, so the popover cannot be verified without a test hook');

    const dashPort = new URL(dashboard.url).port;
    console.log(`dashboard at ${dashboard.url} (server port ${dashPort})`);

    const token = await dashboardChecks('dashboard', port, dashboard, expectedVersion, outDir);
    sandboxChecks('dashboard', electronDist, token);

    if (popover) await popoverChecks(popover, outDir);

    // Close the dashboard window and reopen it through the second-instance
    // handler: the new window must initialise exactly like the first.
    await check('dashboard window can be closed and reopened', async () => {
      await fetch(`http://127.0.0.1:${port}/json/close/${dashboard.id}`);
      await waitFor(async () => !(await listTargets(port)).some((t) => t.id === dashboard.id), 20000, 'the dashboard to close');
      startSecondInstance();
      const reopened = await waitFor(async () => (await listTargets(port)).find(isDashboardTarget), 60000, 'the reopened dashboard');
      if (reopened.id === dashboard.id) throw new Error('same target id after reopen');
      dashboard = reopened;
      return 'second-instance opened a new dashboard window';
    });

    if (dashboard) {
      const token2 = await dashboardChecks('reopened dashboard', port, dashboard, expectedVersion, outDir);
      sandboxChecks('reopened dashboard', electronDist, token2);
    }

    const log = fs.readFileSync(logA, 'utf8');
    const bad = [
      /Unable to load preload script/i,
      /could not (prepare|read) the dashboard bootstrap/i,
      /Cannot find module/i,
    ].filter((re) => re.test(log));
    record('app log has no preload or bootstrap errors', bad.length === 0, bad.map(String).join(', '));
  } catch (err) {
    record('verification run completed', false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopApp(secondInstance);
    await stopApp(app);
  }

  // Negative control: the same detector must classify a --no-sandbox run as
  // unsandboxed, otherwise a pass above would prove nothing.
  const cfgB = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-verify-b-'));
  let control;
  try {
    const controlPort = port + 1;
    control = launchElectron({
      electronBin,
      desktopDir,
      env: makeEnv(cfgB),
      args: ['--no-sandbox', ...debugArgs(controlPort)],
      logFile: path.join(outDir, 'app-negative-control.log'),
    });
    await waitFor(async () => (await listTargets(controlPort)).length > 0 ? true : null, 60000, 'a window in the negative control');
    await sleep(3000);
    const procs = readProcs().filter((p) => p.args[0] && p.args[0].startsWith(electronDist));
    const renderers = procs.filter(isRenderer);
    const unsandboxed = renderers.filter((p) => !isSandboxedStatus(p.status));
    record('negative control: --no-sandbox is detected as unsandboxed',
      renderers.length > 0 && unsandboxed.length > 0,
      renderers.map((p) => `pid ${p.pid}: Seccomp=${p.status.Seccomp}`).join('; ') || 'no renderers found');
  } catch (err) {
    record('negative control: --no-sandbox is detected as unsandboxed', false, err instanceof Error ? err.message : String(err));
  } finally {
    await stopApp(control);
  }

  writeSummary(outDir);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
