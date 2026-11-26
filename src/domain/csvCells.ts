/**
 * The one CSV splitter: `parseCsv` and the streaming file reader both run on it. It reads text a piece at a time
 * (quotes, doubled quotes, commas, line breaks) and hands each cell over as it ends, so a caller that keeps nothing
 * holds only the cell being read. A cell's `quoted` tells the caller whether it was written in quotes.
 */
export class CsvCells {
  private field = '';
  private quoted = false;
  private wasQuoted = false;        // the cell being read has had quotes
  private pendingQuote = false;     // a quote that ended a piece: a second one after it is a doubled quote
  private cellsInRow = 0;
  // the last character outside quotes was a carriage return: a line feed after it is the same break
  private returned = false;

  constructor(
    private readonly onCell: (cell: string, quoted: boolean) => void,
    private readonly onRow: () => void = () => {},
  ) {}

  /** the next piece of the file's text */
  push(text: string): void {
    for (const c of text) this.take(c);
  }

  /** the text has ended: what is left of the last cell and row is theirs */
  end(): void {
    if (this.field || this.cellsInRow) {
      this.endCell();
      this.onRow();
    }
  }

  private take(c: string): void {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (c === '"') {
        this.field += '"';
        return;
      }
      this.quoted = false;
    }
    if (this.quoted) {
      if (c === '"') this.pendingQuote = true;
      else this.field += c;
      return;
    }
    const secondOfBreak = this.returned && c === '\n';
    this.returned = c === '\r';
    if (secondOfBreak) return;
    if (c === '"') {
      this.quoted = true;
      this.wasQuoted = true;
    } else if (c === ',') {
      this.endCell();
    } else if (c === '\n' || c === '\r') {
      this.endCell();
      this.cellsInRow = 0;
      this.onRow();
    } else {
      this.field += c;
    }
  }

  private endCell(): void {
    this.onCell(this.field.replace(/\r\n?/g, '\n'), this.wasQuoted);
    this.field = '';
    this.wasQuoted = false;
    this.cellsInRow++;
  }
}
