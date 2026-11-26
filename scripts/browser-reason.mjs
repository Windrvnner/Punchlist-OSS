// What a browser suite's output says about how it ended, shared by scripts/browser-all.mjs and its tests.

/** The suite's last "N/M passed" line, and whether it is a positive, complete summary. */
export function summaryOf(out) {
  const summary = [...out.matchAll(/^(\d+)\/(\d+) passed\r?$/gm)].at(-1);
  const passed = summary ? Number(summary[1]) : 0;
  const total = summary ? Number(summary[2]) : 0;
  const valid = Number.isSafeInteger(passed) && Number.isSafeInteger(total) && total > 0 && passed <= total;
  return { passed, total, valid };
}

/**
 * Why a suite ended without a summary (#157, #163): its exit, whether the app server still served this build, and its
 * last lines of output, so a run under load says whether the suite crashed, was killed, or lost its server.
 */
export function noResultReason(code, signal, out, serverUp) {
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.length ? lines.slice(-2).join(' | ').slice(0, 240) : 'no output';
  const exit = signal ? `signal ${signal}` : `exit ${code}`;
  return `${exit}; server ${serverUp ? 'up' : 'down'}; last lines: ${last}`;
}

/**
 * A GitHub Actions warning for each suite that failed alongside others and passed only on its own, so the pull
 * request's checks page shows it though the job passes. Empty outside GitHub Actions.
 */
export function rerunWarnings(names, onGitHub) {
  if (!onGitHub) return [];
  return names.map((name) => `::warning title=Browser suite passed only on its own::${name} failed alongside others`);
}
