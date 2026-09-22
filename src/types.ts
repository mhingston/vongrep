export type SourceFragment = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type ScoredFragment = SourceFragment & {
  score: number;
};

export type CacheStats = {
  hits: number;
  misses: number;
  writes: number;
};

export type SearchOptions = {
  root: string;
  query: string;
  scopes?: string[];
  threshold?: number;
  limit?: number;
  maxFileBytes?: number;
  maxFragmentLines?: number;
  maxFragmentChars?: number;
  overlapLines?: number;
  batchSize?: number;
};

export type SearchResult = {
  query: string;
  root: string;
  model: string;
  filesScanned: number;
  fragmentsScored: number;
  threshold: number;
  cache?: CacheStats;
  results: ScoredFragment[];
};

export interface RelevanceEvaluator {
  readonly model: string;
  readonly cacheStats?: CacheStats;
  score(query: string, fragments: readonly SourceFragment[]): Promise<ScoredFragment[]>;
}
