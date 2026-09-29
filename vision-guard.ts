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
//   Bypass without env: marker file ~/.config/opencode/vision-guard.off
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

const OLLAMA_URL = (process.env.OPENCODE_VISION_GUARD_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")
const MODEL = process.env.OPENCODE_VISION_GUARD_MODEL || "qwen3-vl:8b"
const POLICY = (process.env.OPENCODE_VISION_GUARD_POLICY || "fail-closed").toLowerCase()
const TIMEOUT_MS = Number(process.env.OPENCODE_VISION_GUARD_TIMEOUT_MS) || 90_000
const CACHE_TTL_MS = 10 * 60_000
const AUDIT_LOG = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || ".", ".local", "share"), "opencode", "vision-guard.log")
const BYPASS_MARKER = path.join(process.env.HOME || ".", ".config", "opencode", "vision-guard.off")
const NOTICE_FILE = path.join(tmpdir(), `vision-guard-blocked-${process.pid}.txt`)
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i
const INSPECT_MAXDIM = 1600
const INSPECT_QUALITY = 80

const PROMPT = [
  "You are a local privacy screen deciding if this image may be sent to a REMOTE AI API.",
  "Mark it SENSITIVE if it shows any of: credentials (API keys, tokens, passwords, login forms, OTP codes), private messages / chats / email content, financial data (banking, cards, invoices, crypto wallets), government IDs or documents with personal data, medical information, explicit or intimate content, or anything a privacy-conscious user would not want leaving their machine.",
  "When in doubt, answer sensitive=true.",
  "Do NOT quote or reproduce any sensitive text you see.",
  "Answer with STRICT JSON only, no markdown, no prose:",
  '{"sensitive": true|false, "categories": ["..."], "reason": "one short line"}',
].join(" ")

type Verdict = { sensitive: boolean; categories: string[]; reason: string }

const cache = new Map<string, { v: Verdict; t: number }>()

function logLine(s: string) {
  try {
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()} ${s}\n`)
  } catch {}
}

const sips = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile("sips", args, (err) => (err ? reject(err) : resolve()))
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

function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (typeof j?.sensitive === "boolean") {
        return {
          sensitive: j.sensitive === true,
          categories: Array.isArray(j.categories) ? j.categories.map(String).slice(0, 5) : [],
          reason: String(j.reason ?? "").slice(0, 200) || "no reason given",
        }
      }
    } catch {}
  }
  if (/\bnot[_ -]?sensitive\b|"sensitive"\s*:\s*false/i.test(text)) {
    return { sensitive: false, categories: [], reason: "parsed via fallback token scan" }
  }
  return null
}

async function inspectImage(filePath: string): Promise<Verdict> {
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
        messages: [{ role: "user", content: PROMPT, images: [b64] }],
      }),
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      return { sensitive: true, categories: ["guard-error"], reason: `ollama HTTP ${resp.status}` }
    }
    const data: any = await resp.json()
    const v = parseVerdict(extractText(data?.message))
    if (!v) {
      return { sensitive: true, categories: ["guard-error"], reason: "unparseable local verdict (fail closed)" }
    }
    cache.set(key, { v, t: Date.now() })
    return v
  } catch (e: any) {
    const why = e?.name === "AbortError" ? "local inspection timed out" : String(e?.message ?? e)
    if (POLICY === "fail-open") {
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
    `Temporary bypass marker: touch ~/.config/opencode/vision-guard.off`,
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

        let bypass = process.env.OPENCODE_VISION_GUARD === "allow"
        if (!bypass) {
          try {
            bypass = existsSync(BYPASS_MARKER)
          } catch {}
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

        const v = await inspectImage(fp)
        logLine(
          `${v.sensitive ? "BLOCK" : "ALLOW"} ${fp} :: ${v.categories.join(",") || "-"} :: ${v.reason} [${input?.sessionID ?? "?"}]`,
        )
        if (!v.sensitive) return

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
