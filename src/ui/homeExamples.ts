/**
 * Home's ask box, under its question, shows example questions one at a time, built from the person's own deals.
 * The change is slow and quiet: a fade every few seconds, held while the box has the focus or text,
 * and no rotation at all when Windows asks for reduced motion.
 */
import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** how long each example shows, and how long its fade takes (matches .phfade in ui.css) */
const SHOW_MS = 6000;
const FADE_MS = 400;

/** one question per pattern, each about a deal in turn; {a} and {b} are deal names */
const ABOUT_ONE = [
  'Which permits are still open on {a}?',
  'What has the counterparty on {a} not answered yet?',
  'Summarize the open findings on {a}',
  'What does the data room on {a} say about delay damages?',
];
const ABOUT_TWO = 'Compare the lock-up ratios on {a} and {b}';
/** for a person with no deals of their own yet */
const GENERIC = [
  'Which permits are still open across my deals?',
  'Which questions has the counterparty not answered yet?',
  'Summarize the open findings across my deals',
];

/** Examples for these deals: each pattern names the next deal, and two deals are compared when there are two */
export function homeExamples(dealNames: string[]): string[] {
  const names = dealNames.filter((name) => name.trim());
  if (!names.length) return GENERIC;
  const examples = ABOUT_ONE.map((pattern, i) => pattern.replace('{a}', names[i % names.length]));
  if (names.length > 1) examples.splice(2, 0, ABOUT_TWO.replace('{a}', names[0]).replace('{b}', names[1]));
  return examples;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The example to show now, or undefined when there are none. Every SHOW_MS the box's placeholder fades out, changes and
 * fades back in, unless the box has the focus or holds text (the person is busy with it) or motion is reduced.
 */
export function useRotatingExample(examples: string[] | undefined, box: RefObject<HTMLTextAreaElement | null>,
  hasText: boolean) {
  const [at, setAt] = useState(0);
  const count = examples?.length ?? 0;
  useEffect(() => {
    if (count < 2 || hasText || reducedMotion()) return;
    let fade: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => {
      const el = box.current;
      if (!el || document.activeElement === el) return;
      el.classList.add('phfade');
      fade = setTimeout(() => { setAt((i) => (i + 1) % count); el.classList.remove('phfade'); }, FADE_MS);
    }, SHOW_MS);
    return () => { clearInterval(tick); clearTimeout(fade); box.current?.classList.remove('phfade'); };
  }, [count, hasText]);
  return count ? examples![at % count] : undefined;
}
