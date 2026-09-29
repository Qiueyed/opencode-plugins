// vision-guard.ts
//
// Tool-layer image privacy guard for OpenCode. ANY model read of an image
// file is intercepted BEFORE execution: the image is classified by a LOCAL
// vision model (via Ollama on localhost) and only clean verdicts let the
// read through. Nothing about the image ever leaves your machine unless the
// local verdict is "clean".
//
// On a SENSITIVE verdict the read is neutered by MUTATION, not by throwing:
// args.filePath is redirected to a notice file, so the model reads WHY in
// the tool result and can tell you, instead of retrying.
//
// Fail-closed by default: Ollama down, timeout, HTTP error, or unparseable
// verdict all BLOCK. If you do not run a local vision model, image reads
// will be blocked with a "guard-error" notice - set
// OPENCODE_VISION_GUARD_POLICY=fail-open to allow reads (with a logged
// warning) when the inspector is unreachable, or OPENCODE_VISION_GUARD=allow
// to disable the guard entirely.
//
// Config (env):
//   OPENCODE_VISION_GUARD=allow            disable the guard completely
//   OPENCODE_VISION_GUARD_URL              Ollama base URL (default http://127.0.0.1:11434)
//   OPENCODE_VISION_GUARD_MODEL            vision model tag (default qwen3-vl:8b)
//   OPENCODE_VISION_GUARD_POLICY           fail-closed (default) | fail-open
//   OPENCODE_VISION_GUARD_TIMEOUT_MS       inspection timeout (default 90000)
//   Bypass without env: state/state.json key visionGuardBypass = true (menu checkbox)
//   (touch to arm, rm to re-enable). Every bypass is written to the audit log.
//
// Scope: the "read" tool on image extensions. Audit trail:
// ~/.local/share/opencode/vision-guard.log (honors XDG_DATA_HOME).
//
// Platform notes: image downscaling for inspection uses macOS `sips`; on
// other platforms the original bytes are sent to the local model instead.
// Requires a running Ollama with a vision-capable model pulled.
//
// Install: drop into ~/.config/opencode/plugins/ (global) or .opencode/plugins/
// (project), then restart OpenCode. Only export the plugin factory from this
// file - the loader calls every exported function of a plugin module.
import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CACHE_TTL_MS = 10 * 60_000
const AUDIT_LOG = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || ".", ".local", "share"), "opencode", "vision-guard.log")
const STATE_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "state", "state.json")
const bypassEnabled = (): boolean => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).visionGuardBypass === true
  } catch {
    return false
  }
}
const NOTICE_FILE = path.join(tmpdir(), `vision-guard-blocked-${process.pid}.txt`)
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i
const INSPECT_MAXDIM = 1600
const INSPECT_QUALITY = 80

// Desktop-app users often cannot export env vars before launch, so every
// option can also live in a settings file. Precedence: env var > settings
// file > default. URL/model/timeout are read once at startup; the POLICY
// setting is read on every inspection failure, so flipping fail-open in the
// file works mid-session without a restart (the bypass marker and the
// OPENCODE_VISION_GUARD=allow check are also evaluated live).
const SETTINGS_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "state", "vision-guard.settings.json")
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

const OLLAMA_URL = setting("OPENCODE_VISION_GUARD_URL", "http://127.0.0.1:11434").replace(/\/+$/, "")
const MODEL = setting("OPENCODE_VISION_GUARD_MODEL", "qwen3-vl:8b")
const TIMEOUT_MS = Number(setting("OPENCODE_VISION_GUARD_TIMEOUT_MS", "90000")) || 90_000
function policy(): string {
  return setting("OPENCODE_VISION_GUARD_POLICY", "fail-closed").toLowerCase()
}

const PROMPT = [
  "You are a local privacy screen deciding if this image may be sent to a REMOTE AI API.",
  "Mark it SENSITIVE if it shows any of: credentials (API keys, tokens, passwords, login forms, OTP codes), private messages / chats / email content, financial data (banking, cards, invoices, crypto wallets), government IDs or documents with personal data, medical information, explicit or intimate content, or anything a privacy-conscious user would not want leaving their machine.",
  "When in doubt, answer sensitive=true.",
  "Do NOT quote or reproduce any sensitive text you see.",
  "Answer with STRICT JSON only, no markdown, no prose:",
  '{"sensitive": true|false, "categories": ["..."], "reason": "one short line"}',
].join(" ")

type Verdict = {
  sensitive: boolean
  categories: string[]
  reason: string
  action?: "allow" | "redact" | "block"
  strip?: "none" | "top" | "bottom" | "left" | "right"
  fraction?: number
  utility?: "high" | "low"
}

const STRIPS = ["none", "top", "bottom", "left", "right"]

// v2 prompt (EXPERIMENTAL redact mode): the judge proposes a sensitive EDGE
// strip (<=50% of one side) that can be cropped away, plus a utility call on
// whether the remaining image is still worth its tokens. Strips, not boxes:
// qwen3-vl boxes drift, and sips can only crop - conservative beats clever.
const PROMPT_V2 = [
  "You are a local privacy screen deciding how this image may be sent to a REMOTE AI API.",
  "Mark SENSITIVE if it shows: credentials (API keys, tokens, passwords, login forms, OTP), private messages/chats/email, financial data, government IDs, medical info, explicit content, or anything a privacy-conscious user would not want leaving their machine.",
  "If SENSITIVE and the sensitive content sits entirely within ONE edge region (top/bottom/left/right) covering at most 50% of that dimension, choose redact: name the strip and the fraction (0-50, round UP to be safe).",
  "If sensitive content spans the middle or multiple edges, choose block.",
  "If NOT sensitive, choose allow.",
  "utility: high if the NON-sensitive remainder is still informative (code, UI, charts, documents); low if it is mostly empty desktop, wallpaper, or noise not worth its tokens.",
  "Do NOT quote or reproduce any sensitive text you see.",
  "Answer with STRICT JSON only, no markdown, no prose:",
  '{"sensitive": true|false, "action": "allow"|"redact"|"block", "strip": "none"|"top"|"bottom"|"left"|"right", "fraction": 0-50, "utility": "high"|"low", "categories": ["..."], "reason": "one short line"}',
].join(" ")

const cache = new Map<string, { v: Verdict; t: number }>()

function logLine(s: string) {
  try {
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()} ${s}\n`)
  } catch {}
}

const sips = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("sips", args, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ""))))
  })

// Some vision models emit <think> blocks or markdown fences; merge thinking
// content when present, strip all of it, and keep the JSON.
function extractText(msg: any): string {
  const merged = String(msg?.content ?? "").trim() || String(msg?.thinking ?? "").trim()
  return merged
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "")
    .trim()
}

function parseVerdict(text: string, promptV2: boolean): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (typeof j?.sensitive === "boolean") {
        const v: Verdict = {
          sensitive: j.sensitive === true,
          categories: Array.isArray(j.categories) ? j.categories.map(String).slice(0, 5) : [],
          reason: String(j.reason ?? "").slice(0, 200) || "no reason given",
        }
        if (promptV2) {
          const strip = STRIPS.includes(j.strip) ? (j.strip as Verdict["strip"]) : "none"
          const frac = Math.max(0, Math.min(50, Number(j.fraction) || 0))
          v.action = ["allow", "redact", "block"].includes(j.action) ? j.action : v.sensitive ? "block" : "allow"
          v.strip = strip
          v.fraction = frac
          v.utility = j.utility === "low" ? "low" : "high"
        }
        return v
      }
    } catch {}
  }
  if (/\bnot[_ -]?sensitive\b|"sensitive"\s*:\s*false/i.test(text)) {
    return { sensitive: false, categories: [], reason: "parsed via fallback token scan" }
  }
  return null
}

// Pure decision: mode + verdict -> pass | redact | block. Sliceable for tests.
const guardOutcome = (v: Verdict, mode: "block" | "redact"): "pass" | "redact" | "block" => {
  if (!v.sensitive) return "pass"
  if (mode !== "redact") return "block"
  if (v.action === "redact" && v.strip && STRIPS.includes(v.strip) && v.strip !== "none" && (v.fraction ?? 0) > 0) {
    return v.utility === "low" ? "block" : "redact"
  }
  return "block"
}

const redactEnabled = (): boolean => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).visionGuardRedact === true
  } catch {
    return false
  }
}

// Crop out the sensitive edge strip. Implementation: python3 + PIL (present on
// this machine; sips' --cropOffset silently no-ops when combined with -c, and
// plain -c is center-only, so sips cannot express edge crops). No PIL ->
// returns null -> caller blocks (fail closed).
async function redactImage(filePath: string, strip: NonNullable<Verdict["strip"]>, fraction: number): Promise<string | null> {
  const f = Math.min(0.5, Math.max(0.05, (fraction + 5) / 100)) // +5% margin, capped 50%
  const dir = mkdtempSync(path.join(tmpdir(), "vision-guard-redact-"))
  const out = path.join(dir, `redacted-${Date.now()}.jpg`)
  const py = path.join(dir, "redact.py")
  writeFileSync(
    py,
    [
      "import sys",
      "from PIL import Image",
      "src, out, strip, f = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])",
      'im = Image.open(src).convert("RGB")',
      "w, h = im.size",
      'if strip == "top": box = (0, int(h*f), w, h)',
      'elif strip == "bottom": box = (0, 0, w, int(h*(1-f)))',
      'elif strip == "left": box = (int(w*f), 0, w, h)',
      "else: box = (0, 0, int(w*(1-f)), h)",
      'im.crop(box).save(out, "JPEG", quality=85)',
    ].join("\n"),
  )
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("python3", [py, filePath, out, strip, String(f)], { timeout: 20_000 }, (err) => (err ? reject(err) : resolve())),
    )
    return existsSync(out) ? out : null
  } catch {
    return null
  }
}

async function inspectImage(filePath: string, promptV2: boolean): Promise<Verdict> {
  const st = statSync(filePath)
  const key = `${filePath}:${st.size}:${st.mtimeMs}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) {
    logLine(`CACHE_HIT ${filePath}`)
    return hit.v
  }

  let b64: string
  const dir = mkdtempSync(path.join(tmpdir(), "vision-guard-"))
  try {
    const inFile = path.join(dir, "in.img")
    const outFile = path.join(dir, "inspect.jpg")
    writeFileSync(inFile, readFileSync(filePath))
    try {
      await sips([
        "-Z", String(INSPECT_MAXDIM),
        "-s", "format", "jpeg",
        "-s", "formatOptions", String(INSPECT_QUALITY),
        inFile, "--out", outFile,
      ])
      b64 = readFileSync(outFile).toString("base64")
    } catch {
      b64 = readFileSync(inFile).toString("base64") // inspect original if sips is unavailable
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: { temperature: 0 },
        messages: [{ role: "user", content: promptV2 ? PROMPT_V2 : PROMPT, images: [b64] }],
      }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      return { sensitive: true, categories: ["guard-error"], reason: `ollama HTTP ${resp.status}` }
    }
    const data: any = await resp.json()
    const v = parseVerdict(extractText(data?.message), promptV2)
    if (!v) {
      return { sensitive: true, categories: ["guard-error"], reason: "unparseable local verdict (fail closed)" }
    }
    cache.set(key, { v, t: Date.now() })
    return v
  } catch (e: any) {
    const why = e?.name === "AbortError" ? "local inspection timed out" : String(e?.message ?? e)
    if (policy() === "fail-open") {
      logLine(`GUARD_ERROR_FAIL_OPEN ${filePath} :: ${why}`)
      return { sensitive: false, categories: ["guard-error"], reason: `inspector unavailable, fail-open policy: ${why}` }
    }
    return { sensitive: true, categories: ["guard-error"], reason: `local inspector unavailable: ${why}` }
  } finally {
    clearTimeout(timer)
  }
}

function writeNotice(originalPath: string, v: Verdict) {
  const txt = [
    `[VISION GUARD] Image read BLOCKED: ${originalPath}`,
    `Verdict: ${v.reason}`,
    `Categories: ${v.categories.join(", ") || "n/a"}`,
    ``,
    `The image was NOT loaded into the model context and was NOT sent to any remote API.`,
    `It was inspected only by a LOCAL vision model (${MODEL} via Ollama on ${OLLAMA_URL}).`,
    ``,
    `If the inspector is not set up yet, install Ollama + a vision model, or set`,
    `  OPENCODE_VISION_GUARD_POLICY=fail-open   (allow reads when the inspector is down)`,
    `  OPENCODE_VISION_GUARD=allow              (disable the guard)`,
    `Temporary bypass: state.json visionGuardBypass = true (Plugins menu checkbox)`,
    `Audit log: ${AUDIT_LOG}`,
  ].join("\n")
  try {
    writeFileSync(NOTICE_FILE, txt)
  } catch {}
}

export const visionGuard = (async ({ client }) => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (input?.tool !== "read") return
        const fp = typeof output?.args?.filePath === "string" ? output.args.filePath : ""
        if (!fp || !IMAGE_RE.test(fp)) return

        let bypass = setting("OPENCODE_VISION_GUARD", "") === "allow"
        if (!bypass) {
          bypass = bypassEnabled()
        }
        if (bypass) {
          logLine(`BYPASSED ${fp}`)
          return
        }

        let st
        try {
          st = statSync(fp)
        } catch {
          return // unreadable path: let the read tool fail naturally
        }
        if (!st.isFile()) return

        const v = await inspectImage(fp, redactEnabled())
        const mode: "block" | "redact" = redactEnabled() ? "redact" : "block"
        const outcome = guardOutcome(v, mode)
        logLine(
          `${outcome.toUpperCase()} ${fp} :: ${v.categories.join(",") || "-"} :: ${v.reason} [${input?.sessionID ?? "?"}]`,
        )
        if (outcome === "pass") return

        if (outcome === "redact" && v.strip && v.strip !== "none") {
          const sanitized = await redactImage(fp, v.strip, v.fraction ?? 0)
          if (sanitized) {
            try {
              await client.tui.showToast({
                body: { title: "VISION GUARD", message: `Redacted (${v.strip} ${(v.fraction ?? 0) + 5}%): ${v.reason}`.slice(0, 180), variant: "warning" },
              })
            } catch {}
            // Experimental redact: the read runs against the SANITIZED file.
            if (output && typeof output === "object") (output as any).args.filePath = sanitized
            return
          }
          // redaction failed: fall through to block (fail closed)
        }

        writeNotice(fp, v)
        try {
          await client.app.log({ body: { service: "vision-guard", level: "warn", message: `blocked ${fp}: ${v.reason}` } })
        } catch {}
        try {
          await client.tui.showToast({
            body: { title: "VISION GUARD", message: `Image blocked: ${v.reason}`.slice(0, 180), variant: "warning" },
          })
        } catch {}
        // Neuter via mutation: the read runs against the notice file, so the
        // model sees WHY, not the pixels.
        if (output && typeof output === "object") (output as any).args.filePath = NOTICE_FILE
      } catch (e: any) {
        // Guard-internal failure: fail CLOSED, never leak by accident.
        const why = String(e?.message ?? e)
        logLine(`ERROR fail-closed :: ${why}`)
        writeNotice("(unknown path)", { sensitive: true, categories: ["guard-error"], reason: `guard internal error: ${why}` })
        try {
          if (output && typeof output === "object" && typeof (output as any).args?.filePath === "string") {
            ;(output as any).args.filePath = NOTICE_FILE
          }
        } catch {}
      }
    },
  }
}) satisfies Plugin

export default visionGuard
