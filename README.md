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

## Local MCP scan / verify

The development-stage MCP stdio server exposes `scan`, `verify`, and `close` for a coding agent working in an existing local Next.js repository. Build the coordinator and configure the agent to launch:

```sh
npm run build
ACCESSWRIGHT_TMP_ROOT=/tmp/accesswright/integration-20261007 npm run mcp -- --repo /absolute/path/to/next-project
```

`scan` freezes a sanitized source snapshot and genuine browser/axe and production baselines in isolated Docker containers. The coding agent edits its own checkout; `verify` uses an exact session/task ID to check the source diff against that baseline, run the existing per-patch anti-gaming verifier, and rerun the full production gate. Concurrent changes to the checkout invalidate the result. `close` cleans run-scoped resources. MCP never writes the developer checkout, makes paid provider calls, or publishes PRs. Source and screenshots remain local, with private evidence removed by default. This is not a hosted service or a published npm package.

## Hosted App service core (local verification only)

The local Hosted service modules now include a signed GitHub webhook receiver with installation allowlisting, delivery/comment deduplication and bounded HTTP transport; a run-token-authenticated model patch endpoint; and an aggregate-results state machine for `POST /runs/{id}/results`, `POST /runs/{id}/finish` and authenticated `GET /runs/{id}/status`. The target runner receives only a scoped per-run token, never provider or GitHub credentials.

`createHostedAgentServer({ agent, store, verifyTrustedResult })` in `src/hosted/agent-http.ts` combines the patch, results, finish and status routes in one private HTTP server. All routes authenticate against the same `HostedPatchAgent` run store. Supply a durable aggregate store and an independent trusted verifier callback before listening behind private ingress. Public GitHub webhooks and Cloud Tasks dispatch use their separate receivers; this factory does not launch a worker or configure cloud infrastructure.

`HostedAgentClient` in `src/hosted/agent-client.ts` sends semantic patch requests using only a scoped run token and an operator-selected HTTPS origin (loopback HTTP is allowed for local tests). It rejects redirects, oversized or malformed responses, contradictory HTTP/result states, and patches outside the task's deterministic context. An interrupted response is returned with unknown usage and never retried automatically. The patch service accepts bounded PNG bytes and previous verifier feedback, forwards the actual image bytes to the configured provider, and retains neither in its run metadata. A schema-accepted response still needs the worker's existing per-patch and final production verification.

`EphemeralRepairSession` in `src/runner/ephemeral-repair-session.ts` reuses the existing scan, repair and production gates inside a secretless, non-root Linux worker container. It requires a preloaded sanitized `/input` snapshot, a read-only trusted runtime, an allowlisted environment and exclusive workspace ownership. Cloud Run Jobs additionally require a trusted image marker and one initial task; automatic retry attempts are rejected. Offline mode is refused because this driver cannot enforce network isolation. The worker's own browser evidence is untrusted; only independent replay can authorize review.

`runHostedWorker` in `src/hosted/worker.ts` drives deterministic repair first, then bounded remote semantic proposals through `HostedAgentClient`. Every accepted proposal still passes the existing browser and production gates. Known rejected-call usage is retained; an unreconciled response blocks all further model calls. A validated `{ report, patches }` candidate reaches the supplied private `submitCandidate` callback only after source cleanup succeeds; it is never printed or published. Omitting the client selects deterministic mode. An owned non-root container fixture exercises a loopback **fake** model HTTP service, three actual source repairs, private-source cleanup and a second Docker verifier. This is transport/repair evidence, not a deployed trusted model service. The executable job entrypoint, private candidate endpoint and durable transfer/scheduling still need implementation.

Submitting a job's own success report **does not authorize a PR**. The finish gate requires all four real production checks, exact verified fix IDs, reconciled usage, and a separately trusted verifier receipt matching the report digest and a pinned base SHA. Its only automatic successful state is `ready-for-review`; there is no cloud publishing in this local implementation. Run metadata intentionally omits raw source, screenshots and prompt text.

`verifyHostedCandidate` in `src/hosted/trusted-verifier.ts` produces a local receipt by replaying the job's claimed source patches in a fresh Docker verifier. Its checkout, pinned SHA and reconciled usage must come from the trusted coordinator, independently of the job. It runs the existing browser and production gates, rejects changed checkout provenance, and removes private snapshots before returning. The finish workflow atomically claims `verifying` in the shared run store; concurrent service instances cannot repeat verification. An interrupted claim remains pending for trusted reconciliation rather than starting another verifier automatically. Cloud deployment still needs durable candidate transfer, receipt scheduling and reconciled per-run usage wiring.

The service now has separate **Cloud Tasks REST** and **Firestore REST** adapters, both validated with exact-request, duplicate-delivery and optimistic-concurrency tests; Firestore stores only bounded aggregate run metadata, never source or prompts. The webhook can enqueue an OIDC-authenticated task through the Cloud Tasks adapter, and a second service instance can recover a submitted run through Firestore and complete the trusted-receipt check. Production infrastructure credentials are injected by trusted workload identity, not read from an untrusted repository. No GCP API requests or billable resources were created in these tests.

`HostedPatchAgent` requires an explicit `runStore`: `FirestoreHostedAgentRunStore` for durable authorization, or `InMemoryHostedAgentRunStore` for local tests. Registration and inspection are asynchronous. The durable store retains token hashes and bounded metadata; it never retains raw tokens, source or prompts. Atomic request claims prevent two service replicas from spending the same run allowance concurrently. Restarts preserve request counts, settled input/output tokens, unknown usage and the originally authorized model, cost and per-task token ceilings. Task allowances use hashed rule/source identities, so changing a worker-supplied task ID does not reset usage. Conservative prompt/image bounds are checked before a call; actual token overshoots reject the patch and retain known spending. Configure the task cap with `maxTaskTokens`, whose default lives in `src/config.ts`. Interrupted in-flight requests stay blocked pending trusted reconciliation.

The trusted service must classify its configured provider with `providerVerification: "provider-api"` or `"fake-provider"`; this classification is bound to the run authorization. Before issuing a verification receipt, call `await agent.sealForVerification(runId)` and pass its service-recorded usage to `verifyHostedCandidate` as `reconciled`. Sealing blocks further provider calls across service replicas and restarts, refuses an in-flight request, and preserves unknown usage. A run with no settled provider calls is labeled `not-run`. Do not substitute usage supplied by the worker. Earlier stored authorizations lacking the required counters and seal fail validation; they are not treated as zero-cost runs.

`FirestoreSpendLedger` supplies shared cumulative allowances to the existing budget provider and Hosted agent. A trusted operator initializes each fixed `budgetId` once; service replicas reopen the same records. With `installationBudgetId`, each call atomically reserves against both the global and installation caps and creates one metadata claim. Settlement updates all three records together. Lost responses retain either reservations or accounted usage; overspending blocks further calls. Aggregate documents stay bounded as settled claims accumulate. Local fake-service tests cover concurrency, restarts, interrupted settlement, unknown usage and historical bounds; live Firestore access remains untested.

`HostedPatchAgent` requires `ledgerForRun` instead of one fixed ledger. Configure `ledgerForRun: run => openMonthlyHostedSpend(metadataOptions, run.installationId)` for the shared monthly policy. The resolver uses the authenticated installation and the current UTC month, opening operator-initialized `global-YYYY-MM` and `installation-ID-YYYY-MM` records. Missing policy denies the call; it never creates a fresh allowance. Outstanding claims keep their original scopes when the month changes. Policy provisioning and actual cloud-service configuration still require operator setup.

A local dispatcher now joins the Cloud Tasks HTTP request to a **create-only Firestore dispatch claim**, run-token registration and a fixed Cloud Run Jobs REST invocation. Its complete local roundtrip tests cover concurrent duplicate dispatch, restart idempotence, unknown-cloud-response reconciliation, scoped token transfer and fixed cloud project/job identity. A failed or uncertain launch consumes the durable claim and is not blindly retried. No real Cloud Run Job was launched, no remote GCP call was made and no paid resource was created.

**Not deployment-ready:** live Cloud Tasks/Firestore IAM and service ingress have not been verified. Google-signed Cloud Tasks OIDC authentication now has a local RS256/JWKS verifier with signature, issuer, fixed audience, service-account identity and expiry checks (tested with fixture-signed tokens). Construct `GoogleCloudTasksOidcVerifier` with the exact service origin in the queue's `oidcToken.audience` and the queue service account, then pass `authorization => verifier.verify(authorization)` as the task dispatcher's authentication callback. Live Google token and ingress/IAM validation remain untested. The executable job/service composition, deployment wiring for spending policies, durable candidate and receipt transport/scheduling, cloud dashboard IAM, release workflow, alerts and the planned operations period are still missing. Production use requires a controlled operator deployment and explicit authorization; the local code is not a completed Hosted App.

## Private operator dashboard (local, read-only)

The `app/` Next.js App Router application now renders Firestore aggregate run metadata, with a paginated run table, individual run details, statuses, checks and reconciled spending. It refuses to display unknown document fields, raw source, prompts, reports, screenshots and secrets. The Firestore client uses a fixed Google HTTPS endpoint and Cloud Run's workload-identity metadata token; no service-account key is bundled. The local HTTP auth gate fails closed without an operator username and a sufficiently long password. **This additional Basic gate is not a substitute for Google Cloud IAM/IAP and private ingress.** Production deployment and authentication have not been authorized or verified.

For a normal local dependency installation: `npm ci --prefix app --ignore-scripts`, `npm run check --prefix app`, `npm run build --prefix app`, then `npm run test:smoke --prefix app`. Supply `ACCESSWRIGHT_DASHBOARD_USERNAME`, `ACCESSWRIGHT_DASHBOARD_PASSWORD`, `ACCESSWRIGHT_GCP_PROJECT_ID` and `ACCESSWRIGHT_FIRESTORE_RUN_COLLECTION` via trusted server configuration for an actual instance. The smoke script starts only a localhost server with fixture credentials and verifies an unauthenticated 401, authenticated HTML, and failure-closed operation without a cloud backend. Firestore adapter tests mock Google APIs; no real cloud read has been performed. In the T7-mounted Mac test environment, `node_modules` and `.next` are symlinks to T7; the local build additionally uses `NODE_PATH` pointing at the mounted dashboard dependency directory.

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
To continue an interrupted run, repeat its *identical* command with `--resume` and the same output folder. Completed cells and the original rendered reference are reused only after checking protocol/model/implementation identities and regenerating every reference mutation from the exact pinned source AST. The original multi-route browser baseline is not repeated for an unchanged reference, but each **new candidate** still undergoes real Docker build, browser checks, per-patch verification and the full final production gate. This avoids duplicate paid calls without counting unverified mutations. A changed protocol, model, selected corpus, system, seed, batch bound or compiled implementation fails closed; completed reports cannot be resumed. A previously stored `blocked` cell is retained as failed evidence and is not silently converted into a success: rerun genuinely changed infrastructure in a separate output and report it separately, without pooling unlike implementations.

Evaluation outputs carry both the frozen protocol digest and a digest of an immutable compiled-runtime snapshot stored in the selected output directory. Trusted dependencies are still reused read-only, not duplicated into Docker; changes to that snapshot during a run fail closed without pooling implementations. Live `B1,A1,A` cells additionally require a dated explicit authorization metadata file, current authenticated model availability, pricing, a per-run cap, and a durable cumulative spending ledger. Fake-provider cells are labeled separately and are never pooled with live measurements.

A frozen development deterministic smoke on 2026-10-07 selected four public repositories and produced five eligible seeded cases across three verified-compatible repositories: three semantically correct fixes, two unresolved cases, zero changed clean controls out of 368 observed, and USD 0 model spend. One fourth repository was unsupported because the unmodified production build failed. This `max-cases=2` smoke is **not** the 300-case Track S test result and is not a live B1/A1/A comparison.

## Deutscher technischer Prüfbericht (lokal)

A German-language evidence template is available for an existing **aggregate** run report. It is not a WCAG / EN 301 549 / EAA legal conformity certification. A reviewed list of accepted fix commits is required; missing or contradictory evidence fails closed. The command never contacts a cloud service and refuses to overwrite existing output:

```sh
npm run build
npm run evidence:de -- --report /absolute/path/report.json --commits /absolute/path/accepted-commits.json --out /absolute/path/evidence-de.md
```

The commits file contains an array of objects with only `id` and the 40-character `commit` SHA. The output contains counts, route/condition coverage, unavailable checks, technical references, limitations and mandatory manual-review topics, not raw source code, screenshots or prompts.

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
