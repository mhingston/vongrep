import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { prepareSource } from './source.ts';
import type { RelevanceEvaluator, ScoredFragment, SearchOptions, SearchResult, SourceFragment } from './types.ts';
import { VonEvaluator } from './von.ts';

const DEFAULTS = Object.freeze({
  threshold: 0.5,
  limit: 10,
  maxFileBytes: 512 * 1024,
  maxFragmentLines: 60,
  maxFragmentChars: 3_500,
  overlapLines: 8,
  batchSize: 8,
});

function validate(options: SearchOptions): void {
  if (options.query.trim().length === 0) throw new Error('query must not be empty');
  const threshold = options.threshold ?? DEFAULTS.threshold;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be between 0 and 1');
  const limit = options.limit ?? DEFAULTS.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
}

export async function searchCode(options: SearchOptions, evaluator?: RelevanceEvaluator): Promise<SearchResult> {
  validate(options);
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const limit = options.limit ?? DEFAULTS.limit;
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error('batchSize must be an integer from 1 to 64');

  const root = await realpath(resolve(options.root));
  const prepared = await prepareSource(root, options.scopes ?? [], {
    maxFileBytes: options.maxFileBytes ?? DEFAULTS.maxFileBytes,
    maxFragmentLines: options.maxFragmentLines ?? DEFAULTS.maxFragmentLines,
    maxFragmentChars: options.maxFragmentChars ?? DEFAULTS.maxFragmentChars,
    overlapLines: options.overlapLines ?? DEFAULTS.overlapLines,
  });
  const scorer = evaluator ?? new VonEvaluator();
  const scored: ScoredFragment[] = [];

  for (let index = 0; index < prepared.fragments.length; index += batchSize) {
    const batch: SourceFragment[] = prepared.fragments.slice(index, index + batchSize);
    scored.push(...await scorer.score(options.query, batch));
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);

  return {
    query: options.query,
    root,
    model: scorer.model,
    filesScanned: prepared.filesScanned,
    fragmentsScored: scored.length,
    threshold,
    results: scored.filter((fragment) => fragment.score >= threshold).slice(0, limit),
  };
}
