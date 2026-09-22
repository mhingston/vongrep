import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { SourceFragment } from './types.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', 'vendor', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__',
]);

const SENSITIVE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.key$/i,
  /credentials?/i,
];

export type SourceOptions = {
  maxFileBytes: number;
  maxFragmentLines: number;
  maxFragmentChars: number;
  overlapLines: number;
};

export type PreparedSource = {
  filesScanned: number;
  fragments: SourceFragment[];
};

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function scopeMatches(path: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function isSensitive(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.split('\0').filter(Boolean).map(normalizePath).sort();
  } catch {
    return null;
  }
}

async function walkFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(root, absolute)));
    }
  }
  return files;
}

async function listFiles(root: string): Promise<string[]> {
  return (await gitFiles(root)) ?? walkFiles(root);
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

export function chunkText(
  path: string,
  text: string,
  options: Pick<SourceOptions, 'maxFragmentLines' | 'maxFragmentChars' | 'overlapLines'>,
): SourceFragment[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const fragments: SourceFragment[] = [];
  let start = 0;
  let index = 0;

  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < options.maxFragmentLines) {
      const next = (lines[end]?.length ?? 0) + 1;
      if (end > start && chars + next > options.maxFragmentChars) break;
      chars += next;
      end += 1;
      if (chars >= options.maxFragmentChars) break;
    }
    if (end === start) end = Math.min(start + 1, lines.length);

    const excerpt = lines.slice(start, end).join('\n');
    if (excerpt.trim().length > 0) {
      fragments.push({
        id: `f${index}`,
        path,
        startLine: start + 1,
        endLine: end,
        text: excerpt,
      });
      index += 1;
    }

    if (end >= lines.length) break;
    const nextStart = Math.max(start + 1, end - options.overlapLines);
    start = nextStart;
  }

  return fragments;
}

export async function prepareSource(
  requestedRoot: string,
  scopes: readonly string[],
  options: SourceOptions,
): Promise<PreparedSource> {
  const root = await realpath(resolve(requestedRoot));
  const normalizedScopes = scopes.map((scope) => normalizePath(scope.replace(/^\.\//, '').replace(/\/$/, ''))).filter(Boolean);
  const candidates = await listFiles(root);
  const fragments: SourceFragment[] = [];
  let filesScanned = 0;

  for (const path of candidates) {
    if (!scopeMatches(path, normalizedScopes)) continue;
    if (isSensitive(path)) continue;
    if (path.split('/').some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment))) continue;

    const absolute = resolve(root, path);
    if (!isWithin(root, absolute)) continue;

    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > options.maxFileBytes) continue;

    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;

    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) continue;
    filesScanned += 1;
    for (const fragment of chunkText(path, text, options)) {
      fragments.push({ ...fragment, id: `f${fragments.length}` });
    }
  }

  return { filesScanned, fragments };
}
