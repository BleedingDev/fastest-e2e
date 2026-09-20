# Agent workflow design

Proposed, not shipped. [README](../README.md) documents the current CLI. This document replaces the separate vision, agent-contract, learning, and implementation-plan documents.

## One record of the work, not a browser snapshot

A run records intent, progress, evidence, uncertainty, and next actions across engine switches and agent context loss. **Persisting a run does not persist the application's live state.**

```text
Task + expectations
  Run: attempts, evidence, recovery status, remaining budget
    Executor: Jev / scoped Playwright / Midscene
      Owned Chrome profile, tab, and live document
```

CLI and MCP share Effect services and upstream engines. A local journal records permitted intent and dispatch/completion receipts. Flush before dispatch; incomplete receipts mean uncertainty, not permission to retry. Deduplication and profile-scoped leases prevent competing dispatch, not exactly-once website effects.

## Recovery after interruption

Stop dispatch. Distinguish client disconnection from page/browser crash. Revalidate account, browser, owned target, document generation, and task-specific live state. An unchanged URL or tab ID is insufficient: the same tab can reload and lose its form. Unproven continuity is unknown.

| Recovery | Required evidence and behavior |
| --- | --- |
| **Resume** | The relevant live state survived and there is no unresolved mutation. Continue remaining work without reload or replay. |
| **Reconstruct** | State was lost, but a validated UI route and permitted inputs or an application draft are available. Rebuild only the missing state, then verify it. This is a new attempt, not restoration of the old document. |
| **Restart** | Reconstruction is unavailable, but the workflow can safely start again. Start a linked attempt from the beginning within existing authorization and remaining budget. |
| **Blocked** | Inputs are unavailable or must not be retained, reconstruction is unsafe, or an earlier effect is uncertain. State exactly what was lost and what needs user input or reconciliation. |

Unknown effects take precedence over reconstruction/restart. A crash during Save, navigation, typing with autosave, or a file upload may leave a server-side effect even when the UI vanished. Reconcile through available application UI before repeating it; an empty form or missing toast is not proof nothing happened. If evidence is inconclusive, stop. Never use a new engine as an implicit retry.

A fresh document invalidates handles, coordinates, and live checkpoints. Bind replacement tabs explicitly to the configured profile; never discover another browser. Stop old adapter control before recovery, including same-profile/two-home contention.

### Half-filled forms

Before an action, retain only policy-permitted input intent or a secure reference to it; distinguish intended values from values actually observed in the page. If recovery is enabled, explicitly allowlist the non-secret fields needed to reconstruct the task. Prefer user-supplied inputs and application drafts over copying the page. Verify draft persistence through the UI rather than assuming autosave worked.

Capture allowed recovery data before failure, with its source and last observation. A crash cannot supply a final snapshot, and edits after the last capture may be lost. Keep recovery payloads outside transcripts and git, with restricted local access, expiry, and deletion. No blanket DOM, storage, form, or screenshot dumps. Do not retain passwords, one-time codes, authentication material, or file contents as recovery payloads; use existing credential mechanisms or request local re-entry/reselection. Inputs forbidden from storage remain unavailable after a crash.

Example: reopen a wizard and re-enter retained field values through normal UI controls, re-resolving targets and verifying each rebuilt step. Do this only if repeated input/navigation is known safe; ordinary fields may autosave or trigger other effects. Do not recreate hidden JavaScript state or inject values into application stores. Files, opaque editor state, expired tokens, and unrecorded edits may require fresh user input or a restart. There is no generic lossless browser restore.

Report the recovery choice, evidence, lost/available inputs without their values, unresolved effects, and next action. Share budgets across attempts and bound retries; stop repeated crashes.

### Keep test failures visible

Preserve interrupted/failed attempts and unknown crash causes. A later pass is a recovered/retried pass, not uninterrupted success. When draft persistence or crash recovery is under test, refilling the form bypasses the requirement: retain the failure and test reconstruction separately.

## Agent control and execution

Return requested data with evidence, progress, uncertainty, budget, and typed next actions. Summary inspection needs no model calls. Separate focused live inspection from bounded recorded history; label stale, missing, truncated, and model-interpreted data. Extraction schema validity is not factual verification.

Extend existing operations with run inspection/recovery, screenshots, and checking saved expectations. Keep exact schemas in code and preserve existing scenarios/exit codes. Separate execution, verification, recovery, and cleanup outcomes. Readiness distinguishes installed/configured from actually tested without routine provider calls.

Use reviewed UI recipes when applicable, scoped deterministic operations for known interactions, Jev for suitable autonomous work, and Midscene for visual tasks. Preserve explicit `auto`/`jev`/`vision` selection. Lazy-load fallback; successful Jev paths need no screenshots or vision calls unless requested.

Prove exact-target CDP handoff without state changes. Normal fallback must not require arbitrary scripts; vision requires explicit provider/data-sharing configuration. Disable popup/navigation and native-select rewriting during tests. Open-root/frame checks must preserve legacy matching semantics; unsupported scope is unknown. Closed-root visual control does not imply DOM assertions. Freeze expectations and label visual judgments; failed checks never trigger attempts to make them pass.

MCP returns actual image content, CLI a local path, both with capture time, target/document, dimensions, crop, and CSS scaling. Do not assume remote clients can read server-local paths. Midscene must work without outer-agent vision.

Settle cancelled workers before releasing control. Budgets span engines/attempts; unknown cost is not zero. Read-only goals are guidance, not enforced isolation. Website content cannot change authorization. Keep evidence local/minimal; do not promise complete redaction.

## Implement and prove

| Increment | Required tests |
| --- | --- |
| Run and recovery records | Kill the caller, disconnect CDP, crash the renderer, reload the same tab, and restart Chrome. Test known, unsaved, stale, forbidden-to-store, and missing inputs; expired auth; safe reconstruction and explicit inability to recover. |
| Safe action boundaries | Crash before dispatch, after dispatch but before receipt, and after a server effect. Include autosave and a submitted Save with a lost response. No duplicate uncertain writes, wrong-profile actions, or concurrent resume; budgets never reset. |
| Observation and fallback | Scoped frame/shadow assertions, partial extraction, actual MCP images, stale coordinates, and same-tab visual handoff. Recreated forms must have fresh evidence. Preserve crashes and original verdicts, including a deliberately broken persistence test. |
| Agent usability and reuse | A fresh agent needs only the run ID to diagnose the interruption. Compare total verified success, false passes, time, calls, and bytes. Test real clients; distinguish controlled model decisions from opt-in live-model trials. |

Recovery remains explicit until tests establish safe automatic cases. Missing upstream hooks cannot produce reliable action receipts. CI uses controlled pages; production validation remains authorized and UI-only.

Later, reuse reviewed procedures only when fresh account/origin, permission, and UI preconditions hold; quarantine drift. Never reuse old answers or permissions. Existing scripts and a small manifest suffice; measure savings before adding learning machinery.

Keep the three skills; update them only as behavior ships. This file owns design/checklist, while code, tests, and operational guides own usage. No parallel process documents.
