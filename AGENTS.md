# fastest-e2e

Read `package.json` for commands and `README.md` for supported behavior. Run `npm run check` before committing. Browser integration tests are documented in the README.

For orchestration or protocol changes, read [the system design](docs/design.md) and [agent contract](docs/agent-contract.md). For reusable site knowledge, read [learning and reuse](docs/learning.md). Follow [the implementation plan](docs/implementation-plan.md) for delivery gates. These describe proposed behavior; advertise it in operational guides and skills only after the corresponding tests pass. [VISION.md](VISION.md) indexes the design.

CLI and MCP call the same Effect v4 service. Keep the Jev action loop upstream; `worker/bridge.py` owns only session handoff, assertions, and the process protocol. Pin upgrades as one reviewed change with both lock files updated.

Browser selection must fail closed. Never add automatic personal-profile discovery, implicit cloud fallback, or retries of uncertain production mutations. Keep stdout valid JSON or MCP; redact credentials and avoid raw model error dumps.

A test pass requires fresh explicit evidence. A model's completion claim is not evidence. Preserve blocked/failed tabs and failed attempts for diagnosis.

Keep the three skills short. Put setup details in `docs/setup.md`, fallback details in `docs/fallback.md`, and command options in `--help`. Change shared behavior in one place.
