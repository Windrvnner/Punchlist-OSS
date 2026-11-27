// Syntax that shows a screen deciding something it should only display: timers, list work, loops, limits, dates and
// patterns. Each kind is a plain syntax pattern, so a comment or a string that names one never counts.
//
// What these kinds cannot see: plain `if` logic on state; Math.min and Math.max; .flatMap, .at and .includes; Intl
// and toLocale...String; requestAnimationFrame; a limit given by a named constant (including changing its value); a
// swap between identical trimmed lines; edits inside a loop body.
import { unwrapped } from './pane-of-glass-syntax.mjs';

const timerNames = new Set(['setTimeout', 'setInterval', 'requestIdleCallback']);
const listMethods = new Set(['sort', 'toSorted', 'filter', 'reduce', 'reduceRight', 'find', 'findLast', 'findIndex',
  'findLastIndex', 'some', 'every', 'slice', 'splice', 'toSpliced', 'substring', 'substr']);
const loopTypes = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const comparisons = new Set(['<', '<=', '>', '>=', '===', '!==', '==', '!=']);
const limitAttributes = new Set(['maxLength', 'minLength', 'min', 'max']);
const dateFunctions = new Set(['parse', 'UTC', 'now']);

function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function isLengthRead(node) {
  const member = unwrapped(node);
  return member.type === 'MemberExpression' && !member.computed && member.property.name === 'length';
}

function isZero(node) {
  const literal = unwrapped(node);
  return literal.type === 'Literal' && literal.value === 0;
}

// A comparison of a length with anything but 0 is a limit; comparing with 0 only asks whether a list is empty.
function isLengthLimit(node) {
  if (!comparisons.has(node.operator)) return false;
  if (isLengthRead(node.left)) return !isZero(node.right);
  return isLengthRead(node.right) && !isZero(node.left);
}

function isNumberValue(value) {
  const literal = unwrapped(value?.type === 'JSXExpressionContainer' ? value.expression : value);
  return literal?.type === 'Literal' && typeof literal.value === 'number';
}

function isLimitAttribute(node) {
  return node.name.type === 'JSXIdentifier' && limitAttributes.has(node.name.name) && isNumberValue(node.value);
}

function isDateCall(node) {
  const callee = unwrapped(node.callee);
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  return isIdentifier(unwrapped(callee.object), 'Date') && dateFunctions.has(callee.property.name);
}

// A call whose callee is a member with one of the list methods; it is recorded at the method name, so each call
// of a chain counts on its own line.
function listMethod(node) {
  const callee = unwrapped(node.callee);
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  return listMethods.has(callee.property.name) ? callee.property : null;
}

export function ruleChecks(record) {
  const loop = (node) => record('loop', node);
  // The visitor reaches `typeof setTimeout` in a type before its name, so the name is known to be only a type.
  const typeOnly = new Set();
  const handlers = {
    TSTypeQuery(node) {
      typeOnly.add(node.exprName);
    },
    // Every runtime reference counts, so `const t = setTimeout` and `const { setTimeout: wait } = window` are
    // caught too.
    Identifier(node) {
      if (timerNames.has(node.name) && !typeOnly.has(node)) record('timer', node);
    },
    CallExpression(node) {
      const method = listMethod(node);
      if (method) record('list', method);
      if (isDateCall(node)) record('date', node);
      if (isIdentifier(unwrapped(node.callee), 'RegExp')) record('pattern', node);
    },
    NewExpression(node) {
      const callee = unwrapped(node.callee);
      if (isIdentifier(callee, 'Date') && node.arguments.length) record('date', node);
      if (isIdentifier(callee, 'RegExp')) record('pattern', node);
    },
    Literal(node) {
      if (node.regex) record('pattern', node);
    },
    BinaryExpression(node) {
      if (isLengthLimit(node)) record('limit', node);
    },
    JSXAttribute(node) {
      if (isLimitAttribute(node)) record('limit', node);
    },
  };
  for (const type of loopTypes) handlers[type] = loop;
  return handlers;
}
