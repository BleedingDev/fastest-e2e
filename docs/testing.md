# Writing a browser test

Use [account.test.json](../examples/account.test.json) for a read-only example or [settings.test.json](../examples/settings.test.json) for an authorized change. Replace the URLs, selectors, and expected values. Goals guide the model; they are not read-only or domain restrictions enforced by the runtime.

A scenario requires `name`, `url`, `goal`, and a nonempty `checks` array. Each check has `kind`, a **string** `value`, and a `selector` where required. [TestInput and validation](../src/contracts.ts) define the accepted fields and bounds.

| Kind | What is checked | Selector |
| --- | --- | --- |
| `text` | Case-sensitive inclusion in rendered text. | Optional; defaults to the document body. |
| `url` | Exact current URL, including query and fragment. | Not used. |
| `value` | Exact control value. Password values are rejected. | Required. |
| `checked` | Native checkable control state; `"true"` or `"false"`. | Required. |
| `count` | Number of matching DOM elements as a string, such as `"0"`. Includes hidden matches. | Required. |

`value`, `checked`, and scoped `text` require exactly one visible matching element. These are DOM checks, not pixel or layout assertions. `[aria-checked]` alone is not a native `checked` property.

## Choose evidence before acting

```text
Requirement: Saving a display name persists it.
Action: Edit the name, save, reload, then reopen settings if necessary.
Evidence: The control still has the new value after reload.
Cleanup: Restore the original name through the UI after collecting evidence.
```

Checking the field immediately after typing proves neither saving nor persistence. A success toast supports a save check, but does not prove persistence after reload.

Checks run together at the end of the goal and poll for up to `checkTimeoutMs`. They do not run after each intermediate action. They can also collect partial-state evidence when the agent blocks, without turning that result into a pass. Split independent cases into separate scenario files. For intermediate checkpoints in one tab, use a trusted [fallback script](fallback.md) and report its evidence separately. A new `run` or `test` opens a new tab.

Capture evidence before cleanup removes it. Use `keepTab: true` when cleanup or further inspection must happen on that same tab. There are no `setup`, `steps`, `expect`, or `cleanup` executable fields in this scenario format.

## Evaluate the result

`passed` requires Jev to finish and every explicit check to pass. A blocked run remains blocked even if some checks happen to pass. `failed` means a check did not match; inspect the page before attributing it to the application. Invalid selectors and other verification errors can produce `blocked`.

`changeRef` is report metadata, not proof of the deployed revision. Establish deployment identity through available build or deployment evidence. Otherwise report that the change's presence is unverified.

Preserve the original result when retrying or using fallback. Label a manual recovery separately. Never repair application state through JavaScript or an API to make a broken UI appear to pass.

Report each case as passed, failed, blocked, or untested with its expected/actual evidence, the deployment tested, and any data left behind. Screenshots and raw page output may contain account data; review before sharing.
