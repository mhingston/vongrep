import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { searchCode } from '../src/search.ts';
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
