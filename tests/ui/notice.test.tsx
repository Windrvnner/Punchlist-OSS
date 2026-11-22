import { expect, it } from 'vitest';
import { glyphOf } from '../../src/ui/notice';

it('uses the action and notice title to pick the glyph (#565)', () => {
  expect(glyphOf('Deleted finding · Notice of default not cured', 'Undo')).toBe('done');
  expect(glyphOf("Couldn't save · disk full")).toBe('warn');
});
