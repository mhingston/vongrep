#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareChunking, loadBenchmarkDataset, runBenchmark } from './benchmark.ts';
import { CachingEvaluator, ScoreCache } from './cache.ts';
import { prepareSource } from './source.ts';
import { runMcpServer } from './mcp.ts';
import { searchCode } from './search.ts';
import type { ChunkingMode, RelevanceEvaluator } from './types.ts';
import { checkVonHealth, VonEvaluator } from './von.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Parsed = { command: string; positional: string[]; flags: Map<string, string[]> };

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let command = 'help';
  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey!;
    let value = inline;
    if (value === undefined && argv[index + 1] && !argv[index + 1]!.startsWith('--')) {
      value = argv[++index]!;
    }
    const values = flags.get(key) ?? [];
    values.push(value ?? 'true');
    flags.set(key, values);
  }
  return { command, positional, flags };
}

function one(parsed: Parsed, key: string): string | undefined {
  return parsed.flags.get(key)?.at(-1);
}

function many(parsed: Parsed, key: string): string[] {
  return parsed.flags.get(key) ?? [];
}

function numberFlag(parsed: Parsed, key: string): number | undefined {
  const value = one(parsed, key);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) throw new Error(`--${key} must be a number`);
  return parsedValue;
}

function chunkingFlag(parsed: Parsed): ChunkingMode {
  const value = one(parsed, 'chunking') ?? 'auto';
  if (value !== 'auto' && value !== 'window') {
    throw new Error('--chunking must be auto or window');
  }
  return value;
}

function createSearchEvaluator(baseURL: string, cacheEnabled: boolean): RelevanceEvaluator {
  const von = new VonEvaluator({ baseURL, apiKey: process.env.VON_API_KEY });
  return cacheEnabled ? new CachingEvaluator(von, new ScoreCache()) : von;
}

function help(): string {
  return `vongrep - local semantic code search powered by Von

Usage:
  vongrep search --query "Where is session expiry handled?" [options]
  vongrep inspect [--root .] [--scope src] [--chunking auto|window] [--json]
  vongrep doctor [--base-url http://localhost:8000]
  vongrep benchmark --dataset benchmarks.json [--root .] [--limit 5] [--chunking auto|window]
  vongrep benchmark --dataset benchmarks.json --compare-chunking [--limit 5]
  vongrep cache [status|clear] [--json]
  vongrep mcp [--root .] [--base-url http://localhost:8000] [--chunking auto|window] [--no-cache]

Search options:
  --root <path>        Repository root (default: .)
  --scope <path>       Limit search to a repository-relative path; repeatable
  --threshold <0..1>   Minimum Von relevance probability (default: 0.5)
  --limit <n>          Maximum excerpts to return (default: 10)
  --base-url <url>     Von server URL (default: VON_BASE_URL or http://localhost:8000)
  --chunking <mode>     auto (default) or window
  --no-cache           Bypass the local score cache
  --json               Emit JSON instead of human-readable output

Benchmark options:
  --dataset <path>     JSON dataset containing query + expected_paths cases
  --limit <n>          Evaluate Hit@K using K results (default: 5)
  --chunking <mode>     auto (default) or window
  --compare-chunking    Run auto and window against the same dataset
  --json               Emit the full benchmark result as JSON
  Benchmarks always bypass the score cache.

Von must be running locally, for example:
  von serve --host 127.0.0.1 --port 8000`;
}

function render(result: Awaited<ReturnType<typeof searchCode>>): string {
  const lines = [
    `vongrep: ${result.results.length} result(s) from ${result.fragmentsScored} fragments in ${result.filesScanned} files`,
    `model: ${result.model}  threshold: ${result.threshold.toFixed(2)}`,
    `chunking: ${result.chunking.mode} (${result.chunking.structuredFiles} structured, ${result.chunking.windowFiles} windowed)`,
  ];
  if (result.cache !== undefined) {
    lines.push(`cache: ${result.cache.hits} hit(s), ${result.cache.misses} miss(es)`);
  }
  lines.push('');
  for (const item of result.results) {
    lines.push(`${item.path}:${item.startLine}-${item.endLine}  score=${item.score.toFixed(3)}`);
    lines.push(item.text);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderBenchmark(result: Awaited<ReturnType<typeof runBenchmark>>): string {
  const location = result.locationCases === 0
    ? 'locations: no line-labelled cases'
    : `location Hit@${result.k} ${((result.locationHitAtK ?? 0) * 100).toFixed(1)}%, location MRR ${(result.locationMrr ?? 0).toFixed(3)}, location recall ${((result.meanLocationRecall ?? 0) * 100).toFixed(1)}%`;
  const lines = [
    `${result.dataset}: ${result.cases} case(s), chunking ${result.chunking}`,
    `path Hit@${result.k} ${(result.hitAtK * 100).toFixed(1)}%, MRR ${result.mrr.toFixed(3)}, path recall ${(result.meanPathRecall * 100).toFixed(1)}%`,
    location,
    `mean fragments scored: ${result.meanFragmentsScored.toFixed(1)}  total time: ${result.totalElapsedMs}ms`,
    '',
  ];
  for (const item of result.results) {
    const rank = item.firstRelevantRank === null ? 'MISS' : `rank ${item.firstRelevantRank}`;
    const locationRank = item.expectedLocations.length === 0
      ? ''
      : item.firstLocationRank === null ? '  location MISS' : `  location rank ${item.firstLocationRank}`;
    lines.push(`${rank.padEnd(7)}  ${item.query}${locationRank}`);
  }
  return lines.join('\n').trimEnd();
}

function renderComparison(result: Awaited<ReturnType<typeof compareChunking>>): string {
  const percent = (value: number | null): string => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const signed = (value: number | null, scale = 1): string => {
    if (value === null) return 'n/a';
    const adjusted = value * scale;
    return `${adjusted >= 0 ? '+' : ''}${adjusted.toFixed(scale === 100 ? 1 : 3)}`;
  };
  return [
    `${result.dataset}: chunking comparison at K=${result.k}`,
    '',
    'metric                  auto       window     delta(auto-window)',
    `path Hit@K              ${percent(result.auto.hitAtK).padEnd(10)} ${percent(result.window.hitAtK).padEnd(10)} ${signed(result.delta.hitAtK, 100)}pp`,
    `path MRR                ${result.auto.mrr.toFixed(3).padEnd(10)} ${result.window.mrr.toFixed(3).padEnd(10)} ${signed(result.delta.mrr)}`,
    `location Hit@K          ${percent(result.auto.locationHitAtK).padEnd(10)} ${percent(result.window.locationHitAtK).padEnd(10)} ${signed(result.delta.locationHitAtK, 100)}pp`,
    `location MRR            ${(result.auto.locationMrr?.toFixed(3) ?? 'n/a').padEnd(10)} ${(result.window.locationMrr?.toFixed(3) ?? 'n/a').padEnd(10)} ${signed(result.delta.locationMrr)}`,
    `location recall         ${percent(result.auto.meanLocationRecall).padEnd(10)} ${percent(result.window.meanLocationRecall).padEnd(10)} ${signed(result.delta.meanLocationRecall, 100)}pp`,
    `mean fragments scored   ${result.auto.meanFragmentsScored.toFixed(1).padEnd(10)} ${result.window.meanFragmentsScored.toFixed(1).padEnd(10)} ${signed(result.delta.meanFragmentsScored)}`,
    'total time              ' + `${result.auto.totalElapsedMs}ms`.padEnd(10) + ' ' + `${result.window.totalElapsedMs}ms`.padEnd(10) + ' ' + `${result.delta.totalElapsedMs >= 0 ? '+' : ''}${result.delta.totalElapsedMs}ms`,
  ].join('\n');
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderInspect(root: string, report: Awaited<ReturnType<typeof prepareSource>>['report']): string {
  const exclusions = Object.entries(report.excludedByReason)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const lines = [
    `vongrep inspect: ${report.eligibleFiles} eligible file(s), ${report.fragments} fragment(s), ${humanBytes(report.eligibleBytes)}`,
    `root: ${root}`,
    `discovery: ${report.discovery}`,
    `scope: ${report.scopes.length === 0 ? 'entire repository' : report.scopes.join(', ')}`,
    `chunking: ${report.chunking.mode} (${report.chunking.structuredFiles} structured, ${report.chunking.windowFiles} windowed)`,
    `.vgignore: ${report.vgignore.present ? `${report.vgignore.rules} rule(s)` : 'not present'}`,
    `discovered candidates: ${report.discoveredFiles}`,
  ];
  if (exclusions.length > 0) {
    lines.push('', 'excluded:');
    for (const [reason, count] of exclusions) lines.push(`  ${reason}: ${count}`);
  }
  return lines.join('\n');
}

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? 'unknown';
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (parsed.command === 'version' || parsed.flags.has('version')) {
    console.log(await version());
    return;
  }
  if (parsed.command === 'help' || parsed.flags.has('help')) {
    console.log(help());
    return;
  }

  const root = one(parsed, 'root') ?? '.';
  const baseURL = one(parsed, 'base-url') ?? process.env.VON_BASE_URL ?? 'http://localhost:8000';

  if (parsed.command === 'doctor') {
    const health = await checkVonHealth(baseURL);
    console.log(`Von: ${String(health.status ?? 'unknown')} (${String(health.engine ?? health.version ?? 'unknown')}) at ${baseURL}`);
    return;
  }

  if (parsed.command === 'cache') {
    const cache = new ScoreCache();
    const action = parsed.positional[0] ?? 'status';
    if (action === 'clear') {
      await cache.clear();
      console.log(`Cleared vongrep cache at ${cache.directory}`);
      return;
    }
    if (action !== 'status') throw new Error('cache expects status or clear');
    const status = await cache.status();
    if (parsed.flags.has('json')) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Cache: ${status.entries} entries, ${humanBytes(status.bytes)}\n${status.directory}`);
    }
    return;
  }

  if (parsed.command === 'inspect') {
    const prepared = await prepareSource(root, many(parsed, 'scope'), {
      maxFileBytes: 512 * 1024,
      maxFragmentLines: 60,
      maxFragmentChars: 3_500,
      overlapLines: 8,
      chunking: chunkingFlag(parsed),
    });
    const resolvedRoot = resolve(root);
    if (parsed.flags.has('json')) {
      console.log(JSON.stringify({ root: resolvedRoot, ...prepared.report }, null, 2));
    } else {
      console.log(renderInspect(resolvedRoot, prepared.report));
    }
    return;
  }

  if (parsed.command === 'mcp') {
    await runMcpServer({
      root,
      baseURL,
      apiKey: process.env.VON_API_KEY,
      cache: !parsed.flags.has('no-cache'),
      chunking: chunkingFlag(parsed),
    });
    return;
  }

  if (parsed.command === 'benchmark') {
    const datasetPath = one(parsed, 'dataset') ?? parsed.positional[0];
    if (!datasetPath) throw new Error('benchmark requires --dataset <path>');
    const dataset = await loadBenchmarkDataset(datasetPath);
    const evaluator = new VonEvaluator({ baseURL, apiKey: process.env.VON_API_KEY });
    if (parsed.flags.has('compare-chunking')) {
      if (parsed.flags.has('chunking')) {
        throw new Error('--compare-chunking cannot be combined with --chunking');
      }
      const result = await compareChunking({
        root,
        dataset,
        k: numberFlag(parsed, 'limit'),
      }, evaluator);
      console.log(parsed.flags.has('json') ? JSON.stringify(result, null, 2) : renderComparison(result));
      return;
    }
    const result = await runBenchmark({
      root,
      dataset,
      k: numberFlag(parsed, 'limit'),
      chunking: chunkingFlag(parsed),
    }, evaluator);
    console.log(parsed.flags.has('json') ? JSON.stringify(result, null, 2) : renderBenchmark(result));
    return;
  }

  if (parsed.command === 'search') {
    const query = one(parsed, 'query') ?? parsed.positional.join(' ');
    if (!query) throw new Error('search requires --query <text>');
    const evaluator = createSearchEvaluator(baseURL, !parsed.flags.has('no-cache'));
    const result = await searchCode({
      root,
      query,
      scopes: many(parsed, 'scope'),
      threshold: numberFlag(parsed, 'threshold'),
      limit: numberFlag(parsed, 'limit'),
      chunking: chunkingFlag(parsed),
    }, evaluator);
    console.log(parsed.flags.has('json') ? JSON.stringify(result, null, 2) : render(result));
    return;
  }

  throw new Error(`unknown command: ${parsed.command}\n\n${help()}`);
}

main().catch((error) => {
  console.error(`vongrep: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
