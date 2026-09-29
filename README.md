# opencode-plugins

A collection of self-contained [OpenCode](https://opencode.ai) plugins.
Single files, no dependencies, everything configurable through environment
variables, everything disable-able.

| Plugin | What it does | Platform | Needs |
|---|---|---|---|
| [vision-guard](#vision-guard) | Inspects every image read through a LOCAL vision model before it can reach a remote API; sensitive images are blocked | macOS (works elsewhere with raw-bytes inspection) | Ollama + a vision model |
| [image-shrink](#image-shrink) | Auto-downscales large images at send time so sessions stay small | macOS only (no-op elsewhere) | `sips` (built in) |
| [caffeinate](#caffeinate) | Keeps the Mac awake (system + display) while AI is processing | macOS only (no-op elsewhere) | `caffeinate` (built in) |
| [session-size](#session-size) | Tags every session title with its storage size: `428M · My Session` | Any (needs `sqlite3` CLI) | sqlite3 |
| [error-root-cause](#error-root-cause) | Real root cause of provider errors as a toast + local JSONL archive | Any | - |
| [session-guard](#session-guard) | Context-budget warnings + optional low-quality-window reminders | Any | - |
| [godot-gate-guard](#godot-gate-guard) | Mechanically blocks AI agents from launching hanging headless Godot runs | Any (Godot projects) | your gate wrapper |

## Install

Drop the files you want into a plugin directory and restart OpenCode:

- Global (all projects): `~/.config/opencode/plugins/`
- Per project: `.opencode/plugins/`

```sh
curl -fsSL -o ~/.config/opencode/plugins/vision-guard.ts \
  https://raw.githubusercontent.com/Qiueyed/opencode-plugins/main/vision-guard.ts
```

(Repeat per file.) Read the file first - plugins run with your permissions,
so know what you install. No npm packages yet; each file is meant to be
readable in one sitting before you trust it.

## Configuring (terminal AND desktop app)

Every option is env-first, but **desktop-app users usually cannot export
env vars before launch**. So every plugin ALSO reads a settings file:

```
~/.config/opencode/<plugin-name>.settings.json
```

e.g. `~/.config/opencode/vision-guard.settings.json`:

```json
{
  "OPENCODE_VISION_GUARD_POLICY": "fail-open",
  "OPENCODE_VISION_GUARD_MODEL": "qwen3-vl:8b"
}
```

Precedence: environment variable > settings file > built-in default.
vision-guard additionally re-reads its policy (and evaluates the bypass
marker) on every image read, so flipping `fail-open` in the settings file
works mid-session without a restart - exactly what you want when your local
Ollama or vision model dies unexpectedly.

## vision-guard

Every model read of an image file (`read` tool on image extensions) is
routed through a local vision model via Ollama first. A `sensitive` verdict
replaces the image with a notice file explaining the block, so the model can
tell you instead of retrying. The image itself never reaches the model
context and never leaves the machine.

- **Fail-closed by default**: if the local inspector is down, image reads
  are BLOCKED with a `guard-error` notice. This is intentional for a
  privacy guard.
- **No Ollama yet?** Every image read will be blocked. Either install
  Ollama + a vision model (`ollama pull qwen3-vl:8b`), set
  `OPENCODE_VISION_GUARD_POLICY=fail-open` (allow reads with a logged
  warning when the inspector is unreachable), or
  `OPENCODE_VISION_GUARD=allow` to disable the guard.

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_VISION_GUARD` | - | `allow` disables the guard |
| `OPENCODE_VISION_GUARD_URL` | `http://127.0.0.1:11434` | Ollama base URL |
| `OPENCODE_VISION_GUARD_MODEL` | `qwen3-vl:8b` | vision model tag |
| `OPENCODE_VISION_GUARD_POLICY` | `fail-closed` | `fail-open` allows reads when the inspector is down |
| `OPENCODE_VISION_GUARD_TIMEOUT_MS` | `90000` | inspection timeout |

Every decision (allow, block, cache hit, bypass) is appended to
`~/.local/share/opencode/vision-guard.log`. Verdicts are cached per
(file, size, mtime) for 10 minutes.

## image-shrink

At send time, replaces image parts larger than ~300KB with a downscaled
JPEG (max 1600px, quality 80). Never breaks a send: any failure keeps the
original. Honest limit: this cannot help with the composer holding full-res
base64 before you hit send - shrink huge batches before attaching.

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_IMAGE_SHRINK` | - | `off` disables |
| `OPENCODE_IMAGE_SHRINK_MAXDIM` | `1600` | max dimension in px |
| `OPENCODE_IMAGE_SHRINK_QUALITY` | `80` | JPEG quality |
| `OPENCODE_IMAGE_SHRINK_MIN_KB` | `300` | minimum size to bother with |

## caffeinate

Holds a `caffeinate -d -i` assertion while any session is processing and
releases it when all sessions go idle. Per-session tracking means one
subagent finishing cannot release the assertion while others still work.
Each assertion has a hard expiry as crash insurance, and the child is
killed on OpenCode exit.

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_CAFFEINATE` | - | `off` disables |

## session-size

Prepends each session's storage size to its title, refreshed every 10
minutes from a strictly read-only sqlite query (the plugin never writes to
the database). Makes multi-hundred-MB sessions visible before they slow
everything down.

**This rewrites your session titles.** A hand-written title starting with
something like `2G · ` would be re-tagged. Disable if that matters to you.

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_SESSION_SIZE` | - | `off` disables |
| `OPENCODE_SESSION_SIZE_INTERVAL_MS` | `600000` | refresh interval |
| `OPENCODE_SESSION_SIZE_DB` | auto | explicit db path |

## error-root-cause

Classifies provider errors (quota, auth, 429, context overflow, 5xx, TLS,
network, nested JSON bodies...) and toasts the actual root cause with a
hint, instead of a bare "server error". Every diagnosis is appended to
`~/.config/opencode/error-diagnosis.jsonl` (local only).

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_ERROR_LOG` | `~/.config/opencode/error-diagnosis.jsonl` | archive path |

## session-guard

Warns once per session as context usage crosses soft (150k) and hard (200k)
token lines, and can remind you about provider low-quality time windows.

| Env | Default | Meaning |
|---|---|---|
| `OPENCODE_SESSION_GUARD` | - | `off` disables |
| `OPENCODE_SESSION_GUARD_WARN` | `150000` | soft context limit |
| `OPENCODE_SESSION_GUARD_CRIT` | `200000` | hard context limit |
| `OPENCODE_SESSION_GUARD_WINDOWS` | none | UTC windows, e.g. `6-10,14-18` |
| `OPENCODE_SESSION_GUARD_WINDOW_THROTTLE` | `1800000` | min ms between window toasts |

## Safety notes

- No telemetry, no network calls except vision-guard's localhost Ollama
  requests. All archives/logs stay on your machine.
- session-size accesses the OpenCode database strictly read-only and writes
  titles only through the official SDK.
- Every plugin catches its own errors and degrades to a no-op rather than
  breaking your session; every one has an env kill-switch.
- All of them were extracted from daily personal use; they are plain-reading
  single files on purpose - read before you install.

## Related work

- [Qiueyed/opencode-desktop-patch](https://github.com/Qiueyed/opencode-desktop-patch) -
  idempotent UI patcher for the desktop app: model-picker sizing + row info
  badges, colored session titles (renders the session-size tags in color),
  and a registry-driven native Plugins menu


- [opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard) - text
  secret/PII redaction before LLM calls (complementary to vision-guard, which
  handles images)
- [opencode-vision-analyze](https://github.com/MwumLi/opencode-vision-analyze) - a
  tool for models to analyze images via your vision model (different goal:
  enabling, not gating)
- [opencode-models-discovery](https://github.com/yuhp/opencode-models-discovery) -
  auto-discovery of local Ollama/LM Studio models

## godot-gate-guard

For Godot projects developed with AI agents. Two classic hang classes,
made mechanically impossible instead of documented-and-hoped:

1. **Ungated headless runs**: a parse-dead script probe never reaches its
   `quit()` and the process sits forever. The guard blocks any bare
   `--headless` Godot launch, except standard one-shots
   (`--check-only`, `--import`, `--version`, `--help`, `--export-*`).
2. **Misplaced `--quit-after`**: engine args after Godot's ` -- ` separator
   are user args and get ignored - the boot never quits. Blocked in both
   headless and windowed runs.

Blocked commands are neutered by rewriting them into an echo of the reason
(the original never executes), so the agent reads WHY and reroutes through
your gate wrapper - typically a `tools/gate` script that launches Godot with
an instant kill on the first error line plus a wall-clock cap:

```sh
./tools/gate smoke-test 30 -- --headless --path . scenes/World.tscn
```

**Zero config**: any session started inside a project that contains
`tools/gate` is guarded automatically. Everything else is inert. The plugin
never fires outside guarded projects, and an explicit absolute `--path` to a
different project opts the command out.

| Env / settings key | Default | Meaning |
|---|---|---|
| `OPENCODE_GODOT_GATE` | - | `off` disables |
| `OPENCODE_GODOT_GATE_TOKENS` | none | extra project name/path fragments to guard |
| `OPENCODE_GODOT_GATE_WRAPPER` | `tools/gate` | command fragment treated as "gated" |
| `OPENCODE_GODOT_GATE_EXEMPT` | none | extra regex of bare-headless exemptions |

## License

MIT. Not affiliated with the OpenCode project.
