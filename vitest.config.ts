import { defineConfig, configDefaults } from 'vitest/config';
import preact from '@preact/preset-vite';
import path from 'node:path';
import { insideGate } from './scripts/gate-dir.mjs';
const live = process.env.PUNCHLIST_LIVE === '1';
// check:all sets this folder so the run leaves a machine-readable result (scripts/gate-compare.mjs)
const gateDir = insideGate(process.env.PUNCHLIST_GATE_DIR);
const aiCheck = ['claude', 'north', 'openai'].includes(process.env.PUNCHLIST_AI_CHECK ?? '');
export default defineConfig({ plugins: [preact()], test: { include: [
    'tests/domain/**/*.test.ts', 'tests/adapters/**/*.test.ts', 'tests/app/**/*.test.ts', 'tests/backend/**/*.test.ts',
    'tests/ui/**/*.test.tsx', 'tests/e2e/**/*.test.ts', 'tests/scripts/**/*.test.ts', 'tests/desktop/**/*.test.ts'], environment: 'jsdom',
  // the AI check against a real model service runs only when someone runs npm run ai:check -- <backend> themselves; never in npm test or check:all
  exclude: [...configDefaults.exclude, ...(aiCheck ? [] : ['tests/e2e/ai-check-live.test.ts']),
    // the live tests on Claude make paid calls: only npm run e2e:live (PUNCHLIST_LIVE=1) runs them, never a plain run
    ...(live ? [] : ['tests/e2e/live*.test.ts'])],
  // and no other test sees a key the shell holds, unless the run asked for live calls or the AI check
  env: live || aiCheck ? {} : { PUNCHLIST_AI_KEY: '' },
  ...(gateDir ? { reporters: ['default', ['json', { outputFile: path.join(gateDir, 'vitest.json') }]] } : {}) } });
