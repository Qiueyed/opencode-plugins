#!/bin/bash
# class-sweep - automated bug-class sweeps from instructions/bug-hunting.md.
# Exit 1 on ANY hit; run after multi-file edits, migrations, or publishes.
#
#   class-sweep.sh                      opencode config + plugins repo (default)
#   class-sweep.sh --project <dir>      universal checks for any managed project:
#                                       .bak clutter, contracts.json validation,
#                                       doc-reference staleness (Godot scene-
#                                       manifest + save-version patterns)
set -u

# ---------- project mode (universal checks, contracts.json-driven) ----------
if [ "${1:-}" = "--project" ]; then
  PROJ="${2:?usage: class-sweep.sh --project <dir>}"
  cd "$PROJ" || exit 1
  fails=0
  say() { printf '%s\n' "$*"; }
  # Godot save-file pattern: a project's contract graph is DECLARED, the sweep
  # validates the declaration against reality.
  if [ -f contracts.json ]; then
    python3 - <<'PY' || fails=$((fails+1))
import json, os, sys
c = json.load(open("contracts.json"))
missing = [p for p in c.get("mustExist", []) if not os.path.exists(p)]
for doc in c.get("docs", []):
    f = doc.get("file", "")
    for ref in doc.get("references", []):
        if not os.path.exists(ref):
            missing.append(f"{f} -> {ref}")
if missing:
    print("FAIL contract violations:")
    for m in missing:
        print("     ", m)
    sys.exit(1)
print(f"ok   contracts: {len(c.get('mustExist', []))} paths + doc refs validated")
PY
  else
    say "note no contracts.json (declare one: {\"mustExist\": [...], \"docs\": [...]})"
  fi
  # .bak clutter: git holds history; stray .bak files are Class 2 bait
  BAKS=$(find . -name "*.bak*" -not -path "./addons/*" -not -path "./archive/*" -not -path "./.git/*" | wc -l | tr -d ' ')
  if [ "$BAKS" -gt 5 ]; then
    fails=$((fails+1)); say "FAIL .bak clutter: $BAKS files (git is the history; archive/ the rest)"
    find . -name "*.bak*" -not -path "./addons/*" -not -path "./archive/*" -not -path "./.git/*" | head -5 | sed 's/^/     /'
  else
    say "ok   .bak clutter: $BAKS"
  fi
  # scene integrity: every ext_resource path in every .tscn/.tres must exist on disk
  # (a renamed/deleted dependency breaks the scene silently until it loads)
  python3 - <<'PY' || fails=$((fails+1))
import os, re, sys
missing = []
scanned = 0
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in (".git", "archive", "addons")]
    for f in files:
        if not f.endswith((".tscn", ".tres")):
            continue
        scanned += 1
        p = os.path.join(root, f)
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for m in re.finditer(r'^\[ext_resource[^\]]*path="(res://[^"]+)"', text, re.M):
            rel = m.group(1)[len("res://"):]
            if rel and not os.path.exists(rel):
                missing.append(f"{p} -> {m.group(1)}")
if missing:
    print(f"FAIL scene ext_resource missing: {len(missing)}")
    for x in missing[:5]:
        print("     ", x)
    sys.exit(1)
print(f"ok   scene integrity: {scanned} scenes/resources, all ext_resource paths exist")
PY
  # counter drift: STATUS.md's counters line must match WORKLOG.md's actual max doc/pass (ledger desync = stale number source).
  # Convention-optional: projects without STATUS/WORKLOG skip cleanly.
  python3 - <<'PY' || fails=$((fails+1))
import os, re, sys
if not (os.path.exists("STATUS.md") and os.path.exists("WORKLOG.md")):
    print("skip counter drift (no STATUS.md/WORKLOG.md convention)")
    sys.exit(0)
st = open("STATUS.md", encoding="utf-8", errors="replace").read()
m = re.search(r"counters: doc (\d+), pass (\d+)", st)
if not m:
    print("FAIL counter drift: STATUS.md has no 'counters: doc N, pass M' line"); sys.exit(1)
sdoc, spass = int(m.group(1)), int(m.group(2))
wdoc = wpass = 0
for line in open("WORKLOG.md", encoding="utf-8", errors="replace"):
    if not line.startswith("## "):
        continue
    h = re.search(r"\[doc (\d+)(?:, pass (\d+))?\]", line)
    if not h:
        continue
    wdoc = max(wdoc, int(h.group(1)))
    if h.group(2):
        wpass = max(wpass, int(h.group(2)))
bad = []
if wdoc != sdoc:
    bad.append(f"doc STATUS={sdoc} WORKLOG={wdoc}")
if wpass != spass:
    bad.append(f"pass STATUS={spass} WORKLOG={wpass}")
if bad:
    print("FAIL counter drift: " + "; ".join(bad)); sys.exit(1)
print(f"ok   counters: doc {sdoc} pass {spass} match WORKLOG")
PY
  # archive guard: snapshot scripts carry class_name duplicates - without .gdignore the editor registers them as second global classes and every referencing script parse-errors ("hides a global script class")
  if [ -d archive ] && [ ! -f archive/.gdignore ]; then
    fails=$((fails+1)); say "FAIL archive/ has no .gdignore (editor class-collision risk: snapshot class_name copies get scanned)"
  else
    say "ok   archive guard: .gdignore present"
  fi
  # stale class registrations: ANY engine cache referencing archive/ re-parses snapshot copies on editor start even with .gdignore present - the scan honors .gdignore but DIRECT file loads (restore buffers, layout, recent files) bypass it (2026-09-30 Fleet incident, doc 521/522/523)
  if [ -d .godot ]; then
    STALE=$(grep -rIl "res://archive/" .godot/ 2>/dev/null)
    if [ -n "$STALE" ]; then
      fails=$((fails+1)); say "FAIL stale archive references in engine caches (quit the editor, purge the listed files, reopen):"
      printf '%s\n' "$STALE" | sed 's/^/     /'
    else
      say "ok   archive references: all engine caches clean"
    fi
  else
    say "note no .godot/ yet (first import will create it)"
  fi
  # pairing note: if the project ships its own deeper probe, remind about it
  grep -q "consistency-probe" AGENTS.md 2>/dev/null && say "note project has its own consistency-probe - run it for registry/JSON parity"
  echo "---"
  if [ "$fails" -eq 0 ]; then say "PROJECT SWEEP: ALL CLEAN"; else say "PROJECT SWEEP: $fails CLASS(ES) FAILED"; exit 1; fi
  exit 0
fi

D="${1:-$HOME/.config/opencode}"
R="${2:-$HOME/Documents/github/opencode-plugins}"
fails=0
say() { printf '%s\n' "$*"; }
check() { # check <label> <dir> <grep-args...>
  local label="$1"; shift; local dir="$1"; shift
  local out
  out=$(grep -rn "$@" "$dir" 2>/dev/null | grep -vE "\.bak|node_modules|/archive/|\.log" | head -5)
  if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL $label"; printf '%s\n' "     ${out//$'\n'/$'\n'     }"; else say "ok   $label"; fi
}
# Class 1: bare require() in ESM plugins (typed as global, absent at runtime)
check "bare require in ESM" "$D/plugins" -e "require(" --include="*.ts" --include="*.js"
# Class 2: stale root paths for relocated state/contract files (absolute + tilde + $D forms)
for pat in "opencode/trim-keep.txt" "opencode/peak-banner.off" "opencode/notify-autogrant.on" "opencode/vision-guard.off" "opencode/model-quality.json" "opencode/ui-patch.json" "opencode/plugin-manager.json" "opencode/.trim-keep-"; do
  out=$(grep -rn "$pat" "$D/plugins" "$D/patches" "$D/tools" "$D/instructions" "$R" 2>/dev/null | grep -v "state/$pat" | grep -vE "\.bak|/archive/|janitor\.log|node_modules|class-sweep\.sh" | head -3)
  if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL stale root path: $pat"; printf '%s\n' "     ${out//$'\n'/$'\n'     }"; else say "ok   root path: $pat"; fi
done
# Class 3: version-pinned chunk paths in asar patchers (must anchor-search)
check "version-pinned chunk paths" "$D/patches" -E "chunks/[a-zA-Z]+-[A-Za-z0-9_-]+\.js"
# Class 4: non-atomic asar writes (must be .incoming + rename)
out=$(grep -rn "copyFileSync(packed, ASAR)" "$D/patches" "$R/desktop-patch" 2>/dev/null | grep -v "\.incoming" | head -3)
if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL non-atomic asar write"; printf '%s\n' "     ${out//$'\n'/$'\n'     }"; else say "ok   atomic asar writes"; fi
# Class 5: escaping-layer - JS patchers need a syntax gate; the JSON patcher needs a parse-back gate
for p in "$D"/patches/patch-opencode-*.mjs; do
  grep -q -- '--check' "$p" || { fails=$((fails+1)); say "FAIL no syntax gate: $(basename "$p")"; }
done
say "ok   syntax gates ($(find "$D/patches" -maxdepth 1 -name 'patch-opencode-*.mjs' 2>/dev/null | wc -l | tr -d ' ') JS patchers)"
grep -q 'parse-back gate' "$D/patches/patch-models-cache.mjs" || { fails=$((fails+1)); say "FAIL models-cache: no parse-back gate"; }
say "ok   models-cache parse-back gate"
# Class 6: registry validity + stale stateFile entries
python3 - "$D/plugins-menu.json" <<'PY' || fails=$((fails+1))
import json, sys
r = json.load(open(sys.argv[1]))
stale = []
def walk(items):
    for i in items:
        if i.get("stateFile"): stale.append(i.get("label"))
        walk(i.get("submenu", []))
walk(r.get("items", []))
if stale:
    print("FAIL stale stateFile entries:", stale); sys.exit(1)
print("ok   registry: valid JSON, no stale stateFile")
PY
# Class 7: injected-block markers must pair open+end in the SHIPPED bundle
# (slow: full asar extract - skipped when GATE_FAST=1; run full at least at close time)
ASAR="/Applications/OpenCode.app/Contents/Resources/app.asar"
if [ "${GATE_FAST:-0}" = "1" ]; then
  say "skip marker pairing (GATE_FAST=1)"
elif [ -f "$ASAR" ] && command -v npx >/dev/null; then
  TMPD=$(mktemp -d)
  if npx --yes @electron/asar extract "$ASAR" "$TMPD" >/dev/null 2>&1; then
      check_pair() {
      local file="$1" name="$2"
      local o e
      # grep -c prints 0 AND exits 1 on no-match: dropping the count here silently swallowed the FAIL case this check exists for
      o=$(grep -c "== ${name}" "$file" 2>/dev/null); o=${o:-0}
      e=$(grep -c "== end ${name} ==" "$file" 2>/dev/null); e=${e:-0}
      if [ "${o:-0}" -lt 1 ] || [ "${e:-0}" -ne "${o:-0}" ]; then
        fails=$((fails+1)); say "FAIL marker pairing: ${name} (open=${o} end=${e})"
      fi
    }
    check_pair "$TMPD/out/main/index.js" "opencode-plugins-menu-patch"
    say "ok   marker pairing (shipped bundle)"
  else
    say "skip marker pairing (bundle extract failed)"
  fi
  rm -rf "$TMPD"
else
  say "skip marker pairing (bundle or npx unavailable)"
fi
echo "---"
# Godot save-version pattern: state.json carries a schema; consumers and this sweep can key migrations on it
python3 - "$D/state/state.json" <<'PY' || fails=$((fails+1))
import json, sys
try:
    st = json.load(open(sys.argv[1]))
except Exception as e:
    print("FAIL state.json unparseable:", e); sys.exit(1)
if st.get("schema") != 2:
    print("FAIL state.json schema", st.get("schema"), "!= 2 (migration needed)"); sys.exit(1)
print("ok   state.json schema 2,", len(st) - 1, "keys")
PY
# Upstream pass: generic language checks defer to the established tools when
# installed (class-sweep only adds what no generic tool can know: project contracts)
if command -v shellcheck >/dev/null 2>&1; then
  SH_FILES=()
  for f in "$D"/tools/*.sh "$D/tools/trim-keep" "$D/tools/state-toggle" "$D/tools/janitor.sh" "$R/janitor/janitor.sh" "$R/janitor/trim-keep" "$R/desktop-patch/oc-ui"; do
    # ShellCheck speaks sh/bash only - skip zsh scripts (SC1071)
    [ -f "$f" ] && ! head -1 "$f" | grep -q "#!.*/zsh" && SH_FILES+=("$f")
  done
  # stock bash 3.2 + set -u: an empty array aborts on "${SH_FILES[@]}"
  if [ "${#SH_FILES[@]}" -eq 0 ]; then
    say "skip shellcheck (no candidate files)"
  else
    ERRS=$(shellcheck -S warning "${SH_FILES[@]}" 2>/dev/null | grep -c "SC[0-9]" || true)
    STYLE=$(shellcheck -S style "${SH_FILES[@]}" 2>/dev/null | grep -c "SC[0-9]" || true)
    if [ "${ERRS:-0}" -gt 0 ]; then
      fails=$((fails+1)); say "FAIL shellcheck warnings+: $ERRS"
    else
      say "ok   shellcheck: 0 warnings+ (${STYLE:-0} style notes)"
    fi
  fi
else
  say "skip shellcheck (not installed - brew install shellcheck)"
fi
say "upstream note: semgrep/eslint are the heavier upstream equivalents for TS rules (no-require-imports, no-empty); install if plugin logic grows."
if [ "$fails" -eq 0 ]; then say "CLASS SWEEP: ALL CLEAN"; else say "CLASS SWEEP: $fails CLASS(ES) FAILED"; exit 1; fi
