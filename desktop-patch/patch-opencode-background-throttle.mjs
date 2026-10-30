#!/usr/bin/env node
// Idempotent patch: keep the app processing when occluded / on another Space.
//
// Problem: macOS App Nap was already disabled via
//   defaults write ai.opencode.desktop NSAppSleepDisabled -bool YES   (value 1)
// but that only covers App Nap. Chromium (Electron's renderer) ALSO throttles
// occluded/hidden windows on its own: JS timers drop to 1 Hz, then to one
// wakeup per minute (Intensive Wake Up Throttling) and rAF stops, so the UI
// stops updating while the app is not frontmost or the window sits on another
// desktop Space. The stock bundle sets no counter-switches (only
// enable-features / proxy-bypass-list / remote-debugging-port).
//
// Fix: inject the standard anti-throttling trio into the main process right
// after the app's own appendSwitch block (anchor survives the patch):
//   --disable-renderer-backgrounding        renderer keeps normal priority
//   --disable-background-timer-throttling   no background timer throttling
//   --disable-backgrounding-occluded-windows occlusion != backgrounded
// The switches are app-wide Chromium flags; they do not change rendering or
// GPU behavior, only scheduler throttling of hidden/occluded pages.
//
// Anchor: `app.commandLine.appendSwitch("remote-debugging-port", "9222");`
// inside out/main/index.js (exactly 1 occurrence expected; located by content,
// never by version-pinned filename). Idempotent via the oc-bgthrottle marker.
//
// Shares the pristine backup (app.asar.original.bak) with the other patch
// scripts; --revert restores it (and removes ALL patches - re-run the others
// after).
//
// Usage: node patch-opencode-background-throttle.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const REVERT = process.argv.includes("--revert");

const ANCHOR = 'app.commandLine.appendSwitch("remote-debugging-port", "9222");';
const MARKER = "/*oc-bgthrottle v1 (added by patches/patch-opencode-background-throttle.mjs)*/";
const MARKER_END = "/*oc-bgthrottle-end*/";
const INJ =
  MARKER +
  'app.commandLine.appendSwitch("disable-renderer-backgrounding");' +
  'app.commandLine.appendSwitch("disable-background-timer-throttling");' +
  'app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");' +
  MARKER_END;

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
  // Stable identity (matches the other patchers): ad-hoc breaks keychain ACLs.
  sh("codesign", ["--force", "--deep", "--sign", process.env.OC_SIGN_IDENTITY || "OpenCode Local Notifier", APP]);
  sh("codesign", ["--verify", "--deep", APP]);
  console.log("codesign: re-signed with stable identity + verified OK");
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

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-bgthrottle-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    sh("npx", ["--yes", "@electron/asar", "extract", ASAR, workdir]);
    // Find the file by ANCHOR, not by version-pinned path: exactly one file
    // under out/ may contain the stock anchor or the injected marker.
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
          if (txt.includes(ANCHOR) || txt.includes("oc-bgthrottle")) {
            seen.push(full);
            file = full;
          }
        }
      }
    }
    if (seen.length !== 1) {
      throw new Error(`expected exactly 1 bundle file with the switch anchor or marker, found ${seen.length}: ${seen.map((f) => path.relative(workdir, f)).join(", ")}`);
    }
    let js = fs.readFileSync(file, "utf8");
    const markerCount = js.split(MARKER).length - 1;
    const anchorCount = js.split(ANCHOR).length - 1;
    // Idempotency branch BEFORE anchor-count checks (class-3 rule).
    if (markerCount >= 1) {
      if (markerCount === 1 && anchorCount === 1 && js.split(MARKER_END).length - 1 === 1) {
        console.log("already patched; nothing to do");
        return;
      }
      throw new Error(`unexpected patched state (marker=${markerCount}, anchor=${anchorCount}) in ${file}; re-derive from a fresh bundle extract`);
    }
    // FAIL LOUD: the anchor must appear exactly once.
    if (anchorCount !== 1) {
      throw new Error(`expected exactly 1 stock anchor, found ${anchorCount} in ${file}; re-derive the anchor from a fresh bundle extract (npx --yes @electron/asar extract)`);
    }
    js = js.replace(ANCHOR, () => ANCHOR + INJ);
    // Post-injection guards, all before any write.
    if (js.split(MARKER).length - 1 !== 1) throw new Error("post-inject start marker count mismatch");
    if (js.split(MARKER_END).length - 1 !== 1) throw new Error("post-inject end marker count mismatch (unclosed comment risk)");
    for (const sw of ["disable-renderer-backgrounding", "disable-background-timer-throttling", "disable-backgrounding-occluded-windows"]) {
      if (js.split(`appendSwitch("${sw}")`).length - 1 !== 1) throw new Error(`post-inject switch count mismatch: ${sw}`);
    }
    if (js.split(ANCHOR).length - 1 !== 1) throw new Error("anchor disturbed by injection");
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
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen - the UI now keeps processing while occluded or on another Space.");
    console.log("NOTE: app updates replace the bundle -> re-run this patch after updates (oc-post-update runs it).");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
