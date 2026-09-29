#!/usr/bin/env node
// Idempotent patch for the OpenCode desktop app UI (Electron renderer).
//
// Fixes three picker/list problems at their root (the app has no config options
// for any of them, and it enforces ElectronAsarIntegrity, so this script
// re-stamps the integrity hash and ad-hoc re-signs the app after patching):
//
//   1. Model-picker row clipping: each row is a flex <span class=truncate>
//      plus Free/Latest tag badges. The span has no min-width floor override,
//      so it cannot shrink below its text width and gets hard-clipped at the
//      popover edge (no ellipsis) when name + badges exceed the row width.
//   2. Picker size: the popover is hardcoded to w-72 h-80 (288x320px).
//   3. Session-size COLOR (pairs with the
//      plugins/session-size.ts tag "[428M] Title"): the session LIST row
//      (SessionRow) and the session TAB render titles as plain text via
//      insert(el, title); a text node cannot be partially colored by CSS, so
//      the patch injects an ocColoredTitle() helper into the main renderer
//      bundle and wraps those two accessors - a leading "[428M]" size token
//      becomes a styled span (red >= SIZE_RED_MB MB, amber >= SIZE_AMBER_MB,
//      green below). Emoji in titles was tried first (plugin v2) and
//      dropped; this is the real colored-text version. Graceful
//      degradation: unpatched builds just show the plain bracket tag.
//   4. Model-picker row INFO BADGES (v3): the picker rows show
//      only name + Free/Latest; context window, image capability, and price
//      are hover-tooltip-only. ocModelBadges() is injected into the session
//      chunk (the chunk whose JS holds the w-72 h-80 Popover.Content) and the
//      ModelList row builder gains a call that appends right-aligned compact
//      badges: context (200K/1M), IMG when the model accepts image input,
//      $in/M input price when > 0. All null-safe (custom/config models just
//      show fewer badges).
//
// What it does:
//   - extracts Resources/app.asar to a temp dir
//   - appends (or replaces) a marker-delimited CSS block in the main
//     renderer stylesheet (out/renderer/assets/main-*.css):
//       * model-row name spans become shrinkable -> real ellipsis
//       * .z-50.h-80 (the model popover; the only element with both classes)
//         grows to POPOVER_WIDTH_REM x POPOVER_HEIGHT_REM
//   - injects (or replaces) the marker-delimited ocColoredTitle helper at the
//     top of the main renderer bundle (out/renderer/assets/main-*.js) and
//     normalizes the two title inserts to route through it (anchors verified
//     unique on 1.16.2; the script FAILS LOUD if an anchor count drifts -
//     re-derive the anchor from a fresh bundle extract)
//   - repacks the asar, backs up the pristine original once
//     (app.asar.original.bak), computes the new asar header SHA256 and writes
//     it into Info.plist ElectronAsarIntegrity (integrity stays ENABLED)
//   - ad-hoc re-signs the app bundle (codesign -s -) and verifies it
//
// Re-run after every app auto-update (updates replace the whole bundle).
// Revert with: node patch-opencode-desktop-ui.mjs --revert
//
// Usage: node patch-opencode-desktop-ui.mjs [--revert]

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const APP = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app";
const ASAR = `${APP}/Contents/Resources/app.asar`;
const BACKUP = `${ASAR}.original.bak`;
const INFO_PLIST = `${APP}/Contents/Info.plist`;
const CSS_MARKER_START = "/* == opencode-desktop-ui-patch";
const CSS_MARKER_END = "/* == end opencode-desktop-ui-patch == */";
const JS_MARKER_START = "/* == opencode-session-size-color-patch";
const JS_MARKER_END = "/* == end opencode-session-size-color-patch == */";
const MB_MARKER_START = "/* == opencode-model-badges-patch";
const MB_MARKER_END = "/* == end opencode-model-badges-patch == */";
const MENU_MARKER_START = "/* == opencode-plugins-menu-patch";
const MENU_MARKER_END = "/* == end opencode-plugins-menu-patch == */";
const REGISTRY_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "plugins-menu.json");
const STATE_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "state", "state.json");

// Picker popover size. Tweak these and re-run to resize.
// Overridable WITHOUT editing this file: ~/.config/opencode/state/ui-patch.json
//   { "popoverWidthRem": 24, "popoverHeightRem": 32,
//     "badgeContext": true, "badgeImage": true, "badgeCost": true }
// or CLI: --popover-w 28 --popover-h 40 --badge-img off  (CLI > json > here)
const CONFIG_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "state", "ui-patch.json");
function readUiConfig() {
  const cfg = {
    popoverWidthRem: 24, // stock: 18rem (288px)
    popoverHeightRem: 32, // stock: 20rem (320px)
    badgeContext: true,
    badgeImage: true,
    badgeCost: true,
  };
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    for (const k of Object.keys(cfg)) if (typeof j[k] === typeof cfg[k]) cfg[k] = j[k];
  } catch {}
  const argv = process.argv.slice(2);
  const num = (flag) => {
    const i = argv.indexOf(flag);
    if (i !== -1 && /^\d+(\.\d+)?$/.test(argv[i + 1] || "")) return parseFloat(argv[i + 1]);
    return null;
  };
  const bool = (flag) => {
    const i = argv.indexOf(flag);
    if (i !== -1) return !/^(off|false|0)$/i.test(argv[i + 1] || "");
    return null;
  };
  const w = num("--popover-w");
  const h = num("--popover-h");
  if (w) cfg.popoverWidthRem = w;
  if (h) cfg.popoverHeightRem = h;
  const bc = bool("--badge-ctx");
  const bi = bool("--badge-img");
  const bco = bool("--badge-cost");
  if (bc !== null) cfg.badgeContext = bc;
  if (bi !== null) cfg.badgeImage = bi;
  if (bco !== null) cfg.badgeCost = bco;
  return cfg;
}
const CFG = readUiConfig();
const POPOVER_WIDTH_REM = CFG.popoverWidthRem;
const POPOVER_HEIGHT_REM = CFG.popoverHeightRem;

// Session-size tag colors (see patchTitleJs). Tweak and re-run.
const SIZE_RED_MB = 300; // tag text turns red at/above this many MB
const SIZE_AMBER_MB = 100; // amber at/above this, green below

// Model row badges (see applyModelBadges). Tweak and re-run.
const BADGE_CONTEXT = CFG.badgeContext; // context window: 200K / 1M
const BADGE_IMAGE = CFG.badgeImage; // IMG when the model accepts image input
const BADGE_COST = CFG.badgeCost; // $in/M input price, hidden when free/unknown

const REVERT = process.argv.includes("--revert");

function sh(cmd, args, opts = {}) {
  const { input, ...rest } = opts;
  const out = execFileSync(cmd, args, {
    // stdin must be piped when `input` is passed; "ignore" would feed nothing.
    stdio: ["pipe", "pipe", "pipe"],
    ...rest,
    ...(input !== undefined ? { input } : {}),
  });
  return out === null ? "" : out.toString().trim();
}

function cssBlock() {
  return `${CSS_MARKER_START} v2 (added by patches/patch-opencode-desktop-ui.mjs; safe to delete this block to undo) */

/* Model-picker rows: let the name span shrink so .truncate ellipsizes for
   real and the Free/Latest badges stay visible instead of being pushed out. */
[class~="text-13-regular"][class~="gap-x-2"] > span.truncate {
  min-width: 0;
}

/* Model picker popover: wider + taller (only element in the app with both
   z-50 and h-80). Stock: 18rem x 20rem (288x320px). */
.z-50.h-80 {
  width: ${POPOVER_WIDTH_REM}rem;
  height: ${POPOVER_HEIGHT_REM}rem;
}

/* Model row info badges (v3): compact right-aligned chips appended by
   ocModelBadges(). First badge pushes itself + the rest to the right edge;
   the name span keeps truncating. */
.oc-mb {
  flex: none;
  font-size: 10px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 5px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  opacity: 0.75;
  font-family: ui-monospace, monospace;
}
.oc-mb:first-of-type,
.oc-mb.oc-mb-first {
  margin-left: auto;
}
.oc-mb-ctx {
  color: var(--text-weak, #8b949e);
}
.oc-mb-img {
  color: #57ab5a;
}
.oc-mb-cost {
  color: #d29922;
}

${CSS_MARKER_END}`;
}

/** SHA256 hex of the asar header JSON (bytes 16..16+jsonLen). Matches what
 * Electron checks against Info.plist ElectronAsarIntegrity. */
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

/** Recompute hash from the current asar and write it into Info.plist. */
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
  // verify round-trip
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

// Stable signing identity (self-signed cert, login keychain). Ad-hoc ("-")
// yields a fresh cdhash on every re-patch, which makes macOS TCC grants stop
// matching: the microphone prompt for afplay-via-Background-Music kept
// returning even after Allow (2026-09-29). A named identity keeps the TCC
// code designation stable, so grants survive re-patches. Override with
// OC_SIGN_IDENTITY env var; codesign fails loud if the cert is missing.
const SIGN_IDENTITY = process.env.OC_SIGN_IDENTITY || "OpenCode Local Notifier";

function resign() {
  sh("codesign", ["--force", "--deep", "--sign", SIGN_IDENTITY, APP]);
  sh("codesign", ["--verify", "--deep", APP]);
  console.log(`codesign: re-signed as "${SIGN_IDENTITY}" + verified OK`);
}

function extractAsar(dest) {
  fs.mkdirSync(dest, { recursive: true });
  sh("npx", ["--yes", "@electron/asar", "extract", ASAR, dest]);
}

/** The injected helper: returns a span-wrapped Node for "[428M] ..." titles
 * (colored size token), the original string otherwise. Injected at the TOP of
 * the main renderer bundle; function declarations hoist module-wide, and an
 * ES module may legally declare functions before its import statements. */
function titleColorHelperBlock() {
  // HISTORICAL TRAP: the start-marker line once ran on WITHOUT a "*/",
  // so the block comment swallowed the whole helper up to the end marker -
  // valid syntax (node --check passed), but the function never existed and
  // the app died on ReferenceError at the call sites. The start marker now
  // CLOSES ITSELF on its own line, and patchTitleJs runtime-evals the block
  // (new Function) to prove ocColoredTitle is actually defined before the
  // asar is written. Comment-marker blocks are also why the CSS variant has
  // always carried its rules in separately-commented lines.
  return `${JS_MARKER_START} (added by patches/patch-opencode-desktop-ui.mjs; safe to delete this block to undo) */
function ocTitleMB(tok) {
  const m = /^(\\d+(?:\\.\\d+)?)([GMKB])$/.exec(tok);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return m[2] === "G" ? n * 1024 : m[2] === "M" ? n : m[2] === "K" ? n / 1024 : n / 1048576;
}
function ocColoredTitle(t) {
  if (typeof t !== "string") return t;
  const m = /^(\\d+(?:\\.\\d+)?[GMKB])\\s*\\u00B7/.exec(t);
  if (!m) return t;
  // UNIT-AWARE value (a past bug: parseFloat("330K") = 330
  // dropped the K suffix and compared against MEGABYTE thresholds, so 330K
  // rendered RED and 1.1G rendered GREEN - exactly inverted for K and G).
  const v = ocTitleMB(m[1]);
  const col = v >= ${SIZE_RED_MB} ? "#e5534b" : v >= ${SIZE_AMBER_MB} ? "#d29922" : "#57ab5a";
  const wrap = document.createElement("span");
  const tag = document.createElement("span");
  tag.textContent = m[0];
  tag.style.color = col;
  tag.style.fontWeight = "600";
  wrap.appendChild(tag);
  wrap.appendChild(document.createTextNode(t.slice(m[0].length)));
  return wrap;
}
${JS_MARKER_END}`;
}

/** Shared transform: strip old blocks, normalize inserts, inject helper,
 * probe + assert + syntax-check. Returns nothing; throws on any drift.
 * minRowSites: expected minimum count of `insert(el, title)` sites. */
function applyTitleColor(file, label, { minRowSites, expectTabSite }) {
  let js = fs.readFileSync(file, "utf8");
  // Idempotency: strip ALL previous helper blocks (LOOP, not single indexOf:
  // a past audit found two stacked blocks because this step was
  // silently missing - the JS patcher re-prepended on every run while only
  // the CSS patcher stripped), then normalize patched inserts to stock form.
  let stripped = 0;
  for (;;) {
    const s = js.indexOf(JS_MARKER_START);
    if (s === -1) break;
    const e = js.indexOf(JS_MARKER_END, s);
    if (e === -1) throw new Error("helper start marker without end marker");
    js = js.slice(0, s) + js.slice(e + JS_MARKER_END.length);
    stripped++;
  }
  if (stripped > 0) console.log(`  ${label}: stripped ${stripped} previous helper block(s)`);
  js = js.replace(/insert\(([\w$]+), \(\) => ocColoredTitle\(title\(\)\)\);/g, "insert($1, title);");
  // Also reverse the guarded accessor form shipped by earlier runs (a past
  // near-miss: normalize only knew the simple form, the anchor count went to
  // zero, and the pre-repack guard refused to build - exactly as designed).
  js = js.replace(
    /insert\(([\w$]+), \(\) => ocColoredTitle\(typeof title === "function" \? title\(\) : title\)\);/g,
    "insert($1, title);",
  );
  js = js.replace(
    /insert\(([\w$]+), \(\) => ocColoredTitle\(props\.title\)\);/g,
    "insert($1, () => props.title);",
  );
  // Session-title insert sites route through the color helper. The accessor
  // form tolerates `title` being a memo (function) or a plain value.
  const rowSites = js.match(/insert\(([\w$]+), title\);/g);
  const rowCount = rowSites ? rowSites.length : 0;
  if (rowCount < minRowSites) {
    throw new Error(
      `${label}: title insert anchor count drifted: ${rowCount} (expected >= ${minRowSites}); ` +
        "re-derive the anchor from a fresh bundle extract",
    );
  }
  js = js.replace(
    /insert\(([\w$]+), title\);/g,
    "insert($1, () => ocColoredTitle(typeof title === \"function\" ? title() : title));",
  );
  let tabCount = 0;
  const tabMatches = js.match(/insert\(([\w$]+), \(\) => props\.title\);/g);
  tabCount = tabMatches ? tabMatches.length : 0;
  if (expectTabSite) {
    if (tabCount !== 1) {
      throw new Error(
        `${label}: session tab anchor count drifted: ${tabCount} (expected 1); ` +
          "re-derive the anchor from a fresh bundle extract",
      );
    }
    js = js.replace(
      /insert\(([\w$]+), \(\) => props\.title\);/,
      "insert($1, () => ocColoredTitle(props.title));",
    );
  }
  const helperBlock = titleColorHelperBlock();
  // PROOF-OF-DEFINITION + UNIT-MATH guard: evaluate the helper
  // block for real AND assert the MB conversion that a past bug got
  // wrong (parseFloat silently dropped K/G suffixes; 330K compared as 300+MB
  // -> red, 1.1G as 1.1MB -> green). The pure ocTitleMB is asserted directly;
  // ocColoredTitle is typeof-checked (its body touches document, unreachable
  // in node). Any regression fails HERE, before the asar is written.
  const probe = new Function(
    helperBlock +
      "\nreturn [typeof ocColoredTitle, ocTitleMB('330K'), ocTitleMB('12K'), ocTitleMB('150M'), ocTitleMB('569M'), ocTitleMB('1.1G'), ocTitleMB('0B')];",
  );
  const [fnType, k330, k12, m150, m569, g11, b0] = probe();
  if (fnType !== "function") {
    throw new Error("ocColoredTitle did not evaluate to a function; refusing to write the bundle");
  }
  const close = (a, b) => Math.abs(a - b) < 0.01;
  const unitOk =
    close(k330, 330 / 1024) &&
    close(k12, 12 / 1024) &&
    close(m150, 150) &&
    close(m569, 569) &&
    close(g11, 1.1 * 1024) &&
    close(b0, 0);
  if (!unitOk) {
    throw new Error(
      `ocTitleMB unit conversion regressed: 330K=${k330} 12K=${k12} 150M=${m150} 569M=${m569} 1.1G=${g11} 0B=${b0}; refusing to write`,
    );
  }
  js = helperBlock + "\n" + js;
  // PRE-REPACK ASSERTIONS (defense in depth): the TRANSFORMED BUNDLE must carry the definition AND the
  // call-site wirings. The probe above catches a commented-out/defective
  // helper; these catch call sites silently left unrouted. All fail loud
  // BEFORE the asar is repacked, converting "silent partial patch -> crash on
  // launch" into a loud refusal.
  for (const re of [/function ocColoredTitle\(/, /ocColoredTitle\(/]) {
    if (!re.test(js)) {
      throw new Error(`pre-repack check failed: ${re} not present in transformed bundle`);
    }
  }
  const wired = js.match(/ocColoredTitle\(/g);
  // 1 definition reference + (row sites + optional tab) wrapped call sites.
  const expectedWired = 1 + rowCount + (expectTabSite ? tabCount : 0);
  if (!wired || wired.length < expectedWired) {
    throw new Error(
      `pre-repack check failed: expected >= ${expectedWired} ocColoredTitle references, found ${wired ? wired.length : 0}`,
    );
  }
  // EXACTLY-ONE declaration (a past audit found two stacked
  // copies -> "Identifier already declared" SyntaxError at launch). Count, do
  // not just test.
  const decls = js.match(/function ocColoredTitle\(/g);
  if (!decls || decls.length !== 1) {
    throw new Error(`expected exactly 1 ocColoredTitle declaration, found ${decls ? decls.length : 0}`);
  }
  // FULL-FILE SYNTAX CHECK of the transformed bundle (the probe above only
  // evaluates the helper block; this proves the WHOLE file still parses -
  // duplicates, stray tokens, anything). Definitive launch-safety gate.
  const syntaxProbe = path.join(path.dirname(file), "syntax-check.mjs");
  fs.writeFileSync(syntaxProbe, js);
  try {
    sh("node", ["--check", syntaxProbe]);
  } finally {
    fs.rmSync(syntaxProbe, { force: true });
  }
  fs.writeFileSync(file, js);
  console.log(
    `  ${label}: ${rowCount} row site(s)${expectTabSite ? ` + ${tabCount} tab site` : ""} routed; probe + assertions + single-decl + node --check OK`,
  );
}

/** Injected helper for model row badges (v3). Marker-delimited like the
 * title-color helper; injected at the TOP of the session chunk. Pure DOM -
 * no component deps, so it cannot break Solid internals. */
function modelBadgeHelperBlock() {
  return `${MB_MARKER_START} (added by patches/patch-opencode-desktop-ui.mjs; safe to delete this block to undo) */
function ocFmtCtx(n) {
  if (typeof n !== "number" || !(n > 0)) return null;
  if (n >= 1e6) {
    const v = n / 1e6;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1).replace(/\\.0$/, "")) + "M";
  }
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(n);
}
function ocModelBadges(i, el) {
  try {
    if (!el || el.querySelector(".oc-mb")) return;
    const cap = (i.capabilities && i.capabilities.input) || (i.modalities && i.modalities.input
      ? Object.fromEntries(i.modalities.input.map((k) => [k, true]))
      : null);
    const parts = [];
    ${BADGE_CONTEXT ? `const ctx = ocFmtCtx(i.limit && i.limit.context);
    if (ctx) parts.push(["oc-mb-ctx", ctx]);` : ""}
    ${BADGE_IMAGE ? `if (cap && cap.image) parts.push(["oc-mb-img", "IMG"]);` : ""}
    ${BADGE_COST ? `const cin = i.cost && typeof i.cost.input === "number" ? i.cost.input : 0;
    if (cin > 0) parts.push(["oc-mb-cost", "$" + (cin < 0.01 ? cin.toFixed(3) : cin.toFixed(2)) + "/M"]);` : ""}
    if (!parts.length) return;
    for (let idx = 0; idx < parts.length; idx++) {
      const s = document.createElement("span");
      s.className = "oc-mb " + parts[idx][0] + (idx === 0 ? " oc-mb-first" : "");
      s.textContent = parts[idx][1];
      el.appendChild(s);
    }
  } catch {}
}
${MB_MARKER_END}`;
}

/** v3: model row badges. Locates the session chunk by CONTENT (the compiled
 * ModelList row template), not by hashed filename. Anchor-verified,
 * idempotent, probe-tested, fail-loud - same rails as the title patch. */
function applyModelBadges(file, label) {
  let js = fs.readFileSync(file, "utf8");
  // idempotency: strip previous helper block + previous call-site insert
  let stripped = 0;
  for (;;) {
    const s = js.indexOf(MB_MARKER_START);
    if (s === -1) break;
    const e = js.indexOf(MB_MARKER_END, s);
    if (e === -1) throw new Error("badge helper start marker without end marker");
    js = js.slice(0, s) + js.slice(e + MB_MARKER_END.length);
    stripped++;
  }
  if (stripped > 0) console.log(`  ${label}: stripped ${stripped} previous badge helper block(s)`);
  // strip ANY previous call site line regardless of indentation
  js = js.replace(/^[ \t]*ocModelBadges\(i, _el\$\);[ \t]*\n?/gm, "");
  // The compiled ModelList row builder. Unique in the chunk: the row
  // template var is referenced exactly once, in the children function.
  const ANCHOR = "var _el$ = _tmpl$$E(), _el$2 = _el$.firstChild;";
  const anchorCount = js.split(ANCHOR).length - 1;
  if (anchorCount !== 1) {
    throw new Error(
      `${label}: model row anchor count drifted: ${anchorCount} (expected 1); ` +
        "bundle layout changed - re-derive the ModelList children anchor",
    );
  }
  const anchorIdx = js.indexOf(ANCHOR);
  const retIdx = js.indexOf("return _el$;", anchorIdx);
  if (retIdx === -1 || retIdx - anchorIdx > 4000) {
    throw new Error(`${label}: row builder return not found within expected distance; re-derive anchor`);
  }
  // PROBE: the helper must eval AND format context sizes correctly
  // (K/M boundaries are exactly where a bad formatter would silently lie).
  const probe = new Function(
    modelBadgeHelperBlock()
      .replace(/^[\s\S]*?\*\//, "") // strip leading comment for eval only
      .replace(MB_MARKER_END, "") +
      "\nreturn [typeof ocModelBadges, ocFmtCtx(200000), ocFmtCtx(1048576), ocFmtCtx(4194304), ocFmtCtx(4096), ocFmtCtx(undefined)];",
  );
  const [fnType, k200, m1, m4, k4, u] = probe();
  if (fnType !== "function") throw new Error("ocModelBadges did not evaluate to a function; refusing to write the bundle");
  const ok = k200 === "200K" && m1 === "1M" && m4 === "4.2M" && k4 === "4K" && u === null;
  if (!ok) {
    throw new Error(`ocFmtCtx unit probe failed: 200000=${k200} 1048576=${m1} 4194304=${m4} 4096=${k4} undefined=${u}; refusing to write`);
  }
  // insert the call INSIDE the row builder IIFE, right before its return
  // (retIdx is preceded by the builder's existing indentation)
  js = js.slice(0, retIdx) + "ocModelBadges(i, _el$);\n      " + js.slice(retIdx);
  js = modelBadgeHelperBlock() + "\n" + js;
  // pre-repack assertions: exactly one declaration, wired call present,
  // whole file still parses
  const decls = js.match(/function ocModelBadges\(/g);
  if (!decls || decls.length !== 1) {
    throw new Error(`expected exactly 1 ocModelBadges declaration, found ${decls ? decls.length : 0}`);
  }
  if ((js.match(/ocModelBadges\(i, _el\$\)/g) || []).length !== 1) {
    throw new Error("badge call site not wired exactly once");
  }
  const syntaxProbe = path.join(path.dirname(file), "syntax-check-mb.mjs");
  fs.writeFileSync(syntaxProbe, js);
  try {
    sh("node", ["--check", syntaxProbe]);
  } finally {
    fs.rmSync(syntaxProbe, { force: true });
  }
  fs.writeFileSync(file, js);
  console.log(`  ${label}: model row badges wired (context/image/cost); probe + assertions + node --check OK`);
}

function patchModelBadges(workdir) {
  const assets = path.join(workdir, "out", "renderer", "assets");
  // The session chunk holds the ModelList row template; find it by content.
  for (const f of fs.readdirSync(assets).filter((x) => x.endsWith(".js"))) {
    const p = path.join(assets, f);
    let has = false;
    try {
      has = fs.readFileSync(p, "utf8").includes("var _el$ = _tmpl$$E(), _el$2 = _el$.firstChild;");
    } catch (e) {
      console.log(`  skipping unreadable ${f}: ${e.message}`);
      continue;
    }
    if (has) {
      applyModelBadges(p, f); // throws propagate - never swallow patcher failures
      return;
    }
  }
  throw new Error("session chunk with ModelList row template not found; bundle layout changed");
}

/** v4: native "Plugins" application menu. Injected into the MAIN bundle at
 * the Menu.setApplicationMenu site. The wrapper clones the app's own
 * MenuItem constructor from a live item (no new imports needed; execFile,
 * spawnSync and dialog are already module-scope imports there), then appends
 * a "Plugins" submenu built from REGISTRY_FILE. Registry entry shapes:
 *   { "label": "...", "command": "shell command" }            action item
 *   { "label": "...", "command": "...", "stateFile": "..." }  checkbox, checked
 *                                                             iff file exists
 *   { "label": "...", "command": "...", "confirm": "msg" }    show an info
 *                                                             dialog after
 *                                                             running (e.g.
 *                                                             "restart to
 *                                                             apply")
 *   { "label": "...", "submenu": [ ...entries... ] }          nested submenu
 *   { "label": "...", "command": "...", "requireFile": "p" }  grayed out with
 *                                                             "(tool missing)"
 *                                                             when the file
 *                                                             does not exist
 *   { "separator": true }
 * Any plugin (or the user) can append entries; restart the app to reload. */
function pluginsMenuBlock() {
  return `${MENU_MARKER_START} (added by patches/patch-opencode-desktop-ui.mjs; safe to delete this block to undo) */
function ocLoadPluginsRegistry() {
  try {
    const raw = spawnSync("/bin/cat", [${JSON.stringify(REGISTRY_FILE)}]);
    if (raw.status !== 0) return [];
    const parsed = JSON.parse(String(raw.stdout));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}
function ocFileExists(p) {
  try {
    // via sh: /usr/bin/test is absent on some macOS installs; /bin/sh never is
    return spawnSync("/bin/sh", ["-c", "test -e \\\"$1\\\"", "oc", String(p)]).status === 0;
  } catch {
    return false;
  }
}
function ocMenuItems(entries, MI) {
  const out = [];
  for (const e of entries || []) {
    try {
      if (e && e.separator) {
        out.push(new MI({ type: "separator" }));
        continue;
      }
      if (!e || typeof e.label !== "string") continue;
      let label = String(e.label).slice(0, 90);
      let enabled = true;
      if (typeof e.requireFile === "string" && e.requireFile && !ocFileExists(e.requireFile)) {
        enabled = false;
        label = label + "  (tool missing)";
      }
      if (Array.isArray(e.submenu)) {
        const sub = ocMenuItems(e.submenu, MI);
        out.push(new MI({ label, enabled: sub.length > 0, submenu: sub }));
        continue;
      }
      if (typeof e.command !== "string" || !e.command) continue;
      const opts = {
        label,
        enabled,
        click: () => {
          try {
            execFile("/bin/zsh", ["-c", String(e.command).slice(0, 800)], {}, () => {});
          } catch {}
          if (typeof e.confirm === "string" && e.confirm) {
            try {
              dialog.showMessageBox({
                type: "info",
                title: "OpenCode",
                message: String(e.confirm).slice(0, 200),
                buttons: ["OK"],
              });
            } catch {}
          }
        },
      };
      if (typeof e.stateKey === "string" && e.stateKey) {
        opts.type = "checkbox";
        try {
          const parsed = JSON.parse(String(spawnSync("/bin/cat", [${JSON.stringify(STATE_FILE)}]).stdout));
          opts.checked = parsed[e.stateKey] === (e.stateValue === undefined ? true : e.stateValue);
        } catch {
          opts.checked = false;
        }
      } else if (typeof e.stateFile === "string" && e.stateFile) {
        opts.type = "checkbox";
        opts.checked = ocFileExists(e.stateFile);
      }
      out.push(new MI(opts));
    } catch {}
  }
  return out;
}
function ocWithPluginsMenu(menu) {
  try {
    if (!menu || !menu.items || menu.items.length === 0) return menu;
    if (menu.items.some((it) => it && it.label === "Plugins")) return menu;
    const MI = menu.items[0].constructor;
    const built = ocMenuItems(ocLoadPluginsRegistry(), MI);
    if (built.length > 0) menu.append(new MI({ label: "Plugins", submenu: built }));
  } catch {}
  return menu;
}
${MENU_MARKER_END}`;
}

/** v4: locate + patch the main bundle's menu build. Anchor-verified,
 * idempotent, syntax-checked; fails loud on drift. */
function applyPluginsMenu(file, label) {
  let js = fs.readFileSync(file, "utf8");
  let stripped = 0;
  for (;;) {
    const s = js.indexOf(MENU_MARKER_START);
    if (s === -1) break;
    const e = js.indexOf(MENU_MARKER_END, s);
    if (e === -1) throw new Error("menu helper start marker without end marker");
    js = js.slice(0, s) + js.slice(e + MENU_MARKER_END.length);
    stripped++;
  }
  if (stripped > 0) console.log(`  ${label}: stripped ${stripped} previous menu helper block(s)`);
  const ORIG = "Menu.setApplicationMenu(Menu.buildFromTemplate(template));";
  const WRAPPED = "Menu.setApplicationMenu(ocWithPluginsMenu(Menu.buildFromTemplate(template)));";
  while (js.includes(WRAPPED)) js = js.replace(WRAPPED, ORIG);
  const count = js.split(ORIG).length - 1;
  if (count !== 1) {
    throw new Error(
      `${label}: menu build anchor count drifted: ${count} (expected 1); re-derive the setApplicationMenu anchor`,
    );
  }
  js = pluginsMenuBlock() + "\n" + js;
  js = js.replace(ORIG, WRAPPED);
  // pre-repack assertions
  const decls = js.match(/function ocWithPluginsMenu\(/g);
  if (!decls || decls.length !== 1) {
    throw new Error(`expected exactly 1 ocWithPluginsMenu declaration, found ${decls ? decls.length : 0}`);
  }
  if ((js.match(/ocWithPluginsMenu\(Menu\.buildFromTemplate\(template\)\)/g) || []).length !== 1) {
    throw new Error("menu wrapper not wired exactly once");
  }
  const syntaxProbe = path.join(path.dirname(file), "syntax-check-menu.mjs");
  fs.writeFileSync(syntaxProbe, js);
  try {
    sh("node", ["--check", syntaxProbe]);
  } finally {
    fs.rmSync(syntaxProbe, { force: true });
  }
  fs.writeFileSync(file, js);
  console.log(`  ${label}: Plugins menu wired from ${REGISTRY_FILE}; assertions + node --check OK`);
}

function patchPluginsMenu(workdir) {
  const mainDir = path.join(workdir, "out", "main");
  if (!fs.existsSync(mainDir)) throw new Error("out/main not found in bundle");
  const files = fs
    .readdirSync(mainDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ f, size: fs.statSync(path.join(mainDir, f)).size }))
    .sort((a, b) => b.size - a.size);
  for (const { f } of files) {
    const p = path.join(mainDir, f);
    // match BOTH the stock line and the previously-wrapped form (idempotent
    // re-runs run on an already-patched bundle; applyPluginsMenu normalizes)
    const s = fs.readFileSync(p, "utf8");
    if (
      s.includes("Menu.setApplicationMenu(Menu.buildFromTemplate(template));") ||
      s.includes("ocWithPluginsMenu(Menu.buildFromTemplate(template))")
    ) {
      applyPluginsMenu(p, f);
      return;
    }
  }
  throw new Error("main bundle with setApplicationMenu anchor not found; app layout changed");
}

/** Seed the registry file once so the menu is populated out of the box.
 * Never overwrites user edits. Menu entries that invoke oc-ui reference it
 * NEXT TO THIS SCRIPT (self-locating), so the registry works from any
 * install location. Entries that depend on an external tool carry
 * requireFile, so they gray themselves out when the tool is absent. */
function seedRegistry() {
  if (fs.existsSync(REGISTRY_FILE)) return;
  const here = path.dirname(path.resolve(process.argv[1] || "."));
  const sq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const ocui = "sh " + sq(path.join(here, "oc-ui"));
  const home = process.env.HOME || "~";
  const plug = (p) => `${home}/.config/opencode/plugins/${p}`;
  const RESTART = "Applied. Quit OpenCode (Cmd+Q) and reopen to load it.";
  const seed = {
    $comment:
      "OpenCode Plugins menu registry. Any plugin can append items. Restart the app after registry edits. Entry shapes: {label, command}; {label, command, stateFile} checkbox; {label, command, confirm} info dialog after click; {label, submenu:[...]} nested; {label, command, requireFile} grayed when file missing; {separator:true}.",
    items: [
      {
        label: "Vision-guard: allow image reads (bypass)",
        command: "sh \"" + path.join(here, "state-toggle") + "\" visionGuardBypass",
        stateKey: "visionGuardBypass",
        requireFile: plug("vision-guard.ts"),
      },
      {
        label: "Model popover",
        submenu: [
          { label: "Small 20x28", command: `${ocui} preset s`, requireFile: path.join(here, "oc-ui"), confirm: RESTART },
          { label: "Medium 24x32", command: `${ocui} preset m`, requireFile: path.join(here, "oc-ui"), confirm: RESTART },
          { label: "Large 30x40", command: `${ocui} preset l`, requireFile: path.join(here, "oc-ui"), confirm: RESTART },
          { label: "X-Large 36x48", command: `${ocui} preset xl`, requireFile: path.join(here, "oc-ui"), confirm: RESTART },
        ],
      },
      { separator: true },
      {
        label: "Open backup folder",
        command: "open \"" + home + "/.local/share/opencode\"",
        requireFile: home + "/.local/share/opencode/opencode.db.trim-backup",
      },
      { label: "Open plugins folder", command: "open \"$HOME/.config/opencode/plugins\"" },
      { label: "Open patches folder", command: "open \"$HOME/.config/opencode/patches\"" },
    ],
  };
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(seed, null, 2) + "\n");
  console.log("seeded plugins-menu registry:", REGISTRY_FILE);
}

function patchTitleJs(workdir) {
  const assets = path.join(workdir, "out", "renderer", "assets");
  const all = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ f, size: fs.statSync(path.join(assets, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (all.length === 0) throw new Error("no js files found in renderer assets");
  // Main bundle: workspace session list (SessionRow) + session tabs.
  const mainFile = path.join(assets, all[0].f);
  let main = fs.readFileSync(mainFile, "utf8");
  if (!main.includes("text-14-regular text-text-strong min-w-0 flex-1 truncate")) {
    throw new Error(
      `${all[0].f} does not look like the session-list bundle (row span class missing); ` +
        "bundle layout changed - re-derive the anchor from a fresh bundle extract",
    );
  }
  applyTitleColor(mainFile, all[0].f, { minRowSites: 1, expectTabSite: true });
  // Home chunk (user-facing home session list + search result rows; found by
  // a past audit): same helper injected into ITS module scope.
  const home = all.filter((x) => /^home-.*\.js$/.test(x.f));
  if (home.length > 0) {
    applyTitleColor(path.join(assets, home[0].f), home[0].f, { minRowSites: 1, expectTabSite: false });
  }
}

function patchCss(workdir) {  const assets = path.join(workdir, "out", "renderer", "assets");
  const candidates = fs
    .readdirSync(assets)
    .filter((f) => /^main-.*\.css$/.test(f) || (f === "main.css" && !f.includes("-")));
  if (candidates.length === 0) {
    // Fall back to the largest css file in assets; the main bundle stylesheet
    // is by far the biggest (utilities live there).
    const all = fs
      .readdirSync(assets)
      .filter((f) => f.endsWith(".css"))
      .map((f) => ({ f, size: fs.statSync(path.join(assets, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (all.length === 0) throw new Error("no css files found in renderer assets");
    candidates.push(all[0].f);
    console.log(`main-*.css not found, using largest stylesheet: ${all[0].f} (${all[0].size} bytes)`);
  }
  const file = path.join(assets, candidates[0]);
  let css = fs.readFileSync(file, "utf8");
  // strip any previous patch block (idempotent / updatable)
  const start = css.indexOf(CSS_MARKER_START);
  if (start !== -1) {
    const end = css.indexOf(CSS_MARKER_END, start);
    if (end === -1) throw new Error("found patch start marker but no end marker");
    css = css.slice(0, start) + css.slice(end + CSS_MARKER_END.length);
    console.log("replacing previous patch block");
  }
  if (!css.includes(".h-80") || !css.includes(".truncate")) {
    throw new Error("stylesheet does not look like the main bundle (missing utilities)");
  }
  css = css.trimEnd() + "\n\n" + cssBlock() + "\n";
  fs.writeFileSync(file, css);
  console.log(`patched ${path.basename(file)} (${candidates[0]})`);
}

function main() {
  if (!fs.existsSync(ASAR)) throw new Error(`not found: ${ASAR}`);

  if (REVERT) {
    if (!fs.existsSync(BACKUP)) throw new Error(`no backup to revert to: ${BACKUP}`);
    fs.copyFileSync(BACKUP, ASAR);
    stampIntegrity();
    resign();
    console.log("reverted app.asar to pristine backup, integrity re-stamped, re-signed");
    return;
  }

  console.log(
    `UI config: popover ${POPOVER_WIDTH_REM}x${POPOVER_HEIGHT_REM}rem | badges: ctx=${BADGE_CONTEXT} img=${BADGE_IMAGE} cost=${BADGE_COST}` +
      ` (source: ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : "built-in defaults"} + CLI flags)`,
  );
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ui-patch-"));
  try {
    // Keep one pristine copy for --revert.
    if (!fs.existsSync(BACKUP)) {
      fs.copyFileSync(ASAR, BACKUP);
      console.log("saved pristine backup:", BACKUP);
    }
    extractAsar(workdir);
    patchCss(workdir);
    patchTitleJs(workdir);
    patchModelBadges(workdir);
    patchPluginsMenu(workdir);
    const packed = path.join(workdir, "app.asar.new");
    sh("npx", ["--yes", "@electron/asar", "pack", workdir, packed]);
    fs.copyFileSync(packed, ASAR);
    const hash = stampIntegrity();
    console.log("asar repacked; integrity hash:", hash.slice(0, 16) + "...");
    resign();
    try {
      seedRegistry();
    } catch (e) {
      console.warn("NOTE: patch is live, but seeding the plugins-menu registry failed:", e && e.message);
    }
    console.log("\nDone. Quit OpenCode (Cmd+Q) and reopen to load the patched UI.");
    console.log("NOTE: app auto-updates replace the bundle -> re-run this patch after updates.");
    console.log("Revert anytime with: node patch-opencode-desktop-ui.mjs --revert");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
