/**
 * The deal memo laid out as a document: one OpenDocument text file in a single XML file (flat .fodt), with real
 * paragraph and table styles, which LibreOffice turns into Word and PDF (backend/convert `document`). The look follows
 * the app's own: a serif for headings, a plain sans for the text, color only on a High rating (Medium and Low print in
 * the text color), no text in capitals, on US Letter. Fonts are ones every PC has, since a Word file does not carry its
 * fonts.
 */
import { themeColors } from '../palette';
import type { Memo, MemoPart, Rating } from './memo';
import { RATINGS } from './memo';

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hue = themeColors('light');
// the memo prints in the light theme's ink, worked out from the control file's base colors; the faint label gray and
// the rules are print-only shades
/** `ink` laid over `paper` at strength `a` (0 to 1), as a hex color: the memo's rules and faint figures, from the tokens */
const mix = (ink: string, paper: string, a: number) => '#' + [1, 3, 5].map((i) => { const x = parseInt(ink.slice(i, i + 2), 16), y = parseInt(paper.slice(i, i + 2), 16); return Math.round(y + (x - y) * a).toString(16).padStart(2, '0'); }).join('');
const INK = hue.ink, INK2 = hue['ink-2'], INK3 = hue['ink-3'], LINE = mix(hue['paper-ink'], hue.paper, 0.18), FAINT = mix(hue['paper-ink'], hue.paper, 0.33);
const RATING_STYLE: Record<Rating, string> = { High: 'RHigh', Medium: 'RMed', Low: 'RLow' };
/** page: US Letter, 0.85in side margins, so the text is 6.8in wide */
const WIDTH = 6.8;

const p = (style: string, inner: string) => `<text:p text:style-name="${style}">${inner}</text:p>`;
const span = (style: string, inner: string) => `<text:span text:style-name="${style}">${inner}</text:span>`;
const rating = (r: Rating | null) => (r ? span(RATING_STYLE[r], r) : '');
const refs = (ns: number[]) => (ns.length ? span('Sup', [...ns].sort((a, b) => a - b).join(', ')) : '');
const detail = (parts: MemoPart[]) => parts.map((x) => esc(x.text) + refs(x.refs)).join('');

/** A table: column widths as shares of the text width, a header row, and rows of cells already written as paragraphs' contents. `num` marks columns aligned right. */
function table(name: string, widths: number[], head: string[], rows: string[][], num: boolean[] = [], bold?: number) {
  const sum = widths.reduce((a, b) => a + b, 0);
  const cols = widths.map((w, i) => `<table:table-column table:style-name="${name}.${i}"/>`).join('');
  const cell = (inner: string, i: number, style: string) => `<table:table-cell table:style-name="${style}" office:value-type="string">${p(num[i] ? `${style === 'CH' ? 'HeadR' : 'CellR'}` : style === 'CH' ? 'Head' : 'Cell', inner)}</table:table-cell>`;
  const auto = `<style:style style:name="${name}" style:family="table"><style:table-properties style:width="${WIDTH}in" table:align="left" fo:margin-top="2pt" fo:margin-bottom="4pt"/></style:style>`
    + widths.map((w, i) => `<style:style style:name="${name}.${i}" style:family="table-column"><style:table-column-properties style:column-width="${((WIDTH * w) / sum).toFixed(3)}in"/></style:style>`).join('');
  const body = `<table:table table:name="${name}" table:style-name="${name}">${cols}<table:table-header-rows><table:table-row>${head.map((h, i) => cell(esc(h), i, 'CH')).join('')}</table:table-row></table:table-header-rows>`
    + rows.map((r, k) => `<table:table-row>${r.map((c, i) => cell(k === bold ? span('Bold', c) : c, i, 'CC')).join('')}</table:table-row>`).join('') + '</table:table>';
  return { auto, body };
}

export function memoDocument(m: Memo, aiLabel: string): string {
  const autos: string[] = []; const out: string[] = [];
  const add = (t: { auto: string; body: string }) => { autos.push(t.auto); out.push(t.body); };
  const h = (text: string) => `<text:h text:style-name="H" text:outline-level="1">${esc(text)}</text:h>`;

  // header
  out.push(p('Label', 'Deal memo'), `<text:h text:style-name="Title" text:outline-level="1">${esc(m.deal)}</text:h>`);
  if (m.facts.length) out.push(p('Meta', esc(m.facts.join(' · '))));
  out.push(p('MetaRule', esc([m.firm, m.date].filter(Boolean).join(' · '))));   // names no person in the app

  // summary: the model's paragraphs, marked, then the app's own counts
  out.push(h('Summary'));
  out.push(...m.summary.map((s) => p('Body', esc(s))));   // no AI mark in the text: one disclaimer at the back says it
  out.push(p('Body', esc(m.counts)));

  // risk at a glance
  if (m.glance.length) {
    out.push(h('Risk at a glance'));
    const total = { workstream: 'All', High: 0, Medium: 0, Low: 0, open: 0 }; for (const g of m.glance) { total.High += g.High; total.Medium += g.Medium; total.Low += g.Low; total.open += g.open; }
    const count = (k: number, r?: Rating) => (k && r && r !== 'Low' ? span(RATING_STYLE[r], String(k)) : k ? String(k) : span('Zero', '0'));
    add(table('Glance', [3, 1, 1, 1, 1.6], ['Workstream', 'High', 'Medium', 'Low', 'Questions open'], [...m.glance, total].map((g) => [esc(g.workstream), count(g.High, 'High'), count(g.Medium, 'Medium'), count(g.Low, 'Low'), count(g.open)]), [false, true, true, true, true], m.glance.length));
  }

  // the first page is the summary alone; the memo proper starts on the next
  let first = true; const next = (text: string) => { const t = first ? `<text:h text:style-name="HBreak" text:outline-level="1">${esc(text)}</text:h>` : h(text); first = false; return t; };

  // key risks: each a paragraph or two, the last closing on what is still open
  if (m.risks.length) {
    out.push(next('Key risks'));
    for (const r of m.risks) {
      // a long title wraps under itself, and the workstreams sit on a line of their own, so neither breaks into the other
      out.push(p('RiskHead', `${span('Sans', rating(r.rating))}<text:tab/>${esc(r.title)}<text:line-break/>${span('Dim', esc(r.workstream))}`));
      const paras = r.paras.map(detail); if (r.open) paras.push(paras.length ? `${paras.pop()} ${esc(r.open)}` : esc(r.open));
      for (const [k, x] of paras.entries()) out.push(p(k === paras.length - 1 ? 'RiskLast' : 'RiskBody', x));
    }
  }

  // smaller risks: a line or two each
  if (m.minor.length) {
    out.push(next('Other risks'));
    for (const r of m.minor) out.push(p('Minor', `${r.rating ? `${rating(r.rating)}<text:tab/>` : '<text:tab/>'}${span('Bold', esc(r.title))}${r.workstream ? ` ${span('Dim', `· ${esc(r.workstream)}`)}` : ''}${r.detail.length ? `<text:line-break/>${detail(r.detail)}` : ''}`));
  }

  // the references the key and smaller risks cite, after them; nothing else is listed at the back
  if (m.refs.length) { out.push(h('References')); out.push(...m.refs.map((r, i) => p('Ref', `${i + 1}.<text:tab/>${esc(r)}`))); }
  // the one disclaimer, at the very end, instead of a mark on each AI-written part
  out.push(p('Disclaimer', `Disclaimer: the summary, the risk ratings and the write-ups of the key risks in this memo were written by ${esc(aiLabel)} from the deal’s records.`));

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>${esc(`${m.deal} deal memo`)}</dc:title></office:meta>
<office:font-face-decls><style:font-face style:name="Georgia" svg:font-family="Georgia" style:font-family-generic="roman"/><style:font-face style:name="Arial" svg:font-family="Arial" style:font-family-generic="swiss"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="128%"/><style:text-properties style:font-name="Arial" fo:font-size="9.5pt" fo:color="${INK}" fo:language="en" fo:country="US"/></style:default-style>
<style:style style:name="Body" style:family="paragraph"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="5pt"/></style:style>
<style:style style:name="Label" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="2pt"/><style:text-properties fo:font-size="8.5pt" fo:font-weight="bold" fo:color="${INK3}"/></style:style>
<style:style style:name="HBreak" style:family="paragraph" style:parent-style-name="H" style:default-outline-level="1"><style:paragraph-properties fo:margin-top="0pt" fo:break-before="page"/></style:style>
<style:style style:name="Title" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="2pt"/><style:text-properties style:font-name="Georgia" fo:font-size="21pt"/></style:style>
<style:style style:name="Meta" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="2pt"/><style:text-properties fo:font-size="8.8pt" fo:color="${INK2}"/></style:style>
<style:style style:name="MetaRule" style:family="paragraph" style:parent-style-name="Meta"><style:paragraph-properties fo:padding-bottom="5pt" fo:border-bottom="1.5pt solid ${INK}" fo:margin-bottom="4pt"/></style:style>
<style:style style:name="H" style:family="paragraph" style:default-outline-level="1"><style:paragraph-properties fo:margin-top="14pt" fo:margin-bottom="5pt" fo:padding-bottom="3pt" fo:border-bottom="0.75pt solid ${LINE}" fo:keep-with-next="always"/><style:text-properties style:font-name="Georgia" fo:font-size="12.5pt" fo:font-weight="normal"/></style:style>
<style:style style:name="RiskHead" style:family="paragraph"><style:paragraph-properties fo:margin-top="7pt" fo:margin-bottom="3pt" fo:margin-left="0.8in" fo:text-indent="-0.8in" fo:keep-with-next="always" fo:keep-together="always"><style:tab-stops><style:tab-stop style:position="0in"/></style:tab-stops></style:paragraph-properties><style:text-properties style:font-name="Georgia" fo:font-size="10.5pt"/></style:style>
<style:style style:name="Minor" style:family="paragraph"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="5pt" fo:margin-left="0.8in" fo:text-indent="-0.8in" fo:keep-together="always"><style:tab-stops><style:tab-stop style:position="0in"/></style:tab-stops></style:paragraph-properties></style:style>
<style:style style:name="RiskBody" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:margin-left="0.8in"/></style:style>
<style:style style:name="RiskLast" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.8in" fo:margin-bottom="6pt" fo:padding-bottom="6pt" fo:border-bottom="0.5pt solid ${LINE}"/></style:style>
<style:style style:name="Foot" style:family="paragraph"><style:paragraph-properties fo:margin-top="3pt" fo:margin-bottom="6pt"/><style:text-properties fo:font-size="7.8pt" fo:color="${INK2}"/></style:style>
<style:style style:name="Disclaimer" style:family="paragraph" style:parent-style-name="Foot"><style:paragraph-properties fo:margin-top="16pt"/></style:style>
<style:style style:name="Head" style:family="paragraph"><style:text-properties fo:font-size="8pt" fo:font-weight="bold" fo:color="${INK3}"/></style:style>
<style:style style:name="HeadR" style:family="paragraph" style:parent-style-name="Head"><style:paragraph-properties fo:text-align="end"/></style:style>
<style:style style:name="Cell" style:family="paragraph"><style:text-properties fo:font-size="8.8pt"/></style:style>
<style:style style:name="CellR" style:family="paragraph" style:parent-style-name="Cell"><style:paragraph-properties fo:text-align="end"/></style:style>
<style:style style:name="Ref" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="1pt"><style:tab-stops><style:tab-stop style:position="0.3in"/></style:tab-stops></style:paragraph-properties><style:text-properties fo:font-size="8.6pt"/></style:style>
<style:style style:name="RHigh" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="${hue.high}"/></style:style>
<style:style style:name="RMed" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="${INK}"/></style:style>
<style:style style:name="RLow" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="${INK}"/></style:style>
<style:style style:name="Sans" style:family="text"><style:text-properties style:font-name="Arial" fo:font-size="9.5pt"/></style:style>
<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Dim" style:family="text"><style:text-properties style:font-name="Arial" fo:font-size="8.5pt" fo:color="${INK2}"/></style:style>
<style:style style:name="Zero" style:family="text"><style:text-properties fo:color="${FAINT}"/></style:style>
<style:style style:name="Sup" style:family="text"><style:text-properties style:text-position="super 58%" fo:color="${INK2}"/></style:style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="Page"><style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" style:print-orientation="portrait" fo:margin-top="0.8in" fo:margin-bottom="0.75in" fo:margin-left="0.85in" fo:margin-right="0.85in"/></style:page-layout>
<style:style style:name="CH" style:family="table-cell"><style:table-cell-properties fo:padding-top="3pt" fo:padding-bottom="3pt" fo:padding-left="0pt" fo:padding-right="6pt" fo:border-top="none" fo:border-left="none" fo:border-right="none" fo:border-bottom="0.75pt solid ${INK2}"/></style:style>
<style:style style:name="CC" style:family="table-cell"><style:table-cell-properties fo:padding-top="3pt" fo:padding-bottom="3pt" fo:padding-left="0pt" fo:padding-right="6pt" fo:border-top="none" fo:border-left="none" fo:border-right="none" fo:border-bottom="0.5pt solid ${LINE}"/></style:style>
${autos.join('\n')}
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="Page"/></office:master-styles>
<office:body><office:text>
${out.join('\n')}
</office:text></office:body></office:document>
`;
}
