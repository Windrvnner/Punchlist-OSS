import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { assertControl } from './src/control';
import { colorCss } from './src/palette';
// the version shown in Settings is the one in package.json
const version: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// The colors worked out from the control file's base colors go ahead of the stylesheet, so its theme blocks and High
// Contrast block build on them. The build stops on a value out of range in the control file, as the app would at start,
// and on base colors that would leave text hard to read.
const controlColors = (): Plugin => ({
  name: 'control-colors',
  buildStart() { assertControl(); colorCss(); },
  transform(code, id) { return id.replace(/\\/g, '/').endsWith('/src/styles.css') ? { code: colorCss() + code, map: null } : null; },
});
// The app ships inside Electron, so the only browser is Chromium. Saying so keeps the CSS
// minifier from rewriting standard properties into prefixed ones Chromium ignores
// (it had reduced backdrop-filter to -webkit-backdrop-filter, which removed the glass blur).
// Two pages: index.html is the browser demo on stand-in services, desktop.html the desktop app's window on the bridge.
export default defineConfig({ define: { __APP_VERSION__: JSON.stringify(version) }, plugins: [preact(), controlColors()], base: './', build: { outDir: 'dist', rollupOptions: { input: { index: 'index.html', desktop: 'desktop.html' } }, target: 'chrome120', cssTarget: 'chrome120', sourcemap: true } });
