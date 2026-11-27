// Syntax that shows a screen deciding something it should only display: timers, list work, loops, limits, dates and
// patterns. Each kind is a plain syntax pattern, so a comment or a string that names one never counts.
//
// What these kinds cannot see: plain `if` logic on state; Math.min and Math.max; .flatMap, .at and .includes; Intl
// and toLocale...String; requestAnimationFrame; a limit given by a named constant (including changing its value); a
// swap between identical trimmed lines; edits inside a loop body; references that are not called (`const f =
// Date.now`, `rows.sort` passed as a value).
import { propertyNames, unwrapped } from './pane-of-glass-syntax.mjs';

const timerNames = new Set(['setTimeout', 'setInterval', 'requestIdleCallback']);
const listMethods = new Set(['sort', 'toSorted', 'filter', 'reduce', 'reduceRight', 'find', 'findLast', 'findIndex',
  'findLastIndex', 'some', 'every', 'slice', 'splice', 'toSpliced', 'substring', 'substr']);
const loopTypes = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const comparisons = new Set(['<', '<=', '>', '>=', '===', '!==', '==', '!=']);
const limitAttributes = new Set(['maxLength', 'minLength', 'maxlength', 'minlength', 'min', 'max']);
const numericText = /^-?\d+(?:\.\d+)?$/;
const dateFunctions = new Set(['parse', 'UTC', 'now']);

// The name is a plain identifier or a member of something (`Date`, `window.Date`, `globalThis["Date"]`).
function isGlobalNamed(node, name) {
  const target = unwrapped(node);
  if (target?.type === 'Identifier') return target.name === name;
  return target?.type === 'MemberExpression' && propertyNames(target.property, target.computed).includes(name);
}

function isTimerName(key, computed) {
  return propertyNames(key, computed).some((name) => timerNames.has(name));
}

function isLengthRead(node) {
  const member = unwrapped(node);
  return member.type === 'MemberExpression' && !member.computed && member.property.name === 'length';
}

// A `.length` read, or `+`/`-` arithmetic with one somewhere inside (`rows.length - 1`).
function involvesLength(node) {
  const side = unwrapped(node);
  if (isLengthRead(side)) return true;
  return side.type === 'BinaryExpression' && (side.operator === '+' || side.operator === '-')
    && (involvesLength(side.left) || involvesLength(side.right));
}

function isZero(node) {
  const literal = unwrapped(node);
  return literal.type === 'Literal' && literal.value === 0;
}

// A comparison of a length with anything but 0 is a limit; comparing with 0 only asks whether a list is empty.
function isLengthLimit(node) {
  if (!comparisons.has(node.operator)) return false;
  if (involvesLength(node.left)) return !isZero(node.right);
  return involvesLength(node.right) && !isZero(node.left);
}

// A number (negative too) or a numeric string such as min="1".
function isNumberValue(value) {
  const literal = unwrapped(value?.type === 'JSXExpressionContainer' ? value.expression : value);
  if (literal?.type === 'UnaryExpression' && literal.operator === '-') return isNumberValue(literal.argument);
  if (literal?.type !== 'Literal') return false;
  return typeof literal.value === 'number' || (typeof literal.value === 'string' && numericText.test(literal.value));
}

function isLimitAttribute(node) {
  return node.name.type === 'JSXIdentifier' && limitAttributes.has(node.name.name) && isNumberValue(node.value);
}

function isDateCall(node) {
  const callee = unwrapped(node.callee);
  if (callee.type !== 'MemberExpression') return false;
  return isGlobalNamed(callee.object, 'Date')
    && propertyNames(callee.property, callee.computed).some((name) => dateFunctions.has(name));
}

// A call whose callee is a member with one of the list methods; it is recorded at the method name, so each call
// of a chain counts on its own line.
function listMethod(node) {
  const callee = unwrapped(node.callee);
  if (callee.type !== 'MemberExpression') return null;
  return propertyNames(callee.property, callee.computed).some((name) => listMethods.has(name))
    ? callee.property : null;
}

// Every name in `typeof window.setTimeout` used as a type: it only describes a value and never runs.
function typeQueryNames(node) {
  const names = [];
  let name = node.exprName;
  while (name?.type === 'TSQualifiedName') {
    names.push(name.right, name.left);
    name = name.left;
  }
  names.push(name);
  return names;
}

export function ruleChecks(record) {
  const loop = (node) => record('loop', node);
  // The visitor reaches `typeof setTimeout` in a type before its name, so the name is known to be only a type.
  const typeOnly = new Set();
  const handlers = {
    TSTypeQuery(node) {
      for (const name of typeQueryNames(node)) typeOnly.add(name);
    },
    // A computed string name (`window["setTimeout"]`) counts like the dotted one.
    MemberExpression(node) {
      if (node.computed && isTimerName(node.property, true)) record('timer', node.property);
    },
    ObjectPattern(node) {
      for (const entry of node.properties) {
        if (entry.type === 'Property' && isTimerName(entry.key, entry.computed)) record('timer', entry.key);
      }
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
      if (isGlobalNamed(node.callee, 'RegExp')) record('pattern', node);
    },
    NewExpression(node) {
      if (isGlobalNamed(node.callee, 'Date') && node.arguments.length) record('date', node);
      if (isGlobalNamed(node.callee, 'RegExp')) record('pattern', node);
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
