# Changelog

## [Unreleased]

### Breaking Changes

- `HostedPatchAgent` requires an explicit run store; run registration, inspection and metadata listing are asynchronous.
- `HostedPatchAgent` selects its spending ledger through an asynchronous `ledgerForRun` callback using authenticated run metadata.

### Added

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
