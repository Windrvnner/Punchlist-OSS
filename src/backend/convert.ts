/**
 * Turning a page-shaped file into a PDF, and counting a PDF's pages.
 *
 * A converter is a function from a file to a PDF in a given folder; it throws when the file will not convert
 * (password-protected, corrupt, or a type it does not know). LibreOffice, shipped inside the app, is the only one.
 * A converter's id is recorded with a document's pages: a PC whose converter differs (another LibreOffice version)
 * does not show or send those pages, since they could break in different places.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parseCsv, type Sheet, type SheetEdit } from '../domain/sheets';

/** `id` names the converter and its setting. It is recorded with a document's page count, so that a PC with a different one does not show pages that may break elsewhere. */
/** one sheet of a spreadsheet, exported as a CSV file (UTF-8, dates as YYYY-MM-DD) */
export interface SheetFile { name: string; path: string }
export type Converter = ((
  file: string,
  outDir: string,
  outName: string,
  info?: { tracked?: number },
  /** the document's own name, when the file is kept under another (an attached file): what a file-name field prints */
  shownAs?: string,
) => Promise<string>) & {
  id: string;
  /**
   * every sheet of a spreadsheet as text, in order; `asShown` gives values as the file shows them (1,234.50) rather
   * than plain (1234.5; dates always month first); `formulas` gives a formula cell's formula ("=LEN(B2)") in place of
   * its value
   */
  sheets?: (file: string, asShown?: boolean, formulas?: boolean) => Promise<Sheet[]>;
  /** the same sheets as CSV files on disk, in order, while `visit` runs: read a piece at a time, never whole */
  sheetFiles?: <T>(file: string, visit: (sheets: SheetFile[]) => Promise<T>) => Promise<T>;
  /** an .xlsx made from an OpenDocument spreadsheet in one file (domain/sheets exportDocument) */
  workbook?: (fods: string) => Promise<Uint8Array>;
  /** a Word file and a PDF made from an OpenDocument text in one file (the deal memo, domain/memoDoc) */
  document?: (fodt: string) => Promise<{ docx: Uint8Array; pdf: Uint8Array }>;
  /**
   * writes values into a copy of a spreadsheet, keeping everything else in it, and returns the copy's bytes (see
   * `SheetEdit` in domain/sheets)
   */
  edit?: (file: string, sheet: string, steps: SheetEdit[]) => Promise<Uint8Array>;
  /** a word-processing file's text (.docx, .doc, .odt, .rtf), one paragraph or list entry a line, numbering as shown */
  text?: (file: string) => Promise<string>;
  /** the tracked changes and comments in a file, for a converter that can list them */
  changes?: (file: string) => Promise<{
    passages: {
      before: string;
      after: string;
      changes: { kind: 'insert' | 'delete' | 'format' | 'comment'; by: string; at: string; text: string }[];
    }[];
    tracked: number;
    complete: boolean;
  }>;
};



/** run a program and wait; when it overruns, it and everything it started are stopped */
function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    const stop = setTimeout(() => {
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ }
      failed(new Error('it took too long'));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(stop); failed(e); });
    child.on('exit', (code) => { clearTimeout(stop); if (code === 0) done(); else failed(new Error(`exit ${code}`)); });
  });
}

/** a file's extension in lower case, for a copy made under a short name; '' when it has none a file could have (".v12 final", ".verylongext") */
export const shortExt = (file: string): string => { const ext = path.extname(`x${path.basename(file.trim())}`).toLowerCase(); return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''; };   // "x": a name that is only an extension (".csv") keeps it

/** A file whose name says Word or PowerPoint but whose first bytes say otherwise is not handed to a converter, which might print it as text. */
function looksRight(file: string): boolean {
  const ext = path.extname(file).toLowerCase(); const head = Buffer.alloc(8); let n = 0;
  try { const fd = fs.openSync(file, 'r'); try { n = fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); } } catch { return false; }
  const starts = (...bytes: number[]) => n >= bytes.length && bytes.every((b, i) => head[i] === b);
  if (['.docx', '.docm', '.dotx', '.pptx', '.ppsx', '.pptm', '.odt', '.odp'].includes(ext)) return starts(0x50, 0x4b, 0x03, 0x04);
  if (['.doc', '.dot', '.ppt', '.pps'].includes(ext)) return starts(0xd0, 0xcf, 0x11, 0xe0);
  if (ext === '.rtf') return starts(0x7b, 0x5c, 0x72, 0x74, 0x66);
  return true;
}

/**
 * The lines of LibreOffice's own macro language that do the work. A run reads its job from a small file beside the macro:
 * the file to open, where to put the PDF (or "-" for none), whether to keep markup, where to write the list of
 * tracked changes (or "-" for none), and the document's own name, which its file-name fields are set to (`NameFields`). It opens the file out of sight; writes the list if asked; accepts every tracked
 * change (LibreOffice's own "accept all": deletions go, insertions stay, moved text is where it was moved to, deleted
 * table rows and paragraph breaks go) unless markup was asked for; writes the PDF; and reports "ok", how many tracked
 * changes are left, and how many there were, in a second small file.
 *
 * The list is one line per thing, fields separated by tabs: "N" and the number of tracked changes; "C", kind, author, time
 * and words for each change or comment; and after the changes of a paragraph, "P" with the paragraph as it was and as it is.
 */
const BASIC = String.raw`
Dim gType As String, gBy As String, gAt As String, gText As String

Sub Run
  On Error GoTo Failed
  Dim ps As Object, sfa As Object, tin As Object, doc As Object, d As Object
  Dim userUrl As String, src As String, out As String, markup As String, list As String, shown As String, note As String, filter As String, had As Long
  ps = createUnoService("com.sun.star.util.PathSubstitution")
  userUrl = ps.getSubstituteVariableValue("$(user)")
  sfa = createUnoService("com.sun.star.ucb.SimpleFileAccess")
  tin = createUnoService("com.sun.star.io.TextInputStream")
  tin.setInputStream(sfa.openFileRead(userUrl & "/punchlist-job.txt"))
  tin.setEncoding("UTF-8")
  src = tin.readLine() : out = tin.readLine() : markup = tin.readLine() : list = tin.readLine() : shown = tin.readLine()
  tin.closeInput()
  Dim a(0) As New com.sun.star.beans.PropertyValue
  a(0).Name = "Hidden" : a(0).Value = True
  doc = StarDesktop.loadComponentFromURL(src, "_blank", 0, a())
  filter = "writer_pdf_Export"
  If doc.supportsService("com.sun.star.presentation.PresentationDocument") Then filter = "impress_pdf_Export"
  If doc.supportsService("com.sun.star.sheet.SpreadsheetDocument") Then filter = "calc_pdf_Export"
  If doc.supportsService("com.sun.star.drawing.DrawingDocument") Then filter = "draw_pdf_Export"
  note = "ok"
  If doc.supportsService("com.sun.star.text.TextDocument") Then
    had = doc.Redlines.Count
    If Left(list, 1) <> "-" Then ListChanges doc, sfa, list
    If Left(out, 1) <> "-" Then NameFields doc, shown
    If Left(out, 1) <> "-" And Left(markup, 1) <> "1" Then
      d = createUnoService("com.sun.star.frame.DispatchHelper")
      d.executeDispatch(doc.CurrentController.Frame, ".uno:AcceptAllTrackedChanges", "", 0, Array())
    End If
    note = "ok " & doc.Redlines.Count & " " & had
  End If
  If Left(out, 1) <> "-" And (filter = "impress_pdf_Export" Or filter = "draw_pdf_Export") Then
    NameShapes doc.DrawPages, shown
    NameShapes doc.MasterPages, shown
  End If
  If Left(out, 1) <> "-" Then
    Dim f(0) As New com.sun.star.beans.PropertyValue
    f(0).Name = "FilterName" : f(0).Value = filter
    doc.storeToURL(out, f())
  End If
  doc.close(True)
  Done note, userUrl, sfa
  Exit Sub
Failed:
  Done "failed: " & Error$, userUrl, sfa
End Sub

' A field that prints the file's name would print the copy's: each is set to the document's own name, without its
' extension where the field leaves that out. One that prints the folder as well, or alone, prints the name, or nothing:
' the folder would be a place on this PC. A field its author had already fixed to some words is left as it is.
Function NameFor(f As Object, shown As String) As String
  Dim i As Long
  NameFor = shown
  If f.FileFormat = 1 Then NameFor = ""
  If f.FileFormat = 2 Then
    For i = Len(shown) To 2 Step -1
      If Mid(shown, i, 1) = "." Then
        NameFor = Left(shown, i - 1)
        Exit For
      End If
    Next i
  End If
End Function

Sub NameFields(doc As Object, shown As String)
  Dim e As Object, f As Object
  doc.RecordChanges = False
  e = doc.getTextFields().createEnumeration()
  Do While e.hasMoreElements()
    f = e.nextElement()
    If f.supportsService("com.sun.star.text.TextField.FileName") Then
      If Not f.IsFixed Then
        f.IsFixed = True
        f.CurrentPresentation = NameFor(f, shown)
      End If
    End If
  Loop
End Sub

' the same for a presentation or drawing, where fields sit in the text of each shape, on slides and on their masters;
' there a field cannot be set, so the words take its place
Sub NameShapes(pages As Object, shown As String)
  On Error Resume Next
  Dim i As Long, j As Long, sh As Object, pe As Object, te As Object, t As Object
  For i = 0 To pages.Count - 1
    For j = 0 To pages.getByIndex(i).Count - 1
      sh = pages.getByIndex(i).getByIndex(j)
      If sh.supportsService("com.sun.star.drawing.Text") Then
        pe = sh.createEnumeration()
        Do While pe.hasMoreElements()
          te = pe.nextElement().createEnumeration()
          Do While te.hasMoreElements()
            t = te.nextElement()
            If t.TextPortionType = "TextField" Then
              If t.TextField.supportsService("com.sun.star.text.textfield.FileName") Then
                If Not t.TextField.IsFixed Then t.String = NameFor(t.TextField, shown)
              End If
            End If
          Loop
        Loop
      End If
    Next j
  Next i
End Sub

Sub Done(note As String, userUrl As String, sfa As Object)
  On Error Resume Next
  Dim t As Object
  t = createUnoService("com.sun.star.io.TextOutputStream")
  t.setOutputStream(sfa.openFileWrite(userUrl & "/punchlist-done.txt"))
  t.writeString(note) : t.closeOutput()
  StarDesktop.terminate()
End Sub

Sub ListChanges(doc As Object, sfa As Object, url As String)
  Dim t As Object, styles As Object, st As Object, i As Long
  If sfa.exists(url) Then sfa.kill(url)
  t = createUnoService("com.sun.star.io.TextOutputStream")
  t.setOutputStream(sfa.openFileWrite(url))
  t.setEncoding("UTF-8")
  gType = ""
  t.writeString("N" & Chr(9) & doc.Redlines.Count & Chr(10))
  WalkText doc.Text, t
  For i = 0 To doc.Footnotes.Count - 1
    WalkText doc.Footnotes.getByIndex(i), t
  Next i
  For i = 0 To doc.Endnotes.Count - 1
    WalkText doc.Endnotes.getByIndex(i), t
  Next i
  styles = doc.StyleFamilies.getByName("PageStyles")
  For i = 0 To styles.Count - 1
    st = styles.getByIndex(i)
    If st.HeaderIsOn Then WalkText st.HeaderText, t
    If st.FooterIsOn Then WalkText st.FooterText, t
  Next i
  t.closeOutput()
End Sub

Function Flat(s As String) As String
  Dim r As String
  r = Join(Split(s, Chr(9)), " ")
  r = Join(Split(r, Chr(13)), " ")
  Flat = Join(Split(r, Chr(10)), " ")
End Function

Function Stamp(d As Object) As String
  Stamp = Format(d.Year, "0000") & "-" & Format(d.Month, "00") & "-" & Format(d.Day, "00") & "T" & Format(d.Hours, "00") & ":" & Format(d.Minutes, "00") & ":" & Format(d.Seconds, "00")
End Function

Sub WalkText(x As Object, t As Object)
  Dim e As Object, p As Object, names As Variant, i As Long
  e = x.createEnumeration()
  Do While e.hasMoreElements()
    p = e.nextElement()
    If p.supportsService("com.sun.star.text.TextTable") Then
      names = p.getCellNames()
      For i = LBound(names) To UBound(names)
        WalkText p.getCellByName(names(i)), t
      Next i
    ElseIf p.supportsService("com.sun.star.text.Paragraph") Then
      WalkPara p, t
    End If
  Loop
End Sub

Sub WalkPara(p As Object, t As Object)
  Dim e As Object, r As Object, kind As String, was As String, now As String, s As String, touched As Boolean, f As Object
  touched = (gType <> "")
  e = p.createEnumeration()
  Do While e.hasMoreElements()
    r = e.nextElement()
    kind = r.TextPortionType
    If kind = "Redline" Then
      touched = True
      If r.IsStart Then
        gType = r.RedlineType : gBy = r.RedlineAuthor : gAt = Stamp(r.RedlineDateTime) : gText = ""
      Else
        t.writeString("C" & Chr(9) & gType & Chr(9) & Flat(gBy) & Chr(9) & gAt & Chr(9) & Flat(gText) & Chr(10))
        gType = ""
      End If
    ElseIf kind = "Text" Then
      s = r.getString()
      If gType = "Delete" Then
        was = was & s : gText = gText & s
      ElseIf gType = "Insert" Then
        now = now & s : gText = gText & s
      Else
        was = was & s : now = now & s
        If gType <> "" Then gText = gText & s
      End If
    ElseIf kind = "Annotation" Then
      f = r.TextField
      touched = True
      t.writeString("C" & Chr(9) & "Comment" & Chr(9) & Flat(f.Author) & Chr(9) & Stamp(f.DateTimeValue) & Chr(9) & Flat(f.Content) & Chr(10))
    End If
  Loop
  If touched Then t.writeString("P" & Chr(9) & Flat(was) & Chr(9) & Flat(now) & Chr(10))
End Sub
' Writes values into a spreadsheet and saves it in its own format, so everything else in it (sheets, styles, colors,
' widths, merged cells, rules) stays as it was. The job file: the file's URL, the sheet's name, then one line per step:
'   R <after> <count>   insert <count> rows below sheet row index <after>, each formatted like that row
'   S <row> <col> <text> / N <row> <col> <number>   set a cell (indexes from 0); text has \\, \n and \t escaped
Sub Edit
  On Error GoTo Failed
  Dim ps As Object, sfa As Object, tin As Object, doc As Object, sh As Object, userUrl As String, src As String, line As String, f As Variant, i As Long
  ps = createUnoService("com.sun.star.util.PathSubstitution")
  userUrl = ps.getSubstituteVariableValue("$(user)")
  sfa = createUnoService("com.sun.star.ucb.SimpleFileAccess")
  tin = createUnoService("com.sun.star.io.TextInputStream")
  tin.setInputStream(sfa.openFileRead(userUrl & "/punchlist-edit.txt"))
  tin.setEncoding("UTF-8")
  src = tin.readLine()
  Dim a(0) As New com.sun.star.beans.PropertyValue
  a(0).Name = "Hidden" : a(0).Value = True
  doc = StarDesktop.loadComponentFromURL(src, "_blank", 0, a())
  sh = doc.Sheets.getByName(Unescape(tin.readLine()))
  Do While Not tin.isEOF()
    line = tin.readLine()
    Do While Len(line) > 0 And (Right(line, 1) = Chr(10) Or Right(line, 1) = Chr(13))
      line = Left(line, Len(line) - 1)
    Loop
    f = Split(line, Chr(9))
    If IsFormulaEdit(sh, f) Then
      tin.closeInput()
      doc.setModified(False)
      doc.close(True)
      Done "failed: cell holds a formula", userUrl, sfa
      Exit Sub
    End If
    If f(0) = "R" Then
      sh.Rows.insertByIndex(CLng(f(1)) + 1, CLng(f(2)))
      For i = 1 To CLng(f(2))
        sh.copyRange(sh.getCellByPosition(0, CLng(f(1)) + i).CellAddress, sh.getCellRangeByPosition(0, CLng(f(1)), sh.Columns.Count - 1, CLng(f(1))).RangeAddress)
        sh.getCellRangeByPosition(0, CLng(f(1)) + i, sh.Columns.Count - 1, CLng(f(1)) + i).clearContents(com.sun.star.sheet.CellFlags.VALUE + com.sun.star.sheet.CellFlags.DATETIME + com.sun.star.sheet.CellFlags.STRING + com.sun.star.sheet.CellFlags.FORMULA + com.sun.star.sheet.CellFlags.ANNOTATION)
      Next i
    ElseIf f(0) = "S" Then
      sh.getCellByPosition(CLng(f(2)), CLng(f(1))).setString(Unescape(f(3)))
    ElseIf f(0) = "N" Then
      sh.getCellByPosition(CLng(f(2)), CLng(f(1))).setValue(Val(f(3)))
    End If
  Loop
  tin.closeInput()
  doc.store()
  doc.close(True)
  Done "ok", userUrl, sfa
  Exit Sub
Failed:
  Done "failed: " & Error$, userUrl, sfa
End Sub

' A formula belongs to the team, regardless of the workbook format.
Function IsFormulaEdit(sh As Object, f As Variant) As Boolean
  IsFormulaEdit = False
  If f(0) <> "S" And f(0) <> "N" Then Exit Function
  IsFormulaEdit = sh.getCellByPosition(CLng(f(2)), CLng(f(1))).Type = com.sun.star.table.CellContentType.FORMULA
End Function

Function Unescape(s As String) As String
  Dim r As String, i As Long, c As String
  i = 1
  Do While i <= Len(s)
    c = Mid(s, i, 1)
    If c = "\" And i < Len(s) Then
      i = i + 1 : c = Mid(s, i, 1)
      If c = "n" Then
        r = r & Chr(10)
      ElseIf c = "t" Then
        r = r & Chr(9)
      Else
        r = r & c
      End If
    Else
      r = r & c
    End If
    i = i + 1
  Loop
  Unescape = r
End Function
`;
const MACRO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Punchlist" script:language="StarBasic">${BASIC.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</script:module>
`;

/** One tracked change or comment: what kind, who made it, when (as the file records it, with no time zone), and the words concerned. */
export interface TrackedChange { kind: 'insert' | 'delete' | 'format' | 'comment'; by: string; at: string; text: string }
/** A paragraph (or table cell) with changes in it: as it was, as it reads with them accepted, and the changes in order. */
export interface ChangedPassage { before: string; after: string; changes: TrackedChange[] }
/** `tracked` is how many tracked changes the file has. `complete` is false when some of them are in a part of the file the list does not reach. */
export interface ChangeList { passages: ChangedPassage[]; tracked: number; complete: boolean }

/** Reads the list the macro wrote. A change that runs from one paragraph into the next (a paragraph break deleted or added) joins the two into one passage. */
export function readChangeList(text: string): ChangeList {
  const passages: ChangedPassage[] = []; let tracked = 0; let listed = 0; let pending: TrackedChange[] = []; let open: { before: string; after: string } | null = null;
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'N') tracked = Number(f[1]) || 0;
    else if (f[0] === 'C') { const kind = f[1] === 'Insert' ? 'insert' : f[1] === 'Delete' ? 'delete' : f[1] === 'Comment' ? 'comment' : 'format'; if (kind !== 'comment') listed++; pending.push({ kind, by: f[2] ?? '', at: f[3] ?? '', text: f[4] ?? '' }); }
    else if (f[0] === 'P') {
      let before = f[1] ?? '', after = f[2] ?? '';
      if (open) { const first = pending[0]?.kind; before = open.before + (first === 'insert' ? '' : '\n') + before; after = open.after + (first === 'delete' ? '' : '\n') + after; open = null; }
      if (!pending.length) { open = { before, after }; continue; }                 // its change is still open: it ends in the next paragraph
      passages.push({ before, after, changes: pending }); pending = [];
    }
  }
  return { passages, tracked, complete: listed === tracked };
}
const escaped = (v: string) => v.replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/\t/g, '\\t');
/** the edit job the macro reads: the file, the sheet, then a line per step */
export const editJob = (url: string, sheet: string, steps: SheetEdit[]) => [url, escaped(sheet), ...steps.map((x) => x.kind === 'rows' ? `R\t${x.after}\t${x.count}` : typeof x.value === 'number' ? `N\t${x.row}\t${x.col}\t${x.value}` : `S\t${x.row}\t${x.col}\t${escaped(x.value)}`), ''].join('\n');
/** set by a converter when it is given one: how many tracked changes the file had */
export interface ConvertInfo { tracked?: number }

/**
 * A settings folder for one run of LibreOffice that no other run is using, so two runs at once (another converter, or
 * another copy of the app on the same folder) never read each other's job or overwrite each other's settings. It is the
 * first free one of `profile`, `profile-2`, `profile-3` and so on, held by a lock file beside it that names this process
 * until `free`. A lock whose process is gone (the app was stopped mid-run) is taken over. Folders are kept for next time,
 * since LibreOffice takes a few seconds to set one up.
 */
export function holdFolder(profile: string): { folder: string; free: () => void } {
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  for (let n = 1; ; n++) {
    const folder = n === 1 ? profile : `${profile}-${n}`; const lock = `${folder}.lock`;
    const take = () => { try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; } };  // creating the file is the one step two runs cannot both win; a folder that cannot be written is an error, not a reason to try the next
    let got = take();
    if (!got) {
      let pid = 0; try { pid = Number(fs.readFileSync(lock, 'utf8')); } catch { /* freed meanwhile, or not yet written */ }
      let alive = true; if (pid > 0) { try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; } }
      if (pid > 0 && !alive) { fs.rmSync(lock, { force: true }); got = take(); }
    }
    if (got) return { folder, free: () => fs.rmSync(lock, { force: true }) };
  }
}

/**
 * LibreOffice, run without a window and with settings of its own, so it is apart from any Office or LibreOffice the
 * person has open. One conversion at a time, and no two runs at once share a settings folder (see `holdFolder`).
 *
 * Tracked changes: left to itself LibreOffice prints them into the PDF, deleted words included. So unless `markup` is
 * asked for, every change is accepted first, by LibreOffice itself, and the PDF is the document as it then reads. A
 * conversion that leaves any tracked change behind is thrown away rather than passed off as clean. Comments are not
 * printed either way.
 */
export function libreOfficeConverter(o: { soffice?: string; timeoutMs?: number; markup?: boolean; profile?: string } = {}): Converter {
  const soffice = o.soffice ?? 'soffice'; const timeoutMs = o.timeoutMs ?? 120_000;
  const profile = o.profile ?? path.join(os.tmpdir(), 'punchlist-libreoffice');
  let folder = profile;                                                                               // the settings folder this run holds, set by `one`
  const start = (...args: string[]) => run(soffice, [`-env:UserInstallation=${pathToFileURL(folder).href}`, '--headless', '--norestore', '--nologo', ...args], timeoutMs);
  let user = ''; let lib = '';
  /** the macro is in place, in the settings folder LibreOffice made for itself */
  async function ready() {
    const list = path.join(lib, 'script.xlb');
    if (!fs.existsSync(list)) await start('--terminate_after_init').catch(() => undefined);       // first use: LibreOffice makes its settings folder
    if (!fs.existsSync(list)) throw new Error('LibreOffice did not start');
    if (!fs.existsSync(path.join(lib, 'Punchlist.xba')) || fs.readFileSync(path.join(lib, 'Punchlist.xba'), 'utf8') !== MACRO) fs.writeFileSync(path.join(lib, 'Punchlist.xba'), MACRO);
    const xlb = fs.readFileSync(list, 'utf8');
    if (!xlb.includes('library:name="Punchlist"')) fs.writeFileSync(list, xlb.replace('</library:library>', ' <library:element library:name="Punchlist"/>\n</library:library>'));
  }
  /** removes the copies of documents left in a settings folder's `user`; one that cannot be removed is left for next time */
  const sweep = (dir: string) => { let all: string[] = []; try { all = fs.readdirSync(dir); } catch { /* not made yet */ } for (const f of all) if (f.startsWith('punchlist-in')) { try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch { /* still held */ } } };
  /** once per session: the settings folders with no lock beside them (`profile`, `profile-2`, …) are cleared of copies too; one whose lock a stopped app left is cleared when a run next takes it */
  let swept = false;
  const sweepAll = () => {
    if (swept) return; swept = true; let all: string[] = []; try { all = fs.readdirSync(path.dirname(profile)); } catch { return; }
    const base = path.basename(profile);
    for (const f of all) if ((f === base || (f.startsWith(`${base}-`) && /^\d+$/.test(f.slice(base.length + 1)))) && !fs.existsSync(path.join(path.dirname(profile), `${f}.lock`))) sweep(path.join(path.dirname(profile), f, 'user'));
  };
  let queue: Promise<unknown> = Promise.resolve();
  /** runs one piece of work after the last, in a settings folder no other run is using */
  const one = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      sweepAll(); const held = holdFolder(profile); folder = held.folder; user = path.join(folder, 'user'); lib = path.join(user, 'basic', 'Standard');
      try { return await work(); } finally { held.free(); }
    });
    queue = next.catch(() => undefined); return next;
  };
  /** one run of the macro; returns how many tracked changes were left and how many there had been (both undefined for a file that is not text) */
  // LibreOffice is never given the file where it is: names from comparison tools can run past what Windows lets older
  // programs open (260 characters for the whole path), so it opens a copy under a short name in its own settings folder
  async function job(file: string, out: string | null, list: string | null, shownAs = path.basename(file)): Promise<{ left?: number; had?: number }> {
    if (!looksRight(file)) throw new Error('the file is not what its name says');
    await ready();
    const done = path.join(user, 'punchlist-done.txt'); fs.rmSync(done, { force: true });
    sweep(user);                                                                                    // a copy that a run that was stopped left behind
    // the first free name: a leftover that could not be removed (still held) does not stop this run
    let copy = ''; for (let n = 1; !copy || fs.existsSync(copy); n++) copy = path.join(user, `punchlist-in${n > 1 ? `-${n}` : ''}${shortExt(file)}`);
    try {
      fs.copyFileSync(file, copy);
      fs.writeFileSync(path.join(user, 'punchlist-job.txt'), [pathToFileURL(copy).href, out ? pathToFileURL(out).href : '-', o.markup ? '1' : '0', list ? pathToFileURL(list).href : '-', shownAs.replace(/[\u0000-\u001f\u007f]+/g, ' '), 'end', ''].join('\n'));
      await start('macro:///Standard.Punchlist.Run');
    } finally { try { fs.rmSync(copy, { force: true }); } catch { /* still held by a LibreOffice being stopped: cleared at the next run */ } }
    const note = fs.existsSync(done) ? fs.readFileSync(done, 'utf8').trim() : 'failed: nothing was reported';
    if (!note.startsWith('ok')) throw new Error(note.replace(/^failed: /, '') || 'it did not finish');
    const [, left, had] = note.split(' '); return left === undefined ? {} : { left: Number(left), had: Number(had) };
  }
  const convert = (file: string, outDir: string, outName: string, info?: ConvertInfo, shownAs?: string) => one(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, outName); const part = `${out}.part`; fs.rmSync(part, { force: true });
    try {
      const r = await job(file, part, null, shownAs);
      if (!fs.existsSync(part)) throw new Error('no PDF was produced');
      if (!o.markup && r.left !== undefined && r.left !== 0) throw new Error('tracked changes were left in the document');
      if (info && r.had !== undefined) info.tracked = r.had;
      fs.renameSync(part, out); return out;
    } finally { fs.rmSync(part, { force: true }); }
  });
  const changes = (file: string) => one(async (): Promise<ChangeList> => {
    const list = path.join(user, 'punchlist-changes.txt'); fs.rmSync(list, { force: true });
    try { const r = await job(file, null, list); return r.had === undefined || !fs.existsSync(list) ? { passages: [], tracked: 0, complete: true } : readChangeList(fs.readFileSync(list, 'utf8')); } finally { fs.rmSync(list, { force: true }); }
  });
  /**
   * LibreOffice's own CSV export, every sheet to a file of its own named after the sheet ("in-Sheet name.csv"), written in
   * sheet order. Options, in LibreOffice's order: comma, double quote, UTF-8, from row 1, standard columns, en-US, quote all
   * text, detect special numbers, values as shown or plain, formulas or their values, keep spaces, every sheet (-1).
   */
  // A real date cell comes out unquoted and month first (11/02/2026, with its time if it has one); a text cell is always
  // quoted. The date cell is written YYYY-MM-DD so the import never doubts it; a date typed as text is left as typed.
  const isoDate = (v: string) => v.replace(/^(\d{2})\/(\d{2})\/(\d{4})(?=$| )/, '$3-$1-$2');
  /** every sheet exported as a CSV file, in sheet order; the files are there while `visit` runs and removed after */
  type Visit<T> = (sheets: SheetFile[]) => Promise<T>;
  const exported = <T>(file: string, asShown: boolean, formulas: boolean, visit: Visit<T>) => one(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-sheets-'));
    try {
      const src = path.join(dir, `in${path.extname(file).toLowerCase()}`);
      fs.copyFileSync(file, src);
      const options = `44,34,76,1,,1033,true,true,${asShown},${formulas},false,-1`;
      await start('--convert-to', `csv:Text - txt - csv (StarCalc):${options}`, '--outdir', path.join(dir, 'out'), src);
      const out = path.join(dir, 'out');
      const files = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.csv')) : [];
      if (!files.length) throw new Error('it could not be read as a spreadsheet');
      // finer than milliseconds, so sheets written in one millisecond keep their order
      const at = (f: string) => fs.statSync(path.join(out, f), { bigint: true }).mtimeNs;
      const ordered = files.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
      const sheetName = (f: string) => f.replace(/^in-/, '').replace(/\.csv$/, '');
      const named = ordered.map((f) => ({ name: sheetName(f), path: path.join(out, f) }));
      return await visit(named);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const sheetFiles = <T>(file: string, visit: Visit<T>) => exported(file, false, false, visit);
  const gridsOf = (asShown: boolean) => async (list: SheetFile[]) => list.map((sheet) => {
    const text = fs.readFileSync(sheet.path, 'utf8').replace(/^\uFEFF/, '');
    return { name: sheet.name, grid: parseCsv(text, asShown ? undefined : isoDate) };
  });
  const sheets = (file: string, asShown = false, formulas = false) =>
    exported(file, asShown, formulas, gridsOf(asShown));
  const workbook = (fods: string) => one(async (): Promise<Uint8Array> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-export-'));
    try {
      fs.writeFileSync(path.join(dir, 'export.fods'), fods);
      await start('--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', dir, path.join(dir, 'export.fods'));
      return new Uint8Array(fs.readFileSync(path.join(dir, 'export.xlsx')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const edit = (file: string, sheet: string, steps: SheetEdit[]) => one(async (): Promise<Uint8Array> => {
    if (!looksRight(file)) throw new Error('the file is not what its name says');
    await ready();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-edit-'));
    try {
      const copy = path.join(dir, `log${path.extname(file).toLowerCase()}`); fs.copyFileSync(file, copy);   // the file itself is never opened for writing here
      const done = path.join(user, 'punchlist-done.txt'); fs.rmSync(done, { force: true });
      fs.writeFileSync(path.join(user, 'punchlist-edit.txt'), editJob(pathToFileURL(copy).href, sheet, steps));
      await start('macro:///Standard.Punchlist.Edit');
      const note = fs.existsSync(done) ? fs.readFileSync(done, 'utf8').trim() : null;
      // `refused`: the macro ran and the file said no (a protected sheet, say), which it will say again
      if (note === null) throw new Error('nothing was reported');
      if (note !== 'ok') throw Object.assign(new Error(note.replace(/^failed: /, '') || 'it did not finish'), { refused: true });
      return new Uint8Array(fs.readFileSync(copy));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const text = (file: string) => one(async (): Promise<string> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-text-'));
    try {
      const src = path.join(dir, `in${path.extname(file).toLowerCase()}`); fs.copyFileSync(file, src);
      await start('--convert-to', 'txt:Text (encoded):UTF8', '--outdir', path.join(dir, 'out'), src);
      const out = path.join(dir, 'out', 'in.txt'); if (!fs.existsSync(out)) throw new Error('it could not be read as a document');
      return fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const document = (fodt: string) => one(async (): Promise<{ docx: Uint8Array; pdf: Uint8Array }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-memo-'));
    try {
      const file = path.join(dir, 'memo.fodt'); fs.writeFileSync(file, fodt);
      await start('--convert-to', 'docx:MS Word 2007 XML', '--outdir', dir, file);
      await start('--convert-to', 'pdf:writer_pdf_Export', '--outdir', dir, file);
      return { docx: new Uint8Array(fs.readFileSync(path.join(dir, 'memo.docx'))), pdf: new Uint8Array(fs.readFileSync(path.join(dir, 'memo.pdf'))) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const id = o.markup ? 'libreoffice+markup' : 'libreoffice';
  return Object.assign(convert, { id, changes, sheets, sheetFiles, workbook, edit, document, text });
}

/** A PDF's text, line by line as the file breaks its lines, pages one after another: a list brought in from a PDF. */
export async function pdfLines(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str + (x.hasEOL ? '\n' : '') : '')).join(''));
    return out.join('\n');
  } finally { await doc.destroy(); }
}

/** The words on each page of a PDF, in reading order as the file gives them. For checks; the app does not read inside documents. */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try { const pages: string[] = []; for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join('')); return pages; } finally { await doc.destroy(); }
}

/**
 * How many pages a PDF has, and the text of a spread of them: every page of a short document, and `sample` pages spaced
 * evenly through a long one, which is enough to count its words by and keeps indexing quick. A page with no text layer
 * (a scan) gives no text. `first` is the first page's text, for a document's title. Throws when the PDF cannot be opened (corrupt, or locked with a password).
 */
export async function pdfLook(bytes: Uint8Array, sample = 40): Promise<{ pages: number; text: string; first: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const n = doc.numPages; const which = n <= sample ? Array.from({ length: n }, (_, i) => i + 1) : Array.from({ length: sample }, (_, i) => 1 + Math.floor((i * n) / sample)); const text: string[] = [];
    for (const i of which) { try { text.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ')); } catch { /* a page that cannot be read gives no words */ } }
    return { pages: n, text: text.join('\n'), first: which[0] === 1 ? (text[0] ?? '') : '' };
  } finally { await doc.destroy(); }
}

/** How many pages a PDF has. Throws when it cannot be opened (corrupt, or locked with a password). */
export async function pdfPages(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  try { return doc.numPages; } finally { await doc.destroy(); }
}
