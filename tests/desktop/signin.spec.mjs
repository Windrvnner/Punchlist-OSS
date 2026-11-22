// Builds tests/desktop/signinHarness.ts and runs it in Electron: the North sign-in window against the stand-in North.
// Run with `npm run desktop:signin` (on Linux without a display, under xvfb-run).
import { build } from 'vite';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
await build({ configFile: false, logLevel: 'warn', publicDir: false, build: { outDir: 'dist-desktop-test', emptyOutDir: true, target: 'node22', minify: false, ssr: 'tests/desktop/signinHarness.ts', rollupOptions: { external: ['electron', /^node:/, ...builtinModules], output: { format: 'es', entryFileNames: 'signin.mjs' } } } });
const r = spawnSync(electron, [...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []), 'dist-desktop-test/signin.mjs'], { stdio: 'inherit', env: { ...process.env, PUNCHLIST_AI_KEY: '' } });
process.exit(r.status ?? 1);
