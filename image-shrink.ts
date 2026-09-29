/**
 * image-shrink.ts
 *
 * Minimizes image size automatically when images are posted in an OpenCode
 * message. Full-res retina screenshots (~3.2MB PNG) attach as inline base64
 * data URLs; they bloat the session data stored on disk and the request
 * payload.
 *
 * Mechanics: the "chat.message" hook fires at send time with the live parts
 * array; this plugin replaces any image data-URL part larger than MIN_BYTES
 * with a downscaled JPEG (max MAXDIM px, QUALITY), mutating the part in
 * place. Everything below the threshold passes through untouched, and ANY
 * failure keeps the original part (never break sending).
 *
 * Known limit (be honest): this runs at SEND time. The composer still holds
 * the full-res base64 between attach and send, and re-serializes the whole
 * store per keystroke - for LARGE image batches, shrink BEFORE attaching
 * with any image tool, or the renderer can run out of memory. This plugin
 * is the always-on safety net for what gets stored and sent.
 *
 * Platform notes: downscaling uses macOS `sips`; on other platforms the
 * plugin is a no-op (images pass through untouched).
 *
 * Install: drop into ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project), then restart OpenCode.
 *
 * Config (env):
 *   OPENCODE_IMAGE_SHRINK=off              disable the plugin
 *   OPENCODE_IMAGE_SHRINK_MAXDIM           max width/height (default 1600)
 *   OPENCODE_IMAGE_SHRINK_QUALITY          JPEG quality (default 80)
 *   OPENCODE_IMAGE_SHRINK_MIN_KB           min raw size to bother (default 300)
 */
import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Desktop-app users often cannot export env vars before launch, so every
// option can also live in ~/.config/opencode/image-shrink.settings.json as
// {"OPENCODE_IMAGE_SHRINK_MAXDIM": 1280, ...}. Precedence: env var >
// settings file > default. Read once at startup.
const SETTINGS_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "image-shrink.settings.json")
function setting(key: string, fallback: string): string {
  const envVal = process.env[key]
  if (envVal !== undefined && envVal !== "") return envVal
  try {
    const v = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))?.[key]
    if (typeof v === "string" && v !== "") return v
    if (typeof v === "boolean" || typeof v === "number") return String(v)
  } catch {}
  return fallback
}

const DISABLED = setting("OPENCODE_IMAGE_SHRINK", "") === "off"
const MAXDIM = Number(setting("OPENCODE_IMAGE_SHRINK_MAXDIM", "1600")) || 1600
const QUALITY = Number(setting("OPENCODE_IMAGE_SHRINK_QUALITY", "80")) || 80
const MIN_BYTES = (Number(setting("OPENCODE_IMAGE_SHRINK_MIN_KB", "300")) || 300) * 1024
// Hook-level gate measured on the BASE64 data URL (4/3 of raw bytes): the
// gate sits above MIN_BYTES so a freshly shrunk image can never re-enter
// the shrink path - no second-generation JPEG loss.
const MIN_URL_BYTES = Math.round(MIN_BYTES * 4 / 3)

const sips = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("sips", args, (err) => (err ? reject(err) : resolve()))
  })

/** Shrink one data-URL image; returns the new data URL, or null on any
 * failure / when too small to bother (caller keeps the original). */
async function shrinkDataUrl(dataUrl: string): Promise<string | null> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  const buf = Buffer.from(m[2], "base64")
  if (buf.length < MIN_BYTES) return null
  const dir = mkdtempSync(path.join(tmpdir(), "image-shrink-"))
  try {
    const ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "")
    const inFile = path.join(dir, "in." + ext)
    const outFile = path.join(dir, "out.jpg")
    writeFileSync(inFile, buf)
    await sips(["-Z", String(MAXDIM), "-s", "format", "jpeg", "-s", "formatOptions", String(QUALITY), inFile, "--out", outFile])
    const out = readFileSync(outFile)
    if (out.length >= buf.length) return null // shrink made it bigger: keep original
    return `data:image/jpeg;base64,${out.toString("base64")}`
  } catch {
    return null
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

export const ImageShrink: Plugin = async ({ client }) => {
  if (DISABLED) {
    try {
      await client.app.log({ body: { service: "image-shrink", level: "info", message: "disabled via OPENCODE_IMAGE_SHRINK=off" } })
    } catch {}
    return {}
  }
  if (process.platform !== "darwin") {
    try {
      await client.app.log({ body: { service: "image-shrink", level: "info", message: "non-macOS: sips unavailable, images pass through untouched" } })
    } catch {}
  }

  let logged = 0
  const log = async (level: "info" | "warn", message: string) => {
    try {
      if (logged > 20) return // do not spam the log
      logged++
      await client.app.log({ body: { service: "image-shrink", level, message } })
    } catch {}
  }

  return {
    "chat.message": async (hookInput: any, hookOutput: any) => {
      try {
        const parts = hookOutput?.parts as any[] | undefined
        if (!Array.isArray(parts)) return
        let shrunk = 0
        let saved = 0
        for (const p of parts) {
          const url = p?.url
          if (typeof url !== "string" || !url.startsWith("data:image/")) continue
          const before = Buffer.byteLength(url, "utf8")
          if (before < MIN_URL_BYTES) continue
          const next = await shrinkDataUrl(url)
          if (!next) continue
          p.url = next
          if (typeof p.mime === "string") p.mime = "image/jpeg"
          if (typeof p.filename === "string") p.filename = p.filename.replace(/\.[a-z0-9]+$/i, ".small.jpg")
          shrunk++
          saved += before - Buffer.byteLength(next, "utf8")
        }
        if (shrunk > 0) {
          await log(
            "info",
            `shrunk ${shrunk} image part(s) in session ${hookInput?.sessionID ?? "?"}: saved ~${Math.round(saved / 1024)}KB`,
          )
        }
      } catch (e) {
        await log("warn", "image-shrink failed (originals sent): " + String(e instanceof Error && e.message ? e.message : e))
      }
    },
  }
}

export default ImageShrink
