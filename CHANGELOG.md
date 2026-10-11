# Changelog

## [Unreleased]

### Breaking Changes

- Private candidate expiry requires the authenticated task's original deadline; absent objects require a prior trusted cleanup receipt.
- Hosted run metadata requires a nullable immutable candidate digest; earlier incomplete records fail validation.
- Hosted authorization records require a fixed per-task token ceiling and hashed cumulative task usage; earlier incomplete records fail validation.
- `HostedPatchAgent` requires an explicit provider-evidence classification. Durable authorization records now require settled request and token counters plus a verification seal; earlier records fail validation rather than inferring missing usage.
- LLM `promptHash` now covers a versioned encoding of text, system instructions, image bytes, media types and image order, rather than text alone.
- `HostedPatchAgent` requires an explicit run store; run registration, inspection and metadata listing are asynchronous.
- `HostedPatchAgent` selects its spending ledger through an asynchronous `ledgerForRun` callback using authenticated run metadata.

### Added

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

- Opt-in OpenAI live validation uses the standard local `OPENAI_API_KEY` environment variable instead of the temporary GitHub secret name.

### Fixed

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
