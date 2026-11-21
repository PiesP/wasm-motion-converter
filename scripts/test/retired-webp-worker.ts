// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { parse } from '@babel/parser';

import { RETIRED_WEBP_EXECUTABLES, RETIRED_WEBP_SHIM } from './retired-webp-assets.ts';

const LEGACY_MODULE_REFERENCE =
  /(?:\.\/|\bassets\/)(?:webp-wasm|wasm-webp)[-.][\w-]+\.(?:wasm|[cm]?js)\b/i;
const LEGACY_MARKERS = ['emscripten_resize_heap', 'wasmMemory', '__wasm_call_ctors'];
const MAX_WORKER_BYTES = 64 * 1024;
const EXECUTION_NAMES = new Set([
  'eval',
  'Function',
  'importScripts',
  'WebAssembly',
  'Worker',
  'SharedWorker',
]);
const EXECUTION_NODES = new Set([
  'ImportExpression',
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'WithStatement',
]);

function hasLegacyReference(source: string) {
  return (
    LEGACY_MODULE_REFERENCE.test(source) ||
    source.includes(RETIRED_WEBP_SHIM.path) ||
    LEGACY_MARKERS.every((marker) => source.includes(marker))
  );
}

export function hasLegacyWebpLoader(bytes: Uint8Array): boolean {
  return hasLegacyReference(Buffer.from(bytes).toString('utf8'));
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function node(value: unknown, type?: string): Node | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string' &&
    (type === undefined || value.type === type) &&
    'start' in value &&
    typeof value.start === 'number' &&
    'end' in value &&
    typeof value.end === 'number'
  )
    return value as Node;
  return undefined;
}

function visit(root: Node) {
  const parents = new Map<Node, Node | undefined>();
  const pending: [Node, Node | undefined][] = [[root, undefined]];
  for (const [current, parent] of pending) {
    parents.set(current, parent);
    for (const value of Object.values(current)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        const nested = node(child);
        if (nested) pending.push([nested, current]);
      }
    }
  }
  return parents;
}

function exactLiteral(value: Node, expected: string | number, source: string) {
  const raw = source.slice(value.start, value.end);
  if (typeof expected === 'number')
    return value.type === 'NumericLiteral' && value.value === expected && raw === String(expected);
  if (value.type === 'StringLiteral')
    return value.value === expected && (raw === `"${expected}"` || raw === `'${expected}'`);
  const quasi = node(Array.isArray(value.quasis) && value.quasis[0], 'TemplateElement');
  const text = quasi?.value as { raw?: unknown; cooked?: unknown } | undefined;
  return (
    value.type === 'TemplateLiteral' &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0 &&
    Array.isArray(value.quasis) &&
    value.quasis.length === 1 &&
    text?.raw === expected &&
    text.cooked === expected &&
    raw === `\`${expected}\``
  );
}

function matchTable(candidate: Node, source: string) {
  const rows = candidate.elements;
  if (!Array.isArray(rows) || rows.length !== RETIRED_WEBP_EXECUTABLES.length) return false;
  const tokens: Node[] = [];
  for (const [index, asset] of RETIRED_WEBP_EXECUTABLES.entries()) {
    const values = node(rows[index], 'ArrayExpression')?.elements;
    if (!Array.isArray(values) || values.length !== 3) return false;
    for (const [column, expected] of ['/' + asset.path, asset.size, asset.sha256].entries()) {
      const value = node(values[column]);
      if (!value || expected === undefined || !exactLiteral(value, expected, source)) return false;
      tokens.push(value);
    }
  }
  let cursor = candidate.start;
  for (const { start, end } of [...tokens, { start: candidate.end, end: candidate.end }]) {
    if (!/^[\s[\],]*$/u.test(source.slice(cursor, start))) return false;
    cursor = end;
  }
  return true;
}

const require = createRequire(import.meta.url);
const PARSER_VERSION = '7.29.14';

function checkedParser(entry: string): typeof parse | undefined {
  const metadata = require(join(dirname(entry), '..', 'package.json'));
  return metadata.name === '@babel/parser' && metadata.version === PARSER_VERSION
    ? require(entry).parse
    : undefined;
}

function loadParser(): typeof parse {
  try {
    const direct = checkedParser(require.resolve('@babel/parser'));
    if (direct) return direct;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND'))
      throw error;
  }
  // The full Windows payload contains regular files only. Named scenarios
  // omit these files and do not request the strict retirement scan.
  const entry = fileURLToPath(
    new URL(
      `../../node_modules/.pnpm/@babel+parser@${PARSER_VERSION}/node_modules/@babel/parser/lib/index.js`,
      import.meta.url
    )
  );
  const bundled = checkedParser(entry);
  if (!bundled) throw new Error(`Missing exact ${PARSER_VERSION} retirement JavaScript parser`);
  return bundled;
}

export function hasLegacyWebpInRetiredBuild(path: string, bytes: Uint8Array): boolean {
  if (path !== 'service-worker.js') return hasLegacyWebpLoader(bytes);
  if (bytes.byteLength > MAX_WORKER_BYTES) return true;
  const source = new TextDecoder('utf-8', { fatal: true });
  const parseWorker = loadParser();
  try {
    return !hasExactRetirementMetadata(source.decode(bytes), parseWorker);
  } catch {
    return true;
  }
}

function hasExactRetirementMetadata(source: string, parseWorker: typeof parse) {
  const root = node(
    parseWorker(source, {
      sourceType: 'module',
      attachComment: false,
      createImportExpressions: true,
    }).program
  );
  if (!root) return false;
  const parents = visit(root);
  const tables = [...parents.keys()].filter(
    (item) => item.type === 'ArrayExpression' && matchTable(item, source)
  );
  const table = tables[0];
  if (tables.length !== 1 || !table) return false;
  if (!hasClosedLookup(table, root, parents)) return false;
  const remaining = source.slice(0, table.start) + ' ' + source.slice(table.end);
  if (hasLegacyReference(remaining)) return false;
  if (containsArchivedIdentity(remaining)) return false;
  for (const item of parents.keys()) {
    if (item.start >= table.start && item.end <= table.end) continue;
    if (EXECUTION_NODES.has(item.type)) return false;
    if (
      item.type === 'Identifier' &&
      typeof item.name === 'string' &&
      EXECUTION_NAMES.has(item.name)
    )
      return false;
    const value =
      item.type === 'TemplateElement' ? (item.value as { cooked?: unknown }).cooked : item.value;
    if (
      typeof value === 'string' &&
      (EXECUTION_NAMES.has(value) || hasLegacyReference(value) || containsArchivedIdentity(value))
    )
      return false;
  }
  return true;
}

function containsArchivedIdentity(source: string) {
  const lower = source.toLowerCase();
  return RETIRED_WEBP_EXECUTABLES.some(
    ({ path, sha256 }) =>
      lower.includes(path.slice(path.lastIndexOf('/') + 1).toLowerCase()) || lower.includes(sha256)
  );
}

type Parents = ReturnType<typeof visit>;

function identifier(value: unknown) {
  const name = node(value, 'Identifier')?.name;
  return typeof name === 'string' ? name : undefined;
}

function isNumber(value: unknown, expected: number) {
  return node(value, 'NumericLiteral')?.value === expected;
}

function oneDeclaration(value: unknown) {
  const declaration = node(value, 'VariableDeclaration');
  return Array.isArray(declaration?.declarations) && declaration.declarations.length === 1
    ? node(declaration.declarations[0], 'VariableDeclarator')
    : undefined;
}

function twoStatements(fn: Node | undefined) {
  const body = node(fn?.body, 'BlockStatement');
  return body && Array.isArray(body.body) && body.body.length === 2 ? body.body : [];
}

function hasClosedLookup(table: Node, root: Node, parents: Parents) {
  const tableDeclaration = parents.get(table);
  const tableName = identifier(tableDeclaration?.id);
  const privateScope = tableDeclaration && parents.get(tableDeclaration);
  const block = privateScope && parents.get(privateScope);
  const closure = node(block && parents.get(block), 'ArrowFunctionExpression');
  const [declaration, returnLookup] = twoStatements(closure);
  const lookup = node(node(returnLookup, 'ReturnStatement')?.argument, 'ArrowFunctionExpression');
  if (
    !tableName ||
    tableDeclaration?.init !== table ||
    oneDeclaration(declaration) !== tableDeclaration ||
    !closure ||
    closure.async ||
    !Array.isArray(closure.params) ||
    closure.params.length !== 0 ||
    !lookup ||
    lookup.async ||
    !Array.isArray(lookup.params) ||
    lookup.params.length !== 1
  )
    return false;
  const initialize = node(parents.get(closure), 'CallExpression');
  const publicBinding = initialize && parents.get(initialize);
  const publicStatement = publicBinding && parents.get(publicBinding);
  if (
    initialize?.callee !== closure ||
    !Array.isArray(initialize.arguments) ||
    initialize.arguments.length !== 0 ||
    publicBinding?.type !== 'VariableDeclarator' ||
    publicBinding.init !== initialize ||
    !identifier(publicBinding.id) ||
    publicStatement?.type !== 'VariableDeclaration' ||
    parents.get(publicStatement) !== root
  )
    return false;

  const pathname = identifier(lookup.params[0]);
  const [readRow, returnMatch] = twoStatements(lookup);
  const rowDeclaration = oneDeclaration(readRow);
  const row = identifier(rowDeclaration?.id);
  const read = node(rowDeclaration?.init, 'CallExpression');
  const member = node(read?.callee, 'MemberExpression');
  if (
    !pathname ||
    !row ||
    member?.computed ||
    identifier(member?.object) !== tableName ||
    identifier(member?.property) !== 'find' ||
    !Array.isArray(read?.arguments) ||
    read.arguments.length !== 1 ||
    !isExactPredicate(read.arguments[0], pathname)
  )
    return false;
  if (tableName === pathname || row === pathname || row === tableName) return false;
  return returnsOnlySizeAndHash(returnMatch, row);
}

function isExactPredicate(value: unknown, pathname: string) {
  const predicate = node(value, 'ArrowFunctionExpression');
  if (
    !predicate ||
    predicate.async ||
    !Array.isArray(predicate.params) ||
    predicate.params.length !== 1
  )
    return false;
  const destructured = node(predicate.params[0], 'ArrayPattern')?.elements;
  const path =
    Array.isArray(destructured) && destructured.length === 1
      ? identifier(destructured[0])
      : undefined;
  if (!path || path === pathname) return false;
  const comparison = node(predicate.body, 'BinaryExpression');
  return (
    comparison?.operator === '===' &&
    identifier(comparison.left) === path &&
    identifier(comparison.right) === pathname
  );
}

function returnsOnlySizeAndHash(value: unknown, row: string) {
  const match = node(node(value, 'ReturnStatement')?.argument, 'LogicalExpression');
  const props = node(match?.right, 'ObjectExpression')?.properties;
  if (
    match?.operator !== '&&' ||
    identifier(match.left) !== row ||
    !Array.isArray(props) ||
    props.length !== 2
  )
    return false;
  return ['size', 'sha256'].every((name, offset) => {
    const property = node(props[offset], 'ObjectProperty');
    const access = node(property?.value, 'MemberExpression');
    return (
      property &&
      !property.computed &&
      !property.shorthand &&
      identifier(property.key) === name &&
      access?.computed &&
      identifier(access.object) === row &&
      isNumber(access.property, offset + 1)
    );
  });
}
