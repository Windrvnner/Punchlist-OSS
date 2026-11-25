// The first and last line of each function in a source file, for the readability hints (check-readability.mjs).
import { parseSync, Visitor } from 'vite';

/** The 1-based line of each offset, by the offsets where lines start. */
function lineOf(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Whether a call is a test suite (`describe(...)`, `describe.each(...)(...)`), whose callback holds many tests. */
function isSuite(call) {
  let callee = call.callee;
  while (callee.type === 'MemberExpression' || callee.type === 'CallExpression') {
    callee = callee.type === 'MemberExpression' ? callee.object : callee.callee;
  }
  return callee.type === 'Identifier' && callee.name === 'describe';
}

/**
 * Each function, method and arrow function in `source`, as { first, last, suite } lines; `suite` marks the callback
 * of a test suite. Empty when it cannot be parsed.
 */
export function functionSpans(file, source) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) return [];
  const lineStarts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const spans = [];
  const suites = new Set();
  const add = (node) => {
    const first = lineOf(lineStarts, node.start);
    spans.push({ first, last: lineOf(lineStarts, node.end - 1), suite: suites.has(node.start) });
  };
  const markSuite = (call) => {
    if (isSuite(call)) for (const argument of call.arguments) suites.add(argument.start);
  };
  const visitor = new Visitor({
    CallExpression: markSuite, FunctionDeclaration: add, FunctionExpression: add, ArrowFunctionExpression: add,
  });
  visitor.visit(parsed.program);
  return spans;
}

/** The outermost function that starts on `line`, where Biome places a function's finding; null when there is none. */
export function functionStartingAt(spans, line) {
  const starting = spans.filter((span) => span.first === line);
  return starting.reduce((widest, span) => (!widest || span.last > widest.last ? span : widest), null);
}
