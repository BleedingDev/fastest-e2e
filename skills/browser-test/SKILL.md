---
name: browser-test
description: Test a PR, feature, bug fix, or regression in a deployed application with fastest-e2e and report evidence.
---

# Browser test

1. Read the diff or requirements. Identify the deployment and account. Find evidence that the deployment contains the change; otherwise label that uncertainty or report an undeployed PR as untested.
2. Before acting, map each selected requirement to a UI action and observable expectation. Include the relevant success, failure, and nearby regression cases. Keep setup and cleanup in the UI and within authorized production changes.
3. Read `../browser-use/SKILL.md`. Write a separate scenario for each case using `../../examples/account.test.json` or `../../examples/settings.test.json`. For assertion semantics and checkpoints, read `../../docs/testing.md`. Run `fastest-e2e test --file <scenario.json>`, or MCP `browser_test` with the scenario fields.
4. Check each returned expected/actual pair. `done` is not a pass; `passed` covers only the supplied assertions. Investigate failed or blocked cases on the retained target. A fallback can fix an automation limitation, not bypass the UI being tested. Preserve the original result and any failed attempts after recovery.
5. Report the deployment and change reference, each scenario's verdict with evidence, blockers, untested requirements, and production data left behind. Distinguish an observed product defect from an automation failure.
