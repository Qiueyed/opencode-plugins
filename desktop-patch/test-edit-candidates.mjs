#!/usr/bin/env node
// Standalone test harness for the helper functions injected by
// patch-opencode-edit-candidates.mjs.
//
//   node test-edit-candidates.mjs            -> test the template-decoded helpers
//   node test-edit-candidates.mjs <file.js>  -> test helpers extracted from an
//                                               already-patched chunk (end-to-end)
import fs from "fs";
import assert from "assert";

const PATCH = new URL("./patch-opencode-edit-candidates.mjs", import.meta.url).pathname;

function decodeHelpersFromTemplate() {
  const src = fs.readFileSync(PATCH, "utf8");
  const start = src.indexOf("const HELPERS = `");
  const end = src.indexOf("`;", start);
  if (start === -1 || end === -1) throw new Error("HELPERS template not found");
  const raw = src.slice(start + "const HELPERS = `".length, end);
  // Re-parse the raw template body exactly as JS would (handles \${, \\n etc).
  return new Function(`return \`${raw}\`;`)();
}

function extractHelpersFromChunk(file) {
  const code = fs.readFileSync(file, "utf8");
  const start = code.indexOf("function editCandidateLines");
  const end = code.indexOf("function isDisproportionateMatch");
  if (start === -1 || end === -1) throw new Error("helpers not found in chunk");
  return code.slice(start, end);
}

const mode = process.argv[2];
const helpersSrc = mode ? extractHelpersFromChunk(mode) : decodeHelpersFromTemplate();
console.log("helpers source:", mode ? `extracted from ${mode}` : "decoded from patch template");

// Evaluate the helpers in this module's scope (function declarations).
const run = new Function(
  helpersSrc +
    `\nreturn { editAmbiguityReport, editNotFoundReport };`,
)();
const { editAmbiguityReport, editNotFoundReport } = run;

const stockMulti = "Found multiple matches for oldString. Provide more surrounding context to make the match unique.";
const stockNotFound = "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.";

// --- 1. raw duplicate matches ----------------------------------------------
{
  const content = ["alpha", "foo()", "beta", "foo()", "gamma", "foo()"].join("\n");
  const msg = editAmbiguityReport(content, "foo()");
  assert.ok(msg.includes("Found 3 matches"), "count reported: " + msg);
  assert.ok(msg.includes("line 2"), "line 2 reported");
  assert.ok(msg.includes("line 4"), "line 4 reported");
  assert.ok(msg.includes("line 6"), "line 6 reported");
  assert.ok(msg.includes("replaceAll"), "replaceAll hint present");
  console.log("1. raw duplicates: OK");
}

// --- 2. whitespace-variant duplicates --------------------------------------
{
  const content = "function a() {\n  return  1;\n}\n...\nfunction b() {\n  return  1;\n}\n";
  const oldString = "return 1;"; // raw appears 0 times; whitespace variants twice
  const msg = editAmbiguityReport(content, oldString);
  assert.ok(/whitespace-variant/.test(msg), "variant path: " + msg);
  assert.ok(msg.includes("line 2") && msg.includes("line 6"), "both variant lines reported");
  console.log("2. whitespace variants: OK");
}

// --- 3. ambiguity helper fallback on internal error ------------------------
{
  const msg = editAmbiguityReport(null, "x"); // content null -> try throws -> stock
  assert.strictEqual(msg, stockMulti);
  console.log("3. ambiguity fallback: OK");
}

// --- 4. not-found: single-line fuzzy hint ----------------------------------
{
  const content = [
    "function calculateTotal(items) {",
    "  let total = 0;",
    "  for (const item of items) {",
    "    total += item.price;",
    "  }",
    "  return total;",
    "}",
  ].join("\n");
  const msg = editNotFoundReport(content, "  total += item.cost;"); // wrong property name
  assert.ok(msg.startsWith(stockNotFound), "stock prefix kept");
  assert.ok(msg.includes("line 4"), "closest line 4 hinted: " + msg);
  assert.ok(/similar/.test(msg), "similarity shown");
  console.log("4. not-found single-line hint: OK");
}

// --- 5. not-found: multi-line window hint ----------------------------------
{
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push("filler line " + i);
  lines.splice(20, 3, "const a = 1;", "const b = 2;", "const c = 3;");
  const content = lines.join("\n");
  const oldString = "const a = 1;\nconst b = 2;\nconst c = 4;"; // last line wrong
  const msg = editNotFoundReport(content, oldString);
  assert.ok(msg.includes("Closest regions"), "regions hinted: " + msg);
  assert.ok(/line 21/.test(msg), "window at line 21 found");
  console.log("5. not-found multi-line window hint: OK");
}

// --- 6. not-found helper fallback on internal error ------------------------
{
  const msg = editNotFoundReport(undefined, "x");
  assert.ok(msg.startsWith(stockNotFound), "stock fallback");
  assert.ok(!msg.includes("undefined"), "no junk in message");
  console.log("6. not-found fallback: OK");
}

// --- 7. perf sanity: large file, worst-case window scan --------------------
{
  const lines = [];
  for (let i = 1; i <= 20000; i++) lines.push("line number " + i + " with some padding text");
  const content = lines.join("\n");
  const t0 = Date.now();
  const msg = editNotFoundReport(content, "line number 19999 with some padding texX");
  const dt = Date.now() - t0;
  assert.ok(msg.includes("Closest lines"), "found closest");
  assert.ok(dt < 2000, "fast enough: " + dt + "ms");
  const t1 = Date.now();
  editAmbiguityReport(content, "line number");
  const dt2 = Date.now() - t1;
  assert.ok(dt2 < 2000, "ambiguity scan fast: " + dt2 + "ms");
  console.log(`7. perf sanity: OK (not-found ${dt}ms, ambiguity ${dt2}ms)`);
}

console.log("\nAll helper tests passed.");
