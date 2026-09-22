import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chunkText, isVgIgnored, parseVgIgnore, prepareSource } from '../src/source.ts';

test('chunkText returns stable one-based ranges with overlap', () => {
  const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
  const chunks = chunkText('src/a.ts', text, { maxFragmentLines: 5, maxFragmentChars: 10_000, overlapLines: 2 });
  assert.deepEqual(chunks.map((chunk) => [chunk.startLine, chunk.endLine]), [[1, 5], [4, 8], [7, 11], [10, 12]]);
  assert.equal(chunks[0]?.text, 'line 1\nline 2\nline 3\nline 4\nline 5');
});

test('chunkText also bounds chunks by characters', () => {
  const chunks = chunkText('README.md', 'aaaa\nbbbb\ncccc', { maxFragmentLines: 100, maxFragmentChars: 6, overlapLines: 0 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['aaaa', 'bbbb', 'cccc']);
});

test('.vgignore supports globbing, directories and narrowing-only negation', () => {
  const rules = parseVgIgnore(`
# generated content
generated/
**/*.snap
secrets/*.json
!secrets/example.json
/root-only.ts
*.min.js
cache
`);

  assert.equal(isVgIgnored('generated/output.ts', rules), true);
  assert.equal(isVgIgnored('src/components/button.snap', rules), true);
  assert.equal(isVgIgnored('secrets/live.json', rules), true);
  assert.equal(isVgIgnored('secrets/example.json', rules), false);
  assert.equal(isVgIgnored('root-only.ts', rules), true);
  assert.equal(isVgIgnored('nested/root-only.ts', rules), false);
  assert.equal(isVgIgnored('vendor/app.min.js', rules), true);
  assert.equal(isVgIgnored('cache/entry.json', rules), true);
  assert.equal(isVgIgnored('src/app.ts', rules), false);
});

test('prepareSource applies .vgignore and reports exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-source-'));
  await mkdir(join(root, 'generated'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, '.vgignore'), 'generated/\n*.snap\n');
  await writeFile(join(root, 'generated', 'client.ts'), 'generated code\n');
  await writeFile(join(root, 'src', 'kept.ts'), 'export const kept = true;\n');
  await writeFile(join(root, 'src', 'fixture.snap'), 'snapshot\n');
  await writeFile(join(root, 'empty.ts'), '');

  const prepared = await prepareSource(root, [], {
    maxFileBytes: 1024,
    maxFragmentLines: 60,
    maxFragmentChars: 3500,
    overlapLines: 8,
  });

  assert.deepEqual(prepared.fragments.map((fragment) => fragment.path), ['src/kept.ts']);
  assert.equal(prepared.report.discovery, 'filesystem');
  assert.equal(prepared.report.vgignore.present, true);
  assert.equal(prepared.report.vgignore.rules, 2);
  assert.equal(prepared.report.eligibleFiles, 1);
  assert.equal(prepared.report.fragments, 1);
  assert.equal(prepared.report.excludedByReason.vgignore, 2);
  assert.equal(prepared.report.excludedByReason.control_file, 1);
  assert.equal(prepared.report.excludedByReason.empty, 1);
});

test('prepareSource reports scope exclusions separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-source-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');

  const prepared = await prepareSource(root, ['src'], {
    maxFileBytes: 1024,
    maxFragmentLines: 60,
    maxFragmentChars: 3500,
    overlapLines: 8,
  });

  assert.equal(prepared.report.eligibleFiles, 1);
  assert.equal(prepared.report.excludedByReason.out_of_scope, 1);
  assert.deepEqual(prepared.report.scopes, ['src']);
});


test('prepareSource fails closed when .vgignore exceeds its safety limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-source-'));
  await writeFile(join(root, '.vgignore'), 'x'.repeat(256 * 1024 + 1));
  await writeFile(join(root, 'source.ts'), 'export const source = true;\n');

  await assert.rejects(
    prepareSource(root, [], {
      maxFileBytes: 1024,
      maxFragmentLines: 60,
      maxFragmentChars: 3500,
      overlapLines: 8,
    }),
    /\.vgignore exceeds the 256 KiB safety limit/,
  );
});


test('prepareSource reports structured and window fallback files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-source-'));
  await writeFile(join(root, 'handlers.ts'), [
    'export function first() { return 1; }',
    '',
    'export function second() { return 2; }',
  ].join('\n'));
  await writeFile(join(root, 'README.md'), '# Guide\nSome prose.\n');

  const prepared = await prepareSource(root, [], {
    maxFileBytes: 1024,
    maxFragmentLines: 60,
    maxFragmentChars: 3500,
    overlapLines: 8,
    chunking: 'auto',
  });

  assert.deepEqual(prepared.report.chunking, {
    mode: 'auto',
    structuredFiles: 1,
    windowFiles: 1,
  });
});

test('prepareSource can force legacy window chunking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vongrep-source-'));
  await writeFile(join(root, 'handlers.ts'), [
    'export function first() { return 1; }',
    '',
    'export function second() { return 2; }',
  ].join('\n'));

  const prepared = await prepareSource(root, [], {
    maxFileBytes: 1024,
    maxFragmentLines: 60,
    maxFragmentChars: 3500,
    overlapLines: 8,
    chunking: 'window',
  });

  assert.deepEqual(prepared.report.chunking, {
    mode: 'window',
    structuredFiles: 0,
    windowFiles: 1,
  });
});
