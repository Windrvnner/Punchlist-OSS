// What the check line says while other PCs share a check (src/app/checking.ts). PCs are named by the person signed in
// at them, as whoami gives it ("jdoe"), with the device id only where two PCs in the check have the same person name.
import { describe, it, expect } from 'vitest';
import { checkingSays, listOf } from '../../src/app/checking';
import { SERVICE } from '../../src/control';

const sroe = { who: 'broe', pc: 'LAPTOP-7Q4M', same: false }, kroe = { who: 'kdoe', pc: 'DESKTOP-2X9P', same: false };
const jdoeA = { who: 'jdoe', pc: 'LAPTOP-1A2B', same: true }, jdoeB = { who: 'jdoe', pc: 'DESKTOP-3C4D', same: true }, nobody = { pc: 'HOME-PC', same: false };
const at = (h: number, m: number) => new Date(2026, 10, 12, h, m).toISOString();

describe('the check line while a check is shared', () => {
  it('names the other person; the device id only where two have the same name; more than one is "three others", with who on hover', () => {
    expect(checkingSays({ with: [sroe], quiet: [] })).toEqual({ text: 'Checking the checklist and findings with broe' });
    expect(checkingSays({ with: [jdoeA], quiet: [] }, true)).toEqual({ text: 'Checking the checklist and findings in depth with jdoe (LAPTOP-1A2B)' });   // jdoe on two PCs, or two jdoes
    expect(checkingSays({ with: [nobody], quiet: [] })).toEqual({ text: 'Checking the checklist and findings with HOME-PC' });                       // no person known: the device id
    expect(checkingSays({ with: [sroe, jdoeA, jdoeB], quiet: [] })).toEqual({ text: 'Checking the checklist and findings with three others', who: 'broe, jdoe (LAPTOP-1A2B) and jdoe (DESKTOP-3C4D)' });
    expect(checkingSays({ with: [sroe, kroe], quiet: [] })).toEqual({ text: 'Checking the checklist and findings with two others', who: 'broe and kdoe' });
  });
  it('a PC that stopped responding, a check waited on, and retries come first; with nobody else there is nothing to add', () => {
    expect(checkingSays({ with: [kroe], quiet: [{ ...sroe, since: at(14, 5) }] })).toEqual({ text: 'broe’s PC stopped responding at 2:05\u00a0PM. This PC is taking over its share' });
    expect(checkingSays({ with: [], quiet: [{ ...jdoeA, since: at(9, 30) }] })!.text).toBe('jdoe’s PC LAPTOP-1A2B stopped responding at 9:30\u00a0AM. This PC is taking over its share');
    expect(checkingSays({ with: [], quiet: [{ ...sroe, since: at(14, 5) }, { ...kroe, since: at(14, 6) }] })).toEqual({ text: 'Two other PCs stopped responding. This PC is taking over their share', who: 'broe and kdoe' });
    expect(checkingSays({ with: [], quiet: [], waitingFor: sroe })!.text).toBe('Waiting for broe’s check to finish');
    expect(checkingSays({ with: [], quiet: [], waitingFor: jdoeB })!.text).toBe('Waiting for jdoe’s check on DESKTOP-3C4D to finish');
    expect(checkingSays({ with: [], quiet: [], waitingFor: nobody })!.text).toBe('Waiting for the check on HOME-PC to finish');
    expect(checkingSays({ with: [sroe], quiet: [{ ...kroe, since: at(14, 5) }], retryUntil: at(14, 21) })!.text).toBe('Intelligence can’t be reached. Retrying until 2:21\u00a0PM');
    expect(checkingSays({ with: [sroe], quiet: [], away: true })!.text).toBe('Intelligence can’t be reached. The check resumes once Intelligence is back');
    // signed out: the check waits for sign-in, which is said in place of the service being out of reach
    expect(checkingSays({ with: [sroe], quiet: [], signIn: true, retryUntil: at(14, 21) })!.text).toBe(`Waiting for ${SERVICE} sign-in. The check resumes once someone signs in`);
    expect(checkingSays({ with: [], quiet: [], signIn: true, away: true })!.text).toBe(`Waiting for ${SERVICE} sign-in. The check resumes once someone signs in`);
    expect(checkingSays({ with: [], quiet: [] })).toBeNull(); expect(checkingSays(undefined)).toBeNull();
    expect(listOf(['A'])).toBe('A'); expect(listOf([])).toBe('');
  });
});
