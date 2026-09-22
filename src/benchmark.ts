import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { searchCode } from './search.ts';
import type { ChunkingMode, RelevanceEvaluator, ScoredFragment } from './types.ts';

export type ExpectedLocation = {
  path: string;
  start_line: number;
  end_line: number;
};

export type BenchmarkCase = {
  query: string;
  expected_paths: string[];
  expected_locations?: ExpectedLocation[];
  scope?: string[];
};

export type BenchmarkDataset = {
  name?: string;
  cases: BenchmarkCase[];
};

export type BenchmarkCaseResult = {
  query: string;
  expectedPaths: string[];
  expectedLocations: ExpectedLocation[];
  returnedPaths: string[];
  returnedLocations: Array<{ path: string; startLine: number; endLine: number }>;
  firstRelevantRank: number | null;
  reciprocalRank: number;
  pathRecall: number;
  firstLocationRank: number | null;
  locationReciprocalRank: number | null;
  locationRecall: number | null;
  fragmentsScored: number;
  elapsedMs: number;
};

export type BenchmarkResult = {
  dataset: string;
  cases: number;
  k: number;
  chunking: ChunkingMode;
  hitAtK: number;
  mrr: number;
  meanPathRecall: number;
  locationCases: number;
  locationHitAtK: number | null;
  locationMrr: number | null;
  meanLocationRecall: number | null;
  meanFragmentsScored: number;
  totalElapsedMs: number;
  results: BenchmarkCaseResult[];
};

export type BenchmarkComparison = {
  dataset: string;
  k: number;
  auto: BenchmarkResult;
  window: BenchmarkResult;
  delta: {
    hitAtK: number;
    mrr: number;
    meanPathRecall: number;
    locationHitAtK: number | null;
    locationMrr: number | null;
    meanLocationRecall: number | null;
    meanFragmentsScored: number;
    totalElapsedMs: number;
  };
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function parseExpectedLocation(value: unknown, caseIndex: number, locationIndex: number): ExpectedLocation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`benchmark case ${caseIndex + 1} expected_locations[${locationIndex}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    throw new Error(`benchmark case ${caseIndex + 1} expected_locations[${locationIndex}] requires path`);
  }
  if (!Number.isSafeInteger(record.start_line) || !Number.isSafeInteger(record.end_line)
    || (record.start_line as number) < 1 || (record.end_line as number) < (record.start_line as number)) {
    throw new Error(`benchmark case ${caseIndex + 1} expected_locations[${locationIndex}] requires valid inclusive line numbers`);
  }
  return {
    path: normalizePath(record.path),
    start_line: record.start_line as number,
    end_line: record.end_line as number,
  };
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

    const locations = value.expected_locations === undefined
      ? []
      : Array.isArray(value.expected_locations)
        ? value.expected_locations.map((location, locationIndex) => parseExpectedLocation(location, index, locationIndex))
        : (() => { throw new Error(`benchmark case ${index + 1} expected_locations must be an array`); })();

    const paths = value.expected_paths === undefined
      ? []
      : Array.isArray(value.expected_paths)
        && value.expected_paths.every((path) => typeof path === 'string' && path.trim().length > 0)
        ? (value.expected_paths as string[]).map(normalizePath)
        : (() => { throw new Error(`benchmark case ${index + 1} expected_paths must be an array of non-empty strings`); })();

    const expectedPaths = [...new Set([...paths, ...locations.map((location) => location.path)])];
    if (expectedPaths.length === 0) {
      throw new Error(`benchmark case ${index + 1} requires expected_paths or expected_locations`);
    }

    if (value.scope !== undefined
      && (!Array.isArray(value.scope) || value.scope.some((path) => typeof path !== 'string'))) {
      throw new Error(`benchmark case ${index + 1} scope must be an array of strings`);
    }
    return {
      query: value.query,
      expected_paths: expectedPaths,
      ...(locations.length === 0 ? {} : { expected_locations: locations }),
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

function overlapsExpected(fragment: ScoredFragment, expected: ExpectedLocation): boolean {
  return normalizePath(fragment.path) === expected.path
    && fragment.startLine <= expected.end_line
    && expected.start_line <= fragment.endLine;
}

function nullableMean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runBenchmark(options: {
  root: string;
  dataset: BenchmarkDataset;
  k?: number;
  chunking?: ChunkingMode;
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
      chunking: options.chunking ?? 'auto',
    }, evaluator);

    const returnedPaths = search.results.map((result) => normalizePath(result.path));
    const expected = new Set(item.expected_paths.map(normalizePath));
    const firstIndex = returnedPaths.findIndex((path) => expected.has(path));
    const returnedExpected = new Set(returnedPaths.filter((path) => expected.has(path)));
    const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;

    const expectedLocations = item.expected_locations ?? [];
    const firstLocationIndex = expectedLocations.length === 0
      ? -1
      : search.results.findIndex((fragment) => expectedLocations.some((location) => overlapsExpected(fragment, location)));
    const matchedLocations = expectedLocations.filter((location) =>
      search.results.some((fragment) => overlapsExpected(fragment, location)));
    const firstLocationRank = expectedLocations.length === 0
      ? null
      : firstLocationIndex === -1 ? null : firstLocationIndex + 1;

    results.push({
      query: item.query,
      expectedPaths: [...expected],
      expectedLocations,
      returnedPaths,
      returnedLocations: search.results.map((fragment) => ({
        path: normalizePath(fragment.path),
        startLine: fragment.startLine,
        endLine: fragment.endLine,
      })),
      firstRelevantRank,
      reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
      pathRecall: returnedExpected.size / expected.size,
      firstLocationRank,
      locationReciprocalRank: expectedLocations.length === 0
        ? null
        : firstLocationRank === null ? 0 : 1 / firstLocationRank,
      locationRecall: expectedLocations.length === 0 ? null : matchedLocations.length / expectedLocations.length,
      fragmentsScored: search.fragmentsScored,
      elapsedMs: Date.now() - started,
    });
  }

  const count = results.length;
  const locationResults = results.filter((item) => item.locationRecall !== null);
  return {
    dataset: options.dataset.name ?? 'benchmark',
    cases: count,
    k,
    chunking: options.chunking ?? 'auto',
    hitAtK: results.filter((item) => item.firstRelevantRank !== null).length / count,
    mrr: results.reduce((sum, item) => sum + item.reciprocalRank, 0) / count,
    meanPathRecall: results.reduce((sum, item) => sum + item.pathRecall, 0) / count,
    locationCases: locationResults.length,
    locationHitAtK: locationResults.length === 0
      ? null
      : locationResults.filter((item) => item.firstLocationRank !== null).length / locationResults.length,
    locationMrr: nullableMean(locationResults.map((item) => item.locationReciprocalRank ?? 0)),
    meanLocationRecall: nullableMean(locationResults.map((item) => item.locationRecall ?? 0)),
    meanFragmentsScored: results.reduce((sum, item) => sum + item.fragmentsScored, 0) / count,
    totalElapsedMs: results.reduce((sum, item) => sum + item.elapsedMs, 0),
    results,
  };
}

function nullableDelta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

export async function compareChunking(options: {
  root: string;
  dataset: BenchmarkDataset;
  k?: number;
}, evaluator?: RelevanceEvaluator): Promise<BenchmarkComparison> {
  const auto = await runBenchmark({ ...options, chunking: 'auto' }, evaluator);
  const window = await runBenchmark({ ...options, chunking: 'window' }, evaluator);
  return {
    dataset: auto.dataset,
    k: auto.k,
    auto,
    window,
    delta: {
      hitAtK: auto.hitAtK - window.hitAtK,
      mrr: auto.mrr - window.mrr,
      meanPathRecall: auto.meanPathRecall - window.meanPathRecall,
      locationHitAtK: nullableDelta(auto.locationHitAtK, window.locationHitAtK),
      locationMrr: nullableDelta(auto.locationMrr, window.locationMrr),
      meanLocationRecall: nullableDelta(auto.meanLocationRecall, window.meanLocationRecall),
      meanFragmentsScored: auto.meanFragmentsScored - window.meanFragmentsScored,
      totalElapsedMs: auto.totalElapsedMs - window.totalElapsedMs,
    },
  };
}
