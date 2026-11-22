/**
 * Apple's title-style capitalization for column heads, menu items and buttons:
 * every word capitalized except articles, coordinating conjunctions and short prepositions,
 * and the first and last words always. Words already capitalized keep their capitals.
 */
const MINOR = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'in', 'on', 'at', 'to', 'by', 'up',
  'as']);

export function titleStyle(text: string): string {
  const words = text.split(' ');
  return words.map((word, i) => {
    const edge = i === 0 || i === words.length - 1;
    if (!/^[a-z]/.test(word) || (!edge && MINOR.has(word))) return word;
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ');
}
