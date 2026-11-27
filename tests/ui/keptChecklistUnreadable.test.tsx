// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { importKey, keepImport, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { StoreContext } from '../../src/ui/hooks';
import { FirmChecklistDialog } from '../../src/ui/firmChecklist';
import { recoveryApp } from '../app/recoveryKit';

it('opens past an unreadable draft and binds the paste field to the current way into the import', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const app = recoveryApp();
  await keptImportsReady;
  const first = importKey.checklist();
  const second = importKey.checklist('technology', 'Solar');
  const damaged = { paste: 'Unreadable review', review: { damaged: true } };
  keepImport(first, damaged);
  keepImport(second, { paste: 'Solar site leases' });
  const screen = document.createElement('div');
  document.body.append(screen);
  const paste = () => screen.querySelector<HTMLTextAreaElement>('#cl-paste')!;
  try {
    app.store.ui({ firmChecklist: { step: 'import' } });
    await act(() => render(
      <StoreContext.Provider value={app.store}><FirmChecklistDialog /></StoreContext.Provider>, screen,
    ));
    expect(paste().value).toBe('');
    expect(keptImport(first)).toEqual(damaged);
    await act(() => app.store.ui({ firmChecklist: { step: 'import', layer: 'technology', name: 'Solar' } }));
    expect(paste().value).toBe('Solar site leases');
    await act(() => {
      paste().value = '  Solar access easements  ';
      paste().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(keptImport(first)).toEqual(damaged);
    expect(keptImport(second)?.paste).toBe('  Solar access easements  ');
  } finally {
    render(null, screen);
    screen.remove();
    app.store.closing();
    await app.repo.close();
    vi.unstubAllGlobals();
  }
});
