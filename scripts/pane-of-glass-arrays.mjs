// Keep literal slots sparse: a length assignment can create billions of holes without creating any path strings.
function slice(slots, from, count) {
  const entries = new Map();
  for (const [index, part] of slots.entries) {
    if (index >= from && index - from < count) entries.set(index - from, part);
  }
  return { entries, length: Math.min(Math.max(0, slots.length - from), count) };
}

export function resizedArray(value, writes) {
  if (!writes.size) return value;
  const lengths = new Map([...(value.lengths ?? []), ...writes]);
  return { type: 'ArrayExpression', original: value.original ?? value, lengths };
}

function resizedSlots(array, resolve, limit, seen) {
  let retained = limit;
  let latest = -1;
  let length = 0;
  for (const [offset, size] of array.lengths) {
    retained = Math.min(retained, size);
    if (offset > latest) {
      latest = offset;
      length = size;
    }
  }
  const prefix = arraySlots(array.original, resolve, retained, seen);
  return prefix && { entries: prefix.entries, length: Math.min(limit, length) };
}

// A spread after the requested index cannot shift an earlier entry.
export function arraySlots(array, resolve, limit, seen = new Set()) {
  if (array?.type !== 'ArrayExpression' || seen.has(array)) return null;
  const visited = new Set(seen).add(array);
  if (array.original) return resizedSlots(array, resolve, limit, visited);
  if (array.slots) return slice(array.slots, 0, limit);
  const entries = new Map();
  let length = 0;
  for (const part of array.elements) {
    if (length >= limit) break;
    if (part?.type === 'SpreadElement') {
      const tail = arraySlots(resolve(part.argument), resolve, limit - length, visited);
      if (!tail) return null;
      for (const [index, entry] of tail.entries) entries.set(length + index, entry);
      length += tail.length;
    } else {
      if (part) entries.set(length, part);
      length++;
    }
  }
  return { entries, length };
}

export function arrayTail(array, index, resolve) {
  const slots = arraySlots(array, resolve, Infinity);
  return slots && { type: 'ArrayExpression', slots: slice(slots, index, Infinity) };
}
