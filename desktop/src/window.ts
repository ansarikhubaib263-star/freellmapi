import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';
import { platformChrome } from './window-chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dashboardWindow: BrowserWindow | null = null;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
}

/** webContents id of the open dashboard window, or undefined when there is none. */
export function getDashboardWebContentsId(): number | undefined {
  return dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow.webContents.id : undefined;
}

// One window at a time, destroyed on close — the app lives in the tray, the
// window is an on-demand view. The session token is NOT passed to the window
// here: command-line arguments are readable by other local users (`ps`, Task
// Manager) and by the renderer's process.argv. Instead the CJS preload fetches
// it from the main process over IPC (`freeapi:bootstrap-sync`, see main.ts) and
// seeds localStorage before any page script runs (no login flash, no reload).
export function openDashboard(port: number): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'FreeLLMAPI',
    ...platformChrome(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // Renderer sandbox ON. The preload is a single bundled CJS file that only
      // imports `electron` (contextBridge / ipcRenderer), which is all a
      // sandboxed preload may require; desktop-hardening.test.ts guards that.
      sandbox: true,
      nodeIntegration: false,
    },
  });

  dashboardWindow.loadURL(`http://127.0.0.1:${port}`);
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}
