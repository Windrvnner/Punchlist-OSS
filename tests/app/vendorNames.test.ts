// @vitest-environment node
// The scan for vendor names, which the allowance checks across src (tests/app/vendorModelNames.test.ts). The service
// name and the AI label come from the control file (names.service, names.aiContent), never written in
// (docs/review-prompt.md, Privacy).
import { describe, expect, it } from 'vitest';
import { screenVendorMatches, vendorMatchesIn } from './vendorNamesKit';
// @ts-expect-error the script is plain JavaScript
import { allowanceProblems, groupMatches } from '../../scripts/allowance.mjs';

describe('the vendor name scan', () => {
  it('finds a vendor or the default service name in a string or JSX text, and not in a comment', () => {
    const service = 'Intel' + 'ligence';
    const vendor = 'Cla' + 'ude';
    const source = [
      `// ${vendor} is named in a comment only`,
      `export const empty = <p>${vendor} found nothing</p>;`,
      `export const title = 'Sign in to ${service}';`,
      `export const wait = \`Waiting for ${service}…\`;`,
      "export const plain = 'Northwest office';",
      `export const tip = <button title="Ask ${vendor.toUpperCase()}" />;`,
    ].join('\n');
    expect(vendorMatchesIn('src/ui/x.tsx', source).map((match) => match.number)).toEqual([2, 3, 4, 6]);
  });

  it('refuses a vendor name written in src/ui and does not scan src/backend', () => {
    const source = `export const label = '${'Cla' + 'ude'} Haiku';`;
    const files = ['src/ui/x.tsx', 'src/backend/x.ts'];
    const found = groupMatches(screenVendorMatches(files, () => source));
    expect(found).toEqual([{ file: 'src/ui/x.tsx', kind: 'vendor', line: source, count: 2, lines: [1, 1] }]);
    const problems: string[] = allowanceProblems(found, [], { decisions: [], verified: [] });
    expect(problems).toEqual([expect.stringContaining('2 not listed')]);
  });

  it('records each occurrence at its own line, deep in a multi-line template too', () => {
    const vendor = 'Cla' + 'ude';
    const source = ['export const text = `', 'plain', `ask ${vendor} or ${vendor}`, `and ${vendor}`, '`;'].join('\n');
    const matches = vendorMatchesIn('src/app/x.ts', source);
    expect(matches.map((match) => [match.number, match.line])).toEqual([
      [3, `ask ${vendor} or ${vendor}`], [3, `ask ${vendor} or ${vendor}`], [4, `and ${vendor}`],
    ]);
  });

  it('fails on a source that does not parse, rather than reading none of it', () => {
    expect(() => vendorMatchesIn('src/app/x.ts', 'export const = ;')).toThrow(/x\.ts/);
  });
});
