// godot-gate-guard.ts
//
// Tool-layer enforcement of hang-prevention rules for AI agents working on
// Godot projects. Background: headless Godot runs are a classic AI-agent
// hang class - a parse-dead script probe never reaches its quit() call and
// the process sits forever; and engine args placed AFTER Godot's " -- "
// user-arg separator are silently ignored, so a misplaced --quit-after hangs
// a run the same way. Reading project docs about this is voluntary for a
// model - this plugin makes the rule MECHANICAL.
//
// Any bash call that would launch an ungated headless Godot run is NEUTERED
// before it executes: the command is replaced with a no-op echo of the guard
// reason, so the model reads WHY in the tool result and reroutes through the
// project's gate wrapper (see below). Mutation, not throw: a thrown hook
// error surfaces as a runtime defect in current OpenCode builds, while arg
// mutation keeps the tool call alive and informative.
//
// Scoping - the plugin is INERT unless one of these matches:
//   1. the command text references a configured project token (default:
//      any project that has the gate wrapper, see zero-config below)
//   2. the session directory is inside such a project
//   3. an explicit absolute --path to a DIFFERENT project opts the command
//      out - sessions in a guarded project must not swallow foreign runs
//
// The gate wrapper convention: a script at tools/gate (relative to the
// project root) that launches Godot with instant kill on the first error
// line plus a wall-clock cap:
//   ./tools/gate <label> <timeout_s> -- <godot args>
// Zero-config: a session directory containing tools/gate is treated as a
// guarded project automatically, no configuration needed.
//
// What gets blocked (bash never launches Godot directly):
//   1. headless Godot runs NOT wrapped in the gate wrapper - the wrapper's
//      error-line kill + wall-clock cap is the only thing standing between a
//      parse-dead probe and an infinite process. Fast one-shots exempt:
//      --check-only, --import, --version, --help, --export-*.
//   2. ANY Godot run (headless or windowed) with --quit-after written AFTER
//      the " -- " separator - Godot never sees it and the boot runs forever.
// Extra project-specific exemptions can be added via a regex (see config).
//
// Install: drop into ~/.config/opencode/plugins/ (global - sessions may
// start from the project dir or its parent) or .opencode/plugins/ (project),
// then restart OpenCode.
//
// Config (env or ~/.config/opencode/godot-gate-guard.settings.json,
// env wins; read once at startup):
//   OPENCODE_GODOT_GATE_TOKENS   comma-separated project name/path fragments
//                                to guard (default: "" = only auto-detected
//                                tools/gate projects)
//   OPENCODE_GODOT_GATE_WRAPPER  wrapper path fragment treated as "gated"
//                                (default "tools/gate")
//   OPENCODE_GODOT_GATE_EXEMPT   extra regex of command fragments that may
//                                run bare headless (optional)
//   OPENCODE_GODOT_GATE=off      disable the plugin
import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const SETTINGS_FILE = path.join(process.env.HOME || ".", ".config", "opencode", "godot-gate-guard.settings.json")
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

const DISABLED = setting("OPENCODE_GODOT_GATE", "") === "off"
const WRAPPER = setting("OPENCODE_GODOT_GATE_WRAPPER", "tools/gate")
const EXTRA_TOKENS = setting("OPENCODE_GODOT_GATE_TOKENS", "")
const EXTRA_EXEMPT = setting("OPENCODE_GODOT_GATE_EXEMPT", "")

function isGodotRun(cmd: string): boolean {
  return cmd.includes("MacOS/Godot") || /\bgodot\b/.test(cmd)
}

function isGated(cmd: string): boolean {
  return cmd.includes(WRAPPER)
}

// Commands that exit on their own in milliseconds - no hang risk. These are
// standard Godot CLI modes that cannot hang.
function fastOneShot(cmd: string): boolean {
  return (
    /--check-only\b/.test(cmd) ||
    /--import\b/.test(cmd) ||
    /--version\b/.test(cmd) ||
    /--help\b/.test(cmd) ||
    // export one-shots terminate on their own
    /--export-(release|pack|preset)\b/.test(cmd) ||
    // project-specific extra exemptions (validated loosely; bad regex = ignored)
    (EXTRA_EXEMPT ? safeRegexTest(EXTRA_EXEMPT, cmd) : false)
  )
}

function safeRegexTest(pattern: string, cmd: string): boolean {
  try {
    return new RegExp(pattern).test(cmd)
  } catch {
    return false
  }
}

function gateHint(): string {
  return (
    `Route it through the gate wrapper instead: ${WRAPPER} <label> <timeout_s> -- <godot args> ` +
    "(instant kill on the first error line, wall-clock cap at the timeout)."
  )
}

function violation(cmd: string): string | null {
  if (!isGodotRun(cmd)) return null
  if (isGated(cmd)) return null
  // An explicit absolute --path to a different project opts the command out -
  // the session dir alone must not drag foreign Godot runs under this guard.
  const pathMatch = cmd.match(/--path\s+(\S+)/)
  if (pathMatch && /^[/~]/.test(pathMatch[1])) {
    const p = pathMatch[1]
    const foreign = !WRAPPER.split("/").some((t) => t && p.includes(t)) && !EXTRA_TOKENS.split(",").some((t) => t.trim() && p.includes(t.trim()))
    if (foreign) return null
  }
  // Engine args after the " -- " separator are user args; a misplaced
  // --quit-after means the boot never quits. Checked for windowed runs too -
  // a misplaced flag hangs those just the same.
  const sep = cmd.indexOf(" -- ")
  if (sep >= 0 && cmd.indexOf("--quit-after", sep) !== -1) {
    return (
      '[GODOT GATE GUARD] blocked: --quit-after appears AFTER the " -- " separator, so Godot receives it as a user arg and ignores it - the run hangs forever. Engine args must sit BEFORE the -- separator. ' +
      gateHint()
    )
  }
  if (/--headless\b/.test(cmd) && !fastOneShot(cmd)) {
    return (
      "[GODOT GATE GUARD] blocked: ungated headless Godot run - a parse-dead script probe never reaches its quit() and the process sits forever. " +
      gateHint() +
      " Fast one-shot exemptions (--check-only, --import, --version, --help, --export-*) may run bare."
    )
  }
  return null
}

export const godotGateGuard = (async ({ client, directory }) => {
  // Zero-config scoping: remember which directories look like guarded
  // projects (they contain the gate wrapper).
  const guardedDirs = new Set<string>()

  function inGuardedProject(cmd: string, dir: string | undefined): boolean {
    const tokens = EXTRA_TOKENS.split(",").map((t) => t.trim()).filter(Boolean)
    for (const t of tokens) {
      if (t && (cmd.includes(t) || (typeof dir === "string" && dir.includes(t)))) return true
    }
    if (typeof dir === "string" && dir) {
      if (guardedDirs.has(dir)) return true
      try {
        // the session dir itself, or anywhere up to the git root, may hold
        // the wrapper; checking the immediate dir + one level up covers the
        // standard layouts without walking the whole tree
        for (const d of [dir, path.dirname(dir)]) {
          if (existsSync(path.join(d, WRAPPER))) {
            guardedDirs.add(dir)
            return true
          }
        }
      } catch {}
    }
    return false
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (DISABLED) return
        if (input?.tool !== "bash") return
        const cmd = typeof output?.args?.command === "string" ? output.args.command : ""
        if (!cmd) return
        if (!inGuardedProject(cmd, typeof directory === "string" ? directory : undefined)) return
        const v = violation(cmd)
        if (!v) return
        try {
          await client.app.log({
            body: { service: "godot-gate-guard", level: "warn", message: v + " | cmd: " + cmd.slice(0, 300) },
          })
        } catch {}
        try {
          await client.tui.showToast({ body: { title: "GODOT GATE GUARD", message: v.slice(0, 200), variant: "warning" } })
        } catch {}
        // Neuter via mutation: the shell runs a no-op that surfaces the
        // reason; the original command never executes.
        const shellSafe = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$")
        if (output && typeof output === "object") (output as any).args.command = `echo "${shellSafe}"; exit 1`
      } catch {
        // guard-internal failure must never break the tool call itself
      }
    },
  }
}) satisfies Plugin

export default godotGateGuard
