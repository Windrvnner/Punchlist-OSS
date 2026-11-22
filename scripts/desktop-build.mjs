// Builds the desktop app's main process and preload into dist-desktop/ (the window's files are dist/, from `npm run build`).
// The main process is an ES module run by Electron's Node; npm dependencies stay outside the bundle and ship in
// node_modules. The preload is one CommonJS file, because a sandboxed preload can load nothing but `electron`.
import { build } from 'vite';
import { builtinModules } from 'node:module';
const external = ['electron', /^node:/, ...builtinModules, 'jsonrepair', 'ulid', 'zod', /^pdfjs-dist/, /^@anthropic-ai\/sdk/];
const common = { configFile: false, logLevel: 'warn', publicDir: false, build: { outDir: 'dist-desktop', emptyOutDir: false, target: 'node22', minify: false, sourcemap: true } };
await build({ ...common, build: { ...common.build, emptyOutDir: true, ssr: 'src/desktop/main.ts', rollupOptions: { external, output: { format: 'es', entryFileNames: 'main.mjs' } } } });
await build({ ...common, build: { ...common.build, ssr: 'src/desktop/preload.ts', rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'preload.cjs' } } } });
console.log('dist-desktop/main.mjs and dist-desktop/preload.cjs built');
