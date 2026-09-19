import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MCP keeps the approval boundary and response limits explicit", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /legacy:\s*["']stateless["']/);
  assert.match(source, /corsOptions:\s*false/);
  assert.match(source, /text\.length > 1_000_000/);
  assert.match(source, /raw\.length <= 24_000/);
  assert.doesNotMatch(source, /approvals\/[^"`]*\/(approve|deny)/);
});
