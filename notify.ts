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
 *   Question asks: an early-October 2026 update killed the form-based
 *   question event (form.created) that @mohak34/opencode-notifier listens
 *   on (still true upstream at 1.1.1, checked 2026-10-24), so asks were
 *   silent for ~3 weeks. This file
 *   plays the notifier-configured question tone on question.asked (raw
 *   name question.v2.asked also handled) plus ONE reminder after 10 min
 *   while the ask is pending; cancelled on question.replied/rejected.
 *   Cross-window dedup via per-id claim files in state/. Banners are
 *   NOT posted here: the app's native Electron banner (ai.opencode.desktop)
 *   owns those; osascript banners show as Script Editor, which the
 *   September work explicitly engineered away.
 *   Permission auto-grant (OPT-IN, default OFF): the documented
 *   `permission.ask` plugin hook is not wired in desktop builds (no
 *   plugin.trigger("permission.ask") anywhere in app.asar), so instead
 *   the `event` hook listens for `permission.asked` bus events and
 *   auto-replies "once" via the session permissions API - the same
 *   call the desktop's own auto-accept uses. DANGEROUS BY DESIGN: it
 *   approves every ask that reaches it. Enable ONLY by creating
 *   state/state.json key notifyAutogrant. Config-level denies
 *   (sudo) short-circuit in the core permission service; rm -rf asks DO
 *   reach this hook (only sudo is config-denied), so guardrails and
 *   per-agent denies still win over this.
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
 * Toggle: the peakBannerDisabled key in state/state.json is checked per poll,
 * so the banner can be disabled live; wire it to a menu checkbox.
 *
 * Delivery: sound only via afplay. Banners are dead for scripts on this
 * macOS - every osascript banner shows as "Script Editor" (tell-target
 * included, A/B-proven 2026-10-05) - so alerts are audio-only and banners
 * are left to the app's native notifications. Focus /
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
  readdirSync,
  readFileSync,
  statSync,
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
const STATE_FILE = homedir() + "/.config/opencode/state/state.json"
const readState = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}
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

// Resting-user gate: if there has been no keyboard/mouse input for this
// long, the user is away or asleep -> suppress the peak banner (and its
// sound). The key is NOT consumed on suppression, so the banner still
// fires later the same day if they return while the window is open.
// Rationale: peak windows can open at night; the machine may be awake
// (caffeinate.ts keeps it up during processing) but the user asleep -
// "computer awake" cannot be the gate, user presence (HID idle) is.
const IDLE_SUPPRESS_S = 10 * 60

// Question asks: an early-October app update (before 2026-10-21) replaced
// form-based questions with the native question module; the bus event is
// `question.asked` (raw name `question.v2.asked`) and
// @mohak34/opencode-notifier (0.4.0 installed, 1.1.1 latest as of
// 2026-10-24) only listens for the dead `form.created` event, so question
// asks have been silent since early October (user-corrected timeline).
// notify.ts covers the gap: play the configured question tone
// (sounds.question / volumes.question / events.question.sound from
// opencode-notifier.json, same file the Plugins menu edits), then ONE
// reminder after QUESTION_REMIND_MS if the ask is still unanswered.
const NOTIFIER_CFG = homedir() + "/.config/opencode/opencode-notifier.json"
const STATE_DIR = homedir() + "/.config/opencode/state"
const QUESTION_CLAIM_PREFIX = PEAK_KEY_FILE + "-q-"
const QUESTION_REMIND_MS = 10 * 60_000
// Minimal stage trace: the question path used to leave zero observable
// trace, which cost a full debug session (2026-10-30 outage: two native
// banner sounds, no Tink, no way to tell load vs event vs claim vs audio).
// One line per load / question event / reminder; 64KB self-rotate.
const DBGQ = STATE_DIR + "/notify-debug.log"
const dbgQ = (line: string) => {
  try {
    appendFileSync(DBGQ, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

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

export const Notify: Plugin = async ({ client, directory }) => {
  if (process.platform !== "darwin") return {}

  // Banner delivery is DEAD on this macOS: every osascript banner attributes
  // to Script Editor, tell-target included (A/B-proven 2026-10-05 - targeted
  // and bare both showed Script Editor, exit 0). Scripts cannot carry the
  // OpenCode identity; only the app's native notifications can. So: play the
  // alert sound via afplay (identity-free) and post no banner at all.
  const playSound = (path: string, vol: number) => {
    try {
      // afplay -v is linear volume, 1 = unity.
      const args = vol === 1 ? [path] : ["-v", String(vol), path]
      const child = spawn("/usr/bin/afplay", args, { stdio: "ignore" })
      child.unref()
      child.on("error", () => {})
    } catch {}
  }
  const notify = (_subtitle: string, _message: string, sound: string) => {
    playSound(`/System/Library/Sounds/${sound}.aiff`, 1)
  }
  // In-app toast (same client.tui.showToast pattern as gate.ts/caffeinate):
  // the visible, informative channel for peak entry now that banners are
  // impossible for scripts. Failure logs a warning, never breaks the watcher.
  const toast = async (title: string, message: string) => {
    try {
      await client.tui.showToast({ body: { title, message, variant: "info" } })
    } catch (e) {
      try {
        await client.app.log({
          body: { service: "notify-peak", level: "warn", message: `toast failed: ${String(e)}` },
        })
      } catch {}
    }
  }

  // Question sound: full path + volume from the notifier config so the
  // Plugins menu tone/volume picks apply here too. Read per event (cheap),
  // so menu edits are live. Fails closed to the default Tink.
  const questionSound = (): { path: string; vol: number } => {
    try {
      const cfg = JSON.parse(readFileSync(NOTIFIER_CFG, "utf8")) as {
        events?: { question?: { sound?: boolean } }
        sounds?: { question?: string }
        volumes?: { question?: number }
      }
      if (cfg.events?.question?.sound === false) return { path: "", vol: 0 }
      return {
        path: cfg.sounds?.question ?? "/System/Library/Sounds/Tink.aiff",
        vol: typeof cfg.volumes?.question === "number" ? cfg.volumes.question : 1,
      }
    } catch {
      return { path: "/System/Library/Sounds/Tink.aiff", vol: 1 }
    }
  }
  // Cross-window dedup + pending tracking. The desktop runs one plugin
  // instance per project/window; the per-id claim file (same atomic helper
  // as the peak banner) keeps one sound. The reminder arms only in the
  // winner and is cancelled by question.replied / question.rejected.
  const pendingQuestions = new Map<string, ReturnType<typeof setTimeout>>()
  const onQuestionAsked = (p: any) => {
    const id = typeof p?.id === "string" ? p.id : ""
    if (!id) {
      dbgQ(`ask BAD-SHAPE props=${JSON.stringify(p)?.slice(0, 200)}`)
      return
    }
    const claimed = consumeClaim(`${QUESTION_CLAIM_PREFIX}${id}`, id)
    dbgQ(`ask id=${id} claim=${claimed}`)
    if (!claimed) return
    const { path, vol } = questionSound()
    dbgQ(`play path=${path} vol=${vol}`)
    if (path) playSound(path, vol)
    // Banners stay with the app's native Electron path (attributed to
    // ai.opencode.desktop, click deep-links; the Settings > Notifications
    // "Agent" toggle gates it). Script Editor banners were explicitly
    // engineered away in September; notify.ts does not re-add them.
    const t = setTimeout(() => {
      pendingQuestions.delete(id)
      const again = questionSound()
      dbgQ(`remind id=${id} path=${again.path} vol=${again.vol}`)
      if (again.path) playSound(again.path, again.vol)
    }, QUESTION_REMIND_MS)
    t.unref?.()
    pendingQuestions.set(id, t)
  }
  const onQuestionSettled = (p: any) => {
    const id =
      typeof p?.requestID === "string" ? p.requestID : typeof p?.id === "string" ? p.id : ""
    if (!id) return
    const t = pendingQuestions.get(id)
    if (t) {
      clearTimeout(t)
      pendingQuestions.delete(id)
    }
    try {
      unlinkSync(`${QUESTION_CLAIM_PREFIX}${id}`)
    } catch {}
  }
  // Startup sweep: claim files for asks that never settled (session killed)
  // would otherwise accumulate; 48h is far past any real ask lifetime.
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.startsWith(".peak-banner-day-q-")) continue
      const full = `${STATE_DIR}/${f}`
      try {
        if (Date.now() - statSync(full).mtimeMs > 48 * 3_600_000) unlinkSync(full)
      } catch {}
    }
  } catch {}

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
    if (readState().peakBannerDisabled === true) return
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
      // Sound + in-app toast: the old osascript banner is gone (scripts cannot
      // carry the OpenCode identity on this macOS), and a bare Tink loses the
      // entire rate message - the toast carries it instead (2026-10-05).
      void toast(`${p.label}: peak hours`, p.msg)
      notify(`${p.label}: peak hours`, p.msg, p.sound)
    }
  }
  const peakLoop = () => void peakCheck().catch(() => {})
  peakLoop()
  setInterval(peakLoop, PEAK_CHECK_MS).unref()

  // Opt-in auto-grant: approve every permission ask so agent runs never
  // block. DEFAULT OFF - set state/state.json notifyAutogrant to true to
  // enable (restart to apply). Denies from config/agent rules never reach
  // this point, so they are unaffected.
  // The notifier plugin (>=0.3.0) only alerts on asks still pending
  // after 300ms, so auto-granted asks stay silent.
  // Reply failures (and only failures) log to DBG_LOG; a past silent
  // failure is why the dual reply-shape fallback exists.
  // Autogrant stays restart-gated (documented contract); the question
  // sound must work regardless of it.
  const autogrant = readState().notifyAutogrant === true
  // Stage trace: rotate at 64KB, then mark the load.
  try {
    if (statSync(DBGQ).size > 65536) unlinkSync(DBGQ)
  } catch {}
  dbgQ(`load autogrant=${autogrant} peak-off=${readState().peakBannerDisabled === true}`)

  return {
    event: async (input) => {
      const e = input.event as { type?: string; properties?: any }
      const type = e?.type
      // question.v2.* is the raw bus name in some builds; handle both.
      if (type === "question.asked" || type === "question.v2.asked") {
        onQuestionAsked(e.properties)
        return
      }
      if (
        type === "question.replied" ||
        type === "question.v2.replied" ||
        type === "question.rejected" ||
        type === "question.v2.rejected"
      ) {
        onQuestionSettled(e.properties)
        return
      }
      if (!autogrant || type !== "permission.asked") return
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
