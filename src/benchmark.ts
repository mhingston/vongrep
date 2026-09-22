import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { searchCode } from './search.ts';
import type { RelevanceEvaluator } from './types.ts';

export type BenchmarkCase = {
  query: string;
  expected_paths: string[];
  scope?: string[];
};

export type BenchmarkDataset = {
  name?: string;
  cases: BenchmarkCase[];
};

export type BenchmarkCaseResult = {
  query: string;
  expectedPaths: string[];
  returnedPaths: string[];
  firstRelevantRank: number | null;
  reciprocalRank: number;
  pathRecall: number;
  elapsedMs: number;
};

export type BenchmarkResult = {
  dataset: string;
  cases: number;
  k: number;
  hitAtK: number;
  mrr: number;
  meanPathRecall: number;
  results: BenchmarkCaseResult[];
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export function parseBenchmarkDataset(input: unknown): BenchmarkDataset {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('benchmark dataset must be a JSON object');
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw new Error('benchmark dataset must contain a non-empty cases array');
  }

  const cases = record.cases.map((item, index): BenchmarkCase => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`benchmark case ${index + 1} must be an object`);
    }
    const value = item as Record<string, unknown>;
    if (typeof value.query !== 'string' || value.query.trim().length === 0) {
      throw new Error(`benchmark case ${index + 1} requires a non-empty query`);
    }
    if (!Array.isArray(value.expected_paths) || value.expected_paths.length === 0
      || value.expected_paths.some((path) => typeof path !== 'string' || path.trim().length === 0)) {
      throw new Error(`benchmark case ${index + 1} requires expected_paths`);
    }
    if (value.scope !== undefined
      && (!Array.isArray(value.scope) || value.scope.some((path) => typeof path !== 'string'))) {
      throw new Error(`benchmark case ${index + 1} scope must be an array of strings`);
    }
    return {
      query: value.query,
      expected_paths: (value.expected_paths as string[]).map(normalizePath),
      ...(value.scope === undefined ? {} : { scope: (value.scope as string[]).map(normalizePath) }),
    };
  });

  return {
    ...(typeof record.name === 'string' && record.name.trim().length > 0 ? { name: record.name } : {}),
    cases,
  };
}

export async function loadBenchmarkDataset(path: string): Promise<BenchmarkDataset> {
  const input = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  return parseBenchmarkDataset(input);
}

export async function runBenchmark(options: {
  root: string;
  dataset: BenchmarkDataset;
  k?: number;
}, evaluator?: RelevanceEvaluator): Promise<BenchmarkResult> {
  const k = options.k ?? 5;
  if (!Number.isSafeInteger(k) || k < 1 || k > 100) {
    throw new Error('benchmark k must be an integer from 1 to 100');
  }

  const results: BenchmarkCaseResult[] = [];
  for (const item of options.dataset.cases) {
    const started = Date.now();
    const search = await searchCode({
      root: options.root,
      query: item.query,
      scopes: item.scope,
      threshold: 0,
      limit: k,
    }, evaluator);
    const returnedPaths = search.results.map((result) => normalizePath(result.path));
    const expected = new Set(item.expected_paths.map(normalizePath));
    const firstIndex = returnedPaths.findIndex((path) => expected.has(path));
    const returnedExpected = new Set(returnedPaths.filter((path) => expected.has(path)));
    const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
    results.push({
      query: item.query,
      expectedPaths: [...expected],
      returnedPaths,
      firstRelevantRank,
      reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
      pathRecall: returnedExpected.size / expected.size,
      elapsedMs: Date.now() - started,
    });
  }

  const count = results.length;
  return {
    dataset: options.dataset.name ?? 'benchmark',
    cases: count,
    k,
    hitAtK: results.filter((item) => item.firstRelevantRank !== null).length / count,
    mrr: results.reduce((sum, item) => sum + item.reciprocalRank, 0) / count,
    meanPathRecall: results.reduce((sum, item) => sum + item.pathRecall, 0) / count,
    results,
  };
}
