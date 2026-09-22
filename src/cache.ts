import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';

import type { CacheStats, RelevanceEvaluator, ScoredFragment, SourceFragment } from './types.ts';

export const SCORE_CACHE_VERSION = 'vongrep-relevance-v1';
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  schemaVersion: 1;
  score: number;
  createdAt: number;
};

export function defaultCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VONGREP_CACHE_DIR) return env.VONGREP_CACHE_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'vongrep');
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'vongrep');
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vongrep');
}

export function scoreCacheKey(query: string, fragment: SourceFragment, model: string): string {
  return createHash('sha256').update(JSON.stringify({
    version: SCORE_CACHE_VERSION,
    model,
    query,
    path: fragment.path,
    startLine: fragment.startLine,
    endLine: fragment.endLine,
    text: fragment.text,
  })).digest('hex');
}

export class ScoreCache {
  readonly directory: string;
  readonly ttlMs: number;

  constructor(options: { directory?: string; ttlMs?: number } = {}) {
    this.directory = options.directory ?? defaultCacheDirectory();
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  #path(key: string): string {
    return join(this.directory, 'scores', key.slice(0, 2), `${key}.json`);
  }

  async read(key: string): Promise<number | null> {
    try {
      const raw = await readFile(this.#path(key), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheEntry>;
      if (parsed.schemaVersion !== 1 || typeof parsed.score !== 'number'
        || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 1
        || typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) {
        return null;
      }
      if (Date.now() - parsed.createdAt > this.ttlMs) return null;
      return parsed.score;
    } catch {
      return null;
    }
  }

  async write(key: string, score: number): Promise<void> {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error('cache score must be between 0 and 1');
    }
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const entry: CacheEntry = { schemaVersion: 1, score, createdAt: Date.now() };
    await writeFile(temp, JSON.stringify(entry), 'utf8');
    await rename(temp, path);
  }

  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  async status(): Promise<{ directory: string; entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;

    const walk = async (directory: string): Promise<void> => {
      let names;
      try {
        names = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of names) {
        const path = join(directory, item.name);
        if (item.isDirectory()) {
          await walk(path);
        } else if (item.isFile() && item.name.endsWith('.json')) {
          entries += 1;
          try {
            bytes += (await stat(path)).size;
          } catch {
            // A concurrently removed cache entry does not make status fail.
          }
        }
      }
    };

    await walk(join(this.directory, 'scores'));
    return { directory: this.directory, entries, bytes };
  }
}

export class CachingEvaluator implements RelevanceEvaluator {
  readonly model: string;
  readonly cacheStats: CacheStats = { hits: 0, misses: 0, writes: 0 };
  readonly #delegate: RelevanceEvaluator;
  readonly #cache: ScoreCache;

  constructor(delegate: RelevanceEvaluator, cache = new ScoreCache()) {
    this.#delegate = delegate;
    this.#cache = cache;
    this.model = delegate.model;
  }

  async score(query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]> {
    const result = new Map<string, ScoredFragment>();
    const misses: SourceFragment[] = [];
    const keys = new Map<string, string>();

    for (const fragment of fragments) {
      const key = scoreCacheKey(query, fragment, this.model);
      keys.set(fragment.id, key);
      const cached = await this.#cache.read(key);
      if (cached === null) {
        this.cacheStats.misses += 1;
        misses.push(fragment);
      } else {
        this.cacheStats.hits += 1;
        result.set(fragment.id, { ...fragment, score: cached });
      }
    }

    if (misses.length > 0) {
      const fresh = await this.#delegate.score(query, misses);
      for (const scored of fresh) {
        result.set(scored.id, scored);
        const key = keys.get(scored.id);
        if (key !== undefined) {
          await this.#cache.write(key, scored.score);
          this.cacheStats.writes += 1;
        }
      }
    }

    return fragments.map((fragment) => {
      const scored = result.get(fragment.id);
      if (scored === undefined) throw new Error(`missing score for fragment ${fragment.id}`);
      return scored;
    });
  }
}
