// @vitest-environment node
// The LibreOffice check check:all runs first (#85): it names the converter it used and refuses one that cannot convert.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain script, with no type declarations
import { SOFFICE, usableOffice } from '../../scripts/office-check.mjs';
import { hasOffice, soffice } from '../backend/officePrerequisites';

describe('the LibreOffice check', () => {
  it('checks the converter the tests use', () => {
    expect(SOFFICE).toBe(soffice);
  });

  it('refuses a converter that is not there, naming it', () => {
    expect(() => usableOffice('/nowhere/soffice')).toThrow(/not found: install it at \/nowhere\/soffice/);
  });

  it.skipIf(process.platform === 'win32')('refuses a converter that runs but writes no workbook', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-check-'));
    const fake = path.join(dir, 'soffice');
    fs.writeFileSync(fake, '#!/bin/sh\necho "LibreOffice 0.0"\n', { mode: 0o755 });
    expect(() => usableOffice(fake)).toThrow(/sheet Questions came back as "\(no file\)"/);
  });

  it.skipIf(!hasOffice)('passes the real converter and reports its version', () => {
    expect(usableOffice().version).toMatch(/LibreOffice/);
  });
});
