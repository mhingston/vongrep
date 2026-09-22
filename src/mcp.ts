import type { Readable, Writable } from 'node:stream';

import { CachingEvaluator, ScoreCache } from './cache.ts';
import { searchCode } from './search.ts';
import type { RelevanceEvaluator } from './types.ts';
import { VonEvaluator } from './von.ts';

const TOOL_NAME = 'semantic_search_code';
const PROTOCOL_VERSION = '2025-06-18';

export type McpOptions = {
  root: string;
  baseURL?: string;
  apiKey?: string;
  cache?: boolean;
  input?: Readable;
  output?: Writable;
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

function createEvaluator(options: McpOptions): RelevanceEvaluator {
  const von = new VonEvaluator({ baseURL: options.baseURL, apiKey: options.apiKey });
  return options.cache === false ? von : new CachingEvaluator(von, new ScoreCache());
}

export async function runMcpServer(options: McpOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const evaluator = createEvaluator(options);
  let buffer = '';

  const send = (message: unknown): void => { output.write(`${JSON.stringify(message)}\n`); };

  const handle = async (message: JsonRpcRequest): Promise<void> => {
    const id = message.id ?? null;
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vongrep', version: '0.1.0' },
        instructions: 'Use semantic_search_code to find repository code by behavior or concept when exact identifiers are unknown.',
      } });
      return;
    }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [{
        name: TOOL_NAME,
        description: 'Search local repository code by behavior, responsibility, or concept using Von relevance scoring. Returns original source excerpts.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            threshold: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, title: 'Semantic code search' },
      }] } });
      return;
    }
    if (message.method === 'tools/call') {
      if (id === null) return;
      const name = message.params?.name;
      if (name !== TOOL_NAME) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
        return;
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await searchCode({
          root: options.root,
          query: String(args.query ?? ''),
          scopes: Array.isArray(args.scope) ? args.scope.filter((item): item is string => typeof item === 'string') : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          threshold: typeof args.threshold === 'number' ? args.threshold : undefined,
        }, evaluator);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: messageText }], isError: true } });
      }
      return;
    }
    if (id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  };

  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as JsonRpcRequest;
          await handle(parsed);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
      }
      newline = buffer.indexOf('\n');
    }
  }
}
