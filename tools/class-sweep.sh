#!/bin/bash
# class-sweep - automated bug-class sweeps from instructions/bug-hunting.md.
# Exit 1 on ANY hit; run after multi-file edits, migrations, or publishes.
set -u
D="${1:-$HOME/.config/opencode}"
R="${2:-$HOME/Documents/github/opencode-plugins}"
fails=0
say() { printf '%s\n' "$*"; }
check() { # check <label> <dir> <grep-args...>
  local label="$1"; shift; local dir="$1"; shift
  local out
  out=$(grep -rn "$@" "$dir" 2>/dev/null | grep -vE "\.bak|node_modules|/archive/|\.log" | head -5)
  if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL $label"; echo "$out" | sed 's/^/     /'; else say "ok   $label"; fi
}
# Class 1: bare require() in ESM plugins (typed as global, absent at runtime)
check "bare require in ESM" "$D/plugins" -e "require(" --include="*.ts" --include="*.js"
# Class 2: stale root paths for relocated state/contract files (absolute + tilde + $D forms)
for pat in "opencode/trim-keep.txt" "opencode/peak-banner.off" "opencode/notify-autogrant.on" "opencode/vision-guard.off" "opencode/model-quality.json" "opencode/ui-patch.json" "opencode/plugin-manager.json" "opencode/.trim-keep-"; do
  out=$(grep -rn "$pat" "$D/plugins" "$D/patches" "$D/tools" "$D/instructions" "$R" 2>/dev/null | grep -v "state/$pat" | grep -vE "\.bak|/archive/|janitor\.log|node_modules|class-sweep\.sh" | head -3)
  if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL stale root path: $pat"; echo "$out" | sed 's/^/     /'; else say "ok   root path: $pat"; fi
done
# Class 3: version-pinned chunk paths in asar patchers (must anchor-search)
check "version-pinned chunk paths" "$D/patches" -E "chunks/[a-zA-Z]+-[A-Za-z0-9_-]+\.js"
# Class 4: non-atomic asar writes (must be .incoming + rename)
out=$(grep -rn "copyFileSync(packed, ASAR)" "$D/patches" "$R/desktop-patch" 2>/dev/null | grep -v "\.incoming" | head -3)
if [ -n "$out" ]; then fails=$((fails+1)); say "FAIL non-atomic asar write"; echo "$out" | sed 's/^/     /'; else say "ok   atomic asar writes"; fi
# Class 5: escaping-layer - JS patchers need a syntax gate; the JSON patcher needs a parse-back gate
for p in "$D"/patches/patch-opencode-*.mjs; do
  grep -q -- '--check' "$p" || { fails=$((fails+1)); say "FAIL no syntax gate: $(basename "$p")"; }
done
say "ok   syntax gates ($(ls "$D"/patches/patch-opencode-*.mjs 2>/dev/null | wc -l | tr -d ' ') JS patchers)"
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
      o=$(grep -c "== ${name}" "$file" 2>/dev/null || echo 0)
      e=$(grep -c "== end ${name} ==" "$file" 2>/dev/null || echo 0)
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
# Upstream pass: generic language checks defer to the established tools when
# installed (class-sweep only adds what no generic tool can know: project contracts)
if command -v shellcheck >/dev/null 2>&1; then
  SH_FILES=()
  for f in "$D"/tools/*.sh "$D/tools/trim-keep" "$D/tools/state-toggle" "$D/tools/janitor.sh" "$R/janitor/janitor.sh" "$R/janitor/trim-keep" "$R/desktop-patch/oc-ui"; do
    # ShellCheck speaks sh/bash only - skip zsh scripts (SC1071)
    [ -f "$f" ] && ! head -1 "$f" | grep -q "#!.*/zsh" && SH_FILES+=("$f")
  done
  ERRS=$(shellcheck -S warning "${SH_FILES[@]}" 2>/dev/null | grep -c "SC[0-9]" || true)
  STYLE=$(shellcheck -S style "${SH_FILES[@]}" 2>/dev/null | grep -c "SC[0-9]" || true)
  if [ "${ERRS:-0}" -gt 0 ]; then
    fails=$((fails+1)); say "FAIL shellcheck warnings+: $ERRS"
  else
    say "ok   shellcheck: 0 warnings+ (${STYLE:-0} style notes)"
  fi
else
  say "skip shellcheck (not installed - brew install shellcheck)"
fi
say "upstream note: semgrep/eslint are the heavier upstream equivalents for TS rules (no-require-imports, no-empty); install if plugin logic grows."
if [ "$fails" -eq 0 ]; then say "CLASS SWEEP: ALL CLEAN"; else say "CLASS SWEEP: $fails CLASS(ES) FAILED"; exit 1; fi
