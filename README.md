# vongrep

[![CI](https://github.com/mhingston/vongrep/actions/workflows/ci.yml/badge.svg)](https://github.com/mhingston/vongrep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Powered by Von](https://img.shields.io/badge/powered%20by-Von-blue)](https://github.com/wfzyx/von)

**Find code by what it does — locally.**

`vongrep` is semantic grep for codebases. Ask a behaviour-oriented question such as:

```text
Where is session expiry handled?
How are retryable payment failures classified?
Which code publishes the transcription-complete event?
```

vongrep scans the repository, breaks source into small excerpts, asks [Von](https://github.com/wfzyx/von) to score each excerpt for relevance, and returns the original code with file paths, line ranges, and scores.

It is inspired by [JevGrep](https://github.com/nassim-arifette/jevgrep), but targets the open-source Von decision model and is local-first by default.

## Why vongrep?

Use `rg`, IDE search, or symbol search when you already know the identifier or literal.

Use vongrep when you know **the behaviour you are looking for**, but not the file, class, method, event name, or terminology used by the codebase.

| You know... | Use |
| --- | --- |
| exact symbol, filename, string, or regex | `rg` / IDE search |
| responsibility, behaviour, flow, or concept | `vongrep` |
| you need a generated explanation | a coding agent after retrieval |

vongrep deliberately returns **source evidence**, not an LLM-generated summary. The calling human or agent can then inspect the real implementation.

## Features

- Semantic code search with Von Noul relevance probabilities.
- Runs against a local Von server by default.
- No embedding database or persistent repository index; repeat scoring uses a local content-addressed cache.
- Respects Git's normal ignored-file set.
- Skips symlinks, common build/dependency directories, binary files, oversized files, and obvious credential files.
- Returns original source excerpts with paths and inclusive line ranges.
- Suppresses overlapping lower-ranked windows so top results contain more distinct evidence.
- Supports repository-relative scopes.
- Human-readable and JSON output.
- Offline `inspect` command to see scan size before inference.
- `doctor` command to verify the Von service.
- stdio MCP server for coding agents.
- Built-in labelled retrieval benchmark with Hit@K, MRR, and expected-path recall.
- Zero runtime npm dependencies.

## Quick start

### 1. Start Von

Install Von and run its local HTTP server:

```bash
pip install von-sdk
von serve --host 127.0.0.1 --port 8000
```

vongrep defaults to `http://localhost:8000`.

### 2. Install vongrep

Until a package release is published, install from a checkout:

```bash
git clone https://github.com/mhingston/vongrep.git
cd vongrep
npm install
npm run build
npm link
```

Check both pieces are working:

```bash
vongrep --version
vongrep doctor
```

### 3. Search a repository

From the repository you want to search:

```bash
vongrep search --query "Where is session expiry handled?"
```

Example result:

```text
vongrep: 2 result(s) from 84 fragments in 19 files
model: von-1.1.0  threshold: 0.50

src/auth/session.ts:41-76  score=0.934
...original source excerpt...

src/http/middleware.ts:18-54  score=0.781
...original source excerpt...
```

## Search options

Search only selected parts of a repository:

```bash
vongrep search \
  --query "How are permissions checked?" \
  --scope src \
  --scope tests
```

Tune the relevance threshold and maximum number of returned excerpts:

```bash
vongrep search \
  --query "Where is cache invalidation triggered?" \
  --threshold 0.65 \
  --limit 8
```

Use a positional question if you prefer:

```bash
vongrep search "Where is the retry policy applied?"
```

Emit machine-readable output:

```bash
vongrep search --query "Where is the retry policy applied?" --json
```

Search another repository without changing directory:

```bash
vongrep search \
  --root /path/to/project \
  --query "Where is the database transaction committed?"
```

## Inspect before searching

`inspect` walks and chunks the source without contacting Von:

```bash
vongrep inspect --root .
```

Example:

```json
{
  "root": "/path/to/project",
  "files": 142,
  "fragments": 917
}
```

This is useful for spotting unexpectedly large search scopes before running inference.

## MCP for coding agents

Start the stdio MCP server:

```bash
vongrep mcp --root /absolute/path/to/repository
```

It exposes one read-only tool:

```text
semantic_search_code
```

The tool accepts:

- `query` — the behaviour or concept to find.
- `scope` — optional repository-relative paths.
- `threshold` — optional minimum Von relevance probability.
- `limit` — optional result limit.

### Generic MCP configuration

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

### Claude Code

```bash
claude mcp add --transport stdio vongrep -- \
  vongrep mcp --root "/absolute/path/to/repository"
```

### Codex

```toml
[mcp_servers.vongrep]
command = "vongrep"
args = ["mcp", "--root", "/absolute/path/to/repository"]
tool_timeout_sec = 120
```

## Benchmark retrieval quality

vongrep includes a small evaluation harness so search changes can be measured rather than judged by anecdotes.

Create a labelled dataset:

```json
{
  "name": "my-project",
  "cases": [
    {
      "query": "Where is session expiry handled?",
      "expected_paths": ["src/auth/session.ts"]
    },
    {
      "query": "Where is the order-completed event published?",
      "expected_paths": ["src/orders/events.ts"],
      "scope": ["src"]
    }
  ]
}
```

Run it:

```bash
vongrep benchmark --dataset benchmark.json --limit 5
```

The report includes:

- **Hit@K** — how often at least one expected file appears in the first K results.
- **MRR** — mean reciprocal rank of the first expected file.
- **Path recall** — how many labelled expected paths were retrieved.

A small self-search dataset is included:

```bash
vongrep benchmark --dataset benchmarks/vongrep-smoke.json --limit 5
```

Use `--json` for the full per-case result. Benchmarks deliberately bypass the score cache so evaluation runs are not silently satisfied by earlier searches.

## Configure Von

Set a different Von endpoint with either:

```bash
export VON_BASE_URL=http://localhost:8000
```

or:

```bash
vongrep search \
  --base-url http://localhost:8000 \
  --query "Where are feature flags evaluated?"
```

If the Von server requires bearer authentication, set:

```bash
export VON_API_KEY=...
```

## Privacy and source handling

The default endpoint is local, so source evaluation stays on the machine when Von is running locally.

During a search, vongrep sends each eligible source excerpt, its path and line range, and the search question to the configured Von endpoint. **If you point `VON_BASE_URL` at a remote server, those excerpts leave the machine.**

Before evaluation vongrep excludes common dependency/build directories, binary files, symlinks, oversized files, Git-ignored files, and obvious credential/private-key filenames. These filters are guardrails, not a guarantee that arbitrary source contains no secrets.

Use `vongrep inspect` and `--scope` when you need a narrower boundary. The score cache does not store source text or query text; cache files contain only content-derived hashes, probabilities, and timestamps.

## How it works

1. **Discover** — use `git ls-files -co --exclude-standard` where available, with a conservative filesystem fallback outside Git.
2. **Filter** — reject unsafe or unsuitable files before reading them as source.
3. **Chunk** — create bounded overlapping line windows so returned evidence remains precise.
4. **Score** — batch excerpts into Von `noul` questions over `/v1/systemone`, sharing the user's search question as state.
5. **Rank** — sort by affirmative probability and suppress lower-ranked overlapping excerpts.
6. **Return evidence** — output the original source rather than generating an answer about it.

The initial implementation intentionally has no persistent index, embedding store, or score cache. The included benchmark is the gate for deciding which optimisations are worth adding.

## CLI reference

```text
vongrep search --query <question> [--root <path>] [--scope <path>...]
               [--threshold <0..1>] [--limit <n>] [--base-url <url>] [--no-cache] [--json]

vongrep inspect [--root <path>] [--scope <path>...]

vongrep doctor [--base-url <url>]

vongrep benchmark --dataset <path> [--root <path>] [--limit <k>]
                  [--base-url <url>] [--json]

vongrep mcp [--root <path>] [--base-url <url>]

vongrep --version
```

## Development

```bash
npm install
npm run verify
```

`npm run verify` runs TypeScript checking, unit tests, and a production build. CI runs the same gate for pull requests.

## Project status

vongrep is early-stage. The current goal is to establish whether local Von scoring is sufficiently useful for behaviour-oriented code retrieval, then improve the smallest mechanism demonstrated by benchmark evidence.

Likely follow-on work includes structural chunking, richer exclusion controls, and larger cross-repository retrieval evaluations.

## Acknowledgements

vongrep is inspired by the product shape and evidence-returning search flow of [nassim-arifette/jevgrep](https://github.com/nassim-arifette/jevgrep).

Inference is provided by [wfzyx/von](https://github.com/wfzyx/von), an open-source System One decision model with a TypeSafe-compatible HTTP protocol.

## License

[MIT](LICENSE) © 2026 Mark Hingston.
