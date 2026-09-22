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
- Respects Git's normal ignored-file set and supports additional repository-local exclusions through `.vgignore`.
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

## Control the search boundary with `.vgignore`

Add a `.vgignore` file at the repository root when files should be searchable by Git but should **not** be sent to Von.

```gitignore
# Generated clients
generated/
src/api/generated/**

# Snapshots and fixtures
*.snap
test/fixtures/

# Ignore all JSON secrets except a checked-in example
secrets/*.json
!secrets/example.json
```

The syntax intentionally follows the useful subset of gitignore conventions: blank lines and `#` comments, `*`, `?`, `**`, leading `/` for root anchoring, trailing `/` for directories, and `!` to undo an earlier `.vgignore` rule.

`.vgignore` is **narrowing-only**. A negated rule can undo another `.vgignore` rule, but it cannot re-include a file excluded by Git discovery, built-in safety rules, or source validation. If the file exists but cannot be read, is not valid UTF-8, or exceeds 256 KiB, vongrep fails closed rather than silently ignoring it.

## Inspect before searching

`inspect` walks and chunks the source without contacting Von:

```bash
vongrep inspect --root .
```

Example:

```text
vongrep inspect: 138 eligible file(s), 891 fragment(s), 612.4 KiB
root: /path/to/project
discovery: git
scope: entire repository
.vgignore: 4 rule(s)
discovered candidates: 151

excluded:
  control_file: 1
  too_large: 2
  vgignore: 10
```

Use JSON for automation:

```bash
vongrep inspect --root . --json
```

The report separates scope exclusions, `.vgignore`, sensitive names, built-in directories, symlinks/out-of-root paths, unavailable files, empty/oversized/binary files, and invalid UTF-8. With Git discovery, ignored untracked files are omitted by Git before vongrep sees them, so they are not included in `discovered candidates`.

This is useful for auditing the exact source boundary before running inference.

## Score cache

Normal CLI and MCP searches cache Von relevance scores for seven days. Cache identity includes the model, search question, exact source path/range/text, and a versioned relevance criterion, so edits or query changes naturally miss the cache.

Cache files store hashes, scores, and timestamps only — not source code or query text.

```bash
vongrep cache status
vongrep cache clear
vongrep search --no-cache --query "Where is session expiry handled?"
```

Set `VONGREP_CACHE_DIR` to override the platform cache directory. Benchmarks deliberately bypass the cache.

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

Before evaluation vongrep excludes common dependency/build directories, binary files, symlinks, oversized files, Git-ignored untracked files, `.vgignore` matches, and obvious credential/private-key filenames. It also resolves every candidate path and refuses files that escape the authorized repository root. These filters are guardrails, not a guarantee that arbitrary source contains no secrets.

Use `vongrep inspect`, `.vgignore`, and `--scope` when you need a narrower boundary. The score cache does not store source text or query text; cache files contain only content-derived hashes, probabilities, and timestamps.

## How it works

1. **Discover** — use `git ls-files -co --exclude-standard` where available, with a conservative filesystem fallback outside Git.
2. **Narrow** — apply requested scopes, `.vgignore`, and built-in source-safety rules.
3. **Authorize** — resolve each candidate and ensure the real path remains inside the repository root.
4. **Chunk** — create bounded overlapping line windows so returned evidence remains precise.
5. **Cache** — reuse a content-addressed score when the model, question, source, and criterion are unchanged.
6. **Score misses** — batch uncached excerpts into Von `noul` questions over `/v1/systemone`, sharing the user's search question as state.
7. **Rank** — sort by affirmative probability and suppress lower-ranked overlapping excerpts.
8. **Return evidence** — output the original source rather than generating an answer about it.

vongrep has no persistent repository index or embedding store. The score cache accelerates the same exhaustive scoring path rather than introducing a second retrieval mechanism.

## CLI reference

```text
vongrep search --query <question> [--root <path>] [--scope <path>...]
               [--threshold <0..1>] [--limit <n>] [--base-url <url>] [--no-cache] [--json]

vongrep inspect [--root <path>] [--scope <path>...] [--json]

vongrep doctor [--base-url <url>]

vongrep benchmark --dataset <path> [--root <path>] [--limit <k>]
                  [--base-url <url>] [--json]

vongrep cache [status|clear] [--json]\n\nvongrep mcp [--root <path>] [--base-url <url>] [--no-cache]

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

Likely follow-on work includes structural chunking and larger cross-repository retrieval evaluations.

## Acknowledgements

vongrep is inspired by the product shape and evidence-returning search flow of [nassim-arifette/jevgrep](https://github.com/nassim-arifette/jevgrep).

Inference is provided by [wfzyx/von](https://github.com/wfzyx/von), an open-source System One decision model with a TypeSafe-compatible HTTP protocol.

## License

[MIT](LICENSE) © 2026 Mark Hingston.
