// @vitest-environment node
import { expect, it } from 'vitest';
import { control } from '../../src/control';
import type { AiDocs } from '../../src/backend/ai';
import type { DocRecord } from '../../src/backend/documents';
import { ask, doc, setup, val, type Call } from './reviewKit';

function readPermits(records: DocRecord[], wanted: AiDocs['wanted'], helperReply = '') {
  const turns: Call[] = [];
  const batches: Call[] = [];
  const compactAt = 40_000;
  const s = setup((call) => {
    if (call.system?.includes('You work in turns')) {
      turns.push(call);
      return turns.length === 1 ? { tool: 'folder', folder: 'Permits', lookFor: 'permit expiry' }
        : { text: 'The folder read is complete for the files available.', sources: [] };
    }
    if (call.prompt.includes('which is being read a batch at a time')) batches.push(call);
    return helperReply;
  }, { d1: records }, { wanted, compactAt, folderDocs: records.length, width: 8, library: [] });
  s.svc.tokensPerChar = 0;
  return { ...s, turns, batches, room: compactAt * control.limits.charsPerToken / 2 };
}

it('keeps the unavailable-file list within the existing room for a 2,000-document folder', async () => {
  const sites = [
    'Alder Ridge', 'Beacon Fell', 'Brookmere', 'Cedar Bluff', 'Clifton Heath', 'Dunwich Moor', 'Elmgate',
    'Fairhaven', 'Gannet Bay', 'Hawthorn Point', 'Ivy Downs', 'Juniper Hill', 'Kestrel Vale', 'Longwater',
    'Maple Ford', 'Northfield', 'Oakmere', 'Pine Rigg', 'Quarry Bank', 'Redcliff',
  ];
  const facilities = ['Battery Yard', 'Substation', 'Access Road', 'Transmission Spur', 'Water Treatment',
    'Control Building', 'Switchyard', 'Laydown Area', 'Operations Center', 'Grid Connection'];
  const kinds = ['Flood Risk Review', 'Stormwater Approval', 'Environmental Statement', 'Construction Consent',
    'Grid Access Permit', 'Habitat Assessment', 'Building Certificate', 'Archaeology Opinion',
    'Public Consultation Record', 'Planning Determination'];
  const folder = 'Permits/Planning Authorisations/Validated Environmental Assessments/Local Planning Rulings';
  const names = sites.flatMap((site) => facilities.flatMap((facility) => kinds.map((kind) =>
    `${site} ${facility} - ${kind}.pdf`,
  )));
  const records = names.map((name, index) => doc(index + 1, name, { rel: `${folder}/${name}` }));
  const s = readPermits(records, async () => []);
  try {
    const result = val(await s.ai.answer(ask('Anything to add?')));
    expect(result.research?.read).toEqual({ docs: 0, of: 2000 });
    expect(s.batches).toHaveLength(0);
    const report = s.turns[1].prompt.split('\n\nThis is turn')[0];
    expect(report.length).toBeLessThanOrEqual(s.room);
    expect(report).toMatch(/\d+ more unavailable files/);
    expect(report).toContain('documents 1993–2000');
  } finally {
    await s.ai.close();
  }
});

it('keeps the unavailable pair visible if the folder helper fails to read another file', async () => {
  const clean = doc(1, 'Credit Agreement.pdf', { rel: 'Permits/Credit Agreement.pdf' });
  const blackline = doc(2, 'Credit Agreement (blackline).pdf', { rel: 'Permits/Credit Agreement (blackline).pdf' });
  const other = doc(3, 'Environmental Permit.pdf', { rel: 'Permits/Environmental Permit.pdf' });
  const s = readPermits([clean, blackline, other], async (_, ids) => ids.includes(other.docId)
    ? [{ docId: other.docId, name: other.name, read: () => new TextEncoder().encode(other.name) }]
    : [], 'unparseable helper reply');
  try {
    const result = val(await s.ai.answer(ask('Anything to add?')));
    expect(s.batches.length).toBeGreaterThan(0);
    expect(s.batches.every(({ files }) => files.length === 1)).toBe(true);
    expect(s.turns[1].prompt).toContain('the reply on them could not be read');
    expect(s.turns[1].prompt).toContain(`- ${clean.docId} (vdr/Permits/${clean.name})`);
    expect(s.turns[1].prompt).toContain(`- ${blackline.docId} (vdr/Permits/${blackline.name})`);
    expect(result.research?.read).toEqual({ docs: 0, of: 3 });
  } finally {
    await s.ai.close();
  }
});
