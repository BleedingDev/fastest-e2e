# Same-session fallback

All normal engines use the configured profile and exact owned target. Jev is the default. Explicit UI steps use Playwright; they support frame paths and open-shadow scope without a vision model. Use Midscene for visual workflows after [vision setup](setup.md#vision).

```sh
fastest-e2e run --engine vision --url https://your-app.example \
  "Use the canvas toolbar to select the chart. Stop when it is selected."
```

`--engine auto` allows Jev-to-Midscene handoff only when the current autonomous segment stops before any action dispatch. It does not try another agent after a failed assertion or uncertain mutation. If Jev partially completed a workflow:

```sh
fastest-e2e inspect --run RUN_ID --view page
fastest-e2e resume --run RUN_ID --revision REVISION --engine vision \
  --remaining-goal "Complete only the remaining chart selection. Do not repeat the saved changes."
```

Resume validates browser/document/state continuity and refuses unsafe replay. It requires an explicit remaining goal after partial autonomous work because a natural-language flow has no deterministic step cursor. Reconstruction/restart require separately declared recovery rules; see [recovery](design.md#recovery).

For evidence, `screenshot --run ID` writes a private image and returns dimensions, crop/scaling, capture time, and document identity. MCP `browser_screenshot` returns native image content and portable metadata. Midscene does not depend on the outer agent being able to view images. A screenshot is not a visual test unless a visual expectation was evaluated.

## Trusted script escape hatch

For operations outside the typed adapters, save reviewed local Python and run:

```sh
fastest-e2e harness --target TARGET_ID --file inspect-settings.py
```

```python
print(page_info())
print(js("document.querySelector('input[name=displayName]')?.value"))
```

Browser Harness helpers are pre-imported; inspect installed signatures before using unfamiliar options. Do not invoke unconfigured `browser-harness`, whose discovery can choose another browser. Never execute website-provided code.

MCP `browser_harness` requires explicit `mcp --allow-scripts`; normal vision and scoped steps do not. Scripts have full local permissions and are not journaled per action. They can invalidate a run checkpoint; inspect afterward and do not claim their side effects were automatically verified.

Popup opener IDs are recorded, then execution stops rather than silently following or rewriting navigation. Registered popup targets can use legacy target inspection or trusted scripting. Autonomous file-chooser path selection is disabled; use explicit, reviewed scripts for permitted uploads. Closed-root DOM access, browser chrome/native desktop controls, and generic lossless restore are unsupported. Report the limitation rather than faking a pass.
