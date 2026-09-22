# vongrep

Semantic code search for coding agents, powered by [Von](https://github.com/wfzyx/von).

`vongrep` scans a local repository, breaks text files into bounded source excerpts, asks Von to score each excerpt against a behaviour-oriented question, and returns the original source with paths and line numbers.

It is inspired by [JevGrep](https://github.com/nassim-arifette/jevgrep), but is deliberately local-first: Von runs on your machine, so there is no hosted model provider, API key, or remote source-code disclosure by default.

## Why

Use exact search (`rg`, IDE symbol search) when you know the identifier or literal. Use `vongrep` when you know what the code *does* but not where it lives:

```text
Where is session expiry handled?
How are retryable payment failures classified?
Which code publishes the transcription-complete event?
```

## Requirements

- Node.js 22.6+
- Von 1.1+
- a running local Von server

Install and start Von separately:

```bash
pip install von-sdk
von serve --host 127.0.0.1 --port 8000
```

Then install vongrep from a checkout:

```bash
npm install
npm run build
npm link
```

## Usage

Check the Von server:

```bash
vongrep doctor
```

Inspect how much source would be searched without invoking Von:

```bash
vongrep inspect --root .
```

Search by behaviour:

```bash
vongrep search --query "Where is session expiry handled?"
```

Narrow the search and tune result selection:

```bash
vongrep search \
  --query "How are permissions checked?" \
  --scope src \
  --scope tests \
  --threshold 0.6 \
  --limit 8
```

Machine-readable output:

```bash
vongrep search --query "Where is the cache invalidated?" --json
```

Use a non-default Von server with `VON_BASE_URL` or `--base-url`. If the Von server is configured with `VON_API_KEY`, provide the same environment variable to `vongrep`.

## MCP

`vongrep` exposes the same search path as a stdio MCP server:

```bash
vongrep mcp --root /absolute/path/to/repository
```

The MCP tool is `semantic_search_code` and accepts `query`, optional `scope`, `threshold`, and `limit` arguments.

Example client configuration:

```json
{
  "mcpServers": {
    "vongrep": {
      "command": "vongrep",
      "args": ["mcp", "--root", "/absolute/path/to/repository"]
    }
  }
}
```

## How it works

1. Enumerates tracked and untracked non-ignored Git files with `git ls-files -co --exclude-standard`; falls back to a conservative filesystem walk outside Git repositories.
2. Skips symlinks, common build/dependency directories, binary files, oversized files, and obvious credential files.
3. Splits UTF-8 source into small overlapping line windows.
4. Sends batches to Von's `/v1/systemone` interface as Noul questions. The search question is shared state; each excerpt is an independently scored question.
5. Sorts by Von's affirmative probability and returns original excerpts above the requested threshold.

The default batch size is intentionally small because Von evaluates the shared state and questions inside its finite context window. vongrep does not build or persist an embedding index.

## Development

```bash
npm install
npm run verify
```

## Status

This is an initial implementation. The next useful validation step is a small relevance benchmark against representative repositories before adding caching, structural chunking, or more elaborate scan planning.

## Acknowledgements

The product shape and evidence-returning search flow are inspired by [nassim-arifette/jevgrep](https://github.com/nassim-arifette/jevgrep). Von is maintained separately by [wfzyx/von](https://github.com/wfzyx/von).

## License

MIT
