---
name: setup-fastest-e2e
description: Install or repair fastest-e2e, its dedicated Chrome session, and skill or MCP registration in a coding agent.
---

# Setup fastest-e2e

Read `../../docs/setup.md` for installation and client configuration.

1. Inspect the existing CLI, `fastest-e2e doctor` JSON, configured home/profile, and the target agent's skill settings. Preserve working configuration. Repair only missing or broken parts.
2. Follow the documented install. Use `fastest-e2e init` for a new dedicated profile and `fastest-e2e install` for the locked worker. Confirm before adopting existing browser data; keep the personal profile separate.
3. Have the user provide model keys through the invoking shell or credential manager, not chat. Explain that page context goes to the model providers. Start headed Chrome for login to the intended accounts. Stop it before starting the same profile headless.
4. Register all three skills using the client's supported search path or checkout symlinks. Verify that it discovers them and can read their relative references. Configure MCP only when requested, with the same `FASTEST_E2E_HOME` and credentials as the CLI.
5. Finish when `doctor` reports `configured`, `workerInstalled`, `connected`, `jevKeyPresent`, and `textKeyPresent` as true and skill discovery works. Its exit code alone is insufficient; presence does not prove a key is valid. Report any missing step rather than calling setup complete.
