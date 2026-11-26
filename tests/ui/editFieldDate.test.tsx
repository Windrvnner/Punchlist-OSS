// @vitest-environment jsdom
// The Detail date field: a real date or an empty field uses the browser's date control; text typed in a log's date
// column stays a text field, shown as written, at rest and while focused (#1022).
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { EditField } from '../../src/ui/editField';

function mountDate(value: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const commits: string[] = [];
  const commit = async (v: string) => {
    commits.push(v);
    return { ok: true };
  };
  act(() => {
    render(<EditField label="Received" type="date" value={value} rev={1} commit={commit} debounceMs={20} />, host);
  });
  const field = () => host.querySelector('input') as HTMLInputElement;
  const fire = (name: 'focus' | 'blur') => act(() => { field().dispatchEvent(new FocusEvent(name)); });
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));
  const unmount = () => { act(() => render(null, host)); host.remove(); };
  return { field, fire, settle, commits, unmount, label: () => host.querySelector('.dshow')?.textContent ?? '' };
}

describe('the Detail date field (#1022)', () => {
  const typedTexts = ['11/02/2026', '2026-02-30', '2026'];
  it.each(typedTexts)('keeps typed text %s visible while focused, and commits nothing', async (typed) => {
    const editor = mountDate(typed);
    expect(editor.field()).toMatchObject({ type: 'text', value: typed });
    expect(editor.label()).toBe('');
    await editor.fire('focus');
    expect(editor.field()).toMatchObject({ type: 'text', value: typed });
    await editor.fire('blur');
    await editor.settle();
    expect(editor.field()).toMatchObject({ type: 'text', value: typed });
    expect(editor.commits).toEqual([]);
    editor.unmount();
  });

  it('uses the date control for a real date while focused, and for an empty field', async () => {
    const real = mountDate('2026-11-12');
    expect(real.label()).not.toBe('');
    await real.fire('focus');
    expect(real.field()).toMatchObject({ type: 'date', value: '2026-11-12' });
    real.unmount();
    const empty = mountDate('');
    await empty.fire('focus');
    expect(empty.field().type).toBe('date');
    empty.unmount();
  });
});
