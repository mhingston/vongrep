import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkText } from '../src/source.ts';

test('chunkText returns stable one-based ranges with overlap', () => {
  const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
  const chunks = chunkText('src/a.ts', text, { maxFragmentLines: 5, maxFragmentChars: 10_000, overlapLines: 2 });
  assert.deepEqual(chunks.map((chunk) => [chunk.startLine, chunk.endLine]), [[1, 5], [4, 8], [7, 11], [10, 12]]);
  assert.equal(chunks[0]?.text, 'line 1\nline 2\nline 3\nline 4\nline 5');
});

test('chunkText also bounds chunks by characters', () => {
  const chunks = chunkText('README.md', 'aaaa\nbbbb\ncccc', { maxFragmentLines: 100, maxFragmentChars: 6, overlapLines: 0 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['aaaa', 'bbbb', 'cccc']);
});
