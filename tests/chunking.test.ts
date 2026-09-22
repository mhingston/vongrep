import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkSource, declarationStarts } from '../src/chunking.ts';

const OPTIONS = { maxFragmentLines: 12, maxFragmentChars: 1000, overlapLines: 2 };

test('auto chunking aligns TypeScript fragments to top-level declarations', () => {
  const source = [
    "import { thing } from './thing.js';",
    '',
    '/** First handler. */',
    'export function first() {',
    '  return thing();',
    '}',
    '',
    '// Second handler.',
    'export function second() {',
    '  return 2;',
    '}',
  ].join('\n');

  const result = chunkSource('src/handlers.ts', source, { ...OPTIONS, maxFragmentLines: 7 }, 'auto');

  assert.equal(result.method, 'structure');
  assert.deepEqual(result.fragments.map((fragment) => [fragment.startLine, fragment.endLine]), [[1, 7], [8, 11]]);
  assert.match(result.fragments[0]?.text ?? '', /First handler/);
  assert.match(result.fragments[1]?.text ?? '', /Second handler/);
});

test('auto chunking uses Python top-level declarations', () => {
  const source = [
    'import os',
    '',
    'def first():',
    '    return os.getcwd()',
    '',
    'class Worker:',
    '    def nested(self):',
    '        return True',
  ].join('\n');

  const result = chunkSource('worker.py', source, { ...OPTIONS, maxFragmentLines: 5 }, 'auto');
  assert.equal(result.method, 'structure');
  assert.deepEqual(declarationStarts('worker.py', source), [2, 5]);
  assert.equal(result.fragments.length, 2);
  assert.match(result.fragments[1]?.text ?? '', /class Worker/);
  assert.match(result.fragments[1]?.text ?? '', /def nested/);
});

test('unsupported files and single-declaration files fall back to windows', () => {
  assert.equal(chunkSource('README.md', '# Title\ntext', OPTIONS, 'auto').method, 'window');
  assert.equal(chunkSource('one.ts', 'export function only() { return 1; }', OPTIONS, 'auto').method, 'window');
});

test('oversized declarations retain structural boundary then window within the declaration', () => {
  const source = [
    'export function first() {',
    ...Array.from({ length: 18 }, (_, index) => `  const value${index} = ${index};`),
    '}',
    'export function second() {',
    '  return 2;',
    '}',
  ].join('\n');

  const result = chunkSource('large.ts', source, { ...OPTIONS, maxFragmentLines: 8 }, 'auto');
  assert.equal(result.method, 'structure');
  assert.ok(result.fragments.length > 2);
  const second = result.fragments.find((fragment) => fragment.text.includes('function second'));
  assert.equal(second?.startLine, 21);
});

test('window mode preserves legacy overlapping line windows', () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = chunkSource('src/a.ts', source, { maxFragmentLines: 5, maxFragmentChars: 10_000, overlapLines: 2 }, 'window');
  assert.equal(result.method, 'window');
  assert.deepEqual(result.fragments.map((fragment) => [fragment.startLine, fragment.endLine]), [[1, 5], [4, 8], [7, 11], [10, 12]]);
});


test('auto chunking packs adjacent small declarations within the fragment budget', () => {
  const source = [
    'export function first() { return 1; }',
    '',
    'export function second() { return 2; }',
  ].join('\n');

  const result = chunkSource('small.ts', source, OPTIONS, 'auto');
  assert.equal(result.method, 'structure');
  assert.equal(result.fragments.length, 1);
  assert.match(result.fragments[0]?.text ?? '', /function first/);
  assert.match(result.fragments[0]?.text ?? '', /function second/);
});
