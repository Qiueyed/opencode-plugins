#!/usr/bin/env node
// Idempotent patch: default image-input capability for config-defined models.
//
// Problem: models defined manually in opencode.jsonc (custom providers, no
// models.dev catalog entry) get the FALLBACK capability object
// `input: { text: true, audio: false, image: false, video: false, pdf: false }`.
// The part gate in the server chunk replaces image parts with
//   `ERROR: Cannot read "<file>" (this model does not support image input)`
// BEFORE the request ever reaches the provider. Custom vision-capable
// endpoints (e.g. GLM coding-plan models) demonstrably accept images, so the
// gate is a false negative for any provider opencode has no catalog data for.
//
// Fix: in the fallback literal ONLY (exactly one occurrence in the bundle),
// image: false -> image: true. Catalog-backed models keep their real
// capabilities; audio/video/pdf remain gated; if a model truly lacks vision
// the provider API returns its own clear error instead of a pre-flight block.
//
// Shares the pristine backup (app.asar.original.bak) with the other patch
// scripts; --revert restores it (and removes ALL patches - re-run the others
// after).
//
// Usage: node patch-opencode-image-capability.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const REVERT = process.argv.includes("--revert");

const STOCK = "input: { text: true, audio: false, image: false, video: false, pdf: false }";
const PATCHED = "input: { text: true, audio: false, image: true, video: false, pdf: false }";

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
  return sh("python3", ["-c", "import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], { input: header });
}

function stampIntegrity() {
  const hash = asarHeaderHash(ASAR);
  const stamped = sh("python3", [
    "-c",
    `
import plistlib, sys
plist_path, new_hash = sys.argv[1], sys.argv[2]
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)
plist["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = new_hash
with open(plist_path, "wb") as f:
    plistlib.dump(plist, f, fmt=plistlib.FMT_BINARY)
print("ok")
`,
    INFO_PLIST,
    hash,
  ]);
  if (stamped !== "ok") throw new Error("plist stamping failed");
  return hash;
}

function resign() {
  sh("codesign", ["--force", "--deep", "--sign", "-", APP]);
  sh("codesign", ["--verify", "--deep", APP]);
  console.log("codesign: ad-hoc re-signed + verified OK");
}

function main() {
  if (!fs.existsSync(ASAR)) throw new Error(`not found: ${ASAR}`);

  if (REVERT) {
    if (!fs.existsSync(BACKUP)) throw new Error(`no backup to revert to: ${BACKUP}`);
    fs.copyFileSync(BACKUP, ASAR);
    stampIntegrity();
    resign();
    console.log("reverted app.asar to pristine backup (ALL patches removed; re-run the ones you want)");
    return;
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-imgcap-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    sh("npx", ["--yes", "@electron/asar", "extract", ASAR, workdir]);
    // Find the chunk by ANCHOR, not by version-pinned path: exactly one file
    // under out/ may contain the stock or patched fallback literal.
    const seen = [];
    let file = null;
    const stack = [path.join(workdir, "out")];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".js")) {
          const txt = fs.readFileSync(full, "utf8");
          if (txt.includes(STOCK) || txt.includes(PATCHED)) {
            seen.push(full);
            file = full;
          }
        }
      }
    }
    if (seen.length !== 1) {
      throw new Error(`expected exactly 1 chunk with the capability fallback, found ${seen.length}: ${seen.map((f) => path.relative(workdir, f)).join(", ")}`);
    }
    let js = fs.readFileSync(file, "utf8");
    const stockCount = js.split(STOCK).length - 1;
    const patchedCount = js.split(PATCHED).length - 1;
    if (patchedCount === 1 && stockCount === 0) {
      console.log("already patched; nothing to do");
      return;
    }
    // FAIL LOUD: the fallback literal must appear exactly once.
    if (stockCount !== 1) {
      throw new Error(`expected exactly 1 stock capability fallback, found ${stockCount} in ${file}; re-derive the anchor from a fresh bundle extract`);
    }
    js = js.replace(STOCK, PATCHED);
    if (js.split(PATCHED).length - 1 !== 1) throw new Error("post-replace count mismatch");
    // FULL-FILE SYNTAX CHECK before writing - a broken chunk bricks the app.
    const syntaxProbe = path.join(workdir, "syntax-check.mjs");
    fs.writeFileSync(syntaxProbe, js);
    try {
      sh("node", ["--check", syntaxProbe]);
    } finally {
      fs.rmSync(syntaxProbe, { force: true });
    }
    fs.writeFileSync(file, js);
    const packed = path.join(workdir, "app.asar.new");
    sh("npx", ["--yes", "@electron/asar", "pack", workdir, packed]);
    // Atomic replace so a running OpenCode instance keeps its old inode.
    fs.copyFileSync(packed, ASAR + ".incoming");
    fs.renameSync(ASAR + ".incoming", ASAR);
    const hash = stampIntegrity();
    console.log("asar repacked; integrity hash:", hash.slice(0, 16) + "...");
    resign();
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen - config-defined models now accept image parts.");
    console.log("NOTE: app auto-updates replace the bundle -> re-run this patch after updates.");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
