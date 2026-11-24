// Browser compilation and package resolution shared by the app and the UI glob check.
import preact from '@preact/preset-vite';
import manifest from '../package.json' with { type: 'json' };

export const browserTarget = 'chrome120';

export function browserOptions() {
  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(manifest.version) },
    plugins: preact(),
  };
}
