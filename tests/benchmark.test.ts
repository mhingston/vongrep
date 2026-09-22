import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareChunking, parseBenchmarkDataset, runBenchmark } from '../src/benchmark.ts';
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

class LineAwareEvaluator implements RelevanceEvaluator {
  readonly model = 'fake-von';

  async score(_query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]> {
    return fragments.map((fragment) => ({
      ...fragment,
      score: fragment.text.includes('expireSession') ? 0.99 : fragment.path === 'auth.ts' ? 0.8 : 0.1,
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

test('expected_locations can supply paths and validate inclusive ranges', () => {
  const dataset = parseBenchmarkDataset({
    cases: [{
      query: 'Where is session expiry?',
      expected_locations: [{ path: './auth.ts', start_line: 10, end_line: 20 }],
    }],
  });

  assert.deepEqual(dataset.cases[0]?.expected_paths, ['auth.ts']);
  assert.deepEqual(dataset.cases[0]?.expected_locations, [{ path: 'auth.ts', start_line: 10, end_line: 20 }]);

  assert.throws(() => parseBenchmarkDataset({
    cases: [{
      query: 'bad',
      expected_locations: [{ path: 'auth.ts', start_line: 20, end_line: 10 }],
    }],
  }), /valid inclusive line numbers/);
});

test('runBenchmark reports path metrics for path-only labels', async () => {
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
  const result = await runBenchmark({ root, dataset, k: 2, chunking: 'window' }, new QueryAwareEvaluator());

  assert.equal(result.cases, 2);
  assert.equal(result.chunking, 'window');
  assert.equal(result.hitAtK, 1);
  assert.equal(result.mrr, 1);
  assert.equal(result.meanPathRecall, 1);
  assert.equal(result.locationCases, 0);
  assert.equal(result.locationHitAtK, null);
  assert.deepEqual(result.results.map((item) => item.firstRelevantRank), [1, 1]);
});

test('runBenchmark scores returned excerpts by overlap with labelled line ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-benchmark-'));
  const auth = [
    'export function unrelated() {',
    '  return false;',
    '}',
    '',
    'export function expireSession() {',
    '  return true;',
    '}',
  ].join('\n');
  await writeFile(join(root, 'auth.ts'), auth);
  await writeFile(join(root, 'other.ts'), 'export function noop() {}\n');

  const dataset = parseBenchmarkDataset({
    name: 'locations',
    cases: [{
      query: 'Where is session expiry?',
      expected_locations: [{ path: 'auth.ts', start_line: 5, end_line: 7 }],
    }],
  });
  const result = await runBenchmark({ root, dataset, k: 3, chunking: 'auto' }, new LineAwareEvaluator());

  assert.equal(result.locationCases, 1);
  assert.equal(result.locationHitAtK, 1);
  assert.equal(result.locationMrr, 1);
  assert.equal(result.meanLocationRecall, 1);
  assert.equal(result.results[0]?.firstLocationRank, 1);
  assert.equal(result.results[0]?.locationRecall, 1);
  assert.ok((result.results[0]?.fragmentsScored ?? 0) > 0);
});

test('compareChunking reports both modes and deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-benchmark-'));
  await writeFile(join(root, 'auth.ts'), [
    'export function unrelated() { return false; }',
    '',
    'export function expireSession() { return true; }',
  ].join('\n'));

  const dataset = parseBenchmarkDataset({
    name: 'compare',
    cases: [{
      query: 'Where is session expiry?',
      expected_locations: [{ path: 'auth.ts', start_line: 3, end_line: 3 }],
    }],
  });

  const comparison = await compareChunking({ root, dataset, k: 3 }, new LineAwareEvaluator());
  assert.equal(comparison.auto.chunking, 'auto');
  assert.equal(comparison.window.chunking, 'window');
  assert.equal(comparison.delta.locationHitAtK, 0);
  assert.ok(Number.isFinite(comparison.delta.meanFragmentsScored));
});
