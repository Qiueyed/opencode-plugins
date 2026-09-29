/**
 * gate.ts
 *
 * Auto-discovered global plugin (~/.config/opencode/plugins/).
 *
 * OFFLOAD HUB: all mechanical verification runs here so the AI never spends
 * turns on it. Collects files touched by edit/write tool calls during a turn,
 * then on session.idle runs the tiered gates - SILENT when clean, toast only
 * actionable findings:
 *   shell files touched          -> shellcheck -S warning
 *   plugins/*.ts touched         -> tsc --noEmit --strict
 *   any config/repo file touched -> class-sweep.sh fast mode (grep sweeps)
 *   a patcher touched            -> class-sweep.sh FULL (bundle marker pairing)
 * Runs whether or not the model remembers the playbook - instruction layer and
 * this plugin are independent (instructions/bug-hunting.md, Automation).
 *
 * - shellcheck absent -> one notice per session, never per turn.
 * - Every failure degrades to silence except toasts (never break a session).
 * - The AI still MAY run these tools mid-turn for immediate feedback; that is
 *   debugging, not duty.
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

const SHELL_RE = /\.(sh|zsh|bash)$/
const TSC_FLAGS = [
  "--noEmit",
  "--strict",
  "--target",
  "es2022",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  "--skipLibCheck",
  "--types",
  "node",
]

export const Gate = (async ({ client }: { client: any }) => {
  const touched = new Set<string>()
  let warnedNotInstalled = false
  const HOME = process.env.HOME || "."
  const CFG = HOME + "/.config/opencode"
  const STATE_FILE = CFG + "/state/state.json"
  const gateDisabled = (): boolean => {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).gateDisabled === true
    } catch {
      return false
    }
  }
  const REPO = HOME + "/Documents/github/opencode-plugins"

  const toast = async (title: string, message: string) => {
    try {
      await client.tui.showToast({
        body: { title, message, variant: "error" },
      })
    } catch {
      try {
        await client.app.log({
          body: { service: "gate", level: "error", message: title + ": " + message },
        })
      } catch {}
    }
  }

  const runShellcheck = (files: string[]) => {
    execFile(
      "shellcheck",
      ["-S", "warning", ...files],
      { timeout: 15_000 },
      (err: { code?: number | string } | null, stdout: string | Buffer) => {
        const code = typeof err?.code === "number" ? err.code : undefined
        if (code === 127 || (!err && !stdout)) {
          if (code === 127 && !warnedNotInstalled) {
            warnedNotInstalled = true
            void toast("GATE", "shellcheck not installed (brew install shellcheck) - shell gate passive until then")
          }
          return
        }
        if (err) {
          const findings = String(stdout).split("\n").filter((l) => /SC\d+/.test(l)).length
          const scripts = new Set(
            String(stdout).match(/^In .*$/gm)?.map((l) => basename(l.replace(/^In |:$/g, ""))) || [],
          )
          void toast(
            "GATE: shellcheck findings",
            `${findings} finding(s) in ${scripts.size || files.length} file(s): ` +
              ([...scripts].slice(0, 3).join(", ") || files.map((f) => basename(f)).join(", ")),
          )
        }
      },
    )
  }

  const runTsc = (files: string[]) => {
    execFile(
      "npx",
      ["tsc", ...TSC_FLAGS, ...files],
      { timeout: 120_000, cwd: CFG },
      (err, stdout) => {
        if (err) {
          const first = String(stdout).split("\n").find((l) => /error TS/.test(l)) || "tsc failed"
          void toast("GATE: tsc", first.slice(0, 280))
        }
      },
    )
  }

  const runSweep = (full: boolean) => {
    execFile(
      "bash",
      [CFG + "/tools/class-sweep.sh"],
      { timeout: 120_000, env: { ...process.env, GATE_FAST: full ? "0" : "1" } },
      (err, stdout) => {
        if (err) {
          const fails = String(stdout)
            .split("\n")
            .filter((l) => l.startsWith("FAIL"))
            .slice(0, 3)
            .join("\n")
          void toast("GATE: class-sweep", (fails || "sweep failed").slice(0, 280))
        }
      },
    )
  }

  return {
    tool: {
      "execute.before": async (input: any, output: any) => {
        try {
          const tool = input?.tool
          if (tool !== "edit" && tool !== "write") return
          const fp = output?.args?.filePath
          if (typeof fp === "string" && existsSync(fp)) touched.add(fp)
        } catch {}
      },
    },
    event: async ({ event }: { event: any }) => {
      try {
        if (event?.type !== "session.idle") return
        if (gateDisabled()) {
          touched.clear()
          return
        }
        if (touched.size === 0) return
        const files = [...touched].filter((f) => existsSync(f))
        touched.clear()
        if (files.length === 0) return
        try {
          const shells = files.filter((f) => SHELL_RE.test(f))
          if (shells.length > 0) runShellcheck(shells)
          const ts = files.filter((f) => /\/plugins\/[^/]+\.ts$/.test(f))
          if (ts.length > 0) runTsc(ts)
          const inScope = files.some((f) => f.startsWith(CFG) || f.startsWith(REPO))
          if (inScope) {
            const patcherTouched = files.some((f) => /patch-opencode-.*\.mjs$/.test(f))
            runSweep(patcherTouched)
          }
        } catch {}
      } catch {}
    },
  }
})
