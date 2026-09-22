#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkDataset, runBenchmark } from './benchmark.ts';
import { CachingEvaluator, ScoreCache } from './cache.ts';
import { prepareSource } from './source.ts';
import { runMcpServer } from './mcp.ts';
import { searchCode } from './search.ts';
import type { RelevanceEvaluator } from './types.ts';
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

function createSearchEvaluator(baseURL: string, cacheEnabled: boolean): RelevanceEvaluator {
  const von = new VonEvaluator({ baseURL, apiKey: process.env.VON_API_KEY });
  return cacheEnabled ? new CachingEvaluator(von, new ScoreCache()) : von;
}

function help(): string {
  return `vongrep - local semantic code search powered by Von

Usage:
  vongrep search --query "Where is session expiry handled?" [options]
  vongrep inspect [--root .] [--scope src]
  vongrep doctor [--base-url http://localhost:8000]
  vongrep benchmark --dataset benchmarks.json [--root .] [--limit 5]
  vongrep cache [status|clear] [--json]
  vongrep mcp [--root .] [--base-url http://localhost:8000] [--no-cache]

Search options:
  --root <path>        Repository root (default: .)
  --scope <path>       Limit search to a repository-relative path; repeatable
  --threshold <0..1>   Minimum Von relevance probability (default: 0.5)
  --limit <n>          Maximum excerpts to return (default: 10)
  --base-url <url>     Von server URL (default: VON_BASE_URL or http://localhost:8000)
  --no-cache           Bypass the local score cache
  --json               Emit JSON instead of human-readable output

Benchmark options:
  --dataset <path>     JSON dataset containing query + expected_paths cases
  --limit <n>          Evaluate Hit@K using K results (default: 5)
  --json               Emit the full benchmark result as JSON
  Benchmarks always bypass the score cache.

Von must be running locally, for example:
  von serve --host 127.0.0.1 --port 8000`;
}

function render(result: Awaited<ReturnType<typeof searchCode>>): string {
  const lines = [
    `vongrep: ${result.results.length} result(s) from ${result.fragmentsScored} fragments in ${result.filesScanned} files`,
    `model: ${result.model}  threshold: ${result.threshold.toFixed(2)}`,
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
  const lines = [
    `${result.dataset}: ${result.cases} case(s), Hit@${result.k} ${(result.hitAtK * 100).toFixed(1)}%, MRR ${result.mrr.toFixed(3)}, path recall ${(result.meanPathRecall * 100).toFixed(1)}%`,
    '',
  ];
  for (const item of result.results) {
    const rank = item.firstRelevantRank === null ? 'MISS' : `rank ${item.firstRelevantRank}`;
    lines.push(`${rank.padEnd(7)}  ${item.query}`);
  }
  return lines.join('\n').trimEnd();
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
    });
    console.log(JSON.stringify({ root: resolve(root), files: prepared.filesScanned, fragments: prepared.fragments.length }, null, 2));
    return;
  }

  if (parsed.command === 'mcp') {
    await runMcpServer({
      root,
      baseURL,
      apiKey: process.env.VON_API_KEY,
      cache: !parsed.flags.has('no-cache'),
    });
    return;
  }

  if (parsed.command === 'benchmark') {
    const datasetPath = one(parsed, 'dataset') ?? parsed.positional[0];
    if (!datasetPath) throw new Error('benchmark requires --dataset <path>');
    const dataset = await loadBenchmarkDataset(datasetPath);
    const evaluator = new VonEvaluator({ baseURL, apiKey: process.env.VON_API_KEY });
    const result = await runBenchmark({
      root,
      dataset,
      k: numberFlag(parsed, 'limit'),
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
