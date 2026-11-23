// #492: reserve the difference from the closest label that shares a long beginning.
// Keep the word before it for context ("Fund IV"), dropping shared legal-form words first.
export function distinguishingWords(label: string, others: string[]): string {
  const words = [...label.matchAll(/\S+/g)];
  const keys = words.map(([word]) => word.toLocaleLowerCase('en-US'));
  let bestPrefix = 0;
  let bestSuffix = 0;
  for (const other of others) {
    if (other === label) continue;
    const parts = other.toLocaleLowerCase('en-US').match(/\S+/g) ?? [];
    const end = Math.min(parts.length, keys.length);
    let prefix = 0;
    while (prefix < end && keys[prefix] === parts[prefix]) prefix++;
    if (prefix < 2 || prefix < bestPrefix) continue;
    let suffix = 0;
    while (suffix < end - prefix && keys.at(-suffix - 1) === parts.at(-suffix - 1)) suffix++;
    if (prefix === bestPrefix && suffix <= bestSuffix) continue;
    bestPrefix = prefix;
    bestSuffix = suffix;
  }
  if (!bestPrefix) return '';
  const start = words[bestPrefix - 1].index;
  const end = bestSuffix ? words[words.length - bestSuffix].index : label.length;
  return label.slice(start, end).trimEnd();
}
