# Changelog

## [Unreleased]

### Added

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

- Excluded target-repository environment files, package-manager credentials, private-key files, and symbolic links from sandbox snapshots.
- Applied the same source-file boundary to both the legacy candidate runner and the new integration path.

### Removed

- Temporary GitHub workflow for development model verification and live repair smoke testing; the planned product Action and regular CI remain in scope.
