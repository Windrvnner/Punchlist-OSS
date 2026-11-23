import { expect, it } from 'vitest';
import { glyphOf, shorterForms } from '../../src/ui/notice';

it('uses the action and notice title to pick the glyph (#565)', () => {
  expect(glyphOf('Deleted finding · Notice of default not cured', 'Undo')).toBe('done');
  expect(glyphOf("Couldn't save · disk full")).toBe('warn');
});

it('shortens a twin-named deal by its name first, then its twin line, at whole words (#27)', () => {
  expect(shorterForms('Project Northwind Capital Holdings (Fabrikam Partners Fund)')).toEqual([
    'Project Northwind Capital… (Fabrikam Partners Fund)',
    'Project Northwind… (Fabrikam Partners Fund)',
    'Project Northwind… (Fabrikam Partners…)',
    'Project Northwind… (Fabrikam…)',
  ]);
  expect(shorterForms('Quarterly board pack')).toEqual(['Quarterly board…', 'Quarterly…']);
  expect(shorterForms('Project Coho (Wingtip)')).toEqual([]);
});
