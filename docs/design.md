# System design

Status: proposed. Baseline reviewed at `b3b1500`. Read [the vision](../VISION.md) for the objective, [the agent contract](agent-contract.md) for interaction details, and [the implementation plan](implementation-plan.md) for delivery gates.

## Current baseline

The [runtime](../src/runtime.ts) runs a pinned Python worker per request. The [host](../src/host.ts) binds it to the configured Chrome generation and locks one configured home. The [worker](../worker/bridge.py) registers task tabs and checks the top-level document. Runs return a tab ID and status, not a durable execution record or extracted answer. Browser Harness fallback is trusted script execution. There is no autonomous Midscene integration or native MCP screenshot result yet.

Those are useful building blocks. They leave progress, recovery decisions, and evidence interpretation in the outer agent's conversation. The target below moves durable facts into the runtime without moving general product reasoning there.

## Ownership follows the task

```text
Task specification              What outcome, scope, and evidence are required?
  Run                           What has happened and what remains?
    Checkpoint                  What can be continued from this observed state?
      Scoped operations         Observe, act, extract, and check on owned targets.
        Executor adapter        Jev, Playwright recipe, or Midscene.
          Session lease         Exact profile, Chrome generation, and task tabs.
```

Evidence refers back to a run, checkpoint, target, and requirement. Recipes are reusable procedures selected by the run, not owners of the browser or definitions of success.

| Owner | Owns | Does not own |
| --- | --- | --- |
| Coding agent | Requirement interpretation, case selection, deployment evidence, diagnosis | Low-level control between every routine click |
| Effect runtime | Validated task specification, run state, budgets, session lease, routing, result assembly | A replacement browser engine or model reasoning trace |
| Executor adapter | Execution through its upstream library, progress receipts, cancellation | Permission changes, success criteria, another profile |
| Verifier | Fresh checks with explicit scope and evidence type | Actions that repair the application to satisfy a check |
| Recipe store | Reviewed, parameterized knowledge and applicability | Credentials, permissions, authoritative current page state |

Use Effect Schema for shared contracts and Context services for these responsibilities. Keep CLI and MCP as transport adapters to the same handlers. Keep a single package until an independently deployable component earns a split.

## A run outlives an invocation

Create a run ID and persist its validated intent before the first browser action. Keep the current browser-generation ID, owned targets, expected outcomes, requested extraction, attempts, checkpoints, mutation receipts, budget usage, and evidence references under that run.

Use a local append-only event file and atomically replaced summary. Start with files, not a workflow service or database. Record observable decisions and action receipts, not hidden model reasoning. Events need sequence numbers and input/schema versions so summaries can be rebuilt and incompatible records rejected explicitly.

A paused or interrupted run remains inspectable after the CLI exits or the coding agent loses its context. It is resumable only if the original live browser state can be validated. Browser restart preserves the record, not a promise of restoring in-memory tab state.

Journal before an action can be dispatched and record its completion afterward. If a process dies between those writes, mark the action uncertain. Observation may resolve uncertainty; replay cannot. Request deduplication prevents duplicate runtime dispatch for an identical request ID. It cannot promise exactly-once side effects on a website.

A request ID is scoped to the configured home and canonical input digest. Reusing it with different input is a conflict. A duplicate completed request returns its recorded result; a duplicate active request returns the run handle, not another execution.

## Checkpoints and exclusive control

A checkpoint identifies the reached UI state, completed subgoal, unchanged remaining goal, evidence, target lineage, and budget consumed. Prefer semantic boundaries such as an opened dialog or a confirmed save. Do not require the outer agent to author a click-by-click plan.

Hold one exclusive lease per canonical profile and Chrome generation during an execution segment, including an engine handoff. The existing home lock alone does not protect the same profile configured under two homes. Detect and reject that collision. Releasing an invocation's lease does not transfer ownership of its tabs.

Between invocations, a person may change a tab. Resume validates browser identity, target ownership, checkpoint preconditions, and new observations. A stored revision is a journal version, not proof that the live DOM is unchanged. Re-resolve locators and reject stale image coordinates after navigation, scrolling, layout changes, or an invalid screenshot reference.

Jev relinquishes control before another adapter acts. A popup may join the run only through verified opener lineage and allowed navigation context. Never choose a page by array order or URL alone. Detaching an adapter must leave Chrome and unrelated tabs open.

## Choose the cheapest capable executor

Selection uses validated task requirements, current capabilities, live state, and approved recipe applicability. The policy is conditional, not a mandatory sequence of paid trials.

```text
if a reviewed UI recipe matches and its preconditions hold:
  run the recipe and verify fresh evidence
else if a known interaction is directly supported by scoped Playwright operations:
  use those operations without a visual model
else if the requested goal is supported by Jev:
  run Jev
else if vision is configured, allowed, and suitable:
  run Midscene on the same owned target
else:
  return the precise missing capability and safe next actions
```

Ordinary iframe or open-shadow-root targeting does not itself require vision. Use Midscene for rendered controls whose useful identity is visual, or when a bounded semantic workflow needs its visual planner. Never infer capability support solely from the presence of an iframe or canvas somewhere on the page.

`auto`, `jev`, and `vision` remain the proposed public policies. `auto` may skip a predictably unsuitable engine and may use a validated recipe. An explicit engine selection does not silently switch engines. Record the selected executor and reason. Load Playwright/Midscene only for operations that need them.

The adapter must expose enough supported hooks to meter steps and report dispatch uncertainty. If that cannot be demonstrated for a pinned upstream version, limit it to bounded calls and disable automatic continuation across ambiguous boundaries. Do not invent reliable classification by parsing a model's prose.

### Recovery rules

| Observation | Response |
| --- | --- |
| Unsupported interaction, no unresolved mutation, suitable authorized engine available | Continue the remaining subgoal on the same run within the remaining budget |
| Lost response after a potentially mutating action | Mark uncertain; inspect before offering continuation |
| Assertion mismatch after completed execution | Preserve failure; diagnose without another agent trying to make it pass |
| Missing provider, expired login, unsupported scope, or exhausted budget | Return a typed blocker and a concrete remedy |
| User cancellation or lost browser identity | Stop dispatch; never escalate to another engine |

A model's low confidence can justify more observation. It is not calibrated proof that replay or escalation is safe. Automatic recovery needs an observed capability failure and satisfied preconditions.

## Verification is separate from execution

Execution completion, requirement verification, and mutation certainty are separate fields. Finishing a flow is not evidence that it worked. An assertion mismatch is an observation, not automatically proof of a product defect.

Freeze requirement IDs and expected results before the actions they evaluate. Checks refer to checkpoints and explicit frame/locator scopes. Evidence records the expected/actual pair, capture time, URL, target, observation ID, and method. Record deployment identity as verified, user-supplied, or unknown, with its source. An undeployed change is untested; an unknown build does not become verified because a familiar heading appeared.

Keep existing checks backward compatible, including exact value matching, text inclusion, visibility requirements, and DOM-count behavior. Introduce frame-aware and open-shadow-root checks explicitly. Do not silently replace CSS semantics with Playwright's broader shadow-piercing or text normalization. No matching support means blocked or untested, not an absent-element success.

Visual assertions are explicit expectations evaluated from images. Label their evidence as model-evaluated. Schema-valid extraction also proves only shape, not truth. A whole test is verified only to the extent of its supplied checks and inspected requirements. Aggregate reports expose untested and blocked coverage rather than reducing everything to a green badge.

Recovery appends an attempt. Re-verifying a later state does not overwrite the original verdict or prove that the original action worked. A change to the goal, expected result, account, or authorization creates a new specification revision or a linked new run.

## Resource and data boundaries

One run shares action, model-call, active-time, and supported cost budgets across engines and resume calls. Per-invocation wall deadlines still apply. Human review time is separate from active execution time. Resume does not reset consumed budgets. Reserve time for final observation and orderly cancellation before spending the execution allowance.

Interruptible, scoped subprocesses own adapters that cannot cancel individual operations reliably. Cancellation must stop new dispatch and settle the worker before releasing its lease. A timed-out promise alone is not cancellation. No timeout can roll back a submitted production operation.

Cost fields distinguish measured, estimated, and unknown usage. Never treat unknown as zero. Promise a hard monetary cap only where provider request bounds and metering make it enforceable; otherwise reject that requirement or offer explicit call/token limits.

Local configuration owns profile and provider selection. Requests can narrow permissions, not choose a different profile or widen provider egress. A natural-language read-only goal is not a technical read-only guarantee. Browser navigation itself may have side effects. State exactly which controls are enforced and which rely on instructions. Fallback scripts remain trusted local code, not a sandbox.

Keep screenshots, traces, and account data local by default, with bounded retention and explicit export. Mask known secrets before collection where supported, minimize captures, and report redaction coverage honestly. Prefer selectors and short evidence values to full page dumps. Never promise complete screenshot redaction. Page content is untrusted input and cannot change tools, expectations, permissions, or learning policy.

## Upstream integration constraints

[Playwright CDP attachment](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) is lower fidelity than its native protocol. Validate exact-target attachment and state preservation with the selected version. Evaluate `noDefaults` where supported rather than silently applying context overrides. [Playwright locators](https://playwright.dev/docs/locators#locate-in-shadow-dom) support open shadow roots, not closed-root DOM targeting.

[Midscene's Playwright integration](https://midscenejs.com/integrate-with-playwright) accepts existing pages. Disable defaults that rewrite popup navigation or native select rendering for E2E testing. Screenshot-based control of a rendered closed-root widget does not imply DOM assertion support inside it.

These documents are design inputs, not proof that our adapters work. Pin implementation versions and pass [the delivery gates](implementation-plan.md) before advertising a capability.
