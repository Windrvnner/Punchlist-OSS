// Writing into a CSV log: only the lines written into change, in the file's own quoting, line endings and encoding.
import { describe, it, expect } from 'vitest';
import { editCsv, csvSafe } from '../../src/domain/csvEdit';
import { decodeText, encodeLike } from '../../src/domain/sheets';

const LOG = 'No.,Question,Response\r\n1,"What is the DSCR, minimum?",1.20x\r\n2,Who is the EPC contractor?,\r\n';

describe('writing into a CSV log', () => {
  it('fills a cell and adds a row, leaving every other line exactly as it was', () => {
    expect(
      editCsv(LOG, [
        { kind: 'cell', row: 2, col: 2, value: 'Fabrikam, under a "fixed" price\nsee Q1' },
        { kind: 'rows', after: 2, count: 1 },
        { kind: 'cell', row: 3, col: 0, value: 3 },
        { kind: 'cell', row: 3, col: 1, value: 'Tax equity?' },
      ]),
    ).toBe(
      'No.,Question,Response\r\n1,"What is the DSCR, minimum?",1.20x\r\n' +
        '2,Who is the EPC contractor?,"Fabrikam, under a ""fixed"" price\nsee Q1"\r\n3,Tax equity?,\r\n',
    );
  });
  it('keeps a file that quotes every field quoting, and its own line endings, and gives a last line with none one', () => {
    expect(editCsv('"No.","Question"\n"1","DSCR?"', [{ kind: 'rows', after: 1, count: 1 }, { kind: 'cell', row: 2, col: 0, value: 2 }, { kind: 'cell', row: 2, col: 1, value: 'EPC?' }])).toBe('"No.","Question"\n"1","DSCR?"\n"2","EPC?"\n');
  });
  it('will not add rows over lines that have something in them', () => {
    expect(() => editCsv(LOG, [{ kind: 'rows', after: 1, count: 1 }])).toThrow('row 3 of the file is not empty');
  });
});

describe('a text file written back in its own encoding', () => {
  for (const [name, bytes] of [
    ['UTF-8 with a mark', [0xef, 0xbb, 0xbf, 0x61, 0x2c, 0xc3, 0xa9]], ['UTF-8', [0x61, 0x2c, 0xc3, 0xa9]], ['Windows-1252', [0x61, 0x2c, 0xe9, 0x80]],
    ['UTF-16 with a mark', [0xff, 0xfe, 0x61, 0, 0x2c, 0, 0xe9, 0]], ['UTF-16 big-endian with a mark', [0xfe, 0xff, 0, 0x61, 0, 0x2c, 0, 0xe9]],
  ] as const) it(`keeps ${name}`, () => {
    const like = new Uint8Array(bytes); const text = decodeText(like);
    expect([...encodeLike(text, like)]).toEqual([...bytes]);
    expect(decodeText(encodeLike(`${text},Ü`, like))).toBe(`${text},Ü`);
  });
  it('says so when a character has no place in Windows-1252', () => {
    expect(() => encodeLike('漢', new Uint8Array([0x61, 0xe9]))).toThrow('can’t be written');
  });
});

// Edge cases
describe('a CSV log, awkwardly written', () => {
  it('keeps the quoting of the other fields of a line it writes', () => {
    expect(editCsv('No.,Question,Response\r\n"1","DSCR?",\r\n', [{ kind: 'cell', row: 1, col: 2, value: 'x' }])).toBe('No.,Question,Response\r\n"1","DSCR?",x\r\n');
  });
  it('writes text Excel would run as a formula with a space in front; a plain number stays', () => {
    expect(['-5% vs plan', '=HYPERLINK("x")', '@sum', '+ see note', '-5%', '1.20'].map(csvSafe)).toEqual([' -5% vs plan', ' =HYPERLINK("x")', ' @sum', ' + see note', '-5%', '1.20']);
  });
  it('keeps the accents of a Windows-1252 file with a UTF-8 mark in front', () => {
    const before = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('No.,Question,Response\r\n1,Caf'), 0xe9, ...new TextEncoder().encode('?,\r\n')]);
    const after = encodeLike(editCsv(decodeText(before), [{ kind: 'cell', row: 1, col: 2, value: 'Yes' }]), before);
    expect(decodeText(after)).toBe('No.,Question,Response\r\n1,Café?,Yes\r\n'); expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it('names the character a Windows-1252 file can\'t hold', () => {
    expect(() => encodeLike('a,≥1.20x', new Uint8Array([0x61, 0xe9]))).toThrow(/“≥”/);
  });
});
