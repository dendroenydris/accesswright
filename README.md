# accesswright

Accesswright repairs accessibility problems in React/Next.js source and verifies the resulting application before proposing changes. It is a development-stage TypeScript package with a CLI and a backlog GitHub Action. It is not an overlay, a legal compliance service, or a complete accessibility audit.

## How a repair reaches review

```text
Configuration → isolated source snapshot → production baseline
                                         ↓
                           instrumented persistent dev server
                                         ↓
                           browser/axe/source-location scan
                                         ↓
                     deterministic repair or scoped model patch
                                         ↓
                        fresh browser scan + content checks
                                         ↓
                     per-fix commits in an isolated Git journal
                                         ↓
               production build/typecheck/lint/tests/full rescan
                                         ↓
                  bisect and discard newly breaking fix groups
                                         ↓
                    guarded local write or review pull request
```

The verifier checks that targeted findings disappear, no new findings are introduced, protected content and controls remain, and production checks have no new failures. Screenshots are evidence, not an acceptance shortcut. Passing automated checks does not prove semantic correctness, legal conformity, or that all WCAG requirements are covered.

A `verified` result means the returned fix groups passed their gates. It can still include `needsHuman` findings, pre-existing failures, or unavailable checks. Read the full report rather than treating the word as an all-clear audit. The Action currently requires all four production check kinds to be available and passing before publication; unsupported projects are reported instead of bypassing checks.

## Local development and CLI

Prerequisites: a supported Node.js version from `package.json`, npm, Git, and a running Docker engine with the pinned Playwright image available. No model key is needed for deterministic mode. The package is not yet published to npm or the GitHub Marketplace.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
node dist/src/cli.js fix /absolute/path/to/next-project --no-llm --offline
```

Add `--dry-run` to leave the original source unchanged. `--retain-evidence` explicitly retains private screenshots and rendered page facts in the temporary run directory. The default retains only structured run metadata. A changed original repository is never overwritten after the verification snapshot has gone stale. A blocked final verification produces a nonzero CLI exit status.

Configuration is optional `.accesswright.yml`:

```yaml
routes: []
ignore:
  rules: []
  paths: []
scan:
  mobile: true
  darkScheme: false
offline: true
```

A model configuration additionally specifies `provider`, the exact model `id`, and optional `reasoningEffort`. Keys are read from the coordinator environment. Paid calls require an explicit operator `--max-cost-usd` and both `--input-usd-per-million` and `--output-usd-per-million`; the default allowance is zero. A repository cannot increase that allowance or redirect credentials to a custom endpoint without explicit operator trust. The library also provides a durable cumulative spending ledger for development/evaluation: pre-call reservations survive crashes, and unknown usage is not treated as free.

## Backlog and PR-mode GitHub Action

`action.yml` is the product Action. It checks out the target branch separately, runs target code in Docker, and publishes only the verifier-selected source groups. Use a reviewed immutable Action commit when adopting it. Give the calling workflow only `contents: write` and `pull-requests: write`; trigger backlog mode by `workflow_dispatch` or a schedule, not a privileged pull-request event. The default is `no-llm: 'true'` and `max-cost-usd: '0'`.

`.github/workflows/backlog-integration.yml` is a manual, deterministic product integration test on an existing owned branch. It does not use a model key. Ordinary CI likewise does not call paid models and includes the actual Chromium harmful/legitimate-change verifier sets. No temporary API-key workflow is part of the product.

PR mode (`mode: pr`) checks out the exact pull-request head and verifies it using the same Docker and final production gates, then posts GitHub suggested changes only on lines already inside the PR diff. Out-of-diff verified changes receive a CLI handoff instead of silently widening the review. Fork PRs are read-only with LLM spending disabled, regardless of caller flags or head-repository metadata. `.github/workflows/pr-mode-integration.yml` is a manual, no-model test workflow requiring an existing PR number and exact head SHA; it is not an automatically privileged PR trigger. Use a reviewed immutable Action revision and review permissions before enabling it in other repositories.

## Security and privacy

Target source executes only in an isolated application container. The trusted browser is a separate container; the application cannot write browser evidence or access the Docker socket. The model and GitHub credentials remain in the coordinator. Source snapshots exclude Git metadata, environment files, package-manager credentials, private-key files, dependency directories, and symbolic links. Model patches cannot edit manifests, lockfiles, build configuration, or workflows.

The persistent runner reuses the existing trusted runtime and dependencies through read-only host mounts on every platform, including macOS. It does not automatically copy that dependency tree into Docker storage after a mount failure. The library's copy mode requires an explicit caller choice and creates a temporary Docker volume; it is not the CLI default. The target application's writable workspace remains isolated inside its own container. All Docker control operations have bounded timeouts, and cleanup targets only resources owned by that run.

Model-assisted mode sends bounded source excerpts, deterministic call-site context, and cropped images to the explicitly configured provider. `--no-llm` sends none of this to a model. Raw SDK request bodies and credentials are not logged. Retained screenshots and raw page observations can still contain sensitive source content: enable retention only deliberately and do not publish them automatically.

## Reproducible evaluation

`eval/protocol-20261007.json` freezes the public Next.js corpus, exact SHAs, dev/test split, operators, seeds, systems, and `gpt-6-luna` high-reasoning configuration. A zero-cost smoke run is:

```sh
npm run build
npm run eval -- --protocol eval/protocol-20261007.json --output /absolute/path/to/results --split dev --systems deterministic --max-cases 2 --tmp-root /tmp/accesswright/integration-20261007 --cache-root /tmp/accesswright/integration-20261007/eval-source-cache
```

Evaluation outputs carry both the frozen protocol digest and a digest of an immutable compiled-runtime snapshot stored in the selected output directory. Trusted dependencies are still reused read-only, not duplicated into Docker; changes to that snapshot during a run fail closed without pooling implementations. Live `B1,A1,A` cells additionally require a dated explicit authorization metadata file, current authenticated model availability, pricing, a per-run cap, and a durable cumulative spending ledger. Fake-provider cells are labeled separately and are never pooled with live measurements.

A frozen development deterministic smoke on 2026-10-07 selected four public repositories and produced five eligible seeded cases across three verified-compatible repositories: three semantically correct fixes, two unresolved cases, zero changed clean controls out of 368 observed, and USD 0 model spend. One fourth repository was unsupported because the unmodified production build failed. This `max-cases=2` smoke is **not** the 300-case Track S test result and is not a live B1/A1/A comparison.

## Verification evidence and limits

Development checks on 2026-10-07 include more than 360 passing deterministic/unit tests, an owned Next.js 16 App Router fixture, Next.js 15.5.27 TSX and 16.3.8 JSX Pages Router fixtures with dynamic routes and a controlled HTTP data service, and a Tailwind 4.3.3 runtime-palette fixture. Actual Chromium/axe/ARIA scans cover desktop/mobile conditions. Production checks discard both compiler-breaking patches and patches whose target disappears only in development but returns in production. A compiled CLI rerun makes no duplicate change. A fixed browser soundness set rejected all 8 harmful modifications and accepted all 4 legitimate changes. These are controlled integration cases, not a broad public-repository success rate.

One live semantic development case using OpenAI `gpt-6-luna`, reasoning effort `high`, passed actual Next.js production and browser verification twice on 2026-10-07. Its unnamed button retained its identity and received the frozen ground-truth accessible name `Save changes`. The latest request used 485 input and 722 output tokens, with conservative token-price accounting of USD 0.000729025. The earlier request used 485 input and 800 output tokens (USD 0.000793375 on the same conservative basis). These are two executions of one controlled case, not two independent benchmark cases, provider invoices, or benchmark-wide cost-per-fix estimates.

Run reports include the actual axe-core version, observed route/condition coverage, inconclusive findings, source-mapping counts, and reviewed technical WCAG/EN 301 549 cross-references. The EN mapping is explicitly pinned to V3.2.1 (2021-03); criteria without a reviewed clause, including WCAG 2.2 additions, are marked unmapped rather than assigned an invented reference.

A real owned-repository PR roundtrip created two deterministic fix-group commits, repeated the full run without adding commits or opening another PR, and preserved a separately added simulated reviewer commit. A transient mismatch between GitHub PR and branch metadata failed closed before a later consistent read confirmed preservation.

The full public-repository Track S benchmark and public B1/A1/A comparison, independent semantic audit, hosted App/dashboard, deployed operations period, MCP integration, and release acceptance remain unfinished. Do not infer the planned benchmark size, a production SLA, or universal framework compatibility from the controlled fixtures.

Known coverage limits include authenticated pages, projects requiring secrets to build, package-manager and configuration variants not yet exercised, unmapped third-party render paths, dynamic color expressions, complex backgrounds, and manual-only accessibility requirements. Shared design-token changes are proposed for review rather than applied automatically.

## Test commands

```sh
npm run check
npm test
npm run test:integration
```

Docker integration tests build real applications and need Docker/network access for package installation. Live model tests are separately opt-in and require a dated explicit model/pricing authorization and a durable spending ledger; ordinary tests never enable them.

## Kurzbeschreibung

Accesswright prüft Quellcode-Korrekturen für React-/Next.js-Anwendungen in isolierten Containern mit Browser-, Accessibility- und Produktionsprüfungen. Automatisierte Prüfungen ersetzen weder eine vollständige Barrierefreiheitsprüfung noch eine rechtliche Konformitätsbewertung. Das Projekt befindet sich in der Entwicklung.

MIT licensed. See `LICENSE`.
