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
| 2 | Model-picker popover enlarges | stock 288x320 -> 384x512, configurable via `oc-ui` |
| 3 | Colored session titles | a leading size tag (`428M · Title`) renders red >= 300MB / amber >= 100MB / green; pairs with the session-size plugin, harmless without it |
| 4 | Model row info badges | context window (`200K`/`1M`), `IMG` when the model accepts image input, `$in/M` input price - right-aligned chips per row |
| 8 | **Image-capability default** | `patch-opencode-image-capability.mjs` flips the fallback capability literal (text-only) to image-capable, so models you define manually in opencode.jsonc - custom providers with no models.dev entry - are not pre-flight blocked from sending images. Catalog-backed models keep their real capabilities; audio/video/pdf stay gated; a truly non-vision model surfaces its own provider error instead. Finds the chunk by anchor (survives version bumps); shares the pristine backup and --revert with the other patches |
| 7 | **Edit-candidates** error enrichment | `patch-opencode-edit-candidates.mjs` upgrades the edit tool's two dead-end errors: "oldString not found" gains grouped closest lines/regions (`L2, L4, L6 (100% after trim ...); L9 (85%: preview)`), "multiple matches" gains candidate locations, and degenerate needles (single letters, whitespace) get told they are too short instead of a mass-replace hint; CRLF files are called out. Ships with a standalone test harness (`test-edit-candidates.mjs`, 12 assertions incl. adversarial inputs + perf sanity) |
| 6 | Session **Trim & clean** submenu | `patch-opencode-session-menu.mjs` adds one expandable entry to the session "..." menu: mild trim (keep count from the janitor settings), remove images, remove reads, hard trim last. Writes `⏳`-markers into session titles; the [janitor](../janitor/) consumes them at the next app close |
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
enabled), ad-hoc re-signs, and keeps one pristine
`app.asar.original.bak`. Every step fails loud on drift - a failed run
leaves your installed app untouched.

**Verified on OpenCode 1.16.2.** Anchors are version-specific on purpose:
if an app update changes the bundle, the script refuses and tells you -
it will never guess.

Re-apply after every app auto-update (updates replace the whole bundle).
Revert anytime:

```sh
node patch-opencode-desktop-ui.mjs --revert
```

## oc-ui: manual control

```sh
./oc-ui status              # current size/badges config
./oc-ui width 28            # popover width in rem
./oc-ui height 40           # popover height in rem
./oc-ui preset s|m|l|xl     # s=20x28 m=24x32 l=30x40 xl=36x48
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
