import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { insideRoot } from '../../src/backend/insideRoot';

describe('insideRoot (#1156)', () => {
  const root = path.resolve('/data/attachments');
  it('gives a place under the folder, with the folder named by a trailing slash or not', () => {
    expect(insideRoot(root, 'd1/office/a.pdf')).toBe(path.join(root, 'd1', 'office', 'a.pdf'));
    expect(insideRoot(`${root}/`, 'a.pdf')).toBe(path.join(root, 'a.pdf'));
    expect(insideRoot(root, 'd1/../d2/a.pdf')).toBe(path.join(root, 'd2', 'a.pdf'));
  });
  it('refuses a place that leaves the folder', () => {
    expect(insideRoot(root, '../outside.docx')).toBeNull();
    expect(insideRoot(root, 'd1/../../outside.docx')).toBeNull();
    expect(insideRoot(root, path.resolve('/etc/passwd'))).toBeNull();
    expect(insideRoot(root, '../attachments-evil/a.pdf')).toBeNull();
  });
  it('refuses the folder itself and an empty place', () => {
    expect(insideRoot(root, '')).toBeNull();
    expect(insideRoot(root, '.')).toBeNull();
  });
  it('gives a place in the top folder of a drive or of the disk', () => {
    const top = path.parse(root).root;
    expect(insideRoot(top, 'a.pdf')).toBe(path.join(top, 'a.pdf'));
  });
});
