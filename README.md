# fastest-e2e

Browser automation and evidence-based E2E testing for coding agents. Effect v4 provides the CLI and MCP runtime. A pinned Python worker reuses Jev Ultrafast and Browser Harness with a dedicated Chrome profile.

## Start

Follow [setup](docs/setup.md) to install the CLI, provision the worker, and sign into the dedicated browser. No npm package is published yet.

```sh
fastest-e2e run --url https://your-app.example "Open settings and read the current display name"
fastest-e2e test --file examples/settings.test.json
fastest-e2e mcp
```

Replace the example URL, selectors, and expected values with your application's. A test may modify real production data. Authorize its scope and cleanup first.

## Skills

| Skill | Purpose |
| --- | --- |
| [browser-use](skills/browser-use/SKILL.md) | Complete browser tasks and continue blocked runs on the same tab. |
| [browser-test](skills/browser-test/SKILL.md) | Turn PR or feature requirements into checks against the correct deployment. |
| [setup-fastest-e2e](skills/setup-fastest-e2e/SKILL.md) | Install or repair the runtime, profile, and agent skill registration. |

The two operational skills share one runtime. Setup is loaded only for installation or repair. No application API, database access, test fixture service, or agent-specific SDK is required.

## Session behavior

The runtime uses only the configured profile's debugging endpoint. It verifies the browser ID, clears inherited Browser Harness routing, and assigns a separate daemon namespace for each browser generation. It never falls back to personal Chrome.

Each Jev run creates an owned task tab. Browser tasks retain it by default. Successful tests close it unless `keepTab` is true; failed and blocked tests retain it for inspection and [fallback](docs/fallback.md). Concurrent operations on one home are rejected instead of racing the shared session. Use separate homes and profiles for independent parallel sessions.

Chrome and Browser Harness remain warm between tasks. One CLI or MCP call runs the entire Jev loop. The wrapper does not add an outer-model round trip per click or capture screenshots on every step.

## Results and assertions

Commands emit JSON. `done` means Jev reported completion without independent checks. A test can return `passed` only after Jev finishes and every fresh assertion passes. `failed` means an assertion did not match. `blocked` means execution or verification could not finish. Exit codes are 0 for done/passed, 1 for failed, and 2 for blocked/runtime errors.

Supported assertions are case-sensitive text inclusion, exact URL, exact control value, checked state, and selector count. `value`, `checked`, and scoped `text` checks require a single visible matching element. `count` counts DOM matches, including hidden ones. Checks are read-only and poll for a bounded period. `changeRef` records intent; it does not prove that a deployment contains that change.

## Limits

Jev's upstream MVP does not handle all frames, shadow roots, canvas, uploads, popup tabs, nested scrollers, or custom keyboard controls. Use Browser Harness fallback rather than assuming its features are inherited by Jev. Test planning and diagnosis belong to the coding agent; the runtime does not fetch PRs, deploy applications, or generate a test suite automatically.

The worker is pinned to upstream Jev commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, including its internal action limits. `maxSteps` adds a cap; it cannot raise upstream limits. Timeouts and cancellation stop the worker but cannot roll back production actions. Inspect partial state before retrying. Cancellation during upstream browser initialization may leave a tab that has not yet been registered.

This is an initial implementation, not a proven performance comparison or an anti-detection product. Hosted-model reliability and site-specific authentication need testing on the intended applications. Patchright and additional visual-agent frameworks are not included.

## Develop

```sh
npm ci
npm run check
uv sync --project worker --locked --python 3.12
uv run --project worker --no-sync python worker/tests/browser_smoke.py
```

Tests cover contracts, session binding, serialization, process cancellation, CLI exit behavior, MCP discovery, and result verification. The Chrome smoke test uses the real upstream engine with scripted model decisions, not paid model calls.

## References

[rat-stack](https://github.com/joelhooks/rat-stack) inspired shared Effect handlers for CLI and MCP, exact dependency pins, and typed failures. [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) supplies the browser policy and action loop. [Browser Harness](https://github.com/browser-use/browser-harness) supplies the CDP connection and fallback helpers. Skill writing follows [unslop](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md), [writing-for-agents](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md), and Matt Pocock's [setup pattern](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md).

MIT. See [LICENSE](LICENSE).
