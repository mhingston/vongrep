import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBenchmarkDataset, runBenchmark } from '../src/benchmark.ts';
import type { RelevanceEvaluator, ScoredFragment, SourceFragment } from '../src/types.ts';

class QueryAwareEvaluator implements RelevanceEvaluator {
  readonly model = 'fake-von';

  async score(query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]> {
    const target = query.includes('session') ? 'auth.ts' : 'queue.ts';
    return fragments.map((fragment) => ({
      ...fragment,
      score: fragment.path === target ? 0.95 : 0.1,
    }));
  }
}

test('parseBenchmarkDataset validates labelled cases', () => {
  const dataset = parseBenchmarkDataset({
    name: 'tiny',
    cases: [{ query: 'Where is session expiry?', expected_paths: ['./auth.ts'] }],
  });
  assert.equal(dataset.name, 'tiny');
  assert.deepEqual(dataset.cases[0]?.expected_paths, ['auth.ts']);
});

test('runBenchmark reports hit@k, MRR and expected-path recall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-benchmark-'));
  await writeFile(join(root, 'auth.ts'), 'export function expireSession() {}\n');
  await writeFile(join(root, 'queue.ts'), 'export function publish() {}\n');
  await writeFile(join(root, 'other.ts'), 'export function noop() {}\n');

  const dataset = parseBenchmarkDataset({
    name: 'tiny',
    cases: [
      { query: 'Where is session expiry?', expected_paths: ['auth.ts'] },
      { query: 'Where is the event published?', expected_paths: ['queue.ts'] },
    ],
  });
  const result = await runBenchmark({ root, dataset, k: 2 }, new QueryAwareEvaluator());

  assert.equal(result.cases, 2);
  assert.equal(result.hitAtK, 1);
  assert.equal(result.mrr, 1);
  assert.equal(result.meanPathRecall, 1);
  assert.deepEqual(result.results.map((item) => item.firstRelevantRank), [1, 1]);
});
