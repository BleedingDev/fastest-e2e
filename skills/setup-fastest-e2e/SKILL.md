---
name: setup-fastest-e2e
description: Install or repair fastest-e2e, its dedicated Chrome profile, optional vision provider, and coding-agent skill or MCP registration.
---

# Setup fastest-e2e

Read `../../docs/setup.md`.

1. Inspect the installed CLI, `doctor` JSON, configured home/profile, and the client's skill settings. Preserve working configuration; fix only missing/broken parts.
2. Install locked dependencies and build/link the CLI. Use `init` for a new dedicated profile and `install` for the pinned Python worker. Confirm before adopting existing browser data; never copy the personal profile implicitly.
3. Have the user supply keys through local environment/credential management, not chat. Explain provider data sharing. Start headed Chrome for selected account logins; stop it before switching the same profile to headless.
4. Configure vision only when authorized, with explicit provider/model settings and `visionEnabled`. Check per-engine readiness: installed/configured/key-present is not live-provider-tested. Deterministic tasks need no model keys.
5. Register the three skills using the client's supported directory/search path. Verify discovery and relative references. Configure MCP when requested, with the same home and environment. Normal vision does not require `--allow-scripts`.

Finish with verified browser/profile binding, installed worker, requested engine readiness, and working skill discovery. Report untested provider/client behavior and any missing step. Do not call setup complete based on `doctor`'s exit code alone.
