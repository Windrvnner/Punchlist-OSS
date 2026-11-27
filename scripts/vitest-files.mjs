// Which test files Vitest runs, shared by vitest.config.ts and the check that every test file is in the list.
export const testInclude = [
  'tests/domain/**/*.test.ts',
  'tests/adapters/**/*.test.ts',
  'tests/app/**/*.test.ts',
  'tests/backend/**/*.test.ts',
  'tests/ui/**/*.test.tsx',
  'tests/e2e/**/*.test.ts',
  'tests/scripts/**/*.test.ts',
  'tests/desktop/**/*.test.ts',
];

// The AI check against a real model service runs only when someone runs npm run ai:check -- <backend> themselves;
// never in npm test or check:all. The live tests on Claude make paid calls: only npm run e2e:live (PUNCHLIST_LIVE=1)
// runs them, never a plain run.
export function liveExclude(env) {
  const aiCheck = ['claude', 'north', 'openai'].includes(env.PUNCHLIST_AI_CHECK ?? '');
  return [
    ...(aiCheck ? [] : ['tests/e2e/ai-check-live.test.ts']),
    ...(env.PUNCHLIST_LIVE === '1' ? [] : ['tests/e2e/live*.test.ts']),
  ];
}
