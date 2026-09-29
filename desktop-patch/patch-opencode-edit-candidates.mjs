#!/usr/bin/env node
// Idempotent patch for the OpenCode desktop app edit tool (server bundle).
//
// Problem: the built-in edit tool's oldString matching throws two generic
// errors that give a debugging model nothing to iterate on:
//
//   "Could not find oldString in the file. ..."            (zero candidates)
//   "Found multiple matches for oldString. Provide ..."    (zero locations)
//
// Duplicate strings are common when AI models debug their own code, so the
// model needs candidate LOCATIONS to self-correct in one retry.
//
// What it does:
//   - extracts Resources/app.asar to a temp dir
//   - finds the chunk containing the edit tool's replace() implementation
//   - replaces the two throw sites with calls to injected helpers:
//       * editAmbiguityReport(): counts raw + whitespace-variant matches,
//         reports "line N: <first line of match>" for up to 5 candidates
//       * editNotFoundReport(): fuzzy-similar single lines (1-line oldString)
//         or sliding line-windows (multi-line oldString), top 3 hints
//     All helper bodies are try/catch-wrapped and fall back to the original
//     stock messages if anything unexpected happens at runtime.
//   - repacks the asar (atomic rename), re-stamps ElectronAsarIntegrity in
//     Info.plist, ad-hoc re-signs the bundle
//
// Shares the pristine backup (app.asar.original.bak) with
// patch-opencode-desktop-ui.mjs; --revert restores it. After a revert, re-run
// whichever patches you want. Re-run after every app auto-update.
//
// Usage: node patch-opencode-edit-candidates.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;

// Exact anchor strings from the stock bundle (must each appear exactly once
// in the target chunk). Version-specific by design: a changed anchor fails
// loud instead of patching blindly.
const ANCHOR_NOT_FOUND =
  'throw new Error("Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.");';
const ANCHOR_MULTI =
  'throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");';
const INJECT_BEFORE = "function isDisproportionateMatch(search, oldString) {";

const REVERT = process.argv.includes("--revert");

function sh(cmd, args, opts = {}) {
  const { input, ...rest } = opts;
  const out = execFileSync(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...rest,
    ...(input !== undefined ? { input } : {}),
  });
  return out === null ? "" : out.toString().trim();
}

function asarHeaderHash(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const lenBuf = Buffer.alloc(4);
  fs.readSync(fd, lenBuf, 0, 4, 12);
  const jsonLen = lenBuf.readUInt32LE(0);
  const header = Buffer.alloc(jsonLen);
  fs.readSync(fd, header, 0, jsonLen, 16);
  fs.closeSync(fd);
  return sh("python3", [
    "-c",
    "import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())",
  ], { input: header });
}

function stampIntegrity() {
  const hash = asarHeaderHash(ASAR);
  sh("python3", [
    "-c",
    `
import plistlib, sys
plist_path, new_hash = sys.argv[1], sys.argv[2]
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)
plist["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = new_hash
with open(plist_path, "wb") as f:
    plistlib.dump(plist, f, fmt=plistlib.FMT_BINARY)
print("plist hash stamped:", new_hash)
`,
    INFO_PLIST,
    hash,
  ]);
  const current = sh("python3", [
    "-c",
    `
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    p = plistlib.load(f)
print(p["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"])
`,
    INFO_PLIST,
  ]);
  if (current !== hash) throw new Error("plist hash mismatch after stamping");
  return hash;
}

function resign() {
  sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
  sh("codesign", ["--verify", "--deep", APP]);
  console.log("codesign: ad-hoc re-signed + verified OK");
}

// ---------------------------------------------------------------------------
// Injected helper code. Kept ES5-ish and dependency-free; every external
// behavior is wrapped so a bug degrades to the stock message, never a crash.
// ---------------------------------------------------------------------------
const HELPERS = `
/* ec-helpers-v2 */
function editLineAt(content, idx) {
  let lineNo = 1;
  for (let j = 0; j < idx && j < content.length; j++) {
    if (content.charCodeAt(j) === 10) lineNo++;
  }
  return lineNo;
}

function editCandidateLines(content, idxs, label) {
  const lines = content.split("\\n");
  const out = [];
  const shown = idxs.slice(0, 5);
  for (const ix of shown) {
    let lineNo = 1;
    for (let j = 0; j < ix && j < content.length; j++) {
      if (content.charCodeAt(j) === 10) lineNo++;
    }
    const nl = content.indexOf("\\n", ix);
    let text = content.slice(ix, nl === -1 ? ix + 80 : nl).trim();
    if (text.length > 60) text = text.slice(0, 57) + "...";
    out.push("  " + label + " line " + lineNo + ": " + text);
  }
  if (idxs.length > 5) out.push("  (+" + (idxs.length - 5) + " more)");
  return out.join("\\n");
}

// Group scored candidates by identical score so equal ranks share one
// percentage: "L2, L4, L6 (100%); L9 (85%: preview)". A 100% group is
// identical after trimming, so it never needs per-line previews; a preview
// is shown only for a single-member group below 100%.
function editGrouped(scored) {
  try {
    const groups = [];
    for (let k = 0; k < scored.length; k++) {
      const g = groups[groups.length - 1];
      if (g && g.items[0].s === scored[k].s) g.items.push(scored[k]);
      else groups.push({ items: [scored[k]] });
    }
    const parts = [];
    for (const g of groups) {
      const s = g.items[0].s;
      const pct = Math.round(s * 100) + "%";
      const nums = g.items.map(function (x) { return "L" + x.i; }).join(", ");
      if (s >= 0.999) {
        parts.push(nums + " (" + pct + ")");
        continue;
      }
      if (g.items.length === 1 && g.items[0].text) {
        let t = g.items[0].text;
        if (t.length > 60) t = t.slice(0, 57) + "...";
        parts.push(nums + " (" + pct + ": " + t + ")");
      } else {
        parts.push(nums + " (" + pct + ")");
      }
    }
    return parts.join("; ");
  } catch (e) {
    return "";
  }
}

function editAmbiguityReport(content, oldString) {
  try {
    const idxs = [];
    let i = content.indexOf(oldString);
    while (i !== -1 && idxs.length < 2000) {
      idxs.push(i);
      i = content.indexOf(oldString, i + 1);
    }
    const hitCap = idxs.length >= 2000;
    // Too many to list: one compact count + line range instead.
    if (idxs.length > 12) {
      const n = idxs.length + (hitCap ? "+" : "");
      const span = editLineAt(content, idxs[0]) + "-" + editLineAt(content, idxs[idxs.length - 1]);
      return (
        "Found " + n + " matches for oldString (lines " + span + "). " +
        "Pass replaceAll: true to replace every occurrence, or add surrounding lines to target one."
      );
    }
    if (idxs.length > 1) {
      return (
        "Found " + idxs.length + " matches for oldString. Candidates:\\n" +
        editCandidateLines(content, idxs, "match at") +
        "\\nAdd surrounding lines to make oldString unique, or pass replaceAll: true to replace every occurrence."
      );
    }
    const esc = oldString.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/[ \\t]+/g, "[ \\t]+");
    const re = new RegExp(esc, "g");
    const flex = [];
    let m = re.exec(content);
    while (m !== null && flex.length < 2000) {
      flex.push(m.index);
      re.lastIndex = m.index + m[0].length;
      m = re.exec(content);
    }
    if (flex.length > 12) {
      const span = editLineAt(content, flex[0]) + "-" + editLineAt(content, flex[flex.length - 1]);
      return (
        "Found " + flex.length + " whitespace-variant matches for oldString (lines " + span + "). " +
        "Copy the exact text (including its indentation) from one of them."
      );
    }
    if (flex.length > 1) {
      return (
        "Found " + flex.length + " whitespace-variant matches for oldString. Candidates:\\n" +
        editCandidateLines(content, flex, "match at") +
        "\\nCopy the exact text (including its indentation) from the file so the match is unique."
      );
    }
  } catch (e) {}
  return "Found multiple matches for oldString. Provide more surrounding context to make the match unique.";
}

function editSim(a, b) {
  a = a.slice(0, 200);
  b = b.slice(0, 200);
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i2 = 1; i2 <= m; i2++) {
    cur[0] = i2;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i2 - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function editNotFoundReport(content, oldString) {
  let hint = "";
  try {
    const target = oldString.split("\\n");
    const lines = content.split("\\n");
    if (target.length === 1) {
      const needle = oldString.trim().slice(0, 200);
      const scored = [];
      for (let i = 0; i < lines.length; i++) {
        const s = editSim(lines[i].trim().slice(0, 200), needle);
        if (s > 0.5) scored.push({ i: i + 1, s, text: lines[i].trim() });
      }
      scored.sort(function (a, b) { return b.s - a.s; });
      const top = scored.slice(0, 6);
      if (top.length) hint = "\\nClosest lines: " + editGrouped(top);
    } else {
      const w = target.length;
      const t = target.join("\\n").trim().slice(0, 400);
      const scored = [];
      const limit = Math.min(lines.length - w, 5000);
      for (let i = 0; i <= limit; i++) {
        const cand = lines.slice(i, i + w).join("\\n").trim().slice(0, 400);
        const s = editSim(cand, t);
        if (s > 0.55) scored.push({ i: i + 1, s });
        if (scored.length > 2000) { scored.sort(function (a, b) { return b.s - a.s; }); scored.length = 10; }
      }
      scored.sort(function (a, b) { return b.s - a.s; });
      const top = scored.slice(0, 6);
      if (top.length) hint = "\\nClosest regions: " + editGrouped(top);
    }
  } catch (e) {}
  return (
    "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings." +
    hint
  );
}

`;

function extractAsar(dest) {
  fs.mkdirSync(dest, { recursive: true });
  sh("npx", ["--yes", "@electron/asar", "extract", ASAR, dest]);
}

function findTargetFile(workdir) {
  const roots = [path.join(workdir, "out", "main"), workdir];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes(INJECT_BEFORE)) {
          return full;
        }
      }
    }
  }
  throw new Error("no chunk containing the edit-tool anchor found");
}

function patchFile(file, workdir) {
  let code = fs.readFileSync(file, "utf8");
  if (code.includes("editAmbiguityReport")) {
    if (code.includes("ec-helpers-v2")) {
      console.log("already patched (v2):", file);
      return false;
    }
    // v1 -> v2 upgrade: swap the injected helper span in place. The v1
    // layout is deterministic (HELPERS injected right before the injection
    // anchor), so the span from the first helper to the anchor is exact.
    const start = code.indexOf("function editCandidateLines");
    const end = code.indexOf("function isDisproportionateMatch");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("v1 helper span not found for upgrade; refusing to patch blindly");
    }
    code = code.slice(0, start) + HELPERS + code.slice(end);
    fs.writeFileSync(file, code);
    console.log("upgraded edit helpers to v2.1 in:", path.relative(workdir, file));
    return true;
  }
  for (const [name, anchor] of [["not-found", ANCHOR_NOT_FOUND], ["multi-match", ANCHOR_MULTI]]) {
    const count = code.split(anchor).length - 1;
    if (count !== 1) {
      throw new Error(`${name} anchor found ${count} times (expected 1) in ${file}; refusing to patch blindly`);
    }
  }
  const injCount = code.split(INJECT_BEFORE).length - 1;
  if (injCount !== 1) {
    throw new Error(`injection anchor found ${injCount} times (expected 1); refusing to patch`);
  }
  // Function-form replacements: string replacements would interpret $& in
  // the injected code (the regex-escape helper uses "\\$&") as the match.
  code = code.replace(ANCHOR_NOT_FOUND, () => 'throw new Error(editNotFoundReport(content2, oldString));');
  code = code.replace(ANCHOR_MULTI, () => 'throw new Error(editAmbiguityReport(content2, oldString));');
  code = code.replace(INJECT_BEFORE, () => HELPERS + INJECT_BEFORE);
  fs.writeFileSync(file, code);
  console.log("patched edit tool in:", path.relative(workdir, file));
  return true;
}

function main() {
  if (!fs.existsSync(ASAR)) throw new Error(`not found: ${ASAR}`);

  if (REVERT) {
    if (!fs.existsSync(BACKUP)) throw new Error(`no backup to revert to: ${BACKUP}`);
    fs.copyFileSync(BACKUP, ASAR);
    stampIntegrity();
    resign();
    console.log("reverted app.asar to pristine backup, integrity re-stamped, re-signed");
    console.log("NOTE: re-run patch-opencode-desktop-ui.mjs if you also want the UI patch back.");
    return;
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-edit-patch-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    } else {
      console.log("pristine backup already exists, keeping it:", BACKUP);
    }
    extractAsar(workdir);
    const target = findTargetFile(workdir);
    if (!patchFile(target, workdir)) {
      console.log("nothing to do (already patched).");
      return;
    }
    // Syntax sanity check of the patched chunk (it is ESM).
    sh("node", ["--check", "--input-type=module"], { input: fs.readFileSync(target, "utf8") });
    console.log("syntax check OK");

    const packed = path.join(workdir, "app.asar.new");
    sh("npx", ["--yes", "@electron/asar", "pack", workdir, packed]);
    // Atomic replace so a running OpenCode instance keeps its old inode.
    fs.copyFileSync(packed, ASAR + ".incoming");
    fs.renameSync(ASAR + ".incoming", ASAR);
    const hash = stampIntegrity();
    console.log("asar repacked; integrity hash:", hash.slice(0, 16) + "...");
    resign();
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen to load the patched edit tool.");
    console.log("NOTE: app auto-updates replace the bundle -> re-run after updates.");
    console.log("Revert anytime with: node patch-opencode-edit-candidates.mjs --revert");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
