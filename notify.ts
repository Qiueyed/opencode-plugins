/**
 * notify.ts
 *
 * Auto-discovered global plugin (~/.config/opencode/plugins/).
 *
 * Companion to the community plugin `@mohak34/opencode-notifier`, which owns
 * event notifications/sounds (complete, error, question, ...). This file
 * covers only what it does not:
 *
 *   Provider peak-rate windows: one banner when a time-based pricing
 *   window begins (see PEAK_PROVIDERS).
 *   Permission auto-grant (OPT-IN, default OFF): the documented
 *   `permission.ask` plugin hook is not wired in desktop builds (no
 *   plugin.trigger("permission.ask") anywhere in app.asar), so instead
 *   the `event` hook listens for `permission.asked` bus events and
 *   auto-replies "once" via the session permissions API - the same
 *   call the desktop's own auto-accept uses. DANGEROUS BY DESIGN: it
 *   approves every ask that reaches it. Enable ONLY by creating
 *   ~/.config/opencode/state/notify-autogrant.on. Config-level denies
 *   (sudo, rm -rf /*) short-circuit in the core permission service
 *   BEFORE any ask is published, so guardrails and per-agent denies
 *   still win over this.
 *   note: notifier >= 0.3.0 waits 300ms after permission.asked and only
 *   alerts if the ask is still pending, so auto-approved asks stay
 *   silent; sounds.permission fires only if an ask gets stuck.
 *
 *   Subagent noise needs no custom code: @mohak34/opencode-notifier
 *   ships subagent_complete and user_cancelled with sound+notification
 *   off by default.
 *
 * Peak table (PEAK_PROVIDERS): one entry per provider with a time-based
 * usage window. A provider notifies only if the user actually has it: an
 * authKeys substring must match a key in ~/.local/share/opencode/auth.json
 * (unreadable auth.json fails open). GLM coding plan: Beijing weekdays
 * 14:00-18:00 = UTC weekdays 06:00-10:00 year-round, expressed in UTC so
 * local DST cannot shift the window; off-peak is ~0.5x. Add future
 * providers ONLY with VERIFIED window hours - most coding plans publish
 * no time-of-day schedule at all.
 * Toggle: a kill-switch marker file (peak-banner.off) is checked per poll,
 * so the banner can be disabled live; wire it to a menu checkbox.
 *
 * Delivery: osascript, but TARGETED at the OpenCode bundle when it runs so
 * banners show OpenCode's name/icon instead of "Script Editor"; targeting a
 * closed app would auto-launch it, hence the guard + plain fallback. Focus /
 * Do-Not-Disturb suppress banners. Polls every PEAK_CHECK_MS; the UTC date
 * string keys the window (it never crosses a UTC day boundary, so one
 * notification per occurrence). The window is also checked once at startup,
 * so launching inside peak hours still alerts once.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { spawn, execFile } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"

const PEAK_CHECK_MS = 60_000 // how often to poll for window entry
const DBG_LOG = "/tmp/opencode-permission-hook.log" // failure-only: auto-grant reply errors, so a silent regression stays diagnosable
// Peak-window table: one entry per provider with a time-based usage window.
// A provider notifies only when the user actually has it: any `authKeys`
// substring matches a key in ~/.local/share/opencode/auth.json (unreadable
// auth.json fails open). Add future providers ONLY with verified window
// hours - most coding plans publish no time-of-day schedule.
type PeakProvider = {
  id: string
  label: string
  authKeys: string[]
  days: [number, number] // UTC weekday range, 0=Sun
  startH: number // UTC hour, inclusive
  endH: number // UTC hour, exclusive
  sound: string
  msg: string
}
const PEAK_PROVIDERS: PeakProvider[] = [
  {
    id: "glm",
    label: "GLM coding plan",
    authKeys: ["glm", "zhipuai-coding-plan"],
    days: [1, 5],
    startH: 6,
    endH: 10,
    sound: "Tink",
    msg: "GLM peak rate (~3x) until 18:00 Beijing / 10:00 UTC. Off-peak is ~0.5x; heavy jobs can wait.",
  },
]
const AUTH_JSON = homedir() + "/.local/share/opencode/auth.json"
// Kill switch: file present = peak banners disabled. Checked per poll, so
// the toggle is live without a restart (wire it to a menu checkbox).
const PEAK_OFF_MARKER = homedir() + "/.config/opencode/state/peak-banner.off"
// Cross-instance claim files: the desktop app instantiates the plugin once
// per project/window (several instances observed), each firing its own
// peak banner at window open. Per provider: the first instance to atomically
// create `<PEAK_KEY_FILE>-<id>` with today's UTC key wins; every other
// instance (including ones spawned later in the day) sees the file and stays
// quiet.
const PEAK_KEY_FILE = homedir() + "/.config/opencode/state/.peak-banner-day"
// Opt-in marker for the permission auto-grant: file present = ON. Default is
// OFF because this approves every ask. Local installs that want it create the
// marker; the desktop toggle contract is a menu checkbox writing this file.
const AUTOGRANT_ON = homedir() + "/.config/opencode/state/notify-autogrant.on"

// Resting-user gate: if there has been no keyboard/mouse input for this
// long, the user is away or asleep -> suppress the peak banner (and its
// sound). The key is NOT consumed on suppression, so the banner still
// fires later the same day if they return while the window is open.
// Rationale: peak windows can open at night; the machine may be awake
// (caffeinate.ts keeps it up during processing) but the user asleep -
// "computer awake" cannot be the gate, user presence (HID idle) is.
const IDLE_SUPPRESS_S = 10 * 60

const dbg = (line: string) => {
  try {
    appendFileSync(DBG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/** True when the user has the provider (auth.json key match; fail open). */
const userHasProvider = (p: PeakProvider): boolean => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(AUTH_JSON, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return true
    const keys = Object.keys(parsed).map((k) => k.toLowerCase())
    return p.authKeys.some((needle) =>
      keys.some((key) => key.includes(needle.toLowerCase())),
    )
  } catch {
    return true
  }
}

/**
 * Atomically claim today's banner for one provider. True = caller notifies.
 * Cross-instance safe: an empty existing file means another instance is
 * mid-write (create lands before its content) and is NEVER unlinked - we
 * just stay quiet, since the goal is at-most-one banner. Only a readable,
 * different (stale-day) key may be reclaimed.
 */
const consumeClaim = (file: string, key: string): boolean => {
  const create = (): number | null => {
    try {
      return openSync(file, "wx")
    } catch {
      return null
    }
  }
  let fd = create()
  if (fd === null) {
    let cur = ""
    try {
      cur = readFileSync(file, "utf8").trim()
    } catch {
      return false // vanished between EEXIST and read: treat as claimed
    }
    if (cur === key || cur === "") return false
    try {
      unlinkSync(file)
    } catch {
      return false // another instance reclaimed it first
    }
    fd = create()
    if (fd === null) return false
  }
  try {
    writeSync(fd, key)
    closeSync(fd)
    return true
  } catch {
    try {
      closeSync(fd)
    } catch {}
    return false
  }
}

/** Seconds since last human input (keyboard/mouse), or null if unknown. */
const hidIdleSeconds = (): Promise<number | null> =>
  new Promise((resolve) => {
    try {
      execFile("ioreg", ["-c", "IOHIDSystem", "-w", "0"], (err, stdout) => {
        if (err) return resolve(null) // fail open: notify as before
        const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout))
        resolve(m ? Number(m[1]) / 1e9 : null)
      })
    } catch {
      resolve(null)
    }
  })

export const Notify: Plugin = async ({ client, project, directory }) => {
  if (process.platform !== "darwin") return {}

  const scope =
    (project?.worktree || directory || "opencode").split("/").filter(Boolean).pop() || "opencode"

  // Targeted delivery: attribute banners to OpenCode (name/icon) instead of
  // "Script Editor" - but ONLY while the desktop app is running, because
  // AppleScript-targeting a closed app LAUNCHES it. Plain osascript fallback
  // otherwise. The desktop app runs this plugin itself, but the CLI does not.
  const notify = (subtitle: string, message: string, sound: string) => {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    const base =
      'display notification "' + esc(message) + '" with title "opencode: ' + esc(scope) +
      '" subtitle "' + esc(subtitle) + '" sound name "' + sound + '"'
    const run = (script: string) => {
      try {
        const child = spawn("osascript", ["-e", script], { stdio: "ignore" })
        child.unref()
        child.on("error", () => {})
      } catch {}
    }
    execFile("/usr/bin/pgrep", ["-qf", "OpenCode.app"], (err) => {
      if (!err) run('tell application id "ai.opencode.desktop" to ' + base)
      else run(base)
    })
  }

  const lastPeakKey: Record<string, string> = {}
  // Occurrence key: for midnight-crossing windows the late-night hours
  // belong to the PREVIOUS day's occurrence, so the key rolls at window
  // start, not at 00:00 UTC - prevents a second banner for one occurrence.
  const windowKey = (p: PeakProvider) => {
    const d = new Date()
    if (p.startH > p.endH && d.getUTCHours() < p.endH) {
      d.setUTCDate(d.getUTCDate() - 1)
    }
    return d.toISOString().slice(0, 10)
  }
  const inWindow = (p: PeakProvider) => {
    const d = new Date()
    const day = d.getUTCDay()
    const h = d.getUTCHours()
    // Midnight-crossing windows (e.g. 22-02) use OR; `days` then matches the
    // pre-midnight day only. Equal startH/endH means a full-day window.
    // GLM's window stays well inside one UTC day.
    const inHours =
      p.startH === p.endH ? true : p.startH < p.endH ? h >= p.startH && h < p.endH : h >= p.startH || h < p.endH
    // Wrap-around day ranges (e.g. Sat-Mon as [6,1]) match across the week end.
    const inDays = p.days[0] <= p.days[1] ? day >= p.days[0] && day <= p.days[1] : day >= p.days[0] || day <= p.days[1]
    return inDays && inHours
  }
  // Presence is resolved once at plugin init; adding a provider to auth.json
  // takes effect at the next app restart.
  const activeProviders = PEAK_PROVIDERS.filter(userHasProvider)
  const peakCheck = async () => {
    if (existsSync(PEAK_OFF_MARKER)) return
    for (const p of activeProviders) {
      if (!inWindow(p)) continue
      const key = windowKey(p)
      if (lastPeakKey[p.id] === key) continue
      // Suppress while the user is away/resting; do not consume either key so
      // the banner can still fire when they return within the window.
      const idle = await hidIdleSeconds()
      if (idle !== null && idle >= IDLE_SUPPRESS_S) {
        return
      }
      if (!consumeClaim(`${PEAK_KEY_FILE}-${p.id}`, key)) {
        lastPeakKey[p.id] = key // another instance already bannered today
        continue
      }
      lastPeakKey[p.id] = key
      notify(`${p.label}: peak hours`, p.msg, p.sound)
    }
  }
  const peakLoop = () => void peakCheck().catch(() => {})
  peakLoop()
  setInterval(peakLoop, PEAK_CHECK_MS).unref()

  // Opt-in auto-grant: approve every permission ask so agent runs never
  // block. DEFAULT OFF - create ~/.config/opencode/state/notify-autogrant.on to
  // enable (restart to apply). Denies from config/agent rules never reach
  // this point, so they are unaffected.
  // The notifier plugin (>=0.3.0) only alerts on asks still pending
  // after 300ms, so auto-granted asks stay silent.
  // Reply failures (and only failures) log to DBG_LOG; a past silent
  // failure is why the dual reply-shape fallback exists.
  if (!existsSync(AUTOGRANT_ON)) return {}

  return {
    event: async (input) => {
      const e = input.event as { type?: string; properties?: any }
      if (e?.type !== "permission.asked") return
      const p = e.properties
      if (!p?.id || !p?.sessionID) {
        dbg("asked event missing id/sessionID: " + JSON.stringify(e).slice(0, 200))
        return
      }
      const c = client as any
      const body = { response: "once" as const }
      const has2 = typeof c.session?.[p.sessionID]?.permissions?.[p.id]?.post === "function"
      try {
        if (typeof c.postSessionIdPermissionsPermissionId === "function") {
          await c.postSessionIdPermissionsPermissionId({
            path: { id: p.sessionID, permissionID: p.id },
            body,
            query: { directory },
          })
        } else if (has2) {
          await c.session[p.sessionID].permissions[p.id].post({ body })
        } else {
          dbg(
            "no known reply method on client; keys=" +
              Object.keys(c)
                .slice(0, 25)
                .join(","),
          )
        }
      } catch (err) {
        // Shape-1 present but rejected: fall through to shape-2 once before
        // declaring failure, so one broken path never masks the other.
        if (typeof c.postSessionIdPermissionsPermissionId === "function" && has2) {
          try {
            await c.session[p.sessionID].permissions[p.id].post({ body })
          } catch (err2) {
            dbg("reply FAILED (both shapes): " + (err2 instanceof Error ? err2.message : String(err2)))
          }
        } else {
          dbg("reply FAILED: " + (err instanceof Error ? err.message : String(err)))
        }
      }
    },
  }
}
