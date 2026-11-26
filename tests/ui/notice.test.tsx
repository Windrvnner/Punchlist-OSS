import { expect, it } from 'vitest';
import { letterCut, shorterForms } from '../../src/ui/notice';

it('shortens a twin-named deal by its name first, then its twin line, at whole words (#27)', () => {
  expect(shorterForms('Project Northwind Capital Holdings (Fabrikam Partners Fund)')).toEqual([
    'Project Northwind Capital… (Fabrikam Partners Fund)',
    'Project Northwind… (Fabrikam Partners Fund)',
    'Project Northwind… (Fabrikam Partners…)',
    'Project Northwind… (Fabrikam…)',
  ]);
  expect(shorterForms('Quarterly board pack')).toEqual([]);      // other text is cut at a letter, as before
  expect(shorterForms('Project Coho (Wingtip)')).toEqual([]);
});

it('keeps a name\'s own brackets in the name, and leaves no comma before the "…" (#27)', () => {
  expect(shorterForms('Project X (Phase 2) (Fund IV (Lux) SCSp)')).toEqual([
    'Project X (Phase… (Fund IV (Lux) SCSp)',
    'Project X… (Fund IV (Lux) SCSp)',
    'Project X… (Fund IV (Lux)…)',
    'Project X… (Fund IV…)',
    'Project X… (Fund…)',
  ]);
  expect(shorterForms('Project Kestrel (Contoso, Nov 23, 2026)')).toEqual([
    'Project Kestrel (Contoso, Nov 23…)',
    'Project Kestrel (Contoso, Nov…)',
    'Project Kestrel (Contoso…)',
  ]);
});

it('cuts a twin-named deal at a letter of its name only, keeping the twin line\'s first word (#27)', () => {
  expect(letterCut('Project Northwind Capital (Fabrikam Partners)'))
    .toEqual({ head: 'Project Northwind Capital', tail: ' (Fabrikam…)' });
  expect(letterCut('Project Kestrel (Wingtip)')).toEqual({ head: 'Project Kestrel', tail: ' (Wingtip)' });
  expect(letterCut('Quarterly board pack')).toEqual({ head: 'Quarterly board pack', tail: '' });
});
