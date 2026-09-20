import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function pinned(reference) {
  if (/^\.\//.test(reference)) return true;
  if (reference.startsWith("docker://")) return /^docker:\/\/[^\s@]+@sha256:[a-f0-9]{64}$/.test(reference);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/.test(reference);
}

// A formatting guard for this repo's block-style workflows, not a YAML parser.
// Reject complex uses declarations instead of silently skipping them.
function references(source, filename) {
  const result = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/^\s*#/.test(line) || !/(?:\buses|["']uses["'])\s*:/.test(line)) continue;
    const match = /^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    assert.ok(match, `${filename}:${index + 1}: use a block-style literal uses reference`);
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

async function yamlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await yamlFiles(name));
    else if (/\.ya?ml$/.test(name)) files.push(name);
  }
  return files;
}

test("external Actions and reusable workflows use full commit SHAs", async () => {
  let count = 0;
  for (const file of await yamlFiles(path.join(root, ".github"))) {
    for (const reference of references(await readFile(file, "utf8"), file)) {
      assert.ok(pinned(reference), `${path.relative(root, file)}: mutable action ${reference}`);
      count++;
    }
  }
  assert.ok(count > 0, "No action references checked");
});

test("the pin guard accepts commit SHAs and rejects tags, branches, and short SHAs", () => {
  const sha = "a".repeat(40);
  assert.ok(pinned(`actions/checkout@${sha}`));
  assert.ok(pinned(`owner/repo/.github/workflows/reuse.yml@${sha}`));
  assert.ok(pinned("./.github/actions/local"));
  assert.ok(pinned(`docker://alpine@sha256:${"a".repeat(64)}`));
  for (const reference of ["actions/checkout@v7", "actions/checkout@v7.0.1", "owner/repo@main", "owner/repo@abcdef1", "docker://alpine:latest", "${{ inputs.action }}"]) {
    assert.equal(pinned(reference), false, reference);
  }
});

test("the pin guard checks quoted references and fails closed on aliases and inline mappings", () => {
  assert.deepEqual(references("  - uses: 'actions/checkout@v7' # example\n", "fixture.yml"), ["actions/checkout@v7"]);
  assert.deepEqual(references('  "uses": "owner/repo@main"\n', "fixture.yml"), ["owner/repo@main"]);
  assert.equal(pinned(references("  - uses: *action", "fixture.yml")[0]), false);
  assert.throws(() => references("- { uses: owner/repo@main }", "fixture.yml"));
  assert.throws(() => references("- uses: >\n    owner/repo@main", "fixture.yml").forEach(ref => assert.ok(pinned(ref))));
});
