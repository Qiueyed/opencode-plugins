#!/bin/bash
# gd-sweep - GDScript trap scanner for Godot projects.
# Encodes the classic Godot bug classes (see instructions/bug-hunting.md).
# Usage: gd-sweep.sh <project-dir>   (exit 1 = warning-class findings exist)
#
# OPTIONAL COOPERATION (2026-09-30): if the project has addons/outline_dump/
# outline.md (the outline_dump addon's generated symbol index), every sample
# finding is attributed to its enclosing symbol via that index
# (`World.gd:_pick_seed [randi() %]` instead of a bare line number). The file
# is OPTIONAL: missing or malformed = plain file:line output, everything else
# unchanged - the sweep stays fully standalone (it is published standalone on
# GitHub; outline_dump is a separate optional companion).
set -u
PROJ="${1:?usage: gd-sweep.sh <project-dir>}"
cd "$PROJ" || exit 1
SYM_INDEX=""; UNI_INDEX=""; UNI_BAD=""
trap 'rm -f "$SYM_INDEX" "$UNI_INDEX" "$UNI_BAD"' EXIT
count() { grep -rn --include="*.gd" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -vE "addons/" | sed 's/#.*$//' | grep -c "$2"; }
# sym index: path<TAB>line<TAB>symbol rows built from outline.md (funcs list lines + inline consts/vars pairs)
SYM_INDEX=""
if [ -f "addons/outline_dump/outline.md" ]; then
  SYM_INDEX=$(mktemp)
  awk '
    /^## res:\/\// { f = $2; sub(/^res:\/\//, "", f); next }
    /^- / && $4 ~ /^[0-9]+$/ { print f "\t" $4 "\t" $2; next }
    /^(consts|vars|signals):/ {
      s = substr($0, index($0, ":") + 1)
      n = split(s, parts, ",")
      for (i = 1; i <= n; i++) {
        gsub(/^[ \t]+|[ \t]+$/, "", parts[i])
        m = split(parts[i], kv, ":")
        if (m == 2) { nm = kv[1]; ln = kv[2]; gsub(/^[ \t]+|[ \t]+$/, "", nm); gsub(/^[ \t]+|[ \t]+$/, "", ln); if (ln ~ /^[0-9]+$/) print f "\t" ln "\t" nm }
      }
      next
    }
  ' "addons/outline_dump/outline.md" > "$SYM_INDEX"
fi
sym_for() { # sym_for <relpath> <line> -> enclosing symbol (empty = none). The index is grouped by category, not line order, so track the NEAREST preceding declaration (max start <= n), not the last row in file order.
  [ -n "$SYM_INDEX" ] || return 0
  awk -F'\t' -v f="$1" -v n="$2" '$1 == f && ($2 + 0) <= (n + 0) && ($2 + 0) > best { best = ($2 + 0); s = $3 } END { if (s != "") print s }' "$SYM_INDEX"
}
# shader uniform index: flat set of every uniform name across all .gdshader sections (per-shader attribution is not statically traceable from .gd, so a name colliding across shaders can false-negative; typos and renames - the dominant case - always resolve)
UNI_INDEX=""
UNI_BAD=""
if [ -f "addons/outline_dump/outline.md" ]; then
  UNI_INDEX=$(mktemp)
  awk '
    /^### res:\/\// { sh = $2; next }
    /^uniforms:/ {
      s = substr($0, index($0, ":") + 1)
      n = split(s, parts, ",")
      for (i = 1; i <= n; i++) {
        gsub(/^[ \t]+|[ \t]+$/, "", parts[i])
        m = split(parts[i], kv, ":")
        if (m >= 2) { nm = kv[1]; gsub(/^[ \t]+|[ \t]+$/, "", nm); sub(/\[[0-9]+\]$/, "", nm); if (nm != "") print nm }
      }
      next
    }
  ' "addons/outline_dump/outline.md" | sort -u > "$UNI_INDEX"
fi
sample() { grep -rEn --include="*.gd" "$1" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -vE "addons/" | head -3 | while IFS= read -r l; do
    p=$(printf '%s' "$l" | cut -d: -f1)
    ln=$(printf '%s' "$l" | cut -d: -f2)
    sym=$(sym_for "${p#./}" "$ln")
    if [ -n "$sym" ]; then printf '%s  [%s]\n' "$l" "$sym"; else printf '%s\n' "$l"; fi
  done; }
report() { # report <severity> <label> <count> [pattern]
  local sev="$1" label="$2" n="$3" pat="${4:-}"
  if [ "$n" -gt 0 ]; then
    printf '%s %-42s %s\n' "$sev" "$label" "x$n"
    [ -n "${pat:-}" ] && sample "$pat" | sed 's/^/     /'
  else
    printf '%s %-42s %s\n' "ok  " "$label" "x0"
  fi
}
total=0
# --- error class (breaks at parse/load time on Godot 4) ---
n=$(count x "yield "); report "WARN" "yield (Godot 3 keyword, dead in 4.x)" "$n" "yield "; total=$((total+n))
n=$(count x "^[[:space:]]*export "); report "WARN" "export var (3.x; 4.x uses @export)" "$n" "^[[:space:]]*export "; total=$((total+n))
# --- warning class (silent wrong behavior) ---
n=$(count x "\.position\.x =="); report "CHECK" "float equality on position.x" "$n" "\.position\.x =="; total=$((total+n))
n=$(grep -rEn --include="*.gd" -E "== *[0-9]+\.[0-9]+" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -cvE "addons/"); report "CHECK" "float literal equality (== 1.0 style)" "$n"; total=$((total+n))
n=$(count x "randi() %"); report "CHECK" "randi() % n (modulo bias)" "$n" "randi\(\) %"; total=$((total+n))
n=$(grep -rEn --include="*.gd" -E "get_node\(\"" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -cvE "addons/"); report "CHECK" "string get_node paths (break on rename; prefer %UniqueName)" "$n"; total=$((total+n))
n=$(grep -rEn --include="*.gd" -E "_process\(" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -cvE "_physics_process|addons/"); report "CHECK" "_process defs (physics bodies belong in _physics_process)" "$n"; total=$((total+n))
n=$(grep -rEn --include="*.gd" "get_texture\(\)\.get_size" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -cv "/addons/"); report "CHECK" "get_texture().get_size (macOS disagrees with get_image(); normalize captures by the IMAGE)" "$n" "get_texture\(\)\.get_size"; total=$((total+n))
n=$(grep -rEn --include="*.gd" "^(static )?var .*OS\.get_cmdline_user_args" . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -cv "/addons/"); report "CHECK" "load-time cmdline read (flags must be read after -- args parse, in _ready dispatch)" "$n" "^(static )?var .*OS\.get_cmdline_user_args"; total=$((total+n))
# --- shader uniform cross-check (needs a NON-EMPTY outline.md index; empty/malformed index = skip, never flag-all) ---
if [ -n "$UNI_INDEX" ] && [ -s "$UNI_INDEX" ]; then
  UNI_BAD=$(mktemp)
  grep -rEn --include="*.gd" 'set_shader_parameter\("' . 2>/dev/null | grep -v "\.bak" | grep -v "/archive/" | grep -vE "addons/" | while IFS= read -r l; do
    nm=$(printf '%s' "$l" | sed -nE 's/.*set_shader_parameter\("([^"]+)".*/\1/p')
    # prefix match allowed ON PURPOSE: dynamic concat names ("star_cube_" + slot) are a legit pattern; the exact-name typo case still flags
    if [ -n "$nm" ] && ! grep -qE "^${nm}" "$UNI_INDEX"; then printf '%s\n' "$l"; fi
  done > "$UNI_BAD"
  n=$(wc -l < "$UNI_BAD" | tr -d ' ')
  printf 'CHECK %-42s %s\n' "shader param names not in outline.md (silent no-op)" "x$n"
  head -3 "$UNI_BAD" | while IFS= read -r l; do
    p=$(printf '%s' "$l" | cut -d: -f1)
    ln2=$(printf '%s' "$l" | cut -d: -f2)
    sym=$(sym_for "${p#./}" "$ln2")
    if [ -n "$sym" ]; then printf '     %s  [%s]\n' "$l" "$sym"; else printf '     %s\n' "$l"; fi
  done
  total=$((total+n))
else
  printf 'ok   %-42s %s\n' "shader param cross-check" "x0 (skipped: needs outline.md)"
fi
# --- info ---
n=$(count x "@onready"); report "INFO" "@onready vars (access only after _ready)" "$n" ""
n=$(count x "\.connect("); report "INFO" "connect calls (Check return Error + disconnect on free)" "$n" ""
echo "---"
echo "warning+check findings: $total in $(find . -name '*.gd' -not -path './addons/*' -not -path './archive/*' | wc -l | tr -d ' ') scripts"
if [ -n "$SYM_INDEX" ]; then echo "symbol attribution: addons/outline_dump/outline.md"; else echo "symbol attribution: off (no outline.md - standalone mode)"; fi
[ "$total" -gt 0 ] && exit 1 || exit 0
