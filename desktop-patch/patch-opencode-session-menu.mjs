#!/usr/bin/env node
// Idempotent patch: the "Trim & clean" submenu in the session context menu.
//
// Makes session trimming usable in the UI. v5: the three legacy flat items
// collapse into ONE expandable submenu entry - mild default first ("Trim old
// messages (mild)", keep count follows the Plugins-menu setting), then
// Remove images / Remove reads, with the aggressive "Trim hard (keep 5)" LAST.
//
// MECHANICS (honest about the boundary): trimming requires the app CLOSED
// (db surgery; the trim tool refuses while the app runs by design), so the
// menu item cannot trim in-place. Instead it writes a PENDING marker into
// the session title ("... \u23F3TRIM15" = keep last 15 user turns) via the
// same sdk.client.session.update the Archive item uses. At the next quit,
// tools/janitor.sh finds the marker, performs the trim (parts+messages+event
// cleanup identical to the compaction trim), and strips the marker from the
// title. Flow: click item -> quit -> reopen: trimmed.
//
// The marker rides at the END of the title so the session-size plugin's
// prefix logic is unaffected (its TAG_RE strips only leading size tags).
//
// Shares the pristine backup (app.asar.original.bak); --revert restores it
// and removes ALL patches (re-run the others after).
//
// Usage: node patch-opencode-session-menu.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const REVERT = process.argv.includes("--revert");

const TARGET = "out/renderer/assets/session-kFpN98Pe.js";
const ANCHOR = "onSelect: () => void archiveSession(id),";
const ITEM_OPEN = "createComponent(DropdownMenu.Item, {";
const SUB_LABEL = "Trim & clean";
const MARK = "Trim old messages (mild)";
const MARK2 = "Remove images";
const MARK4 = "Remove reads";
const MARK3 = "Trim hard (keep 5)";

// Marker contract shared with the janitor: bare ⏳TRIM resolves the keep
// count from trim-keep.txt (default 15) - the mild default. ⏳TRIM5 is the
// explicit hard option. ⏳IMGS / ⏳READS strip those payload classes.

function markerItem(label, marker) {
  // Trim-family items REPLACE any pending trim marker (switching mild <-> hard
  // must work; a substring no-op guard would silently ignore the click).
  // IMGS/READS keep the simple same-marker dedupe guard.
  const isTrim = marker === "TRIM" || marker === "TRIM5";
  const body = isTrim
    ? `let raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      raw = raw.replace(/ ?\\u23F3TRIM[0-9]*/g, "").trim();
                                      void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3${marker}").trim() });`
    : `let raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      if (raw.indexOf("\\u23F3${marker}") !== -1) return;
                                      void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3${marker}").trim() });`;
  return `createComponent(DropdownMenu.Item, {
                                  onSelect: () => {
                                    try {
                                      const cur = sync.session.get(id);
                                      ${body}
                                    } catch {}
                                  },
                                  get children() {
                                    return createComponent(DropdownMenu.ItemLabel, {
                                      get children() {
                                        return "${label}";
                                      }
                                    });
                                  }
                                }), `;
}

const TRIM_ITEM = markerItem(MARK, "TRIM");
const IMAGES_ITEM = markerItem(MARK2, "IMGS");
const READS_ITEM = markerItem(MARK4, "READS");
const TRIM5_ITEM = markerItem(MARK3, "TRIM5");

// Legacy flat items (v1-v4). Exact strings the older script versions wrote;
// removed by byte-exact replace so old installs upgrade cleanly.
const OLD_TRIM_ITEM = `createComponent(DropdownMenu.Item, {
                                  onSelect: () => {
                                    try {
                                      const cur = sync.session.get(id);
                                      const raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      if (raw.indexOf("\\u23F3TRIM") === -1) {
                                        void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3TRIM").trim() });
                                      }
                                    } catch {}
                                  },
                                  get children() {
                                    return createComponent(DropdownMenu.ItemLabel, {
                                      get children() {
                                        return "Trim old messages";
                                      }
                                    });
                                  }
                                }), `;
const OLD_IMAGES_ITEM = `createComponent(DropdownMenu.Item, {
                                  onSelect: () => {
                                    try {
                                      const cur = sync.session.get(id);
                                      const raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      if (raw.indexOf("\\u23F3IMGS") === -1) {
                                        void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3IMGS").trim() });
                                      }
                                    } catch {}
                                  },
                                  get children() {
                                    return createComponent(DropdownMenu.ItemLabel, {
                                      get children() {
                                        return "Remove images";
                                      }
                                    });
                                  }
                                }), `;
const OLD_TRIM5_ITEM = `createComponent(DropdownMenu.Item, {
                                  onSelect: () => {
                                    try {
                                      const cur = sync.session.get(id);
                                      const raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      if (raw.indexOf("\\u23F3TRIM") === -1) {
                                        void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3TRIM5").trim() });
                                      }
                                    } catch {}
                                  },
                                  get children() {
                                    return createComponent(DropdownMenu.ItemLabel, {
                                      get children() {
                                        return "Trim hard (keep 5)";
                                      }
                                    });
                                  }
                                }), `;

// The expandable submenu wrapper, matching the app's own DropdownMenu
// composition (Sub > SubTrigger + Portal > SubContent). The SubContent gets
// the parent menu's item-padding class so nested rows style identically.
// Wrapped in comment markers so future versions can replace it wholesale
// (byte-exact cut, no bracket matching).
const MENU_CONTENT_CLASS =
  "[&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1";
const SUB_START = "/* oc-trim-sub-start */";
const SUB_END = "/* oc-trim-sub-end */";
const SUBMENU = `${SUB_START}createComponent(DropdownMenu.Sub, {
                                  get children() {
                                    return [
                                      createComponent(DropdownMenu.SubTrigger, {
                                        get children() {
                                          return "${SUB_LABEL} \\u203A";
                                        }
                                      }), createComponent(DropdownMenu.Portal, {
                                        get children() {
                                          return createComponent(DropdownMenu.SubContent, {
                                            "class": "${MENU_CONTENT_CLASS}",
                                            get children() {
                                              return [${TRIM_ITEM}${IMAGES_ITEM}${READS_ITEM}${TRIM5_ITEM}];
                                            }
                                          });
                                        }
                                      })];
                                    }
                                  }), ${SUB_END}`;

// The v5-r1 submenu (pre-marker-switch guards): the previous script version
// assembled this exact text from the old item generator. Reconstructing it
// byte-exactly lets the upgrade REPLACE it in one step instead of gutting
// items from inside it.
function oldItem(label, marker) {
  return `createComponent(DropdownMenu.Item, {
                                  onSelect: () => {
                                    try {
                                      const cur = sync.session.get(id);
                                      const raw = cur && typeof cur.title === "string" ? cur.title : "";
                                      if (raw.indexOf("\\u23F3${marker}") === -1) {
                                        void sdk.client.session.update({ sessionID: id, title: (raw + " \\u23F3${marker}").trim() });
                                      }
                                    } catch {}
                                  },
                                  get children() {
                                    return createComponent(DropdownMenu.ItemLabel, {
                                      get children() {
                                        return "${label}";
                                      }
                                    });
                                  }
                                }), `;
}
const OLD_R1_SUBMENU = `createComponent(DropdownMenu.Sub, {
                                  get children() {
                                    return [
                                      createComponent(DropdownMenu.SubTrigger, {
                                        get children() {
                                          return "${SUB_LABEL} \\u203A";
                                        }
                                      }), createComponent(DropdownMenu.Portal, {
                                        get children() {
                                          return createComponent(DropdownMenu.SubContent, {
                                            "class": "${MENU_CONTENT_CLASS}",
                                            get children() {
                                              return [${oldItem(MARK, "TRIM")}${oldItem(MARK2, "IMGS")}${oldItem(MARK4, "READS")}${oldItem(MARK3, "TRIM5")}];
                                            }
                                          });
                                        }
                                      })];
                                    }
                                  }), `;

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

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-trimmenu-"));
  try {
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    sh("npx", ["--yes", "@electron/asar", "extract", ASAR, workdir]);
    const file = path.join(workdir, TARGET);
    if (!fs.existsSync(file)) {
      throw new Error(`${TARGET} not found in bundle - chunk hash changed, re-derive the anchor from a fresh bundle extract`);
    }
    let js = fs.readFileSync(file, "utf8");
    let changed = false;

    // v5 upgrade FIRST (must run even when all items exist): the main Trim
    // item now writes a BARE marker; the keep count is resolved by the
    // janitor from the Plugins-menu setting (trim-keep.txt).
    const oldWriteCount = js.split('TRIM15").trim()').length - 1;
    if (oldWriteCount > 0) {
      js = js.split('TRIM15").trim()').join('TRIM").trim()');
      changed = true;
      console.log(`upgraded ${oldWriteCount} trim item write(s): count now follows the Plugins-menu setting`);
    }

    // v5-r1 -> v6: replace the unmarked submenu wholesale (byte-exact).
    while (js.includes(OLD_R1_SUBMENU)) {
      js = js.replace(OLD_R1_SUBMENU, "");
      changed = true;
      console.log("replaced v5-r1 submenu with marker-switch guards");
    }

    // Legacy flat items (v1-v4 forms) - also the r1 submenu's innards when
    // the wholesale replace did not match, so any state converges.
    let removed = 0;
    for (const legacy of [OLD_TRIM_ITEM, OLD_IMAGES_ITEM, OLD_TRIM5_ITEM]) {
      while (js.includes(legacy)) {
        js = js.replace(legacy, "");
        removed++;
      }
    }
    if (removed > 0) {
      changed = true;
      console.log(`removed ${removed} legacy flat item(s)`);
    }

    const hasTrim = js.includes(MARK);
    const hasImages = js.includes(MARK2);
    const hasReads = js.includes(MARK4);
    const hasTrim5 = js.includes(MARK3);
    const hasSub = js.includes(SUB_START);

    if (!changed && hasSub && hasTrim && hasImages && hasReads && hasTrim5) {
      console.log("already patched; nothing to do");
      return;
    }

    // FAIL LOUD anchors: the archive item must appear exactly once, and the
    // DropdownMenu.Item opening directly before it must be its container.
    const anchorCount = js.split(ANCHOR).length - 1;
    if (anchorCount !== 1) {
      throw new Error(`expected exactly 1 menu anchor ("${ANCHOR}"), found ${anchorCount}; re-derive the anchor from a fresh bundle extract`);
    }
    const anchorIdx = js.indexOf(ANCHOR);
    const itemStart = js.lastIndexOf(ITEM_OPEN, anchorIdx);
    if (itemStart === -1 || anchorIdx - itemStart > 160) {
      throw new Error("menu item container not found immediately before the archive anchor; re-derive");
    }
    if (!js.slice(itemStart - 8, itemStart).trimEnd().endsWith("}),")) {
      throw new Error("unexpected characters before the archive item container; refusing to inject");
    }

    // Inject the submenu (with all four marker items) once.
    if (!hasSub) {
      js = js.slice(0, itemStart) + SUBMENU + js.slice(itemStart);
      changed = true;
    }
    if (!changed) {
      console.log("already patched; nothing to do");
      return;
    }

    for (const label of [MARK, MARK2, MARK4, MARK3, SUB_LABEL]) {
      if (js.split(label).length - 1 !== 1) {
        throw new Error(`post-injection marker count mismatch for "${label}"`);
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
    fs.copyFileSync(packed, ASAR);
    const hash = stampIntegrity();
    console.log("asar repacked; integrity hash:", hash.slice(0, 16) + "...");
    resign();
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen - the session menu now has a 'Trim & clean' submenu.");
    console.log("Mild default: 'Trim old messages (mild)' follows the Plugins-menu keep count (default 15).");
    console.log("NOTE: app auto-updates replace the bundle -> re-run this patch after updates.");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
