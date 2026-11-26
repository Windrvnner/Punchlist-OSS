// @vitest-environment jsdom
// Home's example questions: built from the person's own deals, with a generic set before there are any
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useRef } from 'preact/hooks';
import { homeExamples, useRotatingExample } from '../../src/ui/homeExamples';

/** a box with the rotating examples as its placeholder, as Home's composer has */
function Box({ examples, text = '' }: { examples: string[]; text?: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const example = useRotatingExample(examples, box, !!text);
  return <textarea ref={box} placeholder={example} value={text} />;
}

/** mounts the box, with Windows' reduced motion on or off */
function mount(props: { examples: string[]; text?: string }, reduced = false) {
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce') })) as typeof matchMedia;
  const host = document.createElement('div'); document.body.appendChild(host);
  act(() => render(<Box {...props} />, host));
  return host.querySelector('textarea')!;
}
const later = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('homeExamples', () => {
  it('shows a deal name exactly as written, even one that looks like a replacement pattern', () => {
    const examples = homeExamples(['Alpha $& Co', "Beta $' Ltd"]);
    expect(examples.some((e) => e.includes('Alpha $& Co'))).toBe(true);
    expect(examples.find((e) => e.startsWith('Compare')))
      .toBe("Compare the lock-up ratios on Alpha $& Co and Beta $' Ltd");
  });

  it('names each deal in turn, and compares two once there are two', () => {
    expect(homeExamples(['Project Proseware'])).toEqual([
      'Which permits are still open on Project Proseware?',
      'What has the counterparty on Project Proseware not answered yet?',
      'Summarize the open findings on Project Proseware',
      'What does the data room on Project Proseware say about delay damages?',
    ]);
    const two = homeExamples(['Project Proseware', 'Project Wingtip']);
    expect(two[1]).toBe('What has the counterparty on Project Wingtip not answered yet?');
    expect(two[2]).toBe('Compare the lock-up ratios on Project Proseware and Project Wingtip');
  });

  it('falls back to questions across the deals when there are none, or only blank names', () => {
    expect(homeExamples([])[0]).toBe('Which permits are still open across my deals?');
    expect(homeExamples(['  '])).toEqual(homeExamples([]));
  });

  it('changes the example every few seconds, and holds it with focus or text in the box, or reduced motion', () => {
    vi.useFakeTimers();
    const examples = ['First?', 'Second?', 'Third?'];
    const box = mount({ examples });
    expect(box.placeholder).toBe('First?');
    later(6400); expect(box.placeholder).toBe('Second?');
    box.focus(); later(13000); expect(box.placeholder).toBe('Second?');
    box.blur(); later(6400); expect(box.placeholder).toBe('Third?');
    const typed = mount({ examples, text: 'What is' }); later(13000); expect(typed.placeholder).toBe('First?');
    const still = mount({ examples }, true); later(13000); expect(still.placeholder).toBe('First?');
    vi.useRealTimers();
  });
});
