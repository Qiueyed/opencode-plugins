#!/usr/bin/env node
// Idempotent patch: "Trim & clean" items in the session TAB context menu.
//
// v6 (2026-10-05, opencode 1.18.34): full port to the 1.18 UI overhaul.
//   - 1.16.2 had a separate session chunk + DropdownMenu.Sub; 1.18 renders
//     everything from the main renderer bundle with a new MenuV2 primitive
//     that has NO submenu support -> flat items after "Rename".
//   - Marker writes now reuse the tab's own rename mutation
//     (rename.mutateAsync -> onRename -> sdk.api.session.rename), replacing
//     the 1.16-era direct sync.session/sdk.client calls that no longer exist
//     in this scope.
//   - Bundle target is DISCOVERED (largest out/renderer/assets/main-*.js)
//     instead of a hardcoded chunk hash.
//   - The ⏳ marker contract with tools/janitor.sh is UNCHANGED:
//     "... ⏳TRIM" keep-count resolves from state.json sessionTrimKeep (default 15),
//     "⏳TRIM5" hard trim, "⏳IMGS" strip image parts, "⏳READS" strip read parts.
//     Marker rides at the END of the title; trim happens at next app quit.
//
// Anchors below are unique in main-BMqLqZd4.js (1.18.34, verified 2026-10-05):
//   - 'onSelect: () => setMenu("rename", true),'  (Rename item, TabNavItem menu)
//   - 'language.t("common.rename");' within 200 chars after it
// Fails loud on any drift; --revert restores the pristine bundle (removes ALL patches).

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const REVERT = process.argv.includes("--revert");

const RENAME_ITEM_ANCHOR = 'onSelect: () => setMenu("rename", true),';
const RENAME_LABEL = 'language.t("common.rename");';
const MARK = "Trim old messages (mild)";
const MARK2 = "Remove images";
const MARK4 = "Remove reads";
const MARK3 = "Trim hard (keep 5)";
const SUB_START = "/* oc-trim-v6-start */";
const SUB_END = "/* oc-trim-v6-end */";
const TITLE_START = "/* oc-trim-title-v6-start */";
const TITLE_END = "/* oc-trim-title-v6-end */";

// Tab-menu items write through the tab's rename mutation.
function item(label, marker) {
  const isTrim = marker === "TRIM" || marker === "TRIM5";
  const body = isTrim
    ? `const cur = props.session();
                    if (!cur) return;
                    const raw = (typeof cur.title === "string" ? cur.title : "").replace(/ ?\\u23F3TRIM[0-9]*/g, "").trim();
                    void rename.mutateAsync((raw + " \\u23F3${marker}").trim());`
    : `const cur = props.session();
                    if (!cur) return;
                    const raw = typeof cur.title === "string" ? cur.title : "";
                    if (raw.indexOf("\\u23F3${marker}") !== -1) return;
                    void rename.mutateAsync((raw + " \\u23F3${marker}").trim());`;
  return `createComponent(MenuV2.Item, {
                    onSelect: () => {
                      try {
                        ${body}
                      } catch {}
                    },
                    get children() {
                      return "${label}";
                    }
                  })`;
}

// Title-menu items (the session title menu exists TWICE in 1.18: a MenuV2
// variant and a legacy DropdownMenu variant; both share the component scope
// with titleMutation + sync2 + id2). Write path: titleMutation
// (sdk().api.session.rename + optimistic sync store update).
function titleItemBody(marker) {
  const read = `const arr = sync2().session || [];
                      const cur = arr.find ? arr.find((s2) => s2.id === id2) : null;
                      if (!cur || typeof cur.title !== "string") return;`;
  if (marker === "TRIM" || marker === "TRIM5") {
    return `${read}
                      const raw = cur.title.replace(/ ?\\u23F3TRIM[0-9]*/g, "").trim();
                      void titleMutation.mutate({ id: id2, title: (raw + " \\u23F3${marker}").trim() });`;
  }
  return `${read}
                      if (cur.title.indexOf("\\u23F3${marker}") !== -1) return;
                      void titleMutation.mutate({ id: id2, title: (cur.title + " \\u23F3${marker}").trim() });`;
}

function titleItemM(label, marker) {
  return `createComponent(MenuV2.Item, {
                      onSelect: () => {
                        try {
                          ${titleItemBody(marker)}
                        } catch {}
                      },
                      get children() {
                        return "${label}";
                      }
                    })`;
}

function titleItemD(label, marker) {
  return `createComponent(DropdownMenu.Item, {
                      onSelect: () => {
                        try {
                          ${titleItemBody(marker)}
                        } catch {}
                      },
                      get children() {
                        return createComponent(DropdownMenu.ItemLabel, {
                          get children() {
                            return "${label}";
                          }
                        });
                      }
                    })`;
}

const PAYLOAD_PARTS = [
  "createComponent(MenuV2.Separator, {})",
  item(MARK, "TRIM"),
  item(MARK2, "IMGS"),
  item(MARK4, "READS"),
  item(MARK3, "TRIM5"),
];

// Injected right AFTER the rename item's closing '})' and BEFORE the array's
// own ',' - so the payload must open with ', ' and not end with one.
const PAYLOAD = `${SUB_START}, ${PAYLOAD_PARTS.join(", ")} ${SUB_END}`;

const TITLE_PAYLOAD_M = `${TITLE_START}, ${[
  "createComponent(MenuV2.Separator, {})",
  titleItemM("Trim mild", "TRIM"),
  titleItemM("Remove images", "IMGS"),
  titleItemM("Remove reads", "READS"),
  titleItemM("Trim hard (5)", "TRIM5"),
].join(", ")} ${TITLE_END}`;
const TITLE_PAYLOAD_D = `${TITLE_START}, ${[
  "createComponent(DropdownMenu.Separator, {})",
  titleItemD("Trim mild", "TRIM"),
  titleItemD("Remove images", "IMGS"),
  titleItemD("Remove reads", "READS"),
  titleItemD("Trim hard (5)", "TRIM5"),
].join(", ")} ${TITLE_END}`;

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
  // Stable identity (matches desktop-ui patcher): ad-hoc signing here was
  // breaking the keychain ACL for "OpenCode Safe Storage" on every run,
  // causing a repeat password prompt at launch.
  sh("codesign", ["--force", "--deep", "--sign", process.env.OC_SIGN_IDENTITY || "OpenCode Local Notifier", APP]);
  sh("codesign", ["--verify", "--deep", APP]);
  console.log("codesign: ad-hoc re-signed + verified OK");
}

function findMainBundle(workdir) {
  const dir = path.join(workdir, "out/renderer/assets");
  if (!fs.existsSync(dir)) throw new Error("out/renderer/assets missing from bundle - layout changed, re-derive");
  const cands = fs
    .readdirSync(dir)
    .filter((f) => /^main-[\w-]+\.js$/.test(f))
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (cands.length === 0) throw new Error("no main-*.js renderer bundle found - layout changed, re-derive");
  console.log(`renderer bundle: ${cands[0].f} (${cands[0].size} bytes, ${cands.length} candidate(s))`);
  return path.join(dir, cands[0].f);
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

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-trimmenu-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    sh("npx", ["--yes", "@electron/asar", "extract", ASAR, workdir]);
    const file = findMainBundle(workdir);
    let js = fs.readFileSync(file, "utf8");
    let changed = false;

    // Idempotency: strip previous v6 payloads wholesale (comment markers),
    // both the tab-menu and the title-menu payload.
    for (const [start, end, what] of [
      [SUB_START, SUB_END, "tab"],
      [TITLE_START, TITLE_END, "title"],
    ]) {
      for (;;) {
        const s = js.indexOf(start);
        if (s === -1) break;
        const e = js.indexOf(end, s);
        if (e === -1) throw new Error(`${what} payload start marker without end marker; refusing`);
        js = js.slice(0, s) + js.slice(e + end.length);
        changed = true;
        console.log(`stripped previous ${what}-menu payload`);
      }
    }

    if (!changed && js.includes(MARK) && js.includes(MARK3)) {
      console.log("already patched; nothing to do");
      return;
    }

    // FAIL LOUD anchors: the Rename item must appear exactly once in the
    // bundle, and its label must sit right after the anchor (within 200 chars).
    const anchorCount = js.split(RENAME_ITEM_ANCHOR).length - 1;
    if (anchorCount !== 1) {
      throw new Error(`expected exactly 1 rename-item anchor, found ${anchorCount}; re-derive the anchor from a fresh bundle extract`);
    }
    const a = js.indexOf(RENAME_ITEM_ANCHOR);
    const li = js.indexOf(RENAME_LABEL, a);
    if (li === -1 || li - a > 200) {
      throw new Error("rename label not found near the anchor; menu shape changed, re-derive");
    }
    // The rename item closes with the first '})' after its label.
    const closeIdx = js.indexOf("})", li);
    if (closeIdx === -1 || closeIdx - li > 80) {
      throw new Error("rename item close not found after label; re-derive");
    }
    const insertAt = closeIdx + 2;

    js = js.slice(0, insertAt) + PAYLOAD + js.slice(insertAt);
    changed = true;

    // v6.1: ALSO inject into BOTH session-title menus (Rename/Share/Export/
    // Archive/Delete). The bundle ships two variants: MenuV2 (new) and
    // DropdownMenu (legacy). Disambiguate by the item wrapper preceding the
    // archive anchor; each variant gets its own item flavor. Both share the
    // scope (titleMutation, sync2, id2). Insert point: the item's closing })
    // right before the family Separator that follows Archive.
    const ARCHIVE_ANCHOR = 'onSelect: () => void sessionArchive.archive(id2),';
    let injectedM = 0;
    let injectedD = 0;
    let searchFrom = 0;
    for (;;) {
      const a2 = js.indexOf(ARCHIVE_ANCHOR, searchFrom);
      if (a2 === -1) break;
      searchFrom = a2 + 1;
      const pre = js.slice(a2 - 200, a2);
      const isMenuV2 = pre.includes("createComponent(MenuV2.Item, {");
      const isDropdown = pre.includes("createComponent(DropdownMenu.Item, {");
      if (!isMenuV2 && !isDropdown) continue;
      const family = isMenuV2 ? "MenuV2" : "DropdownMenu";
      const lab2 = js.indexOf('language.t("common.archive");', a2);
      if (lab2 === -1 || lab2 - a2 > 400) continue;
      const sepIdx = js.indexOf(`createComponent(${family}.Separator`, lab2);
      if (sepIdx === -1 || sepIdx - lab2 > 600) {
        throw new Error(`title-menu (${family}) separator-after-archive not found; re-derive`);
      }
      const closeEnd = js.lastIndexOf("})", sepIdx) + 2;
      const payload = isMenuV2 ? TITLE_PAYLOAD_M : TITLE_PAYLOAD_D;
      js = js.slice(0, closeEnd) + payload + js.slice(closeEnd);
      searchFrom = closeEnd + payload.length;
      if (isMenuV2) injectedM++;
      else injectedD++;
    }
    if (injectedM !== 1 || injectedD !== 1) {
      throw new Error(`expected exactly 1 MenuV2 + 1 DropdownMenu title menu, injected M=${injectedM} D=${injectedD}; re-derive`);
    }
    changed = true;

    // v6.2: the MenuV2 title menu hardcodes width:120px inline, which wraps
    // the trim labels into ugly stacks. Widen to 210px (unique anchor).
    const W_STOCK = 'width: "120px"';
    const W_NEW = 'width: "210px", "min-width": "210px"';
    const wCount = js.split(W_STOCK).length - 1;
    if (wCount > 1) {
      throw new Error(`title menu width anchor count drifted: ${wCount} (expected <= 1); re-derive`);
    }
    if (wCount === 1) {
      // replace only the width line; the adjacent "min-width": "120px" stays
      // (it is covered by the injected min-width that follows)
      js = js.replace(W_STOCK + ",", W_NEW + ",");
      const mwCount = js.split('"min-width": "120px"').length - 1;
      if (mwCount === 1) {
        js = js.replace('"min-width": "120px"', '"min-width": "210px"');
      } else if (mwCount > 1) {
        throw new Error(`min-width anchor ambiguous (${mwCount}); re-derive`);
      }
      changed = true;
      console.log("widened MenuV2 title menu to 210px");
    }

    // v6.3 CANARY classes (temporary): outline colors identify which menus
    // actually render. See the CANARY block in desktop-ui's cssBlock.
    // Tab menu (scoped to TabNavItem: first Context.Content after its def).
    const TAB_CANARY = 'createComponent(MenuV2.Context.Content, { "class": "oc-tab-menu", ';
    js = js.split(TAB_CANARY).join("createComponent(MenuV2.Context.Content, {");
    const tabFn = js.indexOf("function TabNavItem(props) {");
    if (tabFn === -1) throw new Error("canary: TabNavItem not found; re-derive");
    const ctxIdx = js.indexOf("createComponent(MenuV2.Context.Content, {", tabFn);
    if (ctxIdx === -1 || ctxIdx - tabFn > 14000) {
      throw new Error("canary: tab menu Content not found inside TabNavItem; re-derive");
    }
    js = js.slice(0, ctxIdx) + TAB_CANARY + js.slice(ctxIdx + "createComponent(MenuV2.Context.Content, {".length);
    // MenuV2 title menu (own the width:210px style block).
    js = js.split('createComponent(MenuV2.Content, { "class": "oc-title-menu", ').join("createComponent(MenuV2.Content, {");
    const wNewIdx = js.indexOf(W_NEW);
    if (wNewIdx !== -1) {
      const cIdx = js.lastIndexOf("createComponent(MenuV2.Content, {", wNewIdx);
      if (cIdx !== -1 && wNewIdx - cIdx < 400) {
        js = js.slice(0, cIdx) + 'createComponent(MenuV2.Content, { "class": "oc-title-menu", ' + js.slice(cIdx + "createComponent(MenuV2.Content, {".length);
      } else {
        throw new Error("canary: MenuV2.Content not found right before its width style; re-derive");
      }
    }
    // DropdownMenu title menu variant.
    const DROP_STOCK = "createComponent(DropdownMenu.Content, {";
    const DROP_CANARY = 'createComponent(DropdownMenu.Content, { "class": "oc-drop-title-menu", ';
    js = js.split(DROP_CANARY).join(DROP_STOCK);
    const dArch = js.indexOf('onSelect: () => void sessionArchive.archive(id2),');
    if (dArch !== -1) {
      const dcIdx = js.lastIndexOf(DROP_STOCK, dArch);
      if (dcIdx !== -1 && dArch - dcIdx < 6000) {
        js = js.slice(0, dcIdx) + DROP_CANARY + js.slice(dcIdx + DROP_STOCK.length);
      } else {
        throw new Error("canary: DropdownMenu.Content not found before the legacy title menu; re-derive");
      }
    }
    if (js.split('"oc-tab-menu"').length - 1 !== 1 || js.split('"oc-title-menu"').length - 1 !== 1 || js.split('"oc-drop-title-menu"').length - 1 !== 1) {
      throw new Error("canary: class injection counts drifted; refusing");
    }

    for (const [label, expected] of [
      [MARK, 1], // tab menu's long-form mild item
      [MARK3, 1], // tab menu's long-form hard item
      ["Trim mild", 2], // MenuV2 + DropdownMenu title menus
      ["Remove images", 3], // tab + 2 title menus
      ["Remove reads", 3],
      ["Trim hard (5)", 2],
    ]) {
      const n = js.split(label).length - 1;
      if (n !== expected) {
        throw new Error(`post-injection marker count mismatch for "${label}" (expected ${expected}, got ${n})`);
      }
    }
    // FULL-FILE SYNTAX CHECK before writing (house rule).
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
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen - the session tab menu now has the trim items.");
    console.log("Mild default follows the Plugins-menu keep count (default 15). Markers run at next quit via janitor.");
    console.log("NOTE: app auto-updates replace the bundle -> re-run this patch after updates.");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
