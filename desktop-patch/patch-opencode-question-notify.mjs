#!/usr/bin/env node
// Idempotent patch v3: give question asks the same notification treatment as
// response ends (user spec 2026-10-29/30).
//
// WHY v3 (v1/v2 postmortem):
//   v1 injected into useSDKNotificationToasts - dead code, lives inside
//   LegacyLayout while the window renders NewAppLayout (1.19 split).
//   v2 injected into the always-mounted session.idle listener but (a) AFTER
//   its stock gate, which returns every non-idle/error event before the
//   injection, and (b) keyed on question.asked/question.v2.asked events,
//   which runtime forensics (conditional breakpoints on two live listeners)
//   proved never reach the renderer's global event emitter at all.
//   What DOES flow through that emitter: message.part.updated (the global
//   loop even coalesces it), and the question dialog itself renders from a
//   message part: {type:"tool", tool:"question", state:{status}} with
//   status pending/running while the ask waits (verified in the bundle).
//
// v3 therefore injects BEFORE the stock gate in the always-mounted
// notification module listener and alerts on the question tool's part:
//   - play the agent sound (settings.sounds, same as response end),
//   - native banner via platform2.notify(..., !viewedInCurrentSession(...)):
//     viewing the asking session -> no banner; another tab / another app ->
//     banner. Dedup per part id (part updates fire repeatedly while pending).
//   - subagent asks are skipped (parentID, same parity as response end).
// notify.ts's afplay question tone stays OFF (opencode-notifier.json
// events.question.sound=false) - the app owns the sound.
//
// Anchors (exactly 1 occurrence each, located by content):
//   A1/A2: v1 anchors (kept for pristine bundles; harmless dead code).
//   A3: the notification module listener (const unsub ... event gate).
// Idempotency: "oc-qnotify3" marker only exists post-v3. The patcher
// upgrades a v2-applied bundle by replacing the v2 block.
//
// Shares the pristine backup (app.asar.original.bak) with the other patch
// scripts; --revert restores it (removes ALL patches; re-run the others).
//
// Usage: node patch-opencode-question-notify.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const REVERT = process.argv.includes("--revert");

// ---- v1 anchors (LegacyLayout hook + notify() gate) ----
const ANCHOR_NOTIFY =
  'notify: async (title, description, onClick) => {\n' +
  '      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus());\n' +
  '      if (focused) return;';
const PATCH_NOTIFY =
  'notify: async (title, description, onClick, ocForce) => {\n' +
  '      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus());\n' +
  '      if (focused && !ocForce) return; /*oc-qnotify*/';
const ANCHOR_QBRANCH =
  'if (e2.details.type === "question.asked") {\n' +
  '        if (settings.notifications.agent()) {\n' +
  '          void platform2.notify(title, description, () => navigate(href));\n' +
  '        }\n' +
  '      }';
const PATCH_QBRANCH =
  'if (e2.details.type === "question.asked") { /*oc-qnotify*/\n' +
  '        if (settings.sounds.agentEnabled()) {\n' +
  '          void playSoundById(settings.sounds.agent());\n' +
  '        }\n' +
  '        const ocViewingThis = pathKey(directory) === pathKey(currentDir()) && props2.sessionID === params.id;\n' +
  '        if (settings.notifications.agent()) {\n' +
  '          void platform2.notify(title, description, () => navigate(href), !ocViewingThis);\n' +
  '        }\n' +
  '      }';

// ---- v3 anchor: notification module listener (split into head + gate) ----
const LISTEN_HEAD =
  '  const unsub = serverSDK().event.listen((e2) => {\n' +
  '    const event = e2.details;\n';
const GATE_LINE = '    if (event.type !== "session.idle" && event.type !== "session.error") return;';
const ANCHOR_IDLE = LISTEN_HEAD + GATE_LINE;

// v2 injected block (for upgrade replacement; must match v2 output exactly)
const INJ_V2 = [
  '    /*oc-qnotify2*/',
  '    if (event.type === "question.asked" || event.type === "question.v2.asked") {',
  '      const qDirectory = e2.name;',
  '      const qSessionID = event.properties.sessionID;',
  '      if (settings.sounds.agentEnabled()) {',
  '        void playSoundById(settings.sounds.agent());',
  '      }',
  '      void lookup(qDirectory, qSessionID).then((qSession) => {',
  '        if (meta.disposed) return;',
  '        const qTitle = language.t("notification.question.title");',
  '        const qDescription = language.t("notification.question.description", {',
  '          sessionTitle: qSession?.title ?? language.t("command.session.new"),',
  '          projectName: getFilename(qDirectory)',
  '        });',
  '        const qHref = `/${base64Encode(qDirectory)}/session/${qSessionID}`;',
  '        if (settings.notifications.agent()) {',
  '          void platform2.notify(qTitle, qDescription, () => input2.navigate(qHref), !viewedInCurrentSession(qDirectory, qSessionID));',
  '        }',
  '      });',
  '      return;',
  '    }'
].join("\n");

// v3 block: BEFORE the gate, keyed on the question tool's message part.
// All symbols verified in scope (used by handleSessionIdle/handleSessionError
// in the same closure); projectName computed inline to avoid scope risk.
const INJ_V3 = [
  '    /*oc-qnotify3*/',
  '    if (event.type === "message.part.updated" && event.properties?.part?.type === "tool" && event.properties?.part?.tool === "question") {',
  '      const ocqPart = event.properties.part;',
  '      const ocqStatus = ocqPart.state?.status;',
  '      const ocqKey = "ocq:" + (ocqPart.id ?? ocqPart.callID ?? "");',
  '      if ((ocqStatus === "pending" || ocqStatus === "running") && !ocqSeenParts.has(ocqKey)) {',
  '        ocqSeenParts.add(ocqKey);',
  '        const ocqDirectory = e2.name;',
  '        const ocqSessionID = ocqPart.sessionID ?? event.properties.sessionID;',
  '        if (ocqSessionID) {',
  '          if (settings.sounds.agentEnabled()) {',
  '            void playSoundById(settings.sounds.agent());',
  '          }',
  '          void lookup(ocqDirectory, ocqSessionID).then((ocqSession) => {',
  '            if (meta.disposed) return;',
  '            if (ocqSession?.parentID) return;',
  '            const ocqTitle = language.t("notification.question.title");',
  '            const ocqDescription = language.t("notification.question.description", {',
  '              sessionTitle: ocqSession?.title ?? language.t("command.session.new"),',
  '              projectName: (ocqDirectory || "").split("/").pop() || ocqDirectory',
  '            });',
  '            const ocqHref = `/${base64Encode(ocqDirectory)}/session/${ocqSessionID}`;',
  '            if (settings.notifications.agent()) {',
  '              void platform2.notify(ocqTitle, ocqDescription, () => input2.navigate(ocqHref), !viewedInCurrentSession(ocqDirectory, ocqSessionID));',
  '            }',
  '          });',
  '        }',
  '      }',
  '    }'
].join("\n");

const PATCH_IDLE_V3 =
  '  const ocqSeenParts = /* @__PURE__ */ new Set();\n' +
  LISTEN_HEAD +
  INJ_V3 + "\n" +
  GATE_LINE;

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

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-qnotify-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    sh("npx", ["--yes", "@electron/asar", "extract", ASAR, workdir]);
    const needles = ["oc-qnotify", ANCHOR_NOTIFY, ANCHOR_QBRANCH, ANCHOR_IDLE];
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
          if (needles.some((n) => txt.includes(n))) {
            seen.push(full);
            file = full;
          }
        }
      }
    }
    if (seen.length !== 1) {
      throw new Error(`expected exactly 1 bundle file with the anchors or markers, found ${seen.length}: ${seen.map((f) => path.relative(workdir, f)).join(", ")}`);
    }
    let js = fs.readFileSync(file, "utf8");
    const cnt = (s) => js.split(s).length - 1;
    // Idempotency BEFORE any count expectations (class-3 rule).
    if (cnt("oc-qnotify3") >= 1) {
      if (cnt("oc-qnotify3") === 1 && cnt("ocqSeenParts") === 3 && cnt('event.properties?.part?.tool === "question"') === 1) {
        console.log("already patched (v3); nothing to do");
        return;
      }
      throw new Error(`unexpected v3 patched state (marker=${cnt("oc-qnotify3")}) in ${file}; re-derive from a fresh bundle extract`);
    }
    // v1 stage: apply if pristine, verify if already applied.
    if (cnt("/*oc-qnotify*/") === 0) {
      for (const [name, anchor] of [["notify-def", ANCHOR_NOTIFY], ["question-branch", ANCHOR_QBRANCH]]) {
        const n = cnt(anchor);
        if (n !== 1) throw new Error(`expected exactly 1 stock anchor for ${name}, found ${n} in ${file}; re-derive from a fresh bundle extract`);
      }
      js = js.replace(ANCHOR_NOTIFY, () => PATCH_NOTIFY);
      js = js.replace(ANCHOR_QBRANCH, () => PATCH_QBRANCH);
      console.log("v1 edits applied (notify force param + LegacyLayout question branch)");
    } else if (cnt("/*oc-qnotify*/") === 2) {
      console.log("v1 edits already present");
    } else {
      throw new Error(`unexpected v1 patched state (pure=${cnt("/*oc-qnotify*/")}) in ${file}`);
    }
    // v3 stage: upgrade from v2 block if present, else inject at the anchor.
    const v2Block = ANCHOR_IDLE + "\n" + INJ_V2;
    if (cnt("oc-qnotify2") >= 1) {
      if (cnt(v2Block) !== 1) throw new Error(`v2 block found (marker=${cnt("oc-qnotify2")}) but its full text does not match exactly once; re-derive from a fresh bundle extract`);
      js = js.replace(v2Block, () => PATCH_IDLE_V3);
      console.log("v2 block replaced with v3 (pre-gate, message-part keyed)");
    } else {
      if (cnt(ANCHOR_IDLE) !== 1) throw new Error(`expected exactly 1 stock idle-listener anchor, found ${cnt(ANCHOR_IDLE)} in ${file}; re-derive from a fresh bundle extract`);
      js = js.replace(ANCHOR_IDLE, () => PATCH_IDLE_V3);
      console.log("v3 block injected at the idle listener (pre-gate, message-part keyed)");
    }
    // Post-injection guards, all before any write.
    if (cnt("oc-qnotify3") !== 1) throw new Error("post-inject v3 marker count mismatch");
    if (cnt("oc-qnotify2") !== 0) throw new Error("post-inject v2 marker still present");
    if (cnt(GATE_LINE) !== 1) throw new Error("stock idle gate line disturbed (must remain exactly once)");
    if (cnt('event.properties?.part?.tool === "question"') !== 1) throw new Error("post-inject part-branch count mismatch");
    if (cnt("ocqSeenParts.has(ocqKey)") !== 1 || cnt("ocqSeenParts.add(ocqKey)") !== 1) throw new Error("dedup set usage count mismatch");
    if (cnt("input2.navigate(ocqHref)") !== 1) throw new Error("question notify call count mismatch");
    if (!js.includes(PATCH_IDLE_V3)) throw new Error("injected v3 block not contiguous");
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
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen. If native banners stay silent,");
    console.log("re-bind once: System Settings > Notifications > OpenCode -> OFF, then ON");
    console.log("(every re-sign can invalidate the macOS grant).");
    console.log("NOTE: app updates replace the bundle -> re-run this patch after updates (oc-post-update runs it).");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
