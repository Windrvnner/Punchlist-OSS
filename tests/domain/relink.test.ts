import { describe, it, expect } from 'vitest';
import { parse, under, rewrite, ruleFrom, candidates, profileCandidate, topsOf, key, ancestors, deeper } from '../../src/domain/relink';

describe('paths from Windows and POSIX PCs', () => {
  it('reads drives, network shares and POSIX roots, and compares Windows paths without case', () => {
    expect(parse('X:\\Deals\\2026')).toMatchObject({ root: 'X:', parts: ['Deals', '2026'], win: true });
    expect(parse('\\\\server\\deals\\2026\\Proseware')).toMatchObject({ root: '\\\\server\\deals', parts: ['2026', 'Proseware'], win: true });
    expect(parse('/srv/deals')).toMatchObject({ root: '/', parts: ['srv', 'deals'], win: false });
    expect(under('x:\\deals\\2026\\Proseware\\Legal', 'X:\\Deals\\2026')).toBe(true);
    expect(under('\\\\SERVER\\Deals\\x', '\\\\server\\deals')).toBe(true);
    expect(under('X:\\Deals2026', 'X:\\Deals')).toBe(false);
    expect(under('/srv/Deals/x', '/srv/deals')).toBe(false);                  // POSIX names keep their case
    expect(key('X:/Deals/2026/')).toBe(key('x:\\deals\\2026'));
    expect(ancestors('X:\\Deals\\2026\\K')).toEqual(['X:\\Deals\\2026', 'X:\\Deals', 'X:\\']);
  });

  it('moves a path from one start to another, between drives, shares and POSIX', () => {
    expect(rewrite('X:\\Deals\\2026\\Proseware\\Data Room\\01 Corporate', 'X:\\Deals\\2026', '\\\\server\\deals\\2026')).toBe('\\\\server\\deals\\2026\\Proseware\\Data Room\\01 Corporate');
    expect(rewrite('\\\\server\\deals\\2026\\K', '\\\\server\\deals', 'Z:\\')).toBe('Z:\\2026\\K');
    expect(rewrite('X:\\Deals\\K', 'X:\\Deals', '/mnt/nas/deals')).toBe('/mnt/nas/deals/K');
    expect(rewrite('M:\\Deals\\K', 'X:\\Deals', 'Z:\\Deals')).toBeNull();
  });

  it('learns from one located folder what the start of every path is on this PC', () => {
    expect(ruleFrom('X:\\Deals\\2026', '\\\\server\\deals\\2026')).toEqual({ from: 'X:\\Deals', to: '\\\\server\\deals' });   // a share's name is part of its root
    expect(ruleFrom('X:\\Deals\\2026\\Proseware', 'Z:\\Projects\\Deals\\2026\\Proseware')).toEqual({ from: 'X:\\', to: 'Z:\\Projects' });
    expect(ruleFrom('X:\\Deals\\Proseware', '/mnt/nas/Deals/Proseware')).toEqual({ from: 'X:\\', to: '/mnt/nas' });
    expect(ruleFrom('X:\\Deals\\Proseware', 'X:\\Deals\\Proseware')).toBeNull();      // nothing differs
    expect(ruleFrom('X:\\Deals\\Proseware', 'Z:\\Other')).toBeNull();               // nothing in common to go by
  });

  it('suggests places from the rules known here, the most particular first, and from this person’s profile', () => {
    const rules = [{ from: 'X:\\', to: '\\\\server\\deals' }, { from: 'X:\\Team', to: '\\\\nas02\\team' }];
    expect(candidates('X:\\Team\\Shared\\Coho', rules)).toEqual(['\\\\nas02\\team\\Shared\\Coho', '\\\\server\\deals\\Team\\Shared\\Coho']);
    expect(candidates('M:\\x', rules)).toEqual([]);
    expect(profileCandidate('C:\\Users\\adoe\\Firm\\Deals - Proseware\\VDR', 'C:\\Users\\jdoe')).toBe('C:\\Users\\jdoe\\Firm\\Deals - Proseware\\VDR');
    expect(profileCandidate('C:\\Users\\jdoe\\Firm\\VDR', 'C:\\Users\\jdoe')).toBeNull();
    expect(profileCandidate('X:\\Deals', 'C:\\Users\\jdoe')).toBeNull();
  });

  it('when a person picks a folder above the top folder, looks one and two names below it', () => {
    expect(deeper('X:\\Deals\\2026', '\\\\server\\deals')).toEqual(['\\\\server\\deals\\2026', '\\\\server\\deals\\Deals\\2026']);
    expect(deeper('X:\\Deals', '/mnt/nas')).toEqual(['/mnt/nas/Deals']);
  });
});

describe('the top folders a person is asked to point at', () => {
  // 12 deals, 46 folders: 11 deals under X:\Deals\2026, and another team's share holding all of Coho and one folder of First Up
  const DEALS = ['Proseware', 'Wingtip', 'Coho', 'Alpine', 'Munson', 'Margie', 'Trey', 'Yonder', 'Fourth Coffee', 'Wide World', 'City Power', 'First Up'];
  const counts = [6, 5, 3, 4, 4, 3, 5, 3, 4, 3, 3, 3];
  const missing = DEALS.flatMap((d, i) => Array.from({ length: counts[i] }, (_, k) => ({
    dealId: d, folder: d === 'Coho' || (d === 'First Up' && k === 0) ? `X:\\Team\\Shared\\Project ${d}\\0${k + 1}` : `X:\\Deals\\2026\\Project ${d}\\Data Room\\0${k + 1}`,
  })));

  it('asks for the folder the deals share, not for each of 46 folders', () => {
    expect(missing.length).toBe(46);
    const tops = topsOf(missing);
    expect(tops.map((t) => [t.top, t.folders.length, new Set(t.folders.map((f) => f.dealId)).size])).toEqual([
      ['X:\\Deals\\2026', 42, 11],
      ['X:\\Team\\Shared', 4, 2],
    ]);
  });

  it('one located top folder teaches where all 42 deal folders are, across a drive letter and a network share', () => {
    const [deals, infra] = topsOf(missing);
    const rule = ruleFrom(deals.top, '\\\\server\\deals\\2026')!;                       // X:\Deals\2026 is \\server\deals\2026 on this PC
    expect(rule).toEqual({ from: 'X:\\Deals', to: '\\\\server\\deals' });
    const moved = missing.map((f) => rewrite(f.folder, rule.from, rule.to));
    expect(moved.filter(Boolean).length).toBe(42);
    expect(moved[0]).toBe('\\\\server\\deals\\2026\\Project Proseware\\Data Room\\01');
    // the other team's share, on Z: on this PC, is located on its own and teaches its own rule
    const z = ruleFrom(infra.top, 'Z:\\Shared')!; expect(z).toEqual({ from: 'X:\\Team', to: 'Z:\\' });
    expect(infra.folders.map((f) => rewrite(f.folder, z.from, z.to))).toEqual(['Z:\\Shared\\Project Coho\\01', 'Z:\\Shared\\Project Coho\\02', 'Z:\\Shared\\Project Coho\\03', 'Z:\\Shared\\Project First Up\\01']);
  });

  it('a deal alone in its place is asked for by its own top folder; a lone folder by itself', () => {
    expect(topsOf([{ dealId: 'a', folder: 'X:\\A\\Room\\1' }, { dealId: 'a', folder: 'X:\\A\\Room\\2' }]).map((t) => t.top)).toEqual(['X:\\A\\Room']);
    expect(topsOf([{ dealId: 'a', folder: '\\\\nas\\deals\\A' }]).map((t) => t.top)).toEqual(['\\\\nas\\deals\\A']);
    // deals that share only a bare drive are asked for one by one: the drive alone is too wide
    expect(topsOf([{ dealId: 'a', folder: 'X:\\A\\1' }, { dealId: 'b', folder: 'X:\\B\\1' }]).map((t) => t.top).sort()).toEqual(['X:\\A\\1', 'X:\\B\\1']);
  });
});
