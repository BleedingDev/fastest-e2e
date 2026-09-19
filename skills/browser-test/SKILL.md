---
name: browser-test
description: Test a PR, feature, bug fix, or regression in a deployed application through fastest-e2e.
---

# Browser test

1. Read the change and its expected behavior. Identify the target deployment and account. Establish whether that deployment contains the change; report uncertainty rather than claiming to have tested an undeployed PR.
2. Define observable assertions before executing. Cover the relevant successful flow, failure cases, and nearby regressions. Use the UI for setup and cleanup. Keep production changes within the user's authorization.
3. Read `../browser-use/SKILL.md`. Write a scenario using `../../examples/settings.test.json` as the format reference, then run `fastest-e2e test --file <scenario.json>`.
4. Investigate failures on the retained target. A different browser tool may resolve an automation limitation; bypassing a broken UI does not make the test pass. Preserve failed attempts when retrying.
5. Report the deployment tested, each check's result and evidence, blockers, untested behavior, and any production data left behind. Separate application defects from automation failures.
