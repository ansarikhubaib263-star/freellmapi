import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isDashboardBootstrapSender,
  isLocalDashboardUrl,
  isTrustedDashboardSender,
  type IpcSenderEvent,
} from '../ipc-trust.js';

// Two hardening rules for the desktop shell, asserted without launching
// Electron (it cannot run in unit tests):
//
//  1. Renderers are sandboxed. `sandbox: false` once let the preload use full
//     Node; with the sandbox on, a preload may only `require('electron')`,
//     so each preload must stay a bundle that imports nothing else.
//  2. The dashboard session token never rides on the command line. Process
//     arguments are readable by other local users (`ps`, Task Manager) and by
//     the renderer's own process.argv. It reaches the preload over IPC, and
//     the main process only answers the local dashboard origin.

const here = dirname(fileURLToPath(import.meta.url));
const src = (name: string) => readFileSync(resolve(here, '..', name), 'utf8');
const nonComment = (code: string) =>
  code.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

describe('renderer sandbox', () => {
  for (const file of ['window.ts', 'popover.ts']) {
    it(`${file} enables the sandbox and keeps nodeIntegration off`, () => {
      const code = nonComment(src(file));
      expect(code).toMatch(/sandbox:\s*true/);
      expect(code).not.toMatch(/sandbox:\s*false/);
      expect(code).toMatch(/nodeIntegration:\s*false/);
      expect(code).toMatch(/contextIsolation:\s*true/);
    });
  }

  for (const file of ['preload.ts', 'preload-popover.ts']) {
    it(`${file} imports only electron, the one module a sandboxed preload may require`, () => {
      const code = nonComment(src(file));
      const specifiers = [...code.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      expect(new Set(specifiers)).toEqual(new Set(['electron']));
      expect(code).not.toMatch(/\brequire\s*\(/);
    });
  }
});

describe('session token delivery', () => {
  it('never puts the token in command-line arguments', () => {
    for (const file of ['window.ts', 'preload.ts', 'main.ts']) {
      const code = nonComment(src(file));
      expect(code, file).not.toMatch(/--freeapi-token/);
      expect(code, file).not.toMatch(/additionalArguments/);
    }
    // The window opener no longer takes a token at all.
    expect(nonComment(src('window.ts'))).toMatch(/export function openDashboard\(port: number\): void/);
  });

  it('guards both token channels with the window + main-frame sender checks', () => {
    const main = nonComment(src('main.ts'));
    const runtime = main.indexOf("'freeapi:session-token'");
    const boot = main.indexOf("'freeapi:bootstrap-sync'");
    expect(runtime).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    // The check sits inside each handler, before the token is read.
    expect(main.slice(runtime, runtime + 400)).toMatch(
      /isTrustedDashboardSender\(event, resolvedPort, getDashboardWebContentsId\(\)\)/,
    );
    expect(main.slice(boot, boot + 700)).toMatch(
      /isDashboardBootstrapSender\(event, resolvedPort, getDashboardWebContentsId\(\)\)/,
    );
  });

  it('the preload reads the token from the bootstrap IPC call', () => {
    const preload = nonComment(src('preload.ts'));
    expect(preload).toMatch(/sendSync\('freeapi:bootstrap-sync'\)/);
  });
});

describe('isLocalDashboardUrl', () => {
  const port = 31415;

  it('accepts the dashboard origin on the running port', () => {
    expect(isLocalDashboardUrl(`http://127.0.0.1:${port}`, port)).toBe(true);
    expect(isLocalDashboardUrl(`http://127.0.0.1:${port}/`, port)).toBe(true);
    expect(isLocalDashboardUrl(`http://127.0.0.1:${port}/settings?tab=1#x`, port)).toBe(true);
  });

  it('rejects another port, host or scheme', () => {
    expect(isLocalDashboardUrl(`http://127.0.0.1:${port + 1}/`, port)).toBe(false);
    expect(isLocalDashboardUrl('http://127.0.0.1/', port)).toBe(false);
    expect(isLocalDashboardUrl(`http://localhost:${port}/`, port)).toBe(false);
    expect(isLocalDashboardUrl(`http://192.168.1.5:${port}/`, port)).toBe(false);
    expect(isLocalDashboardUrl(`https://127.0.0.1:${port}/`, port)).toBe(false);
    expect(isLocalDashboardUrl(`file:///app/renderer/popover.html`, port)).toBe(false);
  });

  it('rejects lookalike hosts that merely contain the local address', () => {
    expect(isLocalDashboardUrl(`http://127.0.0.1.evil.example:${port}/`, port)).toBe(false);
    expect(isLocalDashboardUrl(`http://evil.example:${port}/@127.0.0.1:${port}/`, port)).toBe(false);
    expect(isLocalDashboardUrl(`http://127.0.0.1:${port}@evil.example/`, port)).toBe(false);
  });

  it('rejects missing and malformed values', () => {
    expect(isLocalDashboardUrl(undefined, port)).toBe(false);
    expect(isLocalDashboardUrl(null, port)).toBe(false);
    expect(isLocalDashboardUrl('', port)).toBe(false);
    expect(isLocalDashboardUrl('not a url', port)).toBe(false);
  });
});

describe('token IPC sender validation', () => {
  const port = 31415;
  const dashboardId = 7;
  const local = `http://127.0.0.1:${port}/`;
  const event = (over: { id?: number; url?: string; parent?: unknown | null; frame?: null } = {}): IpcSenderEvent => ({
    sender: { id: over.id ?? dashboardId },
    senderFrame: over.frame === null ? null : { url: over.url ?? local, parent: over.parent ?? null },
  });

  describe('isTrustedDashboardSender (runtime session refresh)', () => {
    it('accepts the dashboard window main frame at the local origin', () => {
      expect(isTrustedDashboardSender(event(), port, dashboardId)).toBe(true);
    });

    it('rejects a subframe, even a same-origin one', () => {
      expect(isTrustedDashboardSender(event({ parent: { frame: 'top' } }), port, dashboardId)).toBe(false);
    });

    it('rejects another window (e.g. the popover) even at the right URL', () => {
      expect(isTrustedDashboardSender(event({ id: dashboardId + 1 }), port, dashboardId)).toBe(false);
    });

    it('rejects every sender while no dashboard window is open', () => {
      expect(isTrustedDashboardSender(event(), port, undefined)).toBe(false);
    });

    it('rejects a null senderFrame, a foreign URL, and an empty URL', () => {
      expect(isTrustedDashboardSender(event({ frame: null }), port, dashboardId)).toBe(false);
      expect(isTrustedDashboardSender(event({ url: 'https://evil.example/' }), port, dashboardId)).toBe(false);
      expect(isTrustedDashboardSender(event({ url: '' }), port, dashboardId)).toBe(false);
      expect(isTrustedDashboardSender(event({ url: 'about:blank' }), port, dashboardId)).toBe(false);
    });
  });

  describe('isDashboardBootstrapSender (preload boot-time seed)', () => {
    it('accepts the dashboard main frame at the local origin', () => {
      expect(isDashboardBootstrapSender(event(), port, dashboardId)).toBe(true);
    });

    it('also accepts it before the URL is known (empty / about:blank)', () => {
      expect(isDashboardBootstrapSender(event({ url: '' }), port, dashboardId)).toBe(true);
      expect(isDashboardBootstrapSender(event({ url: 'about:blank' }), port, dashboardId)).toBe(true);
    });

    it('still rejects a known foreign URL', () => {
      expect(isDashboardBootstrapSender(event({ url: 'https://evil.example/' }), port, dashboardId)).toBe(false);
      expect(isDashboardBootstrapSender(event({ url: `http://127.0.0.1:${port + 1}/` }), port, dashboardId)).toBe(false);
      expect(isDashboardBootstrapSender(event({ url: 'file:///x.html' }), port, dashboardId)).toBe(false);
    });

    it('applies the same window and main-frame rules as the strict check', () => {
      expect(isDashboardBootstrapSender(event({ parent: { frame: 'top' } }), port, dashboardId)).toBe(false);
      expect(isDashboardBootstrapSender(event({ id: dashboardId + 1 }), port, dashboardId)).toBe(false);
      expect(isDashboardBootstrapSender(event(), port, undefined)).toBe(false);
      expect(isDashboardBootstrapSender(event({ frame: null }), port, dashboardId)).toBe(false);
    });
  });
});
