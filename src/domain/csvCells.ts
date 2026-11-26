/**
 * The cells of a CSV read a piece at a time, so that a file of any size is never held whole. It splits cells as
 * `parseCsv` does (quotes, doubled quotes, commas, line breaks) and hands each cell over as it ends; it keeps only the
 * cell being read.
 */
export class CsvCells {
  private field = '';
  private quoted = false;
  private pendingQuote = false;     // a quote that ended a piece: a second one after it is a doubled quote
  private open = false;             // a cell has begun (so the end of the file closes it)
  // the last character outside quotes was a carriage return: a line feed after it is the same break
  private returned = false;

  constructor(private readonly onCell: (cell: string) => void) {}

  /** the next piece of the file's text */
  push(text: string): void {
    for (const c of text) this.take(c);
  }

  /** the file has ended: the cell being read is the last */
  end(): void {
    if (this.open) this.close();
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
    this.open = true;
    if (c === '"') this.quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') this.close(c === ',');
    else this.field += c;
  }

  private close(more = false): void {
    this.onCell(this.field.replace(/\r\n?/g, '\n'));
    this.field = '';
    this.quoted = false;
    this.open = more;
  }
}
