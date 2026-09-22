#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareSource } from './source.ts';
import { runMcpServer } from './mcp.ts';
import { searchCode } from './search.ts';
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

function help(): string {
  return `vongrep - local semantic code search powered by Von\n\nUsage:\n  vongrep search --query "Where is session expiry handled?" [options]\n  vongrep inspect [--root .] [--scope src]\n  vongrep doctor [--base-url http://localhost:8000]\n  vongrep mcp [--root .] [--base-url http://localhost:8000]\n\nSearch options:\n  --root <path>        Repository root (default: .)\n  --scope <path>       Limit search to a repository-relative path; repeatable\n  --threshold <0..1>   Minimum Von relevance probability (default: 0.5)\n  --limit <n>          Maximum excerpts to return (default: 10)\n  --base-url <url>     Von server URL (default: VON_BASE_URL or http://localhost:8000)\n  --json               Emit JSON instead of human-readable output\n\nVon must be running locally, for example:\n  von serve --host 127.0.0.1 --port 8000`;
}

function render(result: Awaited<ReturnType<typeof searchCode>>): string {
  const lines = [
    `vongrep: ${result.results.length} result(s) from ${result.fragmentsScored} fragments in ${result.filesScanned} files`,
    `model: ${result.model}  threshold: ${result.threshold.toFixed(2)}`,
    '',
  ];
  for (const item of result.results) {
    lines.push(`${item.path}:${item.startLine}-${item.endLine}  score=${item.score.toFixed(3)}`);
    lines.push(item.text);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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
    await runMcpServer({ root, baseURL, apiKey: process.env.VON_API_KEY });
    return;
  }

  if (parsed.command === 'search') {
    const query = one(parsed, 'query') ?? parsed.positional.join(' ');
    if (!query) throw new Error('search requires --query <text>');
    const evaluator = new VonEvaluator({ baseURL, apiKey: process.env.VON_API_KEY });
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
