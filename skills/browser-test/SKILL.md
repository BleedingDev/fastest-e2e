---
name: browser-test
description: Test a deployed PR, feature, fix, or regression with fastest-e2e and report fresh evidence, failures, and untested coverage.
---

# Browser test

1. Read the diff/requirements. Identify deployment and account; establish whether the build contains the change. Unknown build identity stays unknown; an undeployed PR is untested.
2. Map selected requirements to UI actions and explicit expectations before acting. Cover relevant success, failure, and nearby regressions. Keep setup/cleanup in the UI and within authorization.
3. Read `../browser-use/SKILL.md`. Write cases using `../../docs/testing.md` and its examples. Prefer deterministic steps/scoped checks when controls are known; delegate semantic or visual subgoals only where useful. Run `fastest-e2e test --file <case.json>` or MCP `browser_test`.
4. Check expected/actual evidence and its method. `passed` covers supplied assertions only. Investigate failures on the retained run; fallback must not bypass the UI being tested. `verify` rechecks without overwriting the original verdict.
5. Preserve crashes, retries, and recovered passes. Reconstructing a form cannot validate persistence after a crash. Report each case, deployment evidence, blockers, untested requirements, cleanup outcome, and data left behind. Distinguish product defects from automation limitations.

For repeatable procedures, recipe promotion is explicit and reviewed; current requirements still determine the checks. Never weaken expectations to reuse a recipe.
