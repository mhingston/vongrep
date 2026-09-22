import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CachingEvaluator, ScoreCache, scoreCacheKey } from '../src/cache.ts';
import type { RelevanceEvaluator, ScoredFragment, SourceFragment } from '../src/types.ts';

class CountingEvaluator implements RelevanceEvaluator {
  readonly model = 'von-test';
  calls = 0;

  async score(_query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]> {
    this.calls += 1;
    return fragments.map((fragment) => ({ ...fragment, score: fragment.path.includes('auth') ? 0.9 : 0.2 }));
  }
}

const fragment: SourceFragment = {
  id: 'f1', path: 'src/auth.ts', startLine: 1, endLine: 5, text: 'export function expireSession() {}',
};

test('score cache key changes when search or source identity changes', () => {
  const base = scoreCacheKey('session expiry', fragment, 'von-1.1.0');
  assert.notEqual(base, scoreCacheKey('permissions', fragment, 'von-1.1.0'));
  assert.notEqual(base, scoreCacheKey('session expiry', { ...fragment, text: 'changed' }, 'von-1.1.0'));
  assert.notEqual(base, scoreCacheKey('session expiry', fragment, 'von-1.2.0'));
});

test('CachingEvaluator reuses scores without calling the delegate again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vongrep-cache-'));
  const delegate = new CountingEvaluator();
  const evaluator = new CachingEvaluator(delegate, new ScoreCache({ directory }));

  const first = await evaluator.score('session expiry', [fragment]);
  const second = await evaluator.score('session expiry', [fragment]);

  assert.equal(first[0]?.score, 0.9);
  assert.equal(second[0]?.score, 0.9);
  assert.equal(delegate.calls, 1);
  assert.deepEqual(evaluator.cacheStats, { hits: 1, misses: 1, writes: 1 });
});

test('ScoreCache clear removes persisted entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vongrep-cache-'));
  const cache = new ScoreCache({ directory });
  const key = scoreCacheKey('session expiry', fragment, 'von-1.1.0');

  await cache.write(key, 0.75);
  assert.equal((await cache.status()).entries, 1);
  await cache.clear();
  assert.deepEqual(await cache.status(), { directory, entries: 0, bytes: 0 });
});
