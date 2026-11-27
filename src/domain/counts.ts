/** A count as people read it: 2,000, not 2000 */
export const num = (count: number) => count.toLocaleString('en-US');

/** "1 question", "2,000 questions": the count and its word, plural when it is not one */
export const plural = (count: number, word: string) => `${num(count)} ${word}${count === 1 ? '' : 's'}`;
