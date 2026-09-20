# fastest-e2e

Read `package.json` for commands, `README.md` for usage, and `docs/design.md` for runtime/recovery invariants. Run `npm run check`; browser suites are in CI and README. No parallel design/process documents.

CLI and MCP use the same Effect v4 handlers and schemas. Reuse upstream Jev, Playwright, and Midscene. Do not build another agent loop. Pin dependencies with both lockfiles and Actions with full commit SHAs.

A saved run is not saved browser state. Preserve profile/target/document ownership, dispatch uncertainty, cumulative budgets, and failed attempts. Never retry uncertain production writes or use reconstruction to hide a failed persistence test. Missing evidence cannot become a pass.

Keep stdout JSON/MCP, errors redacted, provider use explicit, and recovery inputs allowlisted. Literal task inputs are persisted; sensitive values need local environment references. Do not claim lossless restore, complete redaction, or an OS sandbox.

Keep the three skills short. Put setup in `docs/setup.md`, tests in `docs/testing.md`, and fallback in `docs/fallback.md`. Change shared behavior in one place and test CLI/MCP parity.
