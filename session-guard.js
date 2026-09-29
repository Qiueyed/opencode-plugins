// session-guard.js
//
// In-TUI warnings for context budget. Toasts ONLY - it never blocks
// anything. All tunables are env-configurable; everything defaults to off
// except the context warnings, which work with any provider.
//
// Features:
// 1. Context budget: warns once per session when context usage crosses a
//    soft line and again at a critical line (accuracy degrades as the
//    context fills; past the critical line, summarize your state and start
//    a fresh session).
// 2. Low-quality model windows (optional): repeat a throttled warning while
//    the current UTC hour is inside one of your configured windows - useful
//    when your provider has known peak-hour degradation. Off by default.
//
// Install: drop into ~/.config/opencode/plugins/ (global) or
// .opencode/plugins/ (project), then restart OpenCode. Plain JS, no deps.
//
// Config (env):
//   OPENCODE_SESSION_GUARD=off             disable the plugin
//   OPENCODE_SESSION_GUARD_WARN            soft context limit (default 150000 tokens)
//   OPENCODE_SESSION_GUARD_CRIT            hard context limit (default 200000 tokens)
//   OPENCODE_SESSION_GUARD_WINDOWS         UTC windows "6-10,14-18" (default: none)
//   OPENCODE_SESSION_GUARD_WINDOW_THROTTLE min ms between window toasts (default 1800000)

const WARN_TOKENS = Number(process.env.OPENCODE_SESSION_GUARD_WARN) || 150000
const CRIT_TOKENS = Number(process.env.OPENCODE_SESSION_GUARD_CRIT) || 200000
const WINDOW_THROTTLE_MS = Number(process.env.OPENCODE_SESSION_GUARD_WINDOW_THROTTLE) || 30 * 60 * 1000
const WINDOWS = (process.env.OPENCODE_SESSION_GUARD_WINDOWS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const m = s.match(/^(\d{1,2})-(\d{1,2})$/)
    return m ? [Number(m[1]), Number(m[2])] : null
  })
  .filter(Boolean)

export const SessionGuard = async ({ client }) => {
  const state = new Map() // sessionID -> { warn, crit, lastWindowToast }
  const inBadWindow = () => {
    const h = new Date().getUTCHours()
    return WINDOWS.some(([a, b]) => h >= a && h < b)
  }
  const currentWindow = () => {
    const h = new Date().getUTCHours()
    for (const [a, b] of WINDOWS) if (h >= a && h < b) return `${a}:00-${b}:00`
    return ""
  }
  const toast = async (message, variant, title) => {
    try {
      await client.tui.showToast({ body: { title, message, variant } })
    } catch (e) {
      try {
        await client.app.log({ body: { service: "session-guard", level: "warn", message: "toast failed: " + String(e && e.message ? e.message : e) } })
      } catch {}
    }
  }
  const contextTokens = (info) => {
    const t = info && info.tokens
    if (!t || typeof t !== "object") return 0
    const cache = t.cache || {}
    return (Number(t.input) || 0) + (Number(cache.read) || 0) + (Number(cache.creation) || 0)
  }
  return {
    event: async ({ event }) => {
      try {
        if (process.env.OPENCODE_SESSION_GUARD === "off") return
        if (event.type === "session.created" || event.type === "session.compacted") {
          const p = event.properties || {}
          const id = p.sessionID || (p.info && p.info.id)
          if (id) state.delete(id)
          return
        }
        if (event.type !== "message.updated") return
        const info = event.properties && event.properties.info
        const sid = info && info.sessionID
        if (!sid) return
        const s = state.get(sid) || { warn: false, crit: false, lastWindowToast: 0 }
        state.set(sid, s)
        const ctx = contextTokens(info)
        if (ctx > 0) {
          if (ctx >= CRIT_TOKENS && !s.crit) {
            s.crit = true
            await toast(
              "Context is ~" + Math.round(ctx / 1000) + "k tokens, near the model limit. Accuracy degrades sharply from here: summarize the current state and continue in a fresh session.",
              "error",
              "CONTEXT CRITICAL",
            )
            return
          }
          if (ctx >= WARN_TOKENS && !s.warn) {
            s.warn = true
            await toast(
              "Context is ~" + Math.round(ctx / 1000) + "k tokens and filling up. Start wrapping up: finish the current step, note where you are, and plan to continue in a fresh session.",
              "warning",
              "CONTEXT WARNING",
            )
            return
          }
        }
        const now = Date.now()
        if (WINDOWS.length && inBadWindow() && now - s.lastWindowToast > WINDOW_THROTTLE_MS) {
          s.lastWindowToast = now
          await toast(
            "UTC time is inside a configured low-quality model window (" + currentWindow() + " UTC). Expect degraded output: verify aggressively, defer risky work, or wait for the window to end.",
            "warning",
            "LOW-QUALITY WINDOW",
          )
        }
      } catch (e) {
        try {
          await client.app.log({ body: { service: "session-guard", level: "error", message: String(e && e.message ? e.message : e) } })
        } catch {}
      }
    },
  }
}
