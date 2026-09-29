/**
 * error-root-cause.ts
 *
 * Shows the ROOT CAUSE of chat/provider errors as a toast instead of the
 * generic "server error" text, and archives every diagnosis to a local
 * JSONL file (raw error + classification) so patterns become visible.
 *
 * How: classifies the raw provider error (nested JSON bodies, status codes,
 * known signatures: quota, auth, 429, context overflow, 5xx outage, TLS,
 * network...) into {status, code, root, hint} and toasts the result. The
 * archive lives at ~/.config/opencode/error-diagnosis.jsonl by default
 * (env: OPENCODE_ERROR_LOG) and stays on your machine.
 *
 * NOTE for contributors: export ONLY the plugin factory from this file.
 * OpenCode's loader treats EVERY exported function of a plugin module as a
 * plugin and CALLS it with the plugin input; exporting helper functions
 * makes the loader invoke them with an object and the whole plugin fails
 * to load. That is why the classifier below is a local, non-exported
 * function.
 *
 * Install: drop into ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project), then restart OpenCode.
 *
 * Config (env):
 *   OPENCODE_ERROR_LOG                     archive path (default shown above)
 */
import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"

const OUT_LOG =
  process.env.OPENCODE_ERROR_LOG ||
  homedir() + "/.config/opencode/error-diagnosis.jsonl"
const DEDUPE_MS = 10_000
const TOAST_MAX = 300

type Diagnosis = {
  root: string
  hint: string
  status?: string
  code?: string
  inner?: string
}

// Ordered: first match wins. Keep the list most-specific-first.
const RULES: Array<{ re: RegExp; root: string; hint: string; status?: string }> = [
  {
    re: /free usage limit|free.?pool.*(limit|exhaust)/i,
    root: "provider free-tier rate limit hit",
    hint: "Wait for the rate window to reset or switch to a paid model.",
    status: "FREE-POOL",
  },
  {
    re: /insufficient_quota|quota exceeded|exceeded your current quota|billing|balance is not enough|arrears/i,
    root: "quota/billing exhausted on the provider account",
    hint: "Top up or switch provider; check plan usage window.",
    status: "QUOTA",
  },
  {
    re: /invalid[_ ]?api[_ ]?key|unauthorized|authentication|401\b/i,
    root: "API key invalid, expired, or missing",
    hint: "Check the provider apiKey in your config or run the auth login flow.",
    status: "AUTH",
  },
  {
    re: /forbidden|permission denied|access denied|403\b|no permission|not authorized/i,
    root: "key/plan lacks access to this model or endpoint",
    hint: "Verify plan coverage for this model id and endpoint.",
    status: "FORBIDDEN",
  },
  {
    re: /context length|maximum context|too many tokens|prompt is too long|request too large|exceed.{0,20}token/i,
    root: "context window overflow: prompt exceeds model limit",
    hint: "Start a new session or compact; remove large attachments.",
    status: "CONTEXT",
  },
  {
    re: /429\b|rate.?limit|too many requests|throttl/i,
    root: "rate limited (429) by the provider",
    hint: "Back off; reduce parallel sessions; peak-hour windows are tighter.",
    status: "429",
  },
  {
    re: /model not (?:found|exist)|invalid model|unknown model|no such model|model_does_not_exist/i,
    root: "model id not resolvable on this provider/endpoint",
    hint: "Check the model listing and the model id prefix.",
    status: "MODEL",
  },
  {
    re: /certificate|ssl|tls/i,
    root: "TLS/certificate verification failed (proxy or missing CA)",
    hint: "Check proxy interception; refresh CA bundle.",
    status: "TLS",
  },
  {
    re: /econnrefused|enotfound|etimedout|econnreset|fetch failed|cannot connect|network|getaddrinfo/i,
    root: "network/DNS failure reaching the endpoint",
    hint: "Check connectivity, proxy, and provider baseURL.",
    status: "NETWORK",
  },
  {
    re: /aborted|abort|timeout|timed?\s?out|socket hang up/i,
    root: "request aborted or timed out mid-stream",
    hint: "Retry; if persistent, the provider is dropping long streams.",
    status: "ABORT",
  },
  {
    re: /\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|upstream|overloaded/i,
    root: "provider-side outage or overload (5xx)",
    hint: "Retry shortly; switch model/endpoint if it persists.",
    status: "5xx",
  },
  {
    re: /\b500\b|internal server error|internal error|"1113"|code.{0,4}1113/i,
    root: "provider internal error (their side, not your prompt)",
    hint: "Retry once; persistent 500s: switch model or endpoint.",
    status: "500",
  },
]

// Extract a nested provider body: {"error":{"code":"1113","message":"..."}}
// or {"error":"message string"} or bare {"message":"..."}.
function extractInner(raw: string): { code?: string; inner?: string } {
  const first = raw.indexOf("{")
  if (first !== -1) {
    const last = raw.lastIndexOf("}")
    if (last > first) {
      try {
        const obj = JSON.parse(raw.slice(first, last + 1))
        const e = obj && obj.error
        if (e && typeof e === "object") {
          return {
            code: e.code != null ? String(e.code) : undefined,
            inner:
              typeof e.message === "string" && e.message
                ? e.message
                : typeof e === "string"
                  ? e
                  : undefined,
          }
        }
        if (typeof e === "string" && e) return { inner: e }
        if (typeof obj.message === "string" && obj.message)
          return { inner: obj.message }
      } catch {
        // not JSON; fall through to regex
      }
    }
  }
  const m = raw.match(/"message"\s*:\s*"([^"]{4,300})"/)
  if (m) return { inner: m[1] }
  return {}
}

function diagnose(raw: string): Diagnosis {
  const { code, inner } = extractInner(raw)
  const haystack = inner ? inner + " || " + raw : raw
  for (const rule of RULES) {
    if (rule.re.test(haystack)) {
      return {
        root: rule.root,
        hint: rule.hint,
        status: rule.status,
        code,
        inner: inner ? inner.slice(0, 400) : undefined,
      }
    }
  }
  return {
    root: "unclassified provider error (no known signature)",
    hint: "Full raw error archived in the diagnosis log; add a RULE if this is a new pattern.",
    code,
    inner: inner ? inner.slice(0, 400) : raw.slice(0, 400),
  }
}

export const ErrorRootCause: Plugin = async ({ client }) => {
  const lastBySession = new Map<string, { sig: string; at: number }>()

  const toast = async (title: string, message: string) => {
    try {
      await client.tui.showToast({
        body: { title, message, variant: "error" },
      })
    } catch {
      try {
        await client.app.log({
          body: {
            service: "error-root-cause",
            level: "warn",
            message: "toast failed (headless?)",
          },
        })
      } catch {}
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      try {
        const type = event && event.type
        if (type !== "session.error" && type !== "session.next.step.failed")
          return
        const p = (event && event.properties) || {}
        const err = p.error
        const raw =
          typeof err === "string"
            ? err
            : err && typeof err.message === "string" && err.message
              ? err.message
              : ""
        if (!raw) return

        const sid = String(p.sessionID || p.assistantMessageID || "unknown")
        const sig = type + "|" + raw.slice(0, 200)
        const now = Date.now()
        const prev = lastBySession.get(sid)
        if (prev && prev.sig === sig && now - prev.at < DEDUPE_MS) return
        lastBySession.set(sid, { sig, at: now })
        if (lastBySession.size > 200) {
          for (const [k, v] of lastBySession) {
            if (now - v.at > 300_000) lastBySession.delete(k)
          }
        }

        const d = diagnose(raw)
        const label =
          (d.status ? d.status + " " : "") +
          (d.code ? "[code " + d.code + "] " : "")
        const msg = (label + d.root + "\n" + d.hint).slice(0, TOAST_MAX)
        await toast("ERROR ROOT CAUSE", msg)

        const line = JSON.stringify({
          ts: new Date().toISOString(),
          session: sid,
          event: type,
          status: d.status,
          code: d.code,
          root: d.root,
          hint: d.hint,
          inner: d.inner,
          raw: raw.slice(0, 4000),
        })
        try {
          appendFileSync(OUT_LOG, line + "\n")
        } catch {}
        try {
          await client.app.log({
            body: {
              service: "error-root-cause",
              level: "error",
              message: label + d.root + " | " + d.hint + " | raw: " + raw.slice(0, 500),
            },
          })
        } catch {}
      } catch {}
    },
  }
}
