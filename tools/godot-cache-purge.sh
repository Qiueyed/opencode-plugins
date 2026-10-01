#!/bin/bash
# godot-cache-purge.sh - remove res://archive/ references from Godot editor caches.
# Why: the scan honors .gdignore, but DIRECT file loads (script-editor restore buffers,
# layout restore, recent files) bypass it - a cached archive path re-parses snapshot
# class_name copies on every editor start ("hides a global script class", doc 521/522/523).
# Usage: godot-cache-purge.sh <project-dir>
#   BEST run with the editor CLOSED: a running editor rewrites its caches from memory
#   on quit, undoing the purge. The tool warns but still purges on disk.
#   Class cache is rebuilt via --import afterwards (requires the editor closed too).
set -u
PROJ="${1:?usage: godot-cache-purge.sh <project-dir>}"
cd "$PROJ" || exit 1

if pgrep -f "MacOS/Godot" >/dev/null 2>&1; then
  echo "WARNING: a Godot process is running - it may rewrite these caches on quit. Purge again after closing it."
fi

n=0
for f in .godot/editor/project_metadata.cfg .godot/editor/editor_layout.cfg .godot/editor/script_editor_cache.cfg; do
  [ -f "$f" ] || continue
  before=$(grep -c "res://archive/" "$f" 2>/dev/null || true)
  [ "${before:-0}" -eq 0 ] && continue
  python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().split("\n")
open(p, "w").write("\n".join(l for l in lines if "res://archive/" not in l))
PY
  echo "purged $before archive line(s) from $f"
  n=$((n+1))
done

# any other text cache under .godot referencing archive: list it (binary caches skipped)
LEFT=$(grep -rIl "res://archive/" .godot/ 2>/dev/null)
if [ -n "$LEFT" ]; then
  echo "still referencing archive (inspect manually):"
  printf '%s\n' "$LEFT" | sed 's/^/  /'
fi

# rebuild the class cache only when no editor can fight us over it
if ! pgrep -f "MacOS/Godot" >/dev/null 2>&1; then
  [ -f .godot/global_script_class_cache.cfg ] && rm -f .godot/global_script_class_cache.cfg
  GODOT_BIN="${GODOT_BIN:-/Applications/Godot.app/Contents/MacOS/Godot}"
  "$GODOT_BIN" --headless --path . --import >/dev/null 2>&1
  echo "class cache rebuilt: $(grep -c '"' .godot/global_script_class_cache.cfg 2>/dev/null | tr -d ' ') entries"
else
  echo "skipped class cache rebuild (editor running - run again after closing it)"
fi

[ "$n" -eq 0 ] && [ -z "$LEFT" ] && echo "nothing to purge - caches already clean"
exit 0
