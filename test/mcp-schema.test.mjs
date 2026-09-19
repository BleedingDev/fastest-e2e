import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { browserToolkit } from "../dist/mcp.js";

for (const tool of Object.values(browserToolkit(true).tools)) {
  test(`${tool.name} exposes object-root MCP schemas`, () => {
    const input = Schema.toJsonSchemaDocument(tool.parametersSchema, {
      onExcessProperty: Tool.getStrictMode(tool) ? "error" : "ignore",
    }).schema;
    const output = Tool.getJsonSchemaFromSchema(tool.successSchema);
    assert.equal(input.type, "object", JSON.stringify({ tool: tool.name, input }));
    assert.equal(output.type, "object", JSON.stringify({ tool: tool.name, output }));
  });
}
