// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PickList } from '../../src/ui/pickList';

/** a closed list showing `cur`, among two names that differ only in case */
function mount(cur: string, onPick: (v: string) => void) {
  const host = document.createElement('div'); document.body.appendChild(host);
  act(() => render(<PickList id="pl" label="List" className="x" cur={cur} onPick={onPick}
    names={[{ name: 'Acme', n: 1 }, { name: 'ACME', n: 1 }]} />, host));
  act(() => { (host.querySelector('#pl > button') as HTMLElement).click(); });
  return host;
}
const choose = (host: HTMLElement, name: string) => act(() => {
  [...host.querySelectorAll('button.mi')].find((b) => b.textContent?.includes(name))!.dispatchEvent(
    new MouseEvent('click', { bubbles: true }));
});

describe('picking from a list', () => {
  it('picks a name that differs from the current one only in case', () => {
    const onPick = vi.fn();
    choose(mount('Acme', onPick), 'ACME');
    expect(onPick).toHaveBeenCalledWith('ACME');
  });

  it('does nothing when the current name is picked again', () => {
    const onPick = vi.fn();
    const host = mount('Acme', onPick);
    const same = [...host.querySelectorAll('button.mi')].find((b) => b.classList.contains('on'));
    expect(same?.textContent).toContain('Acme');
    act(() => { same!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onPick).not.toHaveBeenCalled();
  });
});
