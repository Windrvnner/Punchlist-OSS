// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { EditField } from '../../src/ui/editField';
import { atLimit, limitClass, limitTitle } from '../../src/ui/limit';
import { TEXT_MAX, TOO_LONG } from '../../src/domain/importExport';

describe('a text box at the Excel cell limit', () => {
  it('is at the limit only when the text fills one cell', () => {
    expect(atLimit('x'.repeat(TEXT_MAX - 1))).toBe(false);
    expect(atLimit('x'.repeat(TEXT_MAX))).toBe(true);
    expect(limitClass('short')).toBe('');
    expect(limitTitle('short')).toBeUndefined();
  });

  it('shows a red outline class and says why in its tooltip, and holds no more text', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const draw = (value: string) => act(() => {
      render(<EditField label="Question" multiline value={value} rev={1} commit={async () => ({ ok: true })} />, host);
    });
    draw('x'.repeat(TEXT_MAX - 1));
    const box = () => host.querySelector('textarea') as HTMLTextAreaElement;
    expect(box().classList.contains('atlimit')).toBe(false);
    expect(box().maxLength).toBe(TEXT_MAX);
    draw('x'.repeat(TEXT_MAX));
    expect(box().classList.contains('atlimit')).toBe(true);
    expect(box().title).toBe(TOO_LONG);
    draw('x'.repeat(TEXT_MAX - 1));
    expect(box().classList.contains('atlimit')).toBe(false);
    expect(box().title).toBe('');
  });
});
