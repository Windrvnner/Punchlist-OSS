/**
 * The words on each page of a PDF, in reading order as the file gives them.
 * For checks; the app does not read inside documents.
 */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((x) => ('str' in x ? x.str : '')).join(''));
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}
