import { defineConfig, configDefaults } from 'vitest/config';
import preact from '@preact/preset-vite';
import path from 'node:path';
import { insideGate } from './scripts/gate-dir.mjs';
import { isAiCheck, isLive, liveExclude, testInclude } from './scripts/vitest-files.mjs';
// check:all sets this folder so the run leaves a machine-readable result (scripts/gate-compare.mjs)
const gateDir = insideGate(process.env.PUNCHLIST_GATE_DIR);
export default defineConfig({ plugins: [preact()], test: { include: testInclude, environment: 'jsdom',
  // the live tests and the AI check make paid calls: scripts/vitest-files.mjs says when they run
  exclude: [...configDefaults.exclude, ...liveExclude(process.env)],
  // and no other test sees a key the shell holds, unless the run asked for live calls or the AI check
  env: isLive(process.env) || isAiCheck(process.env) ? {} : { PUNCHLIST_AI_KEY: '' },
  ...(gateDir ? { reporters: ['default', ['json', { outputFile: path.join(gateDir, 'vitest.json') }]] } : {}) } });
