import { BrowserWindow, shell } from 'electron';
import type { Credential } from '../backend/signInToken';
import { SERVICE } from '../control';
import type { BrowserSignIn } from './oauth';
import { pickSsoToken, type Cookie } from './token';

export function browserSignInPrompt(
  signIn: ((io: BrowserSignIn) => Promise<Credential>) | undefined,
  accept: (credential: Credential) => boolean,
) {
  let attempt: AbortController | undefined;
  let failed = false;
  return {
    open() {
      if (!signIn || attempt) return;
      failed = false;
      const controller = new AbortController();
      attempt = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
      void signIn({ signal, openBrowser: (url) => shell.openExternal(url) }).then((credential) => {
        if (attempt !== controller) return;
        attempt = undefined;
        failed = !accept(credential);
      }).catch(() => {
        if (attempt !== controller) return;
        attempt = undefined;
        failed = true;
      });
    },
    cancel() {
      const pending = attempt;
      attempt = undefined;
      failed = false;
      pending?.abort();
    },
    active: () => !!attempt,
    failed: () => failed,
  };
}

type NorthWindowOptions = { address: string; ssoSite: string; parent: () => BrowserWindow | null };

export function northSignInPrompt(
  options: NorthWindowOptions,
  usable: (token: string) => boolean,
  accept: (token: string) => void,
) {
  let window: BrowserWindow | undefined;
  return {
    open() {
      if (window && !window.isDestroyed()) {
        window.focus();
        return;
      }
      const opened = createNorthWindow(options.parent());
      window = opened;
      const jar = opened.webContents.session.cookies;
      const look = setInterval(() => {
        void jar.get({}).then((cookies) => {
          if (window !== opened || opened.isDestroyed()) return;
          const token = pickSsoToken(usableCookies(jar, cookies, usable), options.ssoSite);
          if (token) {
            accept(token);
            opened.close();
          }
        }, () => undefined);
      }, 1000);
      opened.on('closed', () => {
        clearInterval(look);
        if (window === opened) window = undefined;
      });
      void opened.loadURL(options.address);
    },
    close: () => window?.close(),
    destroy: () => { if (window && !window.isDestroyed()) window.destroy(); },
    active: () => !!window && !window.isDestroyed(),
  };
}

type CookieJar = BrowserWindow['webContents']['session']['cookies'];
type NorthCookie = Cookie & { path?: string; secure?: boolean };

/** Remove refused cookies so the next sign-in can obtain a fresh one. */
function usableCookies(jar: CookieJar, cookies: NorthCookie[], usable: (token: string) => boolean) {
  return cookies.filter((cookie) => {
    if (usable(cookie.value)) return true;
    void jar.remove(cookieUrl(cookie), cookie.name).catch(() => {});
    return false;
  });
}

const northWebPreferences = { partition: 'persist:ai-signin', contextIsolation: true, sandbox: true };

function createNorthWindow(parent: BrowserWindow | null) {
  const window = new BrowserWindow({
    width: 960, height: 760, title: `${SERVICE} sign-in`, parent: parent ?? undefined, autoHideMenuBar: true,
    webPreferences: { ...northWebPreferences, nodeIntegration: false },
  });
  keepSignInTitle(window);
  return window;
}

/** The North window and its identity-provider pop-ups share a session and the configured title. */
function keepSignInTitle(window: BrowserWindow) {
  window.on('page-title-updated', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      title: `${SERVICE} sign-in`, parent: window, webPreferences: { ...northWebPreferences },
    },
  }));
  window.webContents.on('did-create-window', keepSignInTitle);
}

/** The address a cookie belongs to, which Electron needs to remove it. */
function cookieUrl(cookie: NorthCookie) {
  const scheme = cookie.secure === false ? 'http' : 'https';
  return `${scheme}://${(cookie.domain ?? '').replace(/^\./, '')}${cookie.path ?? '/'}`;
}
