import { vi } from 'vitest';
import { BrowserLocal, MemoryLocal } from '../../src/adapters/local';
import { initializeKeptText } from '../../src/app/keptText';
import { startKeptText } from '../../src/shell/keptText';

// UI modules make their maps when loaded, after the real shell has restored the saved text.
let stopFlush: (() => void) | undefined;
if (typeof window === 'undefined') initializeKeptText(new MemoryLocal());
else stopFlush = startKeptText(new BrowserLocal());

export async function restartKeptText() {
  stopFlush?.();
  vi.resetModules();
  const { startKeptText: start } = await import('../../src/shell/keptText');
  stopFlush = start(new BrowserLocal());
}
