/**
 * janitor.ts
 *
 * Auto-discovered global plugin (~/.config/opencode/plugins/).
 *
 * Purpose: keep the opencode database from strangling the app. Policy:
 * VACUUM ONLY - no automatic session deletes. Spawns tools/janitor.sh as a
 * DETACHED process, so the sweep + VACUUM run after the app has fully
 * exited, on an uncontended db: running VACUUM inside the live app would
 * lock it and slow startup.
 *
 * Mechanics: the plugin spawns tools/janitor.sh as a DETACHED process at
 * PLUGIN LOAD, i.e. once per app startup, and the script itself waits for
 * every OpenCode.app process to disappear before sweeping + vacuuming.
 * Rationale: relying on the sidecar's exit handlers failed twice in
 * practice - desktop quits can kill the sidecar without running "exit"
 * handlers, and crash exits never run them at all. Startup-arming closes
 * both:
 * every app session arms a watcher for its own death. The script's mkdir lock
 * (24h stale reclaim) keeps exactly one watcher across windows/reloads, and
 * the watcher loop is a silent 30s poll that costs nothing for days.
 *
 * Crash behavior: a crashed app obviously never vacuums while dying, but the
 * watcher armed at that session's STARTUP is still alive (detached, waiting
 * for processes to vanish) - the moment the crash kills the last OpenCode
 * process, the sweep + VACUUM run. The script sweeps only orphaned rows
 * (event streams whose session is already deleted - the UI delete path has no
 * FK from event_sequence to session) and VACUUMs only when >= 10% of db pages
 * are free. Details + log: tools/janitor.sh.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"

const SCRIPT = homedir() + "/.config/opencode/tools/janitor.sh"
const MODELS_CACHE_PATCH = homedir() + "/.config/opencode/patches/patch-models-cache.mjs"

// One exit listener PER PROCESS, not per plugin instance: the desktop app
// instantiates each plugin once per window (multiple instances observed) inside the
// same sidecar process, and per-instance process.on("exit") stacking can
// push the sidecar past 10 exit listeners (MaxListenersExceededWarning
// observed in the wild, contributed to by this plugin + caffeinate).
// globalThis guard survives module re-evaluation; the script's own mkdir lock
// still collapses any double-spawn.
const ARMED = Symbol.for("opencode.janitor.armed")
const MODELS_PATCH_BOOT = Symbol.for("opencode.janitor.models-patch-boot")

export const Janitor: Plugin = async () => {
  if (!existsSync(SCRIPT)) return {}

  const g = globalThis as Record<symbol, boolean>
  const armed = () => {
    if (g[ARMED]) return
    g[ARMED] = true
    try {
      const child = spawn(SCRIPT, [], { detached: true, stdio: "ignore" })
      child.unref()
      child.on("error", () => {})
    } catch {}
  }
  // Arm at load: every app startup (re)arms the watcher. No exit-handler
  // dependency - see the mechanics note above for why that failed twice.
  armed()

  // Boot-time models-cache re-apply (OPTIONAL, self-skips when the patch
  // file is absent): the app refreshes
  // ~/.cache/opencode/models.json shortly after launch, wiping local edits
  // (e.g. image-input flags for config-defined models the catalog wrongly
  // lists as text-only - see patches/patch-models-cache.mjs). The janitor
  // script re-applies at app CLOSE, but a boot wipe would leave the FIRST
  // session after every boot unprotected. This re-applies 45s into the
  // session -
  // after the startup refresh has landed - so every session is covered
  // without any daemon. Idempotent script; silent; failures fall back to the
  // close-time re-apply.
  const modelsPatch = () => {
    if (g[MODELS_PATCH_BOOT] || !existsSync(MODELS_CACHE_PATCH)) return
    g[MODELS_PATCH_BOOT] = true
    setTimeout(() => {
      try {
        const child = spawn("node", [MODELS_CACHE_PATCH, "--quiet"], {
          detached: true,
          stdio: "ignore",
        })
        child.unref()
        child.on("error", () => {})
      } catch {}
    }, 45_000).unref()
  }
  modelsPatch()

  return {}
}

export default Janitor
