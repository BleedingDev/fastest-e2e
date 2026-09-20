import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Schema } from "effect";
import { Task, TestTask, validateTask } from "../dist/task.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = name => readFile(path.join(root, name), "utf8");
const skills = ["browser-use", "browser-test", "setup-fastest-e2e"];

test("all example scenarios satisfy the runtime contract", async () => {
  const examples = (await readdir(path.join(root, "examples"))).filter(name => name.endsWith(".json"));
  assert.ok(examples.length > 0);
  for (const example of examples) {
    const input = Schema.decodeUnknownSync(example.endsWith(".test.json") ? TestTask : Task)(JSON.parse(await read(`examples/${example}`)), { onExcessProperty: "error" });
    validateTask(input, example.endsWith(".test.json"));
  }
});

test("the README test example matches the runnable example file", async () => {
  const readme = await read("README.md");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0][1]), JSON.parse(await read("examples/account.test.json")));
});

test("skill names, descriptions, and local reference pointers are valid", async () => {
  for (const skill of skills) {
    const file = `skills/${skill}/SKILL.md`;
    const source = await read(file);
    assert.ok(source.startsWith(`---\nname: ${skill}\ndescription: `), file);
    assert.match(source, /\ndescription: .+\n---\n/, file);
    for (const match of source.matchAll(/`((?:\.\.?\/)[^`]+)`/g)) {
      await access(path.resolve(root, path.dirname(file), match[1]));
    }
  }
});

test("local documentation links resolve", async () => {
  const docs = ["README.md", "AGENTS.md", ...(await readdir(path.join(root, "docs"))).filter(name => name.endsWith(".md")).map(name => `docs/${name}`)];
  for (const file of docs) {
    const source = await read(file);
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      await access(path.resolve(root, path.dirname(file), target.split("#")[0]));
    }
  }
});
