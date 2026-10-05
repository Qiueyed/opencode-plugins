# opencode-desktop-patch

Idempotent UI patches for the [OpenCode](https://opencode.ai) **desktop app**
(macOS). Single script, everything revertible, fails loud instead of
half-applying.

Part of the [Qiueyed/opencode-plugins](https://github.com/Qiueyed/opencode-plugins)
cluster: the colored session titles render the session-size plugin's size
tags, and the Plugins menu is the control surface for the whole plugin set.

## What it changes

| # | Feature | Detail |
|---|---|---|
| 1 | Model-picker rows stop clipping | name spans shrink -> real ellipsis, badges stay visible |
| 2 | Model-picker sized (config-driven) | the 1.18.34 composer picker is the `ModelSelectorPopoverV2View` MenuV2 dropdown - width is config-driven (`.oc-model-menu`; default 40rem, **Stock 284px** removes the override entirely), changed live from the Plugins menu's **Model menu size** radio presets or `./oc-ui menuwidth <rem|stock>`; the old 20x28..36x48 popover presets targeted a dead container on 1.18.34 and were retired. The three other model-picker containers in the bundle are dead code in this flow and stay patched harmlessly |
| 3 | Colored session titles | a leading size tag (`428M · Title`) renders red >= 300MB / amber >= 100MB / green; pairs with the session-size plugin, harmless without it |
| 4 | Model row info badges | context window (`200K`/`1M`), `IMG` when the model accepts image input, `$in/M` input price - wired into BOTH the ModelList rows and the picker menu rows; toggled from the Plugins menu as checkbox entries (`tools/badge-toggle` is the CLI backend). Ollama models show no chips: the provider reports no context/cost metadata |
| 8 | **Image-capability default** | `patch-opencode-image-capability.mjs` flips the fallback capability literal (text-only) to image-capable, so models you define manually in opencode.jsonc - custom providers with no models.dev entry - are not pre-flight blocked from sending images. Catalog-backed models keep their real capabilities; audio/video/pdf stay gated; a truly non-vision model surfaces its own provider error instead. Finds the chunk by anchor (survives version bumps); shares the pristine backup and --revert with the other patches |
| 7 | **Edit-candidates** error enrichment | `patch-opencode-edit-candidates.mjs` upgrades the edit tool's two dead-end errors: "oldString not found" gains grouped closest lines/regions (`L2, L4, L6 (100% after trim ...); L9 (85%: preview)`), "multiple matches" gains candidate locations, and degenerate needles (single letters, whitespace) get told they are too short instead of a mass-replace hint; CRLF files are called out. Ships with a standalone test harness (`test-edit-candidates.mjs`, 12 assertions incl. adversarial inputs + perf sanity) |
| 6 | Session **Trim & clean** menu items | `patch-opencode-session-menu.mjs` adds flat items to the session title menu - Trim mild (keep count from the janitor settings), Remove images, Remove reads, Trim hard (last 5) - in BOTH title-menu variants (MenuV2 has no submenu support, so no expandable entry; menu width raised 120->210px so labels don't wrap). Writes `⏳`-markers via each scope's own mutation; the [janitor](../janitor/) consumes them at the next app close |
| 5 | Native **Plugins** menu | a new application menu built from a JSON registry: any plugin or user can add toggle/action items (checkboxes backed by marker files) |

## Install

macOS + Node.js required (`npx` fetches `@electron/asar` on first run).
OpenCode must be installed at `/Applications/OpenCode.app` (override with
`OPENCODE_APP_PATH`).

```sh
git clone https://github.com/Qiueyed/opencode-plugins
cd opencode-plugins/desktop-patch
node patch-opencode-desktop-ui.mjs
```

Then quit OpenCode (Cmd+Q) and reopen.

The script: extracts `app.asar`, applies marker-delimited patches with
anchor verification + runtime probes + a full-file syntax check, repacks,
updates the `ElectronAsarIntegrity` hash in Info.plist (integrity stays
enabled), re-signs with the stable `OpenCode Local Notifier` identity
(ad-hoc resigns break the keychain ACL for "OpenCode Safe Storage" and
cause a repeat password prompt on every run), publishes the patched
stylesheet under a content-hashed name (`main-oc-<sha256[:10]>.css` + an
index.html href rewrite - the app's `oc://` protocol caches same-named
assets, so in-place CSS edits stay invisible without the bust), and keeps
one pristine `app.asar.original.bak`. Every step fails loud on drift - a
failed run leaves your installed app untouched.

**Verified on OpenCode 1.18.34** (ports survive from 1.16.2 via anchored
patches). Anchors are version-specific on purpose:
if an app update changes the bundle, the script refuses and tells you -
it will never guess.

Re-apply after every app update (updates replace the whole bundle). Note:
on a patched bundle the in-app "Restart now" update button can silently
fail (the download sits in the updater's pending cache); the manual path
is [tools/oc-update-118](../tools/oc-update-118) then
[tools/oc-post-update](../tools/oc-post-update), which runs all four
patchers fail-fast in one command. Revert anytime:

```sh
node patch-opencode-desktop-ui.mjs --revert
```

## oc-ui: manual control

```sh
./oc-ui status              # current size/badges config
./oc-ui width 28            # popover width in rem (legacy - dead container on 1.18.34)
./oc-ui height 40           # popover height in rem (legacy)
./oc-ui size <W> <H>        # both (legacy)
./oc-ui preset s|m|l|xl     # legacy popover presets (dead on 1.18.34)
./oc-ui menuwidth <rem>     # the LIVE model dropdown width (default 40)
./oc-ui badge img off       # toggle row badges: ctx | img | cost
./oc-ui revert              # pristine app
```

Each change re-runs the idempotent patcher and drops a macOS notification
reminding you to restart OpenCode (the CSS ships inside the signed bundle,
so a restart is always part of applying a size). Config persists in
`~/.config/opencode/state/ui-patch.json`; CLI flags `--popover-w/--popover-h/
--badge-ctx/--badge-img/--badge-cost` override it per run.

## The Plugins menu (registry)

After patching, the app has a **Plugins** menu populated from
`~/.config/opencode/plugins-menu.json` (seeded on first run; restart the
app after editing). Entry shapes:

```jsonc
{
  "items": [
    // action item: runs the shell command
    { "label": "Do a thing", "command": "your-command --here" },
    // checkbox: checked iff the file exists; click runs the command
    { "label": "Some bypass", "command": "touch-or-rm marker", "stateFile": "/path/to/marker" },
    // info dialog after the command (e.g. restart reminders)
    { "label": "Popover: Large", "command": "./oc-ui preset l", "confirm": "Applied. Restart OpenCode to load it." },
    // grayed out with "(tool missing)" when the file does not exist
    { "label": "Trim sessions", "command": "./trim --keep 15", "requireFile": "/path/to/trim" },
    // radio group: checked iff the value file's content equals "value";
    // contiguous radio entries auto-group, so a click moves the check natively
    { "label": "Medium 40rem (default)", "command": "./oc-ui menuwidth 40", "stateValueFile": "~/.config/opencode/state/ui-menuwidth.txt", "value": "40" },
    // expandable submenu (recursive)
    { "label": "More", "submenu": [ { "label": "Child", "command": "..." } ] },
    { "separator": true }
  ]
}
```

Any plugin can ship a README snippet telling users what to paste here - no
plugin code changes required. Commands run via `/bin/zsh` with your
privileges when clicked, so only add entries you understand.

## Honest limits

- Registry edits need an app restart to appear (the menu builds at launch).
- Size changes need a restart (CSS lives in the signed bundle).
- The colored-titles and badges features degrade gracefully on builds where
  their anchors are missing - the script fails loud instead.
- Patching a signed app is a local modification for personal use. Keep the
  pristine backup; use `--revert` before support requests. Not affiliated
  with the OpenCode project.

## License

MIT.
