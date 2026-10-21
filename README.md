<h1 align="center">
  <img src="assets/wordmark.png" alt="accesswright" width="640">
</h1>

<h4 align="center">Fixes accessibility bugs in React and Next.js source code, and only proposes fixes it has verified in a real browser and a real build.</h4>

<p align="center">
  <a href="#how-it-works">How it works</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#github-action">GitHub Action</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#mcp-server">MCP server</a> •
  <a href="#limits">Limits</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>

Most accessibility tools point at a problem and leave the fix to you. Coding agents will write a fix, but often one that only silences the warning: they delete the element, add `aria-hidden`, or break the build. accesswright edits your source, then runs the app and checks that the fix is real before you ever see it.

A fix is kept only if:

- the original axe finding is gone,
- no new finding appeared,
- no content or control was removed or hidden (compared on the accessibility tree), and
- the production build, typecheck, lint and tests show no new failures.

Anything else is dropped. Nothing gets through on a "best effort" basis.

## How it works

```text
your repo ─► sandboxed copy ─► baseline scan + production checks
                                   │
                                   ▼
                  codemod, or a scoped model patch
                                   │
                                   ▼
          re-scan in the browser, compare with the baseline
                                   │
                                   ▼
        production build / typecheck / lint / tests, once per PR
                                   │
                                   ▼
            local write, review PR, or PR suggestions
```

- **Deterministic first.** Rules with a known fix (missing `lang`, positive `tabindex`, and so on) are fixed by codemods with no model call.
- **Model fixes are optional.** OpenAI, Anthropic, DeepSeek and OpenAI-compatible providers are supported. Output is schema-validated. Cost and token caps are enforced in code, and the default budget is zero.
- **Repository code runs in Docker.** Install scripts, dev servers and builds run in a container with a scrubbed environment. Model keys and GitHub tokens never enter it.
- **Every check is differential.** Failures that already existed before patching do not count against a fix.

## Quick start

You need Node.js 22.12 or newer, Git, and a running Docker engine. The package is not on npm yet, so build it from source:

```bash
git clone https://github.com/dendroenydris/accesswright.git
cd accesswright
npm ci --ignore-scripts
npm run build
```

Run it on a Next.js project. `--no-llm` uses codemods only and needs no API key:

```bash
node dist/src/cli.js fix /path/to/your-next-app --no-llm --dry-run
```

`--dry-run` leaves your source untouched and writes a report. Drop it to apply the verified fixes to your checkout.

| Option | Meaning |
|---|---|
| `--no-llm` | Codemods only, no model calls |
| `--dry-run` | Report only, do not write the repository |
| `--offline` | Cut the container's network after dependencies are installed |
| `--max-tasks <n>` | Maximum number of repair tasks |
| `--max-cost-usd <n>` | Model spending cap for this run (default 0) |
| `--input-usd-per-million`, `--output-usd-per-million` | Model prices; required whenever the cap is above zero |
| `--retain-evidence` | Keep screenshots and page facts in the temp directory |

## GitHub Action

The Action has two modes:

- **`backlog`** scans a branch and opens one PR with verified fixes.
- **`pr`** comments verified suggestions on an open pull request.

```yaml
name: Accessibility repair
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"
permissions:
  contents: write
  pull-requests: write
jobs:
  accesswright:
    runs-on: ubuntu-latest
    steps:
      - uses: dendroenydris/accesswright@main
        with:
          mode: backlog
```

Enable *Allow GitHub Actions to create and approve pull requests* in the repository settings. A fix branch that has commits from anyone else is never force-pushed; it is left alone and reported. See [`action.yml`](action.yml) for all inputs.

## Configuration

Put an optional `.accesswright.yml` in the target repository:

```yaml
routes: ["/", "/about"]   # empty means discover routes
ignore:
  rules: []
  paths: []
scan:
  mobile: true
  darkScheme: false
  ibm: false        # also run IBM Equal Access as a second checker
  keyboard: false   # record Tab / Shift+Tab focus order
model:
  provider: anthropic
  id: <model id>
```

API keys are read from the environment of the process running accesswright, never from the repository. A repository config cannot raise the spending cap or point keys at another endpoint unless you pass `--trust-provider-config`.

## MCP server

`accesswright-mcp` lets a coding agent use the verifier on your local checkout. It has three tools:

- `scan` records the baseline.
- `verify` checks the agent's edits against that baseline and runs the production checks.
- `close` cleans up the run.

It never writes your checkout, calls a model, or opens PRs.

```bash
npm run build
npm run mcp -- --repo /path/to/your-next-app
```

## Limits

accesswright supports Next.js 12 to 16, both the Pages and App routers. Other React setups are reported as unsupported rather than guessed at.

Passing its checks does **not** mean a site is accessible or meets WCAG, EN 301 549 or any legal requirement. Reports reference WCAG success criteria and EN 301 549 clauses, but automated checks cannot judge:

- whether alt text and labels are meaningful,
- reading and focus order in context,
- screen reader behaviour,
- captions and media alternatives,
- cognitive load and plain language,
- anything behind interactions the scanner does not perform.

Findings that need a person to decide are marked `needsHuman` in the report.

## Development

```bash
npm ci --ignore-scripts
npm run check              # typecheck + lint
npm test                   # unit tests, fake model provider, no network
npm run test:integration   # end-to-end tests in Docker
```

- `src/` is the core library plus three entry points: `cli.ts`, `action/` and `mcp/`.
- `src/hosted/` and `app/` hold the hosted GitHub App and dashboard.
- `eval/` holds the frozen benchmark protocols.

Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. The optional IBM Equal Access engine is Apache-2.0; keep its license and attribution when you redistribute it.
