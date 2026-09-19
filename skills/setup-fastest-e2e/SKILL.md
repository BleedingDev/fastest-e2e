---
name: setup-fastest-e2e
description: Install, configure, or repair fastest-e2e, its dedicated Chrome session, and its browser-use and browser-test skills.
---

# Setup fastest-e2e

Read `../../docs/setup.md` before changing installation or session configuration.

Inspect the existing installation, `fastest-e2e doctor`, the selected agent's skill discovery settings, and any existing fastest-e2e configuration. Preserve working settings.

Install the pinned dependencies and CLI. Register the three skills in the agent's configured skill directory. Use symlinks to this checkout so relative references resolve; verify discovery rather than assuming a universal global directory.

Create a dedicated Chrome user-data directory with `fastest-e2e init`. Confirm the profile choice before adopting existing browser data. Run `fastest-e2e install` to provision the worker.

Have the user supply model keys through their shell or credential manager. Never request keys in chat or commit them. Explain that page context goes to the configured model providers.

Start headed Chrome for the user to sign into only the intended accounts. After they finish, stop it and start headless when requested.

Finish when `doctor` reports the intended connected browser, installed worker, and model-key presence, and the agent discovers both operational skills. Report anything still missing.
