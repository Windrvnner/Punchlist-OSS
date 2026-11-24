// Compile-time values shared by the app build and the UI glob check.
import manifest from '../package.json' with { type: 'json' };

export const browserTarget = 'chrome120';

export const browserOptions = {
  base: './',
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
};
