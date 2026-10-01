## Bug hunting and prevention
> Read this before multi-file edits, refactors, migrations, publishing, or bug hunts. Rules are distilled from real incidents (2026-09-29 sweep: 7 bugs, every one in a named class below).
## Class 1: silent catch-swallowed failures (highest danger)
- Any feature write inside `try { ... } catch {}` dies SILENTLY when the write fails: typecheck passes, no log, feature rots.
- Sweep: `grep -rn -B4 "catch {}" plugins/` then CLASSIFY every hit: diagnostics log = acceptable; feature write (archive, config, notice) = must have a test or a dbg-log in the catch.
- The one harness that existed caught the one bug nothing else could: run `tests/*.test.ts` after ANY refactor of a covered plugin (runner line is in the harness header).
- Typecheck CANNOT catch runtime-API misuse in ESM (`require` is typed as a global but does not exist at runtime). Only execution proves it.
## Class 2: partial multi-file edits (most frequent)
- Any path/schema migration must include ALL spellings of the path: absolute, `$VAR`-relative (`"$D/..."`), tilde (`~/...`), and JSON-escaped forms. Greps that only know one spelling give false-clean verdicts.
- After every cross-file migration: (1) residual grep with all spellings, (2) a FUNCTIONAL round trip through the real tool (grep alone lies), (3) verify BOTH sides of every pair (registry stateFile vs tool write path).
- When applying the same fix to N copies, verify N applications happened - count before and after.
- Copy-order trap: `cp A B` then editing A does not edit B; sync twins AFTER the last edit, then diff to prove it.
## Class 3: done-state detection and marker traps
- "Already patched/done" checks must key on a marker introduced BY the done state, and the check must not be a substring of a newer marker (`v2` is a substring of `v2.1` - version checks must be exact).
- Finders must anchor on something that SURVIVES the modification (injection anchor, post-patch literal), never on pre-patch text that the patch itself removes.
- Idempotency branch runs BEFORE anchor-count checks; a finder that cannot find an already-patched bundle makes every re-run fail forever.
## Class 4: escaping-layer code (asar patchers, code generators)
- A template literal writes the generated code: `\\n` in the template is a newline ESCAPE in the output, `\n` is a REAL newline that breaks string literals. Verify generated output with `cat -v` / `node --check` on the EXTRACTED text, never trust the template read.
- Function-form `replace(() => ...)` when injected code contains `$&`/`${}`; string-form replace interprets them.
- Every injected chunk gets a full-file syntax gate before packing; every pack ends in atomic rename (`ASAR + ".incoming"` then rename) so a running instance keeps its inode.
- Anchor rule: exactly-one-occurrence check, fail loud with the actual count and candidates; finders search by anchor, never by version-pinned chunk filename.
## Class 5: verification theater (checks that check nothing)
- Never take an exit code from a pipe: `cmd | tail` / `cmd | grep -q` report the FILTER's status. Use `cmd; echo exit=$?` unfiltered, or `PIPESTATUS`.
- A hash/diff check must compare two DIFFERENT sources; `git hash-object` on the same path twice always "MATCHES".
- Run the checker named by the shebang: `bash -n` on a `#!/bin/zsh` script reports valid zsh (`<->`) as syntax errors and vice versa.
- Unfiltered output or it did not happen: a failing test behind `| tail -2` is an undetected failure.
- A PREPEND edit must re-anchor: its newString has to END with the old top line, or the replace consumes the header (2026-09-30 godot agent: four WORKLOG header eats, each self-caught). Same family as escape-sequence: script + count asserts, never bare editor replace.
- Escape-sequence strings (`$x27'\n`, ANSI, $x27\\n' literals) NEVER go through editor search-replace: the tool layer re-parses them and can duplicate blocks or drop garbage fragments mid-file (2026-09-30 incident: class-sweep.sh corrupted on first attempt, restored from archive .bak). Apply such edits via a script that asserts replacement COUNT before writing, and archive-.bak first when the file is git-untracked.
## Class 6: stale claims repeated as fact
- Every fact from surveys, other agents, or old worklog entries gets re-verified against disk before entering docs; unverifyable claims are written as "reported, not re-verified".
- Provenance drift is real: repo copies and local copies diverge silently; sweep all twins bidirectionally (repo file vs installed twin) after any feature lands on either side.
- git fetch BEFORE flagging drift: a local-vs-remote difference may just be a stale clone (2026-09-30: the "third oc-ui copy" drift flag was a retired tombstone repo the local had not pulled - fetched first would have resolved it in one command).
## Class 7: historical incident classes (full narratives in the source docs - read before touching these areas)
- Injected-block markers must SELF-CLOSE on their own line: an unclosed /* turns all following code into one comment - valid syntax, runtime ReferenceError (2026-09-23 asar incident). Automated check: class-sweep verifies open/end marker pairing in the shipped bundle.
- Idempotent prependers need STRIP LOOPS: a patcher that adds without removing its previous block stacks copies; duplicate declarations are a launch SyntaxError that survived two verification passes.
- Verify the SHIPPED artifact, never the working copy: extract from the packed output, syntax-check + functionally probe the exact shipped bytes.
- grep -c counts LINES not occurrences: on minified one-line bundles duplicate checks are fiction - count with js.match(/re/g).length in node.
- Guards must throw BEFORE the artifact is written: pre-pack failures leave the system untouched; post-pack failures brick it.
- Cached @latest deps silently revert patches: re-verify the DEPLOYED copy after any dependency refresh; detection = a debug log growing while its enable env var is unset.
- Env-override timing: module constants freeze process.env at import - harnesses set env BEFORE dynamic import, or tests silently write real production paths (this exact trap is documented in tests/error-root-cause.test.ts header).
- WAL-mode SQLite: -readonly opens flake CANTOPEN(14) on live-app databases; use plain read-write opens under an app-closed guard + backup (janitor pattern).
- JSONC vs JSON: opencode tolerates trailing commas, python json.load does not - normalize before scripting edits against opencode.jsonc.
- Error dialects: the same TypeError prints differently under Bun CLI vs Node server - grep BOTH patterns when hunting.
- Source: engineering-lessons.md (Injected Code & Artifact Patching, Testing Methodology, Cross-Stack Pitfalls sections), file-handling-safety.md (encoding/Unicode byte traps), references/ai-collaboration-governance.md (narratives).
## Designated-reader rule (user realization)
- Verification nobody reads is theater. Every verification path needs a NAMED reader: in-turn sweeps are read by the AI now; gate failures toast for the human now; EVERY gate result persists to state/sweep-status.json - the next session reads system health in one file before trusting anything.
- Do not add print-and-pray surfaces: if a check output has no reader (human toast, AI in-turn, or the status ledger), delete the check or wire a reader.
## OFFLOAD PRINCIPLE (user directive)
- The AI builds and fixes; the MACHINERY verifies. Never assign a mechanical check to the model when a gate can run it: gate.ts (session.idle) owns shellcheck/tsc/class-sweep triggers, the janitor owns close-time maintenance, run-all.mjs owns the fuzz suite.
- The playbook\x27s manual sweep instructions are FALLBACKS (debugging feedback, or when a gate is missing) - not the AI\x27s standing duty.
## Automation (run this, do not re-derive by hand)
- `tools/class-sweep.sh` encodes every static sweep: bare require in ESM, stale root paths (all spellings), version-pinned chunk paths, non-atomic asar writes, per-patcher syntax/parse-back gates, registry validity. Exit 1 on any hit; run after ANY multi-file edit or migration; also in the repo at tools/class-sweep.sh.
- Hostile-value batteries live in `tests/fuzz/` (runner.mjs): source-slice eval with shadowed Date for pure logic (notify window math: 23 cases incl midnight-crossing, wrap-around weeks, year boundaries, NaN hours) + subprocess batteries with overridden HOME for click-executed CLIs (16 cases). Pattern: bounded corpora, isolated env, assert no-throw + bounded time + sandbox isolation. Add a battery when touching pure-logic code with no coverage.
## Clustered-fix rule
- One instance of a bug class means more exist: when a bug is confirmed, immediately sweep the whole class (`require(` in ESM, root-path refs, `copyFileSync(packed, ASAR)`, version-pinned chunk paths, `catch {}` around writes) across every consumer directory, not just the file that showed symptoms.
## Fixed-bug reporting (mandatory, user directive)
- EVERY fixed bug: (1) regression lock - encode the fault as a permanent assertion or battery case; (2) CHANGELOG.md entry in the publishing session; (3) a new playbook class here if it was novel. A fix without all three will regress.
- CHANGELOG.md refreshes every publishing session (periodic, not per-fix).
## GDScript (.gd) - Godot projects (scanner: tools/gd-sweep.sh <project>)
- yield is dead in Godot 4 (match statements only); export var is 3.x (use @export). Strip comments before matching - domain jargon in comments false-positives the keyword scan (planetary-defense: 10 "yield set" comments).
- Integer division truncates silently; float == on literals is a trap (12 in planetary-defense).
- randi() % n biases the distribution (4 instances in World.gd) - use randi_range() or randf().
- String get_node("A/B") paths break on scene renames - prefer %UniqueName (6 instances).
- Physics bodies belong in _physics_process, not _process (38 _process defs in planetary-defense - mostly fine for non-physics sim logic, check case by case).
- connect() returns an Error: check it and disconnect on free (205 connect sites in planetary-defense).
- .gdignore is NOT enough for archived snapshot code: the editor scan honors it but DIRECT loads (restore buffers, layout, recent files) bypass it and re-parse duplicate class_name copies every start ("hides a global script class" cascade, 2026-09-30). Purge .godot caches + rebuild the class cache with the editor closed: tools/godot-cache-purge.sh; class-sweep --project now FAILs on both the missing .gdignore and stale cache references.
## Upstream-first
- Generic language checks defer to the established tools when available: shellcheck (shell - SC-series), semgrep (custom pattern rules), typescript-eslint (no-require-imports, no-empty), yamllint/actionlint/jq. Install before hand-writing greps for what they already cover.
- class-sweep.sh keeps only PROJECT-SPECIFIC contracts no generic tool can know (state paths, marker pairing, registry validity, per-patcher gates) + glue that runs the upstream tools when installed.
- Canonical references: github.com/koalaman/shellcheck, semgrep.dev/registry, typescript-eslint.io/rules.
- END-OF-MESSAGE RITUAL: if any shell file (.sh/.zsh/bash) was touched or mentioned this turn, run `shellcheck -S warning <files>` UNFILTERED before ending the message; style notes do not fail, warnings do.
- MECHANICAL LAYER: plugins/gate.ts runs shellcheck on touched shell files at every session.idle regardless of model compliance (instruction layer and plugin layer are independent; the plugin toasts findings, silence = clean).
- BUG HUNTS OPEN WITH THE UPSTREAM TOOL: shellcheck (or semgrep/eslint for TS) runs FIRST on the suspected files, hand-greps second. The generic tool sees what project greps structurally cannot (proven 2026-09-29: 8 findings my sweeps had passed).
- The layers stack, none is vain: shellcheck/semgrep own generic language correctness; class-sweep owns project contracts no generic tool can know (marker pairing, state paths, registry validity).
## Dangerous-areas ranking (where to hunt first)
1. `catch {}` around feature writes - silent, untestable by typecheck.
2. Multi-instance contracts (marker files, registries, symlinked paths, repo/local twins) - every consumer is a failure point.
3. Escaping layers (patcher templates, generated code) - wrong at write-time, invisible at read-time.
4. Version-pinned identifiers - break on every update; replace with anchor searches.
5. Silently superseded features - the local/repo drift class; the drift is invisible until someone diffs.
## State and contract files
- Marker/value files live under `~/.config/opencode/state/`; backups under `archive/`; consumers check exact paths - moving any of them means rewriting every consumer in the same change.
- Never `os.replace`/rename ONTO the root notifier symlinks (replaces the link); write the `state/` real path or open in-place.
