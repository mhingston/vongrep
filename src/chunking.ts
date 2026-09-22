import { extname } from 'node:path';

import type { ChunkingMode, SourceFragment } from './types.ts';

export type ChunkOptions = {
  maxFragmentLines: number;
  maxFragmentChars: number;
  overlapLines: number;
};

export type ChunkResult = {
  method: 'structure' | 'window';
  fragments: SourceFragment[];
};

const DECLARATIONS: Record<string, RegExp> = {
  '.ts': /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|module)\b/,
  '.tsx': /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|module)\b/,
  '.js': /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\b/,
  '.jsx': /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\b/,
  '.mjs': /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\b/,
  '.cjs': /^(?:async\s+)?(?:function|class)\b/,
  '.py': /^(?:async\s+def|def|class)\b/,
  '.go': /^(?:func|type|const|var)\b/,
  '.rs': /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static)\b/,
  '.java': /^(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\b/,
  '.cs': /^(?:(?:public|protected|private|internal|abstract|sealed|static|partial|readonly)\s+)*(?:class|interface|enum|record|struct)\b/,
  '.kt': /^(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|value)\s+)*(?:class|interface|object|fun|typealias)\b/,
  '.kts': /^(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|value)\s+)*(?:class|interface|object|fun|typealias)\b/,
  '.swift': /^(?:(?:public|private|fileprivate|internal|open|final|static)\s+)*(?:class|struct|enum|protocol|extension|func|typealias)\b/,
};

function makeFragment(path: string, lines: readonly string[], start: number, end: number, index: number): SourceFragment | null {
  const text = lines.slice(start, end).join('\n');
  if (text.trim().length === 0) return null;
  return { id: `f${index}`, path, startLine: start + 1, endLine: end, text };
}

function windowChunkRange(
  path: string,
  lines: readonly string[],
  rangeStart: number,
  rangeEnd: number,
  options: ChunkOptions,
  idOffset = 0,
): SourceFragment[] {
  const fragments: SourceFragment[] = [];
  let start = rangeStart;

  while (start < rangeEnd) {
    let end = start;
    let chars = 0;
    while (end < rangeEnd && end - start < options.maxFragmentLines) {
      const next = (lines[end]?.length ?? 0) + 1;
      if (end > start && chars + next > options.maxFragmentChars) break;
      chars += next;
      end += 1;
      if (chars >= options.maxFragmentChars) break;
    }
    if (end === start) end = Math.min(start + 1, rangeEnd);

    const fragment = makeFragment(path, lines, start, end, idOffset + fragments.length);
    if (fragment !== null) fragments.push(fragment);

    if (end >= rangeEnd) break;
    start = Math.max(start + 1, end - options.overlapLines);
  }

  return fragments;
}

export function chunkText(path: string, text: string, options: ChunkOptions): SourceFragment[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  return windowChunkRange(path, lines, 0, lines.length, options);
}

function isMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('*/')
    || trimmed.startsWith('#')
    || trimmed.startsWith('@')
    || /^\[[A-Za-z]/.test(trimmed);
}

function expandMetadataStart(lines: readonly string[], start: number): number {
  let index = start;
  while (index > 0) {
    const previous = lines[index - 1]!;
    if (previous.trim().length === 0 || !isMetadataLine(previous)) break;
    index -= 1;
  }
  return index;
}

export function declarationStarts(path: string, text: string): number[] {
  const pattern = DECLARATIONS[extname(path).toLowerCase()];
  if (pattern === undefined) return [];

  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index]!)) continue;
    const start = expandMetadataStart(lines, index);
    if (starts.at(-1) !== start) starts.push(start);
  }
  return starts;
}

function rangeFits(lines: readonly string[], start: number, end: number, options: ChunkOptions): boolean {
  if (end - start > options.maxFragmentLines) return false;
  let chars = 0;
  for (let index = start; index < end; index += 1) {
    chars += (lines[index]?.length ?? 0) + 1;
    if (chars > options.maxFragmentChars) return false;
  }
  return true;
}

function structuredChunks(path: string, text: string, options: ChunkOptions): SourceFragment[] | null {
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const starts = declarationStarts(path, normalized);
  if (starts.length < 2) return null;

  const boundaries = [0, ...starts.slice(1), lines.length];
  const regions = boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1]! }));
  const fragments: SourceFragment[] = [];
  let packedStart: number | null = null;
  let packedEnd = 0;

  const flushPacked = (): void => {
    if (packedStart === null) return;
    const fragment = makeFragment(path, lines, packedStart, packedEnd, fragments.length);
    if (fragment !== null) fragments.push(fragment);
    packedStart = null;
  };

  for (const region of regions) {
    if (!rangeFits(lines, region.start, region.end, options)) {
      flushPacked();
      const windowed = windowChunkRange(path, lines, region.start, region.end, options, fragments.length);
      fragments.push(...windowed);
      continue;
    }

    if (packedStart === null) {
      packedStart = region.start;
      packedEnd = region.end;
      continue;
    }

    if (rangeFits(lines, packedStart, region.end, options)) {
      packedEnd = region.end;
    } else {
      flushPacked();
      packedStart = region.start;
      packedEnd = region.end;
    }
  }

  flushPacked();
  return fragments;
}

export function chunkSource(
  path: string,
  text: string,
  options: ChunkOptions,
  mode: ChunkingMode = 'auto',
): ChunkResult {
  if (mode === 'window') return { method: 'window', fragments: chunkText(path, text, options) };
  const structured = structuredChunks(path, text, options);
  return structured === null
    ? { method: 'window', fragments: chunkText(path, text, options) }
    : { method: 'structure', fragments: structured };
}
