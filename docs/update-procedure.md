# OpenCode Update Runbook

How to update the OpenCode desktop app on a patched bundle without losing your
patches, your plugins, or a day to recovery. Born from a 1.16.2 -> 1.18.34
migration that cost a full day before this existed.

Tools referenced (all in this repo / the paired config dir):
`tools/oc-update-118` (checkzip/apply/verify/rollback), `tools/oc-post-update`
(all patchers fail-fast), `tools/verify-integrity.mjs`, `tools/oc-clear-cache`,
`tools/oc-asar-read.mjs` (anchor re-derivation), `tools/class-sweep.sh`.

> verification. Reference material: instructions/desktop-update-layer.md.
> Last full exercise: 2026-10-05 (1.16.2 -> 1.18.34 migration). Baselines below
> are as of that date - UPDATE THEM in phase 4.

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
      update-info.json. Mismatch = STOP.
- [ ] `tools/oc-update-118 apply` - staged swap, old bundle renamed aside
      (instant rollback), ElectronAsarIntegrity stamped by the patchers later.
- [ ] Failure here: read the error, `tools/oc-update-118 rollback`, investigate
      before retrying. Never apply twice blindly (double-apply happened once -
      the tool is now idempotent, but treat any surprise as a stop).

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

## Happy-path quick version (all green, no drift)
Cmd+Q -> `oc-update-118 checkzip` -> `oc-update-118 apply` ->
`oc-post-update` -> relaunch -> `oc-update-118 verify` -> `class-sweep.sh`
full -> eyeball menu -> update baselines. Six commands, five minutes.
