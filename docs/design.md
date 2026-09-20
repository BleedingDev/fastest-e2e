# Runtime notes

The implementation lives in [shared contracts](../src/task.ts), [orchestration](../src/workflows.ts), [run storage](../src/journal.ts), [Playwright/Midscene adapter](../src/page-worker.ts), and [managed upstream Jev](../worker/jev_runner.py). CLI/MCP use the same Effect runtime. No separate planning framework is required.

```text
Task: goal, scope, checks, allowed inputs
  Run: attempts, receipts, checkpoints, uncertainty, remaining budget
    Executor: upstream Jev / deterministic Playwright / upstream Midscene
      Configured Chrome generation and owned targets
```

## Recovery

A run journal persists work, not browser memory. It flushes intent before dispatch and records completion afterward. A lost receipt remains uncertain. A document/visible-state fingerprint detects reload or changed input; it is not a snapshot of opaque application stores. Resume also checks scoped frame state when that adapter recorded it.

`inspect --run ID` reads the record without browser/model calls. `--view page` reads current state; `--view history --cursor N --limit 20` reads bounded recorded events. A replacement coding agent can use the run ID without replaying conversation history.

| Mode | Requirements |
| --- | --- |
| Resume | Correct live browser/target/document and matching state; no unresolved dispatch. Latest revision required. Partial autonomous work also needs an explicit remaining goal. |
| Reconstruct | Declared repeat-safe UI route, retained allowlisted fields or local environment inputs, and no unresolved side effect. Creates a new owned tab/attempt and verifies rebuilt state. |
| Restart | Explicit `restartSafe`, no unsafe actions in the history, and remaining budget. Creates a linked attempt from the beginning. |
| Blocked | Missing/expired/forbidden inputs, ambiguous effect, unsafe replay, incompatible browser, or exhausted budget. |

[recover-form.test.json](../examples/recover-form.test.json) shows a half-filled form. Only use `safeToRepeat` where the application's behavior justifies it. Typing and navigation may autosave or submit changes. Recovery freezes retained inputs before navigation, so an empty replacement form cannot erase them. Secrets, files, one-time codes, and opaque editor state are not recoverable payloads; re-entry may be necessary.

Declare `recovery.reconcile` and `reconcileOutcome` before a possibly uncertain effect. `reconcile --run ID` evaluates that UI evidence. For a completed deterministic dispatch, matching evidence advances its cursor once instead of resubmitting. For a completed autonomous dispatch without a cursor, continuation stays blocked rather than guessing.

After a browser crash, a new observation task can inspect application state in the same profile; `reconcile --run ORIGINAL --from-run OBSERVER` uses its live page with the original expectations. This does not retarget or restore the original run. Evidence of absence must be strong enough for the application; a missing toast is not proof that Save did nothing.

Recovery preserves original attempts/verdicts. `verify` never replays actions. A failed test is not resumable as an automatic repair. If persistence itself is under test, reconstruction must not substitute for it.

## Bounds and ownership

Per-profile and per-home leases serialize control. Worker PIDs are registered before dispatch. Stale leases are reclaimed only after owners/workers are dead. Workers check parent liveness; cancellation settles them before another caller can acquire the lease. It cannot undo an already sent action.

A request ID deduplicates identical task specifications in the home/profile; changed input conflicts. It does not provide exactly-once website side effects. A paused record can outlive Chrome, but a browser-generation change invalidates live continuation.

Action/model-call/active-time allowances span attempts. CPU/model pricing is not fabricated: monetary cost remains unknown. Summary/readiness calls use no models. Playwright/Midscene load only when needed. Successful Jev-only paths do not make vision calls unless a visual query is explicitly requested.

## Storage and reusable procedures

Private run files contain literal task intent and selected evidence. Default expiry is 24 hours (configurable 1–168); access after expiry is rejected and `prune` deletes expired records/artifacts. No background deletion service runs. Use local environment references for sensitive input, never literal goals/inputs. Allowlisted recovery fields are a separate, explicitly selected payload. Screenshots/page text may expose account data; no complete redaction or OS sandbox is claimed.

Recipe reuse is opt-in. `recipe propose --run ID --name NAME` requires a verified, uninterrupted deterministic run with preconditions. `recipe approve --name NAME --trial OTHER_RUN_ID` requires explicit review and a distinct matching verified trial. Fill values become current task parameters; repeat permissions and old answers are not inherited. Recipes are bound to origin/path, expire after seven days, and are quarantined on failed preconditions, ambiguous targets, or assertion mismatch. Two trials do not establish universal reliability. No auto-export or global skill rewriting occurs.

## Validation boundary

CI exercises real browser attachment, scoped checks, extraction, native MCP images, reload/crash reconstruction, lost-receipt handling, managed Jev, and the real Midscene SDK against controlled model responses. Paid models, production accounts, non-Linux desktop setups, and discovery in each coding harness still require environment-specific validation. Keep that distinction in reports.
