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

To install a locally built package, run `npm run build` and `npm pack --ignore-scripts`. Install the resulting tarball in a separate consumer directory:

```sh
npm install --ignore-scripts /absolute/path/to/accesswright-0.0.0.tgz
npx accesswright --help
npx accesswright fix /absolute/path/to/next-project --no-llm --dry-run
```

The tarball contains the compiled runtime, type declarations, README, license and changelog. Development checkouts, tests, evaluation fixtures, dashboard sources and internal documents are excluded. The library entry exports `repairRepository` from `accesswright`. Help works without Docker or a model key; repairs require Docker. This installation uses a local tarball and does not publish the package.

The Docker runtime uses one complete dependency tree matching the installed coordinator. Split layouts or dependencies linked outside that tree are rejected; install the tool in a separate npm directory if an existing project's dependency layout conflicts.

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

Backlog publication also requires the target repository's **Allow GitHub Actions to create and approve pull requests** setting and explicit workflow `contents: write` and `pull-requests: write` permissions. A disabled repository setting can return HTTP403 after verified repair commits are created. For GitHub's web-flow commits, recovery requires the expected bot author and a valid signature. Every recovery checks exact verified source and branch ownership before opening a missing PR; human or unattributable changes remain preserved.

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

The local Hosted service modules include a signed GitHub webhook receiver with installation and repository allowlists, multi-repository installation deliveries and bounded HTTP transport; a run-token-authenticated model patch endpoint; and an aggregate-results state machine for `POST /runs/{id}/results`, `POST /runs/{id}/finish` and authenticated `GET /runs/{id}/status`. The target runner receives a scoped per-run token, never provider or GitHub credentials. `FirestoreWebhookRunRegistry` deduplicates confirmed enqueues across restarts; uncertain replies remain held for reconciliation.

`node dist/src/hosted/service-entry.js` composes four operator-configured roles from bounded `ACCESSWRIGHT_HOSTED_CONFIG` JSON. The exported `HostedServiceConfigSchema` is the configuration contract; secrets are separate environment variables. Every role requires an absolute owned `workRoot` for metadata, distinct Firestore collections, and fixed task origins/accounts.

| Role | HTTP responsibility | Required trusted credentials |
| --- | --- | --- |
| `webhook` | Public signed webhook to the private jobs queue | App signing key and webhook secret |
| `agent` | Private job dispatch, pinned input and bounded patch/candidate API | App signing key and configured model key |
| `relay` | Private candidate/expiry tasks to the Docker verifier | Google workload identity |
| `verifier` | Independent Docker replay and durable final result | App signing key and Google workload identity; no model key required |

The agent configuration also fixes its private `agentOrigin`, job/container identifiers, a distinct job-task account and dispatch collection. The webhook configuration fixes the same agent origin/account, its jobs queue, allowed installations and webhook collection. App keys use `ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY`; webhook signatures use `ACCESSWRIGHT_GITHUB_WEBHOOK_SECRET`. Agent model, token/cost ceilings and pricing are operator configuration. Shared monthly allowances must already exist; startup never creates a spending policy.

GitHub source access requests only one repository with `contents: read`, validates the App/installation/owner and pins an exact Git commit before worker authorization. Installation jobs use the default branch; PR comments use the base repository's exact `pull/{number}/head` ref, with no merge/default fallback. Comment senders require confirmed repository write access. The original pin is create-only and reused by input preparation and independent replay; checkout release must succeed before a receipt is returned.

`createHostedAgentServer({ agent, store, verifyTrustedResult, receiveCandidate, input })` in `src/hosted/agent-http.ts` combines input, patch, candidate, results, finish and status routes in one private HTTP server. All routes authenticate against the same `HostedPatchAgent` run store. Candidate staging must be private, immutable per run and cleared after verification or expiry. A candidate acknowledgment binds the exact payload digest and only confirms transfer; the separate finish gate still requires independent verification. Without `receiveCandidate`, candidate submission fails closed. Supply durable stores and an independent verifier before listening behind private ingress. Public GitHub webhooks and Cloud Tasks dispatch use their separate receivers; this factory does not launch a worker or configure cloud infrastructure.

Optional `input: { resolveCheckout, evidenceRoot }` enables `POST /runs/{id}/input`. The server consumes a durable one-time claim before reading private source. Its trusted callback receives authenticated run metadata and returns the original pinned checkout/SHA plus a required `release()` callback; the worker cannot select a repository or revision. `createHostedInputBundle` reads raw Git blobs without filters or hooks, reuses the credential exclusions, omits symlinks and bounds paths, file count and bytes. Binary bytes retain their Git blob hashes. The trusted checkout is released before responding; failed reads or responses retain the claim. Authorizations missing the required input-claim field fail validation.

The generic `node /accesswright/dist/src/hosted/worker-download-entry.js` fetches this bundle at runtime into an exclusively created `/input/source`. It requires the same secretless non-root boundary and scoped environment as the preloaded entry, validates every blob before writing, and deletes its owned input before candidate transfer or on failure. Existing input directories are preserved and rejected. Cloud input authorization, pinned checkout provisioning and image deployment still require acceptance.

`Dockerfile.worker` builds that generic image using pinned dependencies with lifecycle scripts disabled. Its build context allowlist includes only the public runtime and build inputs; repository inputs, internal documents, Git metadata and tests are omitted. The final runtime is root-owned and not writable by `pwuser`; `/input`, `/workspace` and the temporary directory are initially empty and owned by that non-root user. Build locally with `docker build -f Dockerfile.worker -t accesswright-worker:local .`. Inject the trusted agent origin/provider classification and scoped run configuration at job launch. Do not supply provider keys, GitHub tokens, service-account keys or private source through build arguments, image layers or worker environment. Deployment must separately restrict the worker's workload identity. `test/e2e/worker-image-download.test.ts` is opt-in and requires `ACCESSWRIGHT_TEST_WORKER_IMAGE` set to an immutable local image ID.

`HostedAgentClient` in `src/hosted/agent-client.ts` sends semantic patch requests using a scoped run token and an operator-selected HTTPS origin (loopback HTTP is allowed for local tests). Cloud Run workers additionally require `ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL` and a fixed-audience metadata ID token in `X-Serverless-Authorization`; application authorization still uses the run token ([Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)). Grant that worker account only invocation of the private agent, with no storage, metadata-store or secret permissions. The client rejects redirects, oversized or malformed responses, contradictory HTTP/result states, and patches outside the task's deterministic context. An interrupted response is returned with unknown usage and never retried automatically. The patch service accepts bounded PNG bytes and previous verifier feedback, forwards the actual image bytes to the configured provider, and retains neither in its run metadata. A schema-accepted response still needs the worker's existing per-patch and final production verification.

`EphemeralRepairSession` in `src/runner/ephemeral-repair-session.ts` reuses the existing scan, repair and production gates inside a secretless, non-root Linux worker container. It accepts a preloaded sanitized `/input` snapshot or the owned `/input/source` download, and requires a read-only trusted runtime, an allowlisted environment and exclusive workspace ownership. Cloud Run Jobs additionally require a trusted image marker and one initial task; automatic retry attempts are rejected. Offline mode is refused because this driver cannot enforce network isolation. The worker's own browser evidence is untrusted; only independent replay can authorize review.

`runHostedWorker` in `src/hosted/worker.ts` drives deterministic repair first, then bounded remote semantic proposals through `HostedAgentClient`. Every accepted proposal still passes the existing browser and production gates. Known rejected-call usage is retained; an unreconciled response blocks all further model calls. A validated `{ report, patches }` candidate reaches the supplied private `submitCandidate` callback only after the session's workspace and temporary source copies are cleared; it is never printed or published. Preloaded input volumes still belong to their caller, which must remove them when the job ends. Omitting the client selects deterministic mode. The executable `node /accesswright/dist/src/hosted/worker-entry.js` requires the secretless container boundary and image-configured `ACCESSWRIGHT_AGENT_ORIGIN` and `ACCESSWRIGHT_PROVIDER_VERIFICATION`, plus a scoped run ID/token. It submits once through the bounded candidate endpoint; lost acknowledgments require trusted reconciliation. An owned non-root container fixture uses a loopback **fake** model service. This is transport/repair evidence, not a deployed trusted model service.

`createLocalHostedCandidateCoordinator` in `src/hosted/local-candidate-coordinator.ts` supplies `receiveCandidate` and `verifyTrustedResult` callbacks for local execution. It seals service-side usage before staging, bounds private candidates in memory, refuses changed payloads, expires pending source and removes candidates after verification or failure. Checkout/SHA/runtime selection comes from the trusted `resolveCheckout` callback. It retains only digest metadata in its JSONL trace. Pending candidates are lost on restart; cloud use needs durable private staging. Publication is disabled by default.

Candidate submission atomically claims `staging` in the aggregate store before any private write. Finish and other uploads are excluded until staging completes; a failed or uncertain write retains that claim across restarts for trusted reconciliation. A completed or already claimed verification cannot reopen private staging. The dashboard exposes the pending state without source payloads.

The aggregate store fixes the exact candidate digest on first staging. Identical acknowledged transfers return the original confirmation without uploading again, including after source expiry; changed patches with the same report are rejected. Stored metadata lacking the required candidate digest fails validation.

`GcsHostedCandidateStore` in `src/hosted/gcs-candidate-store.ts` provides private, create-only candidate objects with immutable expiry, generation-bound reads and checked deletion. Its bucket gate requires public-access prevention, uniform access control, and disabled soft deletion, versioning and retention/hold policies. A trusted `scheduleExpiry` callback must durably register cleanup before any private upload. Deletion checks both live and soft-deleted revisions; a recoverable object withholds cleanup confirmation. This adapter has fake HTTP tests; cloud wiring and live storage acceptance remain unfinished. Cloud Storage soft deletion otherwise retains deleted objects, so ordinary delete acknowledgment is insufficient ([Cloud Storage deletion contract](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete)).

`createHostedCandidateCoordinator` in `src/hosted/candidate-coordinator.ts` joins durable private storage, trusted usage sealing, metadata-only verification scheduling and fresh independent Docker replay. Use its callbacks behind `HostedRunWorkflow`'s durable claims. Checkout selection remains trusted configuration; every replay result waits for confirmed generation-bound source deletion. Failed metadata recording also removes uploaded source. Fake adapter tests cover service restarts and failure paths; actual cloud scheduling and deployment remain unverified. `store.expire(runId, originalExpiresAt)` uses the authenticated scheduled deadline without parsing potentially corrupted source. An absent object requires a prior trusted cleanup receipt; it is not proof that an interrupted upload or recoverable deletion is safe.

`CloudTasksCandidateQueue` in `src/hosted/candidate-task-queue.ts` schedules run/report digests for verification and run/original-deadline metadata for expiry, with fixed private HTTPS targets and OIDC identity. Wire `scheduleVerification: (id, digest) => queue.enqueueVerification(id, digest)` and the storage adapter's `scheduleExpiry: (id, expiry) => queue.enqueueExpiry(id, expiry)`. No patches or credentials enter tasks. Create responses and duplicate tasks require exact full metadata; a deleted name's reservation is rejected instead of being called a scheduled cleanup. The workload identity needs task create/get/full-view permissions ([Cloud Tasks task lookup](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/get)). Queue checks use fake HTTP only; authenticated handlers, durable cleanup receipts, queue retry policy and live cloud acceptance are still separate requirements.

The durable coordinator requires a `cleanup` store. `FirestoreCandidateCleanupStore` in `src/hosted/candidate-cleanup.ts` persists only the immutable object generation, candidate digest, original expiry and pending/cleared state. Registration precedes deletion, and confirmation follows the storage adapter's physical/recoverability checks. Lost confirmations retain the fixed generation for trusted metadata recovery; they never authorize another model call or replay. `clearHostedCandidate` repeats only that bounded cleanup. Both adapters use fake APIs in tests; live Firestore and bucket behavior still need acceptance. Cleanup metadata alone is not a trusted patch-verification receipt.

`createHostedCandidateTaskServer` in `src/hosted/candidate-task-http.ts` exposes only private `/internal/candidates/verify` and `/internal/candidates/expire` routes. Supply `GoogleCloudTasksOidcVerifier` for the exact queue service account/origin, a trusted workflow, durable run/cleanup stores, private storage and a metadata evidence directory. Authentication precedes bounded metadata parsing; worker tokens are refused. `finishTrustedReport` checks the stored report digest and reuses the existing atomic independent-verification gate, including after worker-token expiry. Interrupted claims are not released. Expiry requires the immutable original deadline and confirmed generation-bound cleanup; an interrupted upload's generation can be recovered without parsing source. Missing objects with no cleanup receipt remain pending. Local HTTP tests use fake cloud APIs and the mocked replay boundary; live ingress, queue retry policy, runtime and deployment acceptance remain unfinished.

Submitting a job's own success report **does not authorize a PR**. The finish gate requires all four real production checks, exact verified fix IDs, reconciled usage, and a separately trusted verifier receipt matching the report digest and a pinned base SHA. Its only automatic successful state is `ready-for-review`; there is no cloud publishing in this local implementation. Run metadata intentionally omits raw source, screenshots and prompt text.

`verifyHostedCandidate` in `src/hosted/trusted-verifier.ts` returns a metadata-only `receipt` and a separate private `artifact` after fresh Docker replay. The artifact contains full source exported from the trusted patch journal and a report rebuilt from actual replay outcomes, production checks, scan summaries and independently reconciled usage. It binds the worker report, candidate and pinned base identities; worker summaries are not forwarded as verification facts. Private snapshots are removed before returning.

Both coordinators optionally accept `onVerifiedCandidate(runId, artifact, artifactDigest)`, also exposed by `createHostedTrustedServices`. The callback runs only after checkout release and candidate deletion are confirmed. Artifacts stay in trusted process memory and never enter HTTP status, durable run metadata or trace payloads. `publishHostedVerifiedCandidate` validates the expected candidate/report/base and complete artifact digest, rebuilds the PR body, and reuses the existing exact-source and human-commit protections. The digest checks integrity; it is not authentication or publishing permission. Supply independently authorized repository metadata and a separate write credential only in this trusted callback; source-only App credentials remain read-only. No executable cloud role enables publication by default.

The finish workflow atomically claims `verifying` in the shared run store. If replay, cleanup, artifact delivery or publication acknowledgment fails, the claim stays pending across restarts; task redelivery cannot blindly replay or write again. Reconciliation must inspect the actual remote branch and PR before any recovery. A metadata receipt alone never authorizes publication.

The service now has separate **Cloud Tasks REST** and **Firestore REST** adapters, both validated with exact-request, duplicate-delivery and optimistic-concurrency tests; Firestore stores only bounded aggregate run metadata, never source or prompts. The webhook can enqueue an OIDC-authenticated task through the Cloud Tasks adapter, and a second service instance can recover a submitted run through Firestore and complete the trusted-receipt check. Production infrastructure credentials are injected by trusted workload identity, not read from an untrusted repository. No GCP API requests or billable resources were created in these tests.

`HostedPatchAgent` requires an explicit `runStore`: `FirestoreHostedAgentRunStore` for durable authorization, or `InMemoryHostedAgentRunStore` for local tests. Registration and inspection are asynchronous. The durable store retains token hashes and bounded metadata; it never retains raw tokens, source or prompts. Atomic request claims prevent two service replicas from spending the same run allowance concurrently. Restarts preserve request counts, settled input/output tokens, unknown usage and the originally authorized model, cost and per-task token ceilings. Task allowances use hashed rule/source identities, so changing a worker-supplied task ID does not reset usage. Conservative prompt/image bounds are checked before a call; actual token overshoots reject the patch and retain known spending. Configure the task cap with `maxTaskTokens`, whose default lives in `src/config.ts`. Interrupted in-flight requests stay blocked pending trusted reconciliation.

The trusted service must classify its configured provider with `providerVerification: "provider-api"` or `"fake-provider"`; this classification is bound to the run authorization. Before issuing a verification receipt, call `await agent.sealForVerification(runId)` and pass its service-recorded usage to `verifyHostedCandidate` as `reconciled`. Sealing blocks further provider calls across service replicas and restarts, refuses an in-flight request, and preserves unknown usage. A run with no settled provider calls is labeled `not-run`. Do not substitute usage supplied by the worker. Earlier stored authorizations lacking the required counters and seal fail validation; they are not treated as zero-cost runs.

`FirestoreSpendLedger` supplies shared cumulative allowances to the existing budget provider and Hosted agent. A trusted operator initializes each fixed `budgetId` once; service replicas reopen the same records. With `installationBudgetId`, each call atomically reserves against both the global and installation caps and creates one metadata claim. Settlement updates all three records together. Lost responses retain either reservations or accounted usage; overspending blocks further calls. Aggregate documents stay bounded as settled claims accumulate. Local fake-service tests cover concurrency, restarts, interrupted settlement, unknown usage and historical bounds; live Firestore access remains untested.

`HostedPatchAgent` requires `ledgerForRun` instead of one fixed ledger. Configure `ledgerForRun: run => openMonthlyHostedSpend(metadataOptions, run.installationId)` for the shared monthly policy. The resolver uses the authenticated installation and the current UTC month, opening operator-initialized `global-YYYY-MM` and `installation-ID-YYYY-MM` records. Missing policy denies the call; it never creates a fresh allowance. Outstanding claims keep their original scopes when the month changes. Policy provisioning and actual cloud-service configuration still require operator setup.

A local dispatcher now joins the Cloud Tasks HTTP request to a **create-only Firestore dispatch claim**, run-token registration and a fixed Cloud Run Jobs REST invocation. Its complete local roundtrip tests cover concurrent duplicate dispatch, restart idempotence, unknown-cloud-response reconciliation, scoped token transfer and fixed cloud project/job identity. A failed or uncertain launch consumes the durable claim and is not blindly retried. No real Cloud Run Job was launched, no remote GCP call was made and no paid resource was created.

The verifier role requires a dedicated native Linux host and local rootful Docker. `deploy/prepare-verifier-network.sh` prepares ordered IPv4/IPv6 forwarding rules on an idle dedicated host: metadata DNS remains usable, while other container access to Google metadata addresses is denied ([Google metadata endpoints](https://docs.cloud.google.com/compute/docs/metadata/overview)). It preserves existing rules and refuses a conflicting guard. Verifier startup and each source preparation independently recheck the local daemon and firewall with read-only commands; missing rules or unavailable restricted `sudo` access withhold verification. Firewall preparation is an operator deployment operation, not performed by the service. Kernel enforcement still requires actual host acceptance.

In the agent role, `finish` polls the separately scheduled verifier without consuming its claim. The relay client requires both the exact HTTP result and matching durable terminal metadata; a successful HTTP response alone cannot authorize review. Job-task creation also checks exact full metadata after a 409, rather than treating a reserved deleted name as a live task.

**Not deployment-ready:** role composition and HTTP tests use fake cloud APIs and fixture-signed Google tokens. Actual Google token/ingress/IAM behavior, private GitHub App source access, storage deletion policy, generic-image acceptance, host firewall enforcement, spending-policy provisioning, cloud dashboard IAM, verified-patch publication, release workflow, alerts and the planned operations period remain incomplete. Production use requires a controlled operator deployment and explicit authorization; the local code is not a completed Hosted App.

## Private operator dashboard (local, read-only)

The `app/` Next.js App Router application now renders Firestore aggregate run metadata, with a paginated run table, individual run details, statuses, checks and reconciled spending. It refuses to display unknown document fields, raw source, prompts, reports, screenshots and secrets. The Firestore client uses a fixed Google HTTPS endpoint and Cloud Run's workload-identity metadata token; no service-account key is bundled. The local HTTP auth gate fails closed without an operator username and a sufficiently long password. **This additional Basic gate is not a substitute for Google Cloud IAM/IAP and private ingress.** Production deployment and authentication have not been authorized or verified.

For a normal local dependency installation: `npm ci --prefix app --ignore-scripts`, `npm run check --prefix app`, `npm run build --prefix app`, then `npm run test:smoke --prefix app`. Supply `ACCESSWRIGHT_DASHBOARD_USERNAME`, `ACCESSWRIGHT_DASHBOARD_PASSWORD`, `ACCESSWRIGHT_GCP_PROJECT_ID` and `ACCESSWRIGHT_FIRESTORE_RUN_COLLECTION` via trusted server configuration for an actual instance. The smoke script starts only a localhost server with fixture credentials and verifies an unauthenticated 401, authenticated HTML, and failure-closed operation without a cloud backend. Firestore adapter tests mock Google APIs; no real cloud read has been performed. In the T7-mounted Mac test environment, `node_modules` and `.next` are symlinks to T7; the local build additionally uses `NODE_PATH` pointing at the mounted dashboard dependency directory.

## Security and privacy

Run steps always write validated `run.jsonl` metadata. Set `OTEL_EXPORTER_OTLP_ENDPOINT` (a base HTTP/HTTPS address) or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (the exact trace URL) in the trusted coordinator to additionally export each step through OTLP HTTP. Standard OTLP header and timeout environment variables are supported. Exported spans contain step status/duration, model identity, token/cost counts and a validated prompt hash; arbitrary page metadata, source paths, prompts and images are excluded. Collector failures add a local `trace-export` error without replacing verifier decisions. No collector connection is made without an endpoint. Export is opt-in; review the collector's access and retention policy before configuring it.

Target source executes only in an isolated application container. The trusted browser is a separate container; the application cannot write browser evidence or access the Docker socket. The model and GitHub credentials remain in the coordinator. Source snapshots exclude Git metadata, environment files, package-manager credentials, private-key files, dependency directories, and symbolic links. Model patches cannot edit manifests, lockfiles, build configuration, or workflows.

The persistent runner reuses the existing trusted runtime and dependencies through read-only host mounts on every platform, including macOS. It does not automatically copy that dependency tree into Docker storage after a mount failure. The library's copy mode requires an explicit caller choice and creates a temporary Docker volume; it is not the CLI default. The target application's writable workspace remains isolated inside its own container. All Docker control operations have bounded timeouts, and cleanup targets only resources owned by that run.

Model-assisted mode sends bounded source excerpts, deterministic call-site context, and cropped images to the explicitly configured provider. `--no-llm` sends none of this to a model. Raw SDK request bodies and credentials are not logged. Retained screenshots and raw page observations can still contain sensitive source content: enable retention only deliberately and do not publish them automatically.

## Reproducible evaluation

`eval/protocol-20261012.json` freezes the public Next.js corpus (55 repositories: 46 test, 9 dev; Next.js 12-16 by lockfile-resolved version), exact SHAs, dev/test split, operators, seeds, systems, the 80-case test target, and `gpt-6-luna` high-reasoning configuration. It extends `eval/protocol-20261007.json` (20 repositories, unchanged and still valid for its own results) with repositories drawn alphabetically from the archived candidate pool `eval/candidate-pool-20261012.json` (every examined candidate and its rejection reason is in `eval/candidate-checks-20261012.json`) and with the A11YRepair repositories that pass the same filters (`eval/a11yrepair-sources-20261012.json`). Results under different protocol digests are not pooled. A zero-cost smoke run is:

```sh
npm run build
npm run eval -- --protocol eval/protocol-20261012.json --output /absolute/path/to/results --split dev --systems deterministic --max-cases 2 --tmp-root /tmp/accesswright/integration-20261007 --cache-root /tmp/accesswright/integration-20261007/eval-source-cache
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

Development checks on 2026-10-07 include more than 360 passing deterministic/unit tests, an owned Next.js 16 App Router fixture, Next.js 15.5.27 TSX and 16.3.8 JSX Pages Router fixtures with dynamic routes (on 2026-10-12 extended to Next.js 12.3.7, 13.5.11 and 14.2.35 Pages Router and 13.5.11 and 14.2.35 App Router fixtures, all mapped and repaired through webpack source mapping) and a controlled HTTP data service, and a Tailwind 4.3.3 runtime-palette fixture. Actual Chromium/axe/ARIA scans cover desktop/mobile conditions. Production checks discard both compiler-breaking patches and patches whose target disappears only in development but returns in production. A compiled CLI rerun makes no duplicate change. A fixed browser soundness set rejected all 8 harmful modifications and accepted all 4 legitimate changes. These are controlled integration cases, not a broad public-repository success rate.

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
