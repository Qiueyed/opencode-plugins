/**
 * caffeinate.ts
 *
 * Keeps macOS awake (system AND display) for the duration of AI processing.
 * Spawns `caffeinate -d -i` when any session turns busy/retry, kills it when
 * every tracked session is idle. Subagent sessions are tracked individually,
 * so one going idle cannot release the assertion while a parent still works.
 *
 * Runtime note: uses node:child_process, NOT Bun globals. The OpenCode
 * desktop app runs the core under Node where `Bun` is undefined; a Bun-based
 * version silently disables itself there. node:child_process works under
 * both runtimes. Flag note: `-i` alone does NOT stop the display from
 * sleeping; `-d` covers the screen.
 *
 * Lifecycle safety: each assertion carries a hard expiry (crash insurance,
 * ASSERT_WINDOW_S) and is refreshed once it ages past RESPAWN_AGE_S; a
 * process-exit handler kills the child when OpenCode quits. Off macOS or
 * without the caffeinate binary the plugin is a no-op with one warning.
 *
 * Install: drop into ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project), then restart OpenCode. macOS only.
 *
 * Config (env):
 *   OPENCODE_CAFFEINATE=off                disable the plugin
 */
import type { Plugin } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"

const ASSERT_WINDOW_S = 1800 // hard expiry per caffeinate run (crash insurance)
const RESPAWN_AGE_S = 900 // respawn the assertion if the running one is older than this
const TOAST_THROTTLE_MS = 10 * 60 * 1000 // min gap between "keeping awake" toasts

export const Caffeinate: Plugin = async ({ client }) => {
  const active = new Map<string, true>() // sessionID -> true, while busy/retry
  let proc: ChildProcess | null = null
  let spawnedAt = 0
  let available = process.platform === "darwin" && process.env.OPENCODE_CAFFEINATE !== "off"
  let lastToastAt = 0

  const log = async (level: "debug" | "info" | "error" | "warn", message: string) => {
    try {
      await client.app.log({ body: { service: "caffeinate", level, message } })
    } catch {}
  }

  // Visible confirmation that the assertion is actually held. A missing
  // toast is the signal that something disabled the plugin.
  const toast = async (message: string) => {
    try {
      await client.tui.showToast({ body: { title: "CAFFEINATE", message, variant: "info" } })
    } catch (e) {
      void log("warn", "toast failed: " + String(e instanceof Error && e.message ? e.message : e))
    }
  }

  // Returns the live subprocess (if any) so strict TS can narrow it.
  const running = () => {
    const p = proc
    return p !== null && p.exitCode === null && p.signalCode === null ? p : null
  }

  const assert = () => {
    if (!available) return
    const current = running()
    if (current) {
      if ((Date.now() - spawnedAt) / 1000 < RESPAWN_AGE_S) return
      try {
        current.kill()
      } catch {}
      proc = null
    }
    try {
      // -d: display sleep, -i: system idle sleep (both wanted during processing)
      const child = spawn("caffeinate", ["-d", "-i", "-t", String(ASSERT_WINDOW_S)], { stdio: "ignore" })
      child.on("error", (err) => {
        // ENOENT or spawn failure surfaces here asynchronously
        available = false
        proc = null
        void log("warn", "caffeinate spawn failed, sleep prevention disabled: " + String(err.message))
      })
      proc = child
      spawnedAt = Date.now()
      if (Date.now() - lastToastAt >= TOAST_THROTTLE_MS) {
        lastToastAt = Date.now()
        void toast("Keeping display + system awake while opencode processes.")
      }
    } catch (e) {
      proc = null
      void log("error", "failed to spawn caffeinate: " + String(e instanceof Error && e.message ? e.message : e))
    }
  }

  const release = () => {
    const current = running()
    if (current) {
      try {
        current.kill()
      } catch {}
    }
    proc = null
  }

  if (!available) {
    void log("warn", process.platform === "darwin" ? "disabled via OPENCODE_CAFFEINATE=off" : "not macOS; sleep prevention disabled")
    return {}
  }

  process.on("exit", () => {
    const current = running()
    if (current) {
      try {
        current.kill()
      } catch {}
    }
  })

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          const p = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
          if (!p || !p.sessionID || !p.status || typeof p.status.type !== "string") return
          if (p.status.type === "idle") {
            active.delete(p.sessionID)
            if (active.size === 0) release()
            return
          }
          // busy, retry, or any future non-idle state counts as processing
          active.set(p.sessionID, true)
          assert()
          return
        }
        if (event.type === "session.idle" || event.type === "session.error") {
          const p = event.properties as { sessionID?: string } | undefined
          const sid = p && p.sessionID
          if (sid) active.delete(sid)
          if (active.size === 0) release()
        }
      } catch (e) {
        void log("error", String(e instanceof Error && e.message ? e.message : e))
      }
    },
  }
}
