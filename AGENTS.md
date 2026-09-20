# fastest-e2e

Read `package.json` for commands and `README.md` for supported behavior. Run `npm run check` before committing. Browser integration tests are documented in the README.

For planned runtime changes, read [the design and checklist](docs/design.md). Keep proposals out of operational skills until implemented. A saved run is not saved browser state; distinguish validated continuation from reconstruction, restart, and unrecoverable loss. Keep design decisions in that one document, not parallel process documents.

CLI and MCP call the same Effect v4 service. Keep the Jev action loop upstream; `worker/bridge.py` owns only session handoff, assertions, and the process protocol. Pin upgrades as one reviewed change with both lock files updated.

Browser selection must fail closed. Never add automatic personal-profile discovery, implicit cloud fallback, or retries of uncertain production mutations. Keep stdout valid JSON or MCP; redact credentials and avoid raw model error dumps.

A test pass requires fresh explicit evidence. A model's completion claim is not evidence. Preserve blocked/failed tabs and failed attempts for diagnosis.

Keep the three skills short. Put setup details in `docs/setup.md`, fallback details in `docs/fallback.md`, and command options in `--help`. Change shared behavior in one place.
