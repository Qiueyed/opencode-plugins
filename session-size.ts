/**
 * session-size.ts
 *
 * Shows how much storage each session consumes, directly in the session
 * list. The list renders session TITLES, so this plugin tags every title
 * with a size prefix:
 *
 *   "428M · Screen sat"   ->   ~428 MB of rows in the opencode database
 *
 * Why: multi-hundred-MB sessions accumulate silently (streaming deltas,
 * attachments) and slow startup down before anything looks wrong. Sizes on
 * the list make the bloat visible.
 *
 * Mechanics: reads sizes from the opencode database via the sqlite3 CLI,
 * STRICTLY read-only ("-readonly" flag + "file:...?mode=ro" URI; this
 * plugin never writes to the db). Per-session bytes = SUM(LENGTH(data))
 * across the payload tables. Titles are rewritten through the OpenCode SDK,
 * never SQL.
 *
 * HONEST TRADEOFF: this plugin rewrites your session titles. A user-authored
 * title that legitimately starts with something like "2G · ..." would be
 * re-tagged. Disable with OPENCODE_SESSION_SIZE=off if you ever set
 * meaningful titles by hand.
 *
 * Idempotence: the tag is stripped from the current title before re-tagging,
 * and the update call fires ONLY when the desired title differs - steady
 * state is zero API calls. Scheduling: one pass shortly after load, then
 * every REFRESH_MS; timers are unref'd and overlapping passes are skipped.
 * Missing db or sqlite3 failure logs a single warning and stays quiet.
 *
 * Install: drop into ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project), then restart OpenCode. Needs the sqlite3
 * CLI on PATH (macOS has it built in; most Linux distros; often missing on
 * Windows -> the plugin disables itself with one warning).
 *
 * Config (env):
 *   OPENCODE_SESSION_SIZE=off              disable the plugin
 *   OPENCODE_SESSION_SIZE_INTERVAL_MS      refresh interval (default 600000)
 *   OPENCODE_SESSION_SIZE_DB               explicit db path (default: XDG data dir)
 */
import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"

const DISABLED = process.env.OPENCODE_SESSION_SIZE === "off"
const REFRESH_MS = Number(process.env.OPENCODE_SESSION_SIZE_INTERVAL_MS) || 10 * 60 * 1000
const STARTUP_DELAY_MS = 5000
const TAG_RE = /^\s*[\d.]+[GMKB]\s*\u00B7\s*/u
const TAG_RE_LEGACY = /^\[[\d.]+[GMKB]\]\s*/
const TAG_RE_EMOJI = /^\s*(?:\u{1F534}|\u{1F7E0}|\u{1F7E2})\s*[\d.]+[GMKB]\s*\u00B7\s*/u
const SEP = " \u00B7 "

const DB_PATH =
  process.env.OPENCODE_SESSION_SIZE_DB ||
  (process.env.XDG_DATA_HOME || homedir() + "/.local/share") + "/opencode/opencode.db"

// Single-line on purpose: one aggregate SELECT, three COALESCE'd subselects.
const QUERY =
  "SELECT s.id AS id, COALESCE((SELECT SUM(LENGTH(e.data)) FROM event e WHERE e.aggregate_id = s.id),0) + COALESCE((SELECT SUM(LENGTH(p.data)) FROM part p WHERE p.session_id = s.id),0) + COALESCE((SELECT SUM(LENGTH(m.data)) FROM message m WHERE m.session_id = s.id),0) AS bytes FROM session s"

/** Bytes to short human form: 1.1G / 569M / 12K / 0B. */
const human = (b: number): string => {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1).replace(/\.0$/, "") + "G"
  if (b >= 1024 ** 2) return Math.round(b / 1024 ** 2) + "M"
  if (b >= 1024) return Math.round(b / 1024) + "K"
  return b + "B"
}

/** Read-only per-session byte map; empty map on any failure (never throws). */
const readSizes = (): Promise<Map<string, number>> =>
  new Promise((resolve) => {
    execFile(
      "sqlite3",
      ["-readonly", `file:${DB_PATH}?mode=ro`, "-json", QUERY],
      (err, stdout) => {
        if (err) return resolve(new Map())
        const m = new Map<string, number>()
        try {
          const rows = JSON.parse(String(stdout)) as Array<{ id?: string; bytes?: number }>
          if (Array.isArray(rows)) {
            for (const r of rows) {
              if (r && typeof r.id === "string") m.set(r.id, Number(r.bytes) || 0)
            }
          }
        } catch {}
        resolve(m)
      },
    )
  })

export const SessionSize: Plugin = async ({ client }) => {
  const log = async (level: "warn" | "error", message: string) => {
    try {
      await client.app.log({ body: { service: "session-size", level, message } })
    } catch {}
  }

  if (DISABLED) {
    await log("warn", "disabled via OPENCODE_SESSION_SIZE=off")
    return {}
  }
  if (!existsSync(DB_PATH)) {
    await log("warn", "db not found at " + DB_PATH + "; session size tagging disabled")
    return {}
  }

  let inFlight = false

  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      // Result shape is build-dependent (RequestResult wrapper or bare
      // array); unwrap defensively.
      const res: any = await client.session.list()
      const sessions: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
      if (!sessions.length) return
      const sizes = await readSizes()
      let failures = 0
      for (const s of sessions) {
        const id = s?.id
        if (typeof id !== "string" || !id) continue
        const title = typeof s.title === "string" ? s.title : ""
        // Loop-until-stable: strip any nesting of old tag formats, capped
        // well above the worst real nesting depth.
        let base = title
        for (let i = 0; i < 6; i++) {
          const next = base.replace(TAG_RE_LEGACY, "").replace(TAG_RE_EMOJI, "").replace(TAG_RE, "")
          if (next === base) break
          base = next
        }
        const desired = `${human(sizes.get(id) ?? 0)}${SEP}${base}`
        if (desired === title) continue
        try {
          await client.session.update({ path: { id }, body: { title: desired } })
        } catch {
          failures++
        }
      }
      if (failures > 0) await log("warn", `${failures} session title tag update(s) failed this cycle`)
    } catch (e) {
      await log("error", "refresh failed: " + String(e instanceof Error && e.message ? e.message : e))
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => void refresh(), REFRESH_MS)
  timer.unref()
  setTimeout(() => void refresh(), STARTUP_DELAY_MS).unref()

  return {}
}

export default SessionSize
