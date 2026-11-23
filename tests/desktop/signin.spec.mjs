// Builds tests/desktop/signinHarness.ts and runs it in Electron: the North sign-in window against the stand-in North.
// Run with `npm run desktop:signin` (on Linux without a display, under xvfb-run).
import { build } from 'vite';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
await build({ configFile: false, logLevel: 'warn', publicDir: false, build: { outDir: 'dist-desktop-test', emptyOutDir: true, target: 'node22', minify: false, ssr: 'tests/desktop/signinHarness.ts', rollupOptions: { external: ['electron', /^node:/, ...builtinModules], output: { format: 'es', entryFileNames: 'signin.mjs' } } } });
const sandbox = process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : [];
// a run that hangs is stopped after five minutes and fails, rather than holding CI until its own timeout
const r = spawnSync(electron, [...sandbox, 'dist-desktop-test/signin.mjs'], {
  stdio: 'inherit',
  timeout: 5 * 60_000,
  env: { ...process.env, PUNCHLIST_AI_KEY: '' },
});
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
