# Browser tasks and tests

`run --file task.json` accepts a goal, optional explicit UI `steps`, and optional `extract`. `test --file scenario.json` additionally requires a name and nonempty final `checks`. Both accept `--file -` for stdin. Unknown fields are rejected. [Schemas](../src/task.ts) define the exact contract.

Without steps, Jev executes the goal. With steps, the goal describes intent while the listed steps execute; it is not another implicit action. Steps are `navigate`, `click`, `fill`, `press`, `select`, `check`, `scroll`, `goal`, and `checkpoint`. Consecutive deterministic steps share one adapter invocation. A checkpoint requires checks; a goal step can specify `engine: "vision"` or `"auto"`.

Replace example URLs/selectors before running [account](../examples/account.test.json), [settings](../examples/settings.test.json), [scoped](../examples/scoped.test.json), or [reconstruction](../examples/recover-form.test.json) scenarios. These are templates, not a claim of matching your application.

## Scope and evidence

| Check | Semantics |
| --- | --- |
| `text` | Case-sensitive inclusion in rendered text; optional selector defaults to body. |
| `url` | Exact URL, including query/fragment; inside the selected frame when scoped. |
| `value` | Exact visible control value; sensitive controls rejected. |
| `checked` | Native checked state as the string `"true"` or `"false"`. |
| `count` | DOM matches, including hidden elements, as an integer string. |
| `visible` | Visibility as the string `"true"` or `"false"`; ambiguous matches do not pass. |
| `visual` | Explicit viewport expectation evaluated by the configured vision model, with the image actually sent retained as evidence. |

All check values are strings. `value`, `checked`, and scoped `text` require one visible element. A custom ARIA state is not a native checked property.

Add `frames: ["#outer", "#inner"]` to enter nested frames, including cross-origin documents. Add `shadow: "open"` to explicitly pierce open roots. Default selectors preserve top-level/light-DOM behavior. A missing/ambiguous frame or closed-root DOM scope is unsupported, not proof of absence. Visual expectations currently describe the full viewport, not selector/frame crops.

Final checks poll for `checkTimeoutMs` (default 5 seconds). Per-step checks establish checkpoints before further actions. Failed checks stop execution; fallback cannot repair the UI to turn them green. Set `keepTab: true` for further inspection or UI cleanup.

## Useful extraction

[read.task.json](../examples/read.task.json) returns named values with evidence in one public call. Extraction kinds are `text`, `value`, `attribute`, `url`, `title`, and `visual`. Visual extraction uses `prompt`; an optional JSON `schema` validates shape, not factual truth. Unsupported or unreadable fields produce partial errors, never invented values. Use focused selectors to stay within output limits.

`valueFromInput` reads a named non-secret task input. `valueFromEnv` reads a local value without putting it into the task record. Plain `value`, `inputs`, and goals are persisted: do not put credentials there. Visual/page evidence can still reveal sensitive UI data; minimize and review it before sharing.

## Test meaning

```text
Requirement: Save persists the display name.
Actions: edit → save → reload → reopen settings if needed
Evidence: fresh control value after reload
Cleanup: restore the original value through authorized UI actions
```

Immediate field contents or a toast alone do not establish persistence. Collect evidence before cleanup removes it. Cleanup is explicit, not automatic rollback.

Use `preconditions` for visible account/tenant/build evidence before task actions. `changeRef` remains metadata, not deployment proof. A PR not deployed is untested; unknown deployment identity stays unknown.

`verify --run ID` preserves the original verdict. A recovered pass retains failed attempts and is not uninterrupted success. When crash/draft persistence is the requirement, refilling the form would bypass it; test reconstruction separately. Report passed/failed/blocked/untested coverage, evidence method, deployment uncertainty, and leftover data.
