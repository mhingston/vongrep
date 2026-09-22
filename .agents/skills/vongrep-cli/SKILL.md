---
name: vongrep-cli
description: Use the vongrep CLI to locate repository code by behavior or concept when exact identifiers are unknown.
---

# Vongrep CLI

Use this skill when a task requires finding implementation evidence in a local
repository and the relevant file, symbol, or terminology is not known yet.
Use `rg` or IDE search instead when the exact identifier or literal is already
known. vongrep returns source excerpts; inspect the referenced files before
making changes.

## Prerequisites

Install the CLI from npm and ensure a Von server is available:

```bash
npm install --global @mhingston5/vongrep
von serve --host 127.0.0.1 --port 8000
```

The CLI uses `http://localhost:8000` by default. Set `VON_BASE_URL` (and, when
needed, `VON_API_KEY`) for another endpoint. A remote endpoint receives the
source excerpts being scored, so narrow the search boundary before using one.

## Search workflow

1. Check the service with `vongrep doctor` when a search fails to connect.
2. Use `vongrep inspect --root <repo> --json` to review the files and fragments
   that would be eligible for scoring.
3. Search with a behavior-oriented question:

   ```bash
   vongrep search \
     --root /path/to/repository \
     --query "Where is session expiry handled?" \
     --scope src \
     --limit 10 \
     --json
   ```

   Repeat `--scope` for multiple repository-relative paths. Use `--threshold`
   to require stronger relevance, `--chunking window` only when comparing with
   the legacy fixed-window behavior, and `--no-cache` when a fresh score is
   required.
4. Follow each returned `path`, `startLine`, and `endLine` back to the original
   source. Treat the excerpts as evidence, not as a generated explanation.

Use `vongrep cache status` or `vongrep cache clear` to inspect or reset the
local score cache. Cache entries contain hashes, scores, and timestamps rather
than source text.

## Repository safety

Searches use Git discovery when possible and exclude ignored files, common
build/dependency directories, binaries, symlinks, oversized files, and obvious
credential filenames. Add a repository-local `.vgignore` or pass `--scope` for
additional narrowing. These filters reduce exposure but are not a guarantee
that source is free of secrets.

## MCP mode

For an MCP-capable coding agent, run:

```bash
vongrep mcp --root /absolute/path/to/repository
```

The server exposes the read-only `semantic_search_code` tool with `query`,
optional `scope`, `threshold`, `limit`, and `chunking` (`auto` or `window`).
Configure the command as an stdio MCP server in the agent's settings rather
than invoking it for every individual search.
