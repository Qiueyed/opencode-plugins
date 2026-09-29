#!/bin/bash
# gd-sweep - GDScript trap scanner for Godot projects.
# Encodes the classic Godot bug classes (see instructions/bug-hunting.md).
# Usage: gd-sweep.sh <project-dir>   (exit 1 = warning-class findings exist)
set -u
PROJ="${1:?usage: gd-sweep.sh <project-dir>}"
cd "$PROJ" || exit 1
count() { grep -rn --include="*.gd" . 2>/dev/null | grep -v "\.bak" | grep -vE "addons/" | sed 's/#.*$//' | grep -c "$2"; }
sample() { grep -rn --include="*.gd" "$1" . 2>/dev/null | grep -v "\.bak" | grep -vE "addons/" | head -3; }
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
n=$(grep -rn --include="*.gd" -E "== *[0-9]+\.[0-9]+" . 2>/dev/null | grep -v "\.bak" | wc -l | tr -d ' '); report "CHECK" "float literal equality (== 1.0 style)" "$n"; total=$((total+n))
n=$(count x "randi() %"); report "CHECK" "randi() % n (modulo bias)" "$n" "randi() %"; total=$((total+n))
n=$(grep -rn --include="*.gd" -E "get_node\(\"" . 2>/dev/null | grep -v "\.bak" | wc -l | tr -d ' '); report "CHECK" "string get_node paths (break on rename; prefer %UniqueName)" "$n"; total=$((total+n))
n=$(grep -rn --include="*.gd" -E "_process\(" . 2>/dev/null | grep -v "\.bak" | grep -vE "_physics_process" | wc -l | tr -d ' '); report "CHECK" "_process defs (physics bodies belong in _physics_process)" "$n"; total=$((total+n))
# --- info ---
n=$(count x "@onready"); report "INFO" "@onready vars (access only after _ready)" "$n" ""
n=$(count x "\.connect("); report "INFO" "connect calls (Check return Error + disconnect on free)" "$n" ""
echo "---"
echo "warning+check findings: $total in $(find . -name '*.gd' -not -path './addons/*' | wc -l | tr -d ' ') scripts"
[ "$total" -gt 0 ] && exit 1 || exit 0
