// Which IPC senders may be handed the dashboard session token.
//
// The token-bearing channels (`freeapi:bootstrap-sync`, `freeapi:session-token`)
// exist for ONE page: the dashboard the main process itself loads from the local
// server at http://127.0.0.1:<port>. Checking the sending frame's URL, rather than
// trusting that only that page can ever be in the window, keeps the token away
// from any other content that ends up there (a redirect, an injected frame, a
// future navigation bug). The window-open and will-navigate handlers in main.ts
// already send everything that is not the local server to the system browser;
// this is the second layer behind them.

/** True when `rawUrl` is the local dashboard origin on exactly this port. */
export function isLocalDashboardUrl(rawUrl: string | null | undefined, port: number): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port;
  } catch {
    return false;
  }
}

// ── sender validation for the token-bearing IPC channels ─────────────────────
//
// A URL check alone is not enough. Every frame can send IPC, and the URL says
// nothing about WHICH window or frame the message came from. A sender is
// trusted only when all of these hold:
//   1. it belongs to the dashboard window (webContents id), not the popover or
//      any other window;
//   2. it is that window's MAIN frame (`parent === null`) — a subframe, even a
//      same-origin one, is refused. Electron's docs say distinct WebFrameMain
//      objects can refer to the same frame, so frames are never compared by
//      identity (`senderFrame === sender.mainFrame` would be unreliable);
//   3. its URL is the local dashboard origin (see isLocalDashboardUrl) —
//      for the runtime channel only; see isDashboardBootstrapSender.

/** The slice of Electron's IpcMainEvent / IpcMainInvokeEvent these checks read. */
export interface IpcSenderEvent {
  sender: { id: number };
  senderFrame: { url: string; parent: unknown | null } | null;
}

function isDashboardMainFrame(event: IpcSenderEvent, dashboardContentsId: number | undefined): boolean {
  return (
    dashboardContentsId !== undefined
    && event.sender.id === dashboardContentsId
    && event.senderFrame != null
    && event.senderFrame.parent === null
  );
}

/** Strict check for requests made after the page has loaded (session refresh). */
export function isTrustedDashboardSender(
  event: IpcSenderEvent,
  port: number,
  dashboardContentsId: number | undefined,
): boolean {
  return isDashboardMainFrame(event, dashboardContentsId) && isLocalDashboardUrl(event.senderFrame?.url, port);
}

/**
 * Check for the preload's boot-time synchronous call. It runs before the page's
 * navigation has necessarily been committed on the main-process side, so the
 * frame URL can still be empty or about:blank; Electron also reports an empty
 * URL on Chromium's error page. Those are accepted here because the window
 * identity and main-frame checks already bind the request to the dashboard
 * window, which the main process only ever points at the local server
 * (will-navigate and window-open in main.ts send everything else to the system
 * browser). Any URL that IS known must still be the local dashboard origin. A
 * wrongly refused call is harmless: AuthGate then fetches a session through the
 * strict runtime channel instead.
 */
export function isDashboardBootstrapSender(
  event: IpcSenderEvent,
  port: number,
  dashboardContentsId: number | undefined,
): boolean {
  if (!isDashboardMainFrame(event, dashboardContentsId)) return false;
  const url = event.senderFrame?.url ?? '';
  return url === '' || url === 'about:blank' || isLocalDashboardUrl(url, port);
}
