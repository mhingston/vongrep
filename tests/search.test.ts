import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { searchCode, selectDistinctFragments } from '../src/search.ts';
import { prepareSource } from '../src/source.ts';
import type { RelevanceEvaluator, ScoredFragment, SourceFragment } from '../src/types.ts';

class FakeEvaluator implements RelevanceEvaluator {
  readonly model = 'fake-von';

  async score(_query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]> {
    return fragments.map((fragment) => ({ ...fragment, score: fragment.text.includes('expireSession') ? 0.95 : 0.1 }));
  }
}

test('searchCode ranks and filters original excerpts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-'));
  await writeFile(join(root, 'auth.ts'), 'export function expireSession() { return true; }\n');
  await writeFile(join(root, 'other.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  const result = await searchCode({ root, query: 'Where is session expiry handled?', threshold: 0.5 }, new FakeEvaluator());
  assert.equal(result.model, 'fake-von');
  assert.equal(result.filesScanned, 2);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.path, 'auth.ts');
  assert.match(result.results[0]?.text ?? '', /expireSession/);
});

test('prepared fragment ids are unique across files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');

  const prepared = await prepareSource(root, [], {
    maxFileBytes: 1024, maxFragmentLines: 60, maxFragmentChars: 3500, overlapLines: 8,
  });
  const ids = prepared.fragments.map((fragment) => fragment.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('selectDistinctFragments suppresses lower-ranked overlapping windows', () => {
  const ranked: ScoredFragment[] = [
    { id: 'a', path: 'src/a.ts', startLine: 1, endLine: 10, text: 'a', score: 0.9 },
    { id: 'b', path: 'src/a.ts', startLine: 8, endLine: 15, text: 'b', score: 0.8 },
    { id: 'c', path: 'src/a.ts', startLine: 20, endLine: 30, text: 'c', score: 0.7 },
    { id: 'd', path: 'src/b.ts', startLine: 1, endLine: 10, text: 'd', score: 0.6 },
  ];

  assert.deepEqual(selectDistinctFragments(ranked, 0.5, 10).map((item) => item.id), ['a', 'c', 'd']);
});
