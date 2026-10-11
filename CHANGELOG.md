# Changelog

## [Unreleased]

### Breaking Changes

- Hosted authorization metadata requires an irreversible private-input claim; earlier incomplete records fail validation.
- Durable candidate coordination requires an explicit trusted cleanup receipt store.
- Private candidate expiry requires the authenticated task's original deadline; absent objects require a prior trusted cleanup receipt.
- Hosted run metadata requires a nullable immutable candidate digest; earlier incomplete records fail validation.
- Hosted authorization records require a fixed per-task token ceiling and hashed cumulative task usage; earlier incomplete records fail validation.
- `HostedPatchAgent` requires an explicit provider-evidence classification. Durable authorization records now require settled request and token counters plus a verification seal; earlier records fail validation rather than inferring missing usage.
- LLM `promptHash` now covers a versioned encoding of text, system instructions, image bytes, media types and image order, rather than text alone.
- `HostedPatchAgent` requires an explicit run store; run registration, inspection and metadata listing are asynchronous.
- `HostedPatchAgent` selects its spending ledger through an asynchronous `ledgerForRun` callback using authenticated run metadata.

### Added

- Opt-in OTLP HTTP step spans with metadata-only export, local failure evidence and no global tracing registration.
- CLI help without repository access, Docker or model credentials, and a typed library entry for installed packages.
- Target-repository support extended from Next.js 15.5-16 to Next.js 12-16; Docker fixtures for Next 12.3.7, 13.5.11 and 14.2.35 (Pages Router) and 13.5.11 and 14.2.35 (App Router) map and repair through webpack source mapping.
- Read-only GitHub App source access with installation/owner/repository checks, bounded signed requests and metadata-only revision records.
- Create-only Firestore original-revision pins shared by source provisioning and independent verification across service restarts.
- Temporary trusted checkouts with pinned HTTPS Git fetches, scrubbed installation-token runtime configuration, metadata-only records and explicit source erasure.
- Run-scoped, one-time source download using bounded pinned Git blobs, shared credential exclusions, exclusive materialization and cleanup before candidate transfer.
- Private candidate task HTTP ingress with distinct OIDC authentication, digest-bound trusted finish, interrupted-upload cleanup and metadata-only step records.
- Firestore candidate cleanup receipts with immutable object identity and deletion confirmation recoverable across service restarts.
- Metadata-only candidate verification/expiry Cloud Tasks with exact OIDC task confirmation and rejection of reserved deleted task names.
- Durable candidate coordination with trusted usage sealing, pre-write verification scheduling, independent replay and cleanup-before-receipt enforcement.
- Private Cloud Storage candidate adapter with create-only writes, immutable expiry, pre-write cleanup scheduling, generation-bound reads and recoverable-object deletion checks.
- Authenticated bounded candidate HTTP transfer, exact-digest acknowledgments, a secretless executable worker entrypoint and local private staging with expiry, trusted usage sealing and independent replay.
- Hosted worker repair loop with bounded remote proposals, retained rejected-call usage, unknown-response blocking and candidate transfer only after private-source cleanup.
- Secretless non-root ephemeral repair sessions that reuse existing browser/production gates, refuse unsupported offline mode and duplicate job attempts, and require independent trusted verification.
- Bounded Hosted worker patch transport with PNG evidence, verifier feedback, scoped authentication and fail-closed response/path validation.
- Trusted Hosted per-run token settlements and an irreversible seal that blocks further model calls before independent verification.
- Independent Docker replay of Hosted candidate patches, pinned-checkout and reconciled-usage checks, and digest-bound review receipts.
- Private Hosted HTTP service composition with shared scoped run authentication for patches, results, finish and status, retaining the independent trusted-verifier gate.
- Atomic global and per-installation spending claims, with explicit UTC monthly policy selection and no automatic allowance creation.
- Firestore cumulative spending ledger with atomic budget/reservation claims, persistent unknown usage, and fail-closed settlement across service replicas.
- Firestore-backed Hosted run authorization with hashed tokens, atomic request claims, and persistent model, request and cost limits.
- Backlog product Action with isolated target checkout, zero-cost/no-LLM defaults, verified-group publication, and read-only checkout provenance validation.
- Real Docker regression coverage for semantic repairs, idempotent compiled CLI runs, production bisect, and browser anti-hiding checks.

- Strict YAML configuration loading and a compiled TypeScript build target.
- Transactional, unique-excerpt source patches with path and symbolic-link defenses.

- TypeScript/npm project foundation with strict checks and Vitest tests.
- Docker sandbox primitives with scrubbed host environment handling.
- Next.js App Router and Pages Router discovery with bounded same-origin crawling.
- Sandbox-only code-inspector source mapping injection.
- Axe, ARIA snapshot, screenshot, and source-location scanning primitives.
- JSONL run tracing with secret-like metadata rejection.
- Week 1 source-mapping fixtures and validation workflow.

### Changed

- npm tarballs contain the compiled runtime and public package documents, excluding development checkouts, fixtures and internal files.
- Opt-in OpenAI live validation uses the standard local `OPENAI_API_KEY` environment variable instead of the temporary GitHub secret name.
- Evaluation protocol `eval/protocol-20261012.json` replaces `eval/protocol-20261007.json` as the CLI default: 55 pinned repositories (46 test, 9 dev; Next.js 12-16 by lockfile-resolved version) instead of 20, and a test target of 80 seeded cases instead of 300, which the 16 original test repositories could not reach (about 2.5 valid unique cases per repository). The original 20 repositories, SHAs and splits are retained, plus eight A11YRepair repositories (A11YBench commits or the commit before a merged A11YRepair PR) that pass the same filters. The candidate pool and per-candidate qualification results are archived beside it.

### Fixed

- Recognized GitHub-signed web-flow commits authored by the expected bot during verified PR recovery and duplicate-run checks, retaining human-commit protection.
- Identified preserved unattributable repair branches in Action errors without exposing arbitrary diagnostics.
- Recognized installed npm command symlinks and mounted complete hoisted runtime dependencies without substituting module versions.
- Docker repairs on Next.js 12-14 no longer time out after a patch: webpack dev watchers could read a copied file before ownership was transferred, cache EACCES, and never recompile. Ownership transfer now also refreshes the file mtime.
- Excluded macOS transport sidecars from lint discovery and removed only verified untracked AppleDouble bytes in a newly owned pinned fetch.
- Withheld private cleanup when its registered object identity conflicts, without deleting a different generation.
- Erased corrupted private candidate objects at their trusted expiry without parsing source; missing current objects no longer imply confirmed cleanup.
- Prevented repeated completed candidate transfers from restaging expired private source or replacing patches with the same report.
- Claimed candidate staging atomically before private writes, preventing finish races and retaining uncertain staging claims across restarts.
- Rejected semantic patches whose settled cost or task tokens exceed the configured cap, including the last allowed attempt, while retaining known usage.
- Enforced cumulative Hosted task-token limits across restarts and changed worker task IDs, including image expansion and known actual overshoots.
- Claimed Hosted finish verification atomically across service replicas; interrupted claims remain pending and terminal decisions cannot be overwritten.
- Rejected contradictory Hosted production check flags and inconsistent verified-fix counts before requesting trusted verification.
- Rejected concurrent MCP operations before they can replace or close an active verification session.
- Collected axe and accessibility facts after the existing screenshot finishes finite page animations.
- Removed private source snapshots after early preparation failures and sandbox shutdown errors.
- Kept missing Hosted budget policies recoverable without recording unknown provider usage before a client call.
- Verified raw frozen Git blobs before rejecting checkout normalization artifacts, while retaining content, mode and path checks.
- Excluded macOS metadata from compiled evaluation snapshots and test discovery on external filesystems.
- Waited for affected development routes to recover after source patches before fresh browser verification; persistent route failures remain rejected.
- Preserved exactly one default export while instrumenting function-based Next.js configuration and avoided generated-name collisions.
- Rejected development-only repairs whose original target still fails or is inconclusive after the production build.
- Reused read-only host runtime mounts on macOS by default instead of silently duplicating dependencies into Docker storage.
- Preserved cumulative model-spend reservations across restarts and retained unknown usage conservatively.

- Rejected contradictory final-check evidence before creating a GitHub publication client.

- Excluded target-repository environment files, package-manager credentials, private-key files, and symbolic links from sandbox snapshots.
- Applied the same source-file boundary to both the legacy candidate runner and the new integration path.

### Removed

- Temporary GitHub workflow for development model verification and live repair smoke testing; the planned product Action and regular CI remain in scope.
