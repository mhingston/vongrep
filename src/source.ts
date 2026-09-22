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

export type ExclusionReason =
  | 'out_of_scope'
  | 'vgignore'
  | 'control_file'
  | 'sensitive_name'
  | 'builtin_directory'
  | 'outside_root'
  | 'unavailable'
  | 'not_regular_file'
  | 'symlink'
  | 'empty'
  | 'too_large'
  | 'binary'
  | 'invalid_utf8';

export type SourceReport = {
  discovery: 'git' | 'filesystem';
  discoveredFiles: number;
  eligibleFiles: number;
  eligibleBytes: number;
  fragments: number;
  scopes: string[];
  vgignore: {
    present: boolean;
    rules: number;
  };
  excludedByReason: Record<ExclusionReason, number>;
};

export type PreparedSource = {
  filesScanned: number;
  fragments: SourceFragment[];
  report: SourceReport;
};

type VgIgnoreRule = {
  negated: boolean;
  regex: RegExp;
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

async function listFiles(root: string): Promise<{ discovery: 'git' | 'filesystem'; files: string[] }> {
  const git = await gitFiles(root);
  return git === null
    ? { discovery: 'filesystem', files: await walkFiles(root) }
    : { discovery: 'git', files: git };
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globBody(pattern: string): string {
  let result = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index]!;
    const next = pattern[index + 1];
    if (current === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        result += '(?:.*/)?';
        index += 2;
      } else {
        result += '.*';
        index += 1;
      }
    } else if (current === '*') {
      result += '[^/]*';
    } else if (current === '?') {
      result += '[^/]';
    } else {
      result += escapeRegex(current);
    }
  }
  return result;
}

export function parseVgIgnore(content: string): VgIgnoreRule[] {
  const rules: VgIgnoreRule[] = [];

  for (const rawLine of content.replaceAll('\r\n', '\n').split('\n')) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
      if (line.length === 0) continue;
    }

    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    if (line.length === 0) continue;

    const hasSlash = line.includes('/');
    const prefix = anchored || hasSlash ? '^' : '(?:^|/)';
    const suffix = '(?:/.*)?$';
    rules.push({ negated, regex: new RegExp(`${prefix}${globBody(line)}${suffix}`) });
  }

  return rules;
}

export function isVgIgnored(path: string, rules: readonly VgIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) ignored = !rule.negated;
  }
  return ignored;
}

async function loadVgIgnore(root: string): Promise<{ present: boolean; rules: VgIgnoreRule[] }> {
  try {
    const buffer = await readFile(resolve(root, '.vgignore'));
    if (buffer.length > 256 * 1024) {
      throw new Error('.vgignore exceeds the 256 KiB safety limit');
    }
    const content = buffer.toString('utf8');
    if (content.includes('\uFFFD')) {
      throw new Error('.vgignore must be valid UTF-8');
    }
    return { present: true, rules: parseVgIgnore(content) };
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause
      && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { present: false, rules: [] };
    }
    throw cause;
  }
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

function emptyExclusions(): Record<ExclusionReason, number> {
  return {
    out_of_scope: 0,
    vgignore: 0,
    control_file: 0,
    sensitive_name: 0,
    builtin_directory: 0,
    outside_root: 0,
    unavailable: 0,
    not_regular_file: 0,
    symlink: 0,
    empty: 0,
    too_large: 0,
    binary: 0,
    invalid_utf8: 0,
  };
}

export async function prepareSource(
  requestedRoot: string,
  scopes: readonly string[],
  options: SourceOptions,
): Promise<PreparedSource> {
  const root = await realpath(resolve(requestedRoot));
  const normalizedScopes = scopes
    .map((scope) => normalizePath(scope.replace(/^\.\//, '').replace(/\/$/, '')))
    .filter(Boolean);
  const inventory = await listFiles(root);
  const vgignore = await loadVgIgnore(root);
  const fragments: SourceFragment[] = [];
  const excludedByReason = emptyExclusions();
  let filesScanned = 0;
  let eligibleBytes = 0;

  const exclude = (reason: ExclusionReason): void => {
    excludedByReason[reason] += 1;
  };

  for (const path of inventory.files) {
    if (!scopeMatches(path, normalizedScopes)) {
      exclude('out_of_scope');
      continue;
    }
    if (path === '.vgignore') {
      exclude('control_file');
      continue;
    }
    if (isVgIgnored(path, vgignore.rules)) {
      exclude('vgignore');
      continue;
    }
    if (isSensitive(path)) {
      exclude('sensitive_name');
      continue;
    }
    if (path.split('/').some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment))) {
      exclude('builtin_directory');
      continue;
    }

    const absolute = resolve(root, path);
    if (!isWithin(root, absolute)) {
      exclude('outside_root');
      continue;
    }

    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (stat.isSymbolicLink()) {
      exclude('symlink');
      continue;
    }
    if (!stat.isFile()) {
      exclude('not_regular_file');
      continue;
    }
    if (stat.size === 0) {
      exclude('empty');
      continue;
    }
    if (stat.size > options.maxFileBytes) {
      exclude('too_large');
      continue;
    }

    let actual: string;
    try {
      actual = await realpath(absolute);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (!isWithin(root, actual)) {
      exclude('outside_root');
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(actual);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (looksBinary(buffer)) {
      exclude('binary');
      continue;
    }

    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
      exclude('invalid_utf8');
      continue;
    }

    filesScanned += 1;
    eligibleBytes += buffer.length;
    for (const fragment of chunkText(path, text, options)) {
      fragments.push({ ...fragment, id: `f${fragments.length}` });
    }
  }

  return {
    filesScanned,
    fragments,
    report: {
      discovery: inventory.discovery,
      discoveredFiles: inventory.files.length,
      eligibleFiles: filesScanned,
      eligibleBytes,
      fragments: fragments.length,
      scopes: normalizedScopes,
      vgignore: { present: vgignore.present, rules: vgignore.rules.length },
      excludedByReason,
    },
  };
}
;
    rules.push({ negated, regex: new RegExp(`${prefix}${globBody(line)}${suffix}`) });
  }

  return rules;
}

export function isVgIgnored(path: string, rules: readonly VgIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) ignored = !rule.negated;
  }
  return ignored;
}

async function loadVgIgnore(root: string): Promise<{ present: boolean; rules: VgIgnoreRule[] }> {
  try {
    const content = await readFile(resolve(root, '.vgignore'), 'utf8');
    return { present: true, rules: parseVgIgnore(content) };
  } catch {
    return { present: false, rules: [] };
  }
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

function emptyExclusions(): Record<ExclusionReason, number> {
  return {
    out_of_scope: 0,
    vgignore: 0,
    control_file: 0,
    sensitive_name: 0,
    builtin_directory: 0,
    outside_root: 0,
    unavailable: 0,
    not_regular_file: 0,
    symlink: 0,
    empty: 0,
    too_large: 0,
    binary: 0,
    invalid_utf8: 0,
  };
}

export async function prepareSource(
  requestedRoot: string,
  scopes: readonly string[],
  options: SourceOptions,
): Promise<PreparedSource> {
  const root = await realpath(resolve(requestedRoot));
  const normalizedScopes = scopes
    .map((scope) => normalizePath(scope.replace(/^\.\//, '').replace(/\/$/, '')))
    .filter(Boolean);
  const inventory = await listFiles(root);
  const vgignore = await loadVgIgnore(root);
  const fragments: SourceFragment[] = [];
  const excludedByReason = emptyExclusions();
  let filesScanned = 0;
  let eligibleBytes = 0;

  const exclude = (reason: ExclusionReason): void => {
    excludedByReason[reason] += 1;
  };

  for (const path of inventory.files) {
    if (!scopeMatches(path, normalizedScopes)) {
      exclude('out_of_scope');
      continue;
    }
    if (path === '.vgignore') {
      exclude('control_file');
      continue;
    }
    if (isVgIgnored(path, vgignore.rules)) {
      exclude('vgignore');
      continue;
    }
    if (isSensitive(path)) {
      exclude('sensitive_name');
      continue;
    }
    if (path.split('/').some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment))) {
      exclude('builtin_directory');
      continue;
    }

    const absolute = resolve(root, path);
    if (!isWithin(root, absolute)) {
      exclude('outside_root');
      continue;
    }

    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (stat.isSymbolicLink()) {
      exclude('symlink');
      continue;
    }
    if (!stat.isFile()) {
      exclude('not_regular_file');
      continue;
    }
    if (stat.size === 0) {
      exclude('empty');
      continue;
    }
    if (stat.size > options.maxFileBytes) {
      exclude('too_large');
      continue;
    }

    let actual: string;
    try {
      actual = await realpath(absolute);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (!isWithin(root, actual)) {
      exclude('outside_root');
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(actual);
    } catch {
      exclude('unavailable');
      continue;
    }
    if (looksBinary(buffer)) {
      exclude('binary');
      continue;
    }

    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
      exclude('invalid_utf8');
      continue;
    }

    filesScanned += 1;
    eligibleBytes += buffer.length;
    for (const fragment of chunkText(path, text, options)) {
      fragments.push({ ...fragment, id: `f${fragments.length}` });
    }
  }

  return {
    filesScanned,
    fragments,
    report: {
      discovery: inventory.discovery,
      discoveredFiles: inventory.files.length,
      eligibleFiles: filesScanned,
      eligibleBytes,
      fragments: fragments.length,
      scopes: normalizedScopes,
      vgignore: { present: vgignore.present, rules: vgignore.rules.length },
      excludedByReason,
    },
  };
}
