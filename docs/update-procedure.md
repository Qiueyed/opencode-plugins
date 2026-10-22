# OpenCode Update Runbook

How to update the OpenCode desktop app on a patched bundle without losing your
patches, your plugins, or a day to recovery. Born from a 1.16.2 -> 1.18.34
migration that cost a full day, hardened by a 2026-10-21 blocked-update
episode (version-guard refusal + misread bug attribution - see rule 7 and the
Troubleshooting section).

Tools referenced (all in this repo / the paired config dir):
`tools/oc-update-118` (checkzip/apply/verify/rollback), `tools/oc-post-update`
(all patchers fail-fast), `tools/verify-integrity.mjs`, `tools/oc-clear-cache`,
`tools/oc-asar-read.mjs` (anchor re-derivation), `tools/class-sweep.sh`.

> verification. Reference material: instructions/desktop-update-layer.md.
> Last full exercise: 2026-10-05 (1.16.2 -> 1.18.34 migration); blocker class
> recorded 2026-10-21 (version-guard refusal, see rule 7 + Troubleshooting).
> Baselines below are as of 2026-10-05 - UPDATE THEM in phase 4.

## The rules (read once, obey always)
1. NEVER use the in-app "Restart now" on a patched bundle - it silently fails;
   the download just sits in the updater's pending cache.
2. NEVER kill or force-quit the app. Real quit = Cmd+Q. Closing the last window
   is NOT quitting (1.18 behavior) - window-close "restarts" are the
   ghost-patches trap.
3. A patcher that refuses (anchor drift) means PORT THE PATCHER. Never force,
   never widen an anchor match. Re-derivation: extract the fresh bundle
   (`npx --yes @electron/asar extract`), `tools/oc-asar-read.mjs` for static
   anchors; renderer-time truth ONLY via DevTools class-chain canary
   (static analysis alone produced three wrong model-picker targets once).
4. Signing: stable `OpenCode Local Notifier` identity only. Ad-hoc resigns
   break the keychain ACL ("OpenCode Safe Storage" repeat-prompt loop).
5. DB migrations moved = bundle rollback is no longer sufficient. Capture the
   migration count BEFORE and AFTER; if it changed, keep the DB backup until
   several stable days pass.
6. No rm of backups without explicit user approval. Old bundles/DB backups
   wait out a few stable days first.
7. `checkzip` refusing the pending version is a TOOL bug, not an obstacle to
   bypass: the updater tool is part of the update surface and must accept any
   version the official updater downloaded (guard only against no-ops:
   zip version == installed version). 2026-10-21: a hardcoded
   EXPECTED_VERSION left over from the 1.18.34 migration silently blocked
   1.19.3 for the user - "doesn't seem to be updating" with no error shown.
   Fix the guard, never force the apply.

## Phase 0 - PRE-FLIGHT (app still running is fine)
- [ ] Baseline: `oc-update-118 verify` - record version, DB migrations
      (baseline 21 @ 1.18.34), sessions count, notifier version (0.4.0).
- [ ] Safety net: `plugins.bak-<ver>/` + `opencode.jsonc.bak-<ver>/` copies of
      ~/.config/opencode/plugins + opencode.jsonc; DB snapshot
      (~/.local/share/opencode/opencode.db.pre-<ver>-backup). The old app
      bundle is preserved automatically by `apply` (rename, instant rollback).
- [ ] Config repo clean + pushed (github.com/Qiueyed/opencode-plugins):
      `git -C ~/Documents/github/opencode-plugins status` - patchers/tools must
      be committed so a bad session can be diffed against truth.
- [ ] `GATE_FAST=1 tools/class-sweep.sh` ALL CLEAN (pre-update sanity).
- [ ] Let the in-app updater DOWNLOAD if it wants (download is safe; only
      "Restart now" is dangerous).

## Phase 1 - APPLY (app FULLY quit via Cmd+Q; run from plain Terminal, not opencode)
- [ ] `pgrep` guard runs inside the tool, but eyeball: app is not running.
- [ ] `tools/oc-update-118 checkzip` - sha512 + bundled version vs
      update-info.json. Mismatch = STOP. A VERSION refusal = rule 7 (fix the
      tool's guard; it must compare zip vs INSTALLED version, aborting only
      no-ops).
- [ ] `tools/oc-update-118 apply` - staged swap, old bundle renamed aside
      (instant rollback), ElectronAsarIntegrity stamped by the patchers later.
- [ ] Failure here: read the error, `tools/oc-update-118 rollback`, investigate
      before retrying. Never apply twice blindly (double-apply happened once -
      the tool is now idempotent, but treat any surprise as a stop).
- [ ] Before ANY rollback: check what you would roll back TO -
      `ls -dt /Applications/OpenCode.app.*-bak` (rollback restores the
      mtime-newest backup; with multiple baks accumulated, confirm it is the
      version you expect, not one from two migrations ago).

## Phase 2 - RE-PATCH (app still quit)
- [ ] `tools/oc-post-update` - runs desktop-ui, session-menu, edit-candidates,
      image-capability fail-fast. Stable signing throughout.
- [ ] Any patcher refuses: anchor drift. Re-derive (see rule 3), port the
      patcher in ~/Documents/github/opencode-plugins/desktop-patch/ (the repo
      copy is the SOURCE OF TRUTH, then cp to ~/.config/opencode/patches/),
      commit the port, re-run oc-post-update.
- [ ] `node tools/verify-integrity.mjs` - asar hash == Info.plist stamp.

## Phase 3 - VERIFY (relaunch first)
- [ ] `tools/oc-update-118 verify` - compare against the Phase 0 baseline:
      migrations moved? plugin log lines with ERROR (API compat)? notifier
      version drift?
- [ ] Plugin API compat: if any local plugin errors at boot, port it against
      the new SDK (today's canaries: notify's `client.tui.showToast` payload
      shape, gate idle hooks, vision-guard interception).
- [ ] `tools/class-sweep.sh` FULL run - marker pairing in the SHIPPED bundle
      must pass (patches landed paired); GATE_FAST acceptable only if nothing
      in the bundle changed after the last full run.
- [ ] Eyeball: Plugins menubar menu complete (radio ticks present), model row
      badge chips, flat Trim & clean items in session-title menus.
- [ ] Ghost-busting if patched UI is stale: app CLOSED, `tools/oc-clear-cache`,
      relaunch (oc:// cache fallback; patchCss cache-bust normally prevents).
- [ ] Native banners silent after re-sign: System Settings > Notifications >
      OpenCode OFF then ON; probe with agent-idle (NOT question.asked).

## Phase 4 - CLOSE
- [ ] Update baselines HERE (version, migrations, patcher versions) and in
      instructions/desktop-update-layer.md (Environment Snapshot).
- [ ] STATUS.md + WORKLOG entry; push repo if tooling/docs changed.
- [ ] Backups (old bundle, DB, plugins.bak) stay until several stable days
      pass, then deletion ONLY with explicit user approval of the exact list.

## Troubleshooting: "it didn't update" / bugs during an update window
Triage BEFORE blaming (or trusting) the update - three planes, check each:
1. **Did anything actually apply?** `ls -la /Applications/OpenCode.app/Contents/Resources/app.asar` (mtime),
   `defaults read /Applications/OpenCode.app/Contents/Info.plist CFBundleShortVersionString`,
   `node tools/verify-integrity.mjs`. Untouched asar mtime + old version +
   MATCH = NOTHING was applied - the "update" never happened, so nothing is
   its fault. (2026-10-21: renderer fetch errors looked update-caused; the
   bundle was untouched - the real blocker was checkzip refusing the version.)
2. **Which plane is the error in?** Renderer-only stacks (`oc://renderer/assets/main-*.js`,
   DevTools console) do NOT appear in the server log -
   `~/.local/share/opencode/log/opencode.log` is the server plane. Session
   message loading failures pair with `process session ... ERROR` server
   lines; fetch failures inside a running renderer usually mean the internal
   API/serving layer, not the network.
3. **Date the errors.** `grep` the log for the error class and look at
   timestamps: errors predating the update attempt are pre-existing bugs
   (candidate for upstream fix in the NEW version - note them, update, then
   re-check; only debug on the new bundle if they survive).
Also: "another set of logs downloaded" = the in-app updater re-downloading to
`~/Library/Caches/@opencode-aidesktop-updater/pending/` - downloads are safe;
only "Restart now" is dangerous on a patched bundle (rule 1).
Anchor PRE-FLIGHTS must scan the WHOLE extracted tree (`grep -rlF` across
`out/`), never a single chunk: 2026-10-22 false forecast - edit-candidates
and image-capability were declared "drifted" because the checker greped only
the renderer chunk, while 1.19.3 had moved that code to
`out/main/chunks/node-*.js`; the patchers (which scan all chunks) had already
applied cleanly. A one-file grep answers "is it here", never "is it gone".

## Happy-path quick version (all green, no drift)
Cmd+Q -> `oc-update-118 checkzip` -> `oc-update-118 apply` ->
`oc-post-update` -> relaunch -> `oc-update-118 verify` -> `class-sweep.sh`
full -> eyeball menu -> update baselines. Six commands, five minutes.
