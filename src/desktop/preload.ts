/**
 * The preload: runs in the window, sandboxed, before the app. It puts the bridge (src/shell/bridge.ts `BridgeApi`) on
 * `window.punchlist` and nothing else. Only `electron` may be imported here, because a sandboxed preload cannot load
 * other modules; the channel names are written out for that reason.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const listeners = { repo: new Set<(c: unknown) => void>(), conversations: new Set<(c: unknown) => void>() };
ipcRenderer.on('punchlist:watch', (_e, service: keyof typeof listeners, change: unknown) => { for (const l of listeners[service] ?? []) l(change); });

contextBridge.exposeInMainWorld('punchlist', {
  describe: () => ipcRenderer.invoke('punchlist:describe'),
  call: (service: string, method: string, args: unknown[]) => ipcRenderer.invoke('punchlist:call', service, method, args),
  on(service: keyof typeof listeners, listener: (c: unknown) => void) {
    const set = listeners[service]; if (!set) return () => {};
    set.add(listener); return () => { set.delete(listener); };
  },
  pathFor: (file: File) => webUtils.getPathForFile(file),
});
