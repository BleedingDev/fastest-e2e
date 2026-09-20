# Agent interaction contract

Status: proposed, not current command syntax. [System design](design.md) owns run and recovery semantics. This document owns what an agent supplies, receives, and needs to remember. Delivery is tracked in [the implementation plan](implementation-plan.md).

## Begin with the outcome

For browser use, provide the URL, bounded goal, stopping condition, and optional requested data. For testing, also provide requirement IDs and observable expectations. Setup supplies the profile and permitted model providers once. Task-specific account, deployment, mutation scope, and cleanup expectations remain explicit.

Accept a goal without forcing a test file, and a scenario without forcing an elaborate workflow definition. Resolve defaults locally and return their effective values. Detect input, configuration, unsupported-schema, and missing-capability errors before taking browser actions or spending model calls where possible.

Treat the PR reference as context supplied by the coding agent. It reads repository changes and available deployment evidence through its own tools. The browser runtime does not need a GitHub integration to validate a UI.

## Small vocabulary, progressive detail

These are proposed extensions to existing commands. Exact flags and schemas must be finalized with contract tests before appearing in installed skills.

| Question | CLI operation | MCP equivalent |
| --- | --- | --- |
| Can this installation do the task? | `doctor` | `browser_doctor` |
| Perform a bounded task | `run` | `browser_run` |
| Test these expectations | `test` | `browser_test` |
| What happened, or what is visible now? | `inspect --run ID --view ...` | `browser_inspect` |
| Continue remaining work | `resume --run ID` | `browser_resume` |
| Show this owned page | `screenshot --run ID` | `browser_screenshot` |
| Check saved expectations again, without replay | `verify --run ID` | `browser_verify` |
| Release task tabs | `close --run ID` | `browser_close` |

Retain the existing target-based inspection and close commands for compatibility. A run resolves targets internally. When a run owns several tabs, return labeled target choices and require disambiguation where necessary. Never make the agent repeatedly copy a CDP endpoint or infer a target ID from a URL.

`run` and `test` should accept structured input through files/stdin as well as common CLI arguments. Reserve stdout for final JSON; send opt-in progress to stderr or supported MCP progress notifications. No banner, provider log, or Base64 image dump belongs in text output.

Do not add a general `execute anything` tool to the default MCP tool list. Keep trusted script execution opt-in. Offer narrow operations and whole-task execution before requiring code authoring.

## Every response should orient the next decision

Return a compact summary first. Include the run ID, record revision, execution state, verification state, requested answer, relevant evidence, remaining budget, and legal next actions. Summaries are derived from structured receipts and checks; they do not require an additional summarizer-model call.

This shortened example illustrates an uncertain submission, not an implemented response schema:

```json
{
  "schemaVersion": 2,
  "runId": "r_settings_01",
  "revision": 7,
  "status": "blocked",
  "execution": {
    "state": "blocked",
    "reasonCode": "mutation_uncertain",
    "lastCheckpoint": "display_name_entered"
  },
  "verification": { "status": "not_run", "pending": ["saved_after_reload"] },
  "mutation": { "state": "uncertain", "actionId": "a_save_04" },
  "summary": "Save was dispatched; its outcome is unknown. The task tab is retained.",
  "budget": { "actionsRemaining": 12, "modelCost": { "kind": "unknown" } },
  "evidenceRefs": ["e_before_save"],
  "nextActions": [
    { "operation": "inspect", "arguments": { "runId": "r_settings_01", "view": "page" } }
  ]
}
```

Next actions are typed suggestions computed from state, capabilities, and policy. They are not website-authored instructions or additional authorization. Validate all preconditions again when invoked. Return enough context with an error to use the suggested remedy without searching a stack trace.

## Observation is a budgeted query

Extend `inspect` with summary, page, checks, and history views. Summary reads the durable record and makes no browser or model calls. Page reads live state. Checks and history retrieve recorded evidence, with explicit capture times and a clear distinction from fresh inspection.

Default page output contains the current URL, title, task-relevant visible controls/text, frame boundaries, pending dialog, and supported locator hints. Preserve accessible labels and exact observed values when they matter. Report empty, unavailable, stale, and truncated as different conditions.

Provide a small default output limit, explicit truncation, and stable cursors bound to an observation or event sequence. Prefer a focused frame/region query to repeatedly dumping the whole page. Changes since an earlier observation must identify their base; a new agent can always request a full focused view. Never truncate a failed check or a required extraction field silently.

Expose which observation strategies are available and which are not. A missing element in an unsupported frame is unknown, not an observed absence. An inspection may reveal account identity through normal UI; a profile directory name does not prove the active tenant or role.

### Requested answers, not tab IDs alone

Allow an optional `extract` description and supported structured-output schema on browser tasks. Return requested values with observation references and the method used: direct DOM read or model interpretation. Type validation is not factual verification. Failed or incomplete extraction returns a field-level error or partial result, not invented values.

Prefer direct control/text extraction when a scoped locator is known. Use a visual/model query only when necessary and charge it to the run. A task asking for a display name should normally finish in one public call with that value and evidence, rather than requiring `run`, an unrelated inspection, and a separate interpretation step.

### Images

MCP screenshots return an actual image content block plus structured metadata. CLI returns a local artifact path and the same metadata. Resource references need a supported retrieval route; a path alone is not an image for a remote MCP client. Provide a bounded direct-content route when that client cannot read local files.

Metadata includes observation ID, browser/target identity, timestamp, viewport size in CSS pixels, encoded image size, crop origin, and scale. Coordinate operations are bound to that observation, not unexplained screen coordinates. Prefer fresh locator-based control where possible.

Keep viewport images the default. Full-page captures, video, and verbose traces are explicit requests or configured failure diagnostics. Midscene's own image-reading ability must not depend on the outer coding agent's model supporting vision. A client without image viewing still receives a useful textual summary and an honest visual-verification limitation.

## Result interpretation

Preserve the legacy top-level `done`, `passed`, `failed`, and `blocked` values and exit codes. Introduce versioned structured details additively; reject incompatible requests rather than silently ignoring important fields.

| Situation | Meaning |
| --- | --- |
| Executor reports completion without checks | `done`, unverified |
| Required execution completes and all declared checks pass | `passed`, with evidence type per check |
| A declared check mismatches after completed execution | `failed`; product attribution still requires diagnosis |
| Execution, extraction, required scope, or verification cannot finish | `blocked`, with partial evidence preserved |
| Case never executed or target change not deployed | Untested coverage in the report, not a fabricated runtime pass |

Distinguish goal outcome from cleanup outcome. A successful feature check with failed cleanup reports both and identifies leftover production data. Preserve evidence collected before cleanup; checking the cleaned-up state does not replace it.

Expected blockers have stable codes such as `auth_required`, `unsupported_scope`, `ambiguous_target`, `mutation_uncertain`, `budget_exhausted`, and `session_changed`. Redacted diagnostics carry an evidence reference where useful. Malformed MCP requests use protocol errors; task failures remain interpretable tool results. Transport errors must not cause automatic mutation retries.

## Survive context loss and concurrent agents

A replacement coding agent should need only the run ID and configured home. `inspect` supplies the original task, checkpoint, observed changes, unresolved uncertainty, pending checks, and safe continuation options. It does not replay a conversational transcript.

Resume accepts an expected run revision and refuses stale competing requests. The runtime also revalidates live preconditions. Two agents resuming one run cannot dispatch in parallel. Cancellation leaves a checkpoint or an explicit uncertain boundary, not a success-looking empty response.

Long work may later need start/status/cancel delivery to survive client request timeouts. Keep it out of the initial API unless client tests demonstrate that need. A transport disconnect must never silently create unbounded detached work.

## Setup and skills

`doctor` should return a capability/readiness matrix by engine and operation, including disabled capabilities and remedies. Separate installed, configured, key-present, provider-tested, and browser-connected. Do not call every provider on every task. Live credential validation is explicit and its resource use visible.

Operational skills retain their current commands until this contract ships. Then `browser-use` teaches run/inspect/resume decisions, and `browser-test` teaches requirement-to-evidence mapping and failure interpretation. Setup teaches capability readiness and client registration. Recipes and troubleshooting are disclosed only when relevant; none belong in always-loaded skill descriptions.

Test CLI/MCP behavior against the same fixtures. Test actual skill discovery and image delivery per supported client. Do not claim one universal installation path or confuse generic shell compatibility with validated Codex, Claude Code, OpenCode, Pi, or OMP integration.

## Design references

[Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents) motivates task-shaped operations, meaningful results, bounded output, and evaluation with agents. Our concrete response contracts above are proposals to test, not guarantees derived from that guidance.

The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) defines structured content, images, and errors. Validate the selected Effect transport against those representations. Follow [writing-for-agents](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md) for conditional references and single-source documentation.
