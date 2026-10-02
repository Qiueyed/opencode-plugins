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
for f in .godot/editor/project_metadata.cfg .godot/editor/editor_layout.cfg; do
  [ -f "$f" ] || continue
  before=$(grep -c "res://archive/" "$f" 2>/dev/null || true)
  [ "${before:-0}" -eq 0 ] && continue
  # element-level purge: array-valued lines (e.g. open_scripts=PackedStringArray(...)) hold MANY
  # paths on ONE physical line - dropping the line kills every key, so strip only the archive
  # ELEMENTS and keep the key alive (2026-09-30: a line-filter wiped open_scripts whole, doc 523)
  python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]
lines = open(p).read().split("\n")
out = []
for l in lines:
    if "res://archive/" in l and re.search(r"PackedStringArray\(|^\s*\"res://", l):
        l2 = re.sub(r'(\s*)"res://archive/[^"]*",?', r"\1", l)
        l2 = re.sub(r"PackedStringArray\(\s*\)", "PackedStringArray()", l2)
        out.append(l2)
    elif "res://archive/" not in l:
        out.append(l)
open(p, "w").write("\n".join(out))
PY
  echo "purged archive element(s) from $f"
  n=$((n+1))
done
# script_editor_cache.cfg is SECTION-per-tab: drop archive sections whole (header + body)
f=".godot/editor/script_editor_cache.cfg"
if [ -f "$f" ] && grep -q "res://archive/" "$f"; then
  python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().split("\n")
out, skip = [], False
for l in lines:
    if l.startswith("[res://archive/"):
        skip = True
        continue
    if skip and l.startswith("[res://"):
        skip = False
    if not skip:
        out.append(l)
open(p, "w").write("\n".join(out))
PY
  echo "purged archive section(s) from $f"
  n=$((n+1))
fi
# restore ScriptEditor/open_scripts from the tab cache when it came out empty (the layout's
# tab list and the cache are two views of the same 53-tab truth; the cache is the richer one)
if [ -f .godot/editor/editor_layout.cfg ] && [ -f .godot/editor/script_editor_cache.cfg ]; then
  EMPTY=$(grep -c "^open_scripts=\[\]" .godot/editor/editor_layout.cfg || true)
  TABS=$(grep -c "^\[res://" .godot/editor/script_editor_cache.cfg || true)
  if [ "${EMPTY:-0}" -gt 0 ] && [ "${TABS:-0}" -gt 0 ]; then
    python3 - <<'PY'
import re
tabs = re.findall(r"^\[(res://[^\]]+)\]$", open(".godot/editor/script_editor_cache.cfg").read(), re.M)
arr = "PackedStringArray(" + ", ".join('"%s"' % t for t in tabs) + ")"
p = ".godot/editor/editor_layout.cfg"
text = open(p).read()
if "open_scripts=" in text:
    text = re.sub(r"^open_scripts=.*$", "open_scripts=" + arr, text, count=1, flags=re.M)
else:
    text = text.replace("[ScriptEditor]", "[ScriptEditor]\nopen_scripts=" + arr, 1)
open(p, "w").write(text)
print("open_scripts rebuilt:", len(tabs), "tabs")
PY
    n=$((n+1))
  fi
fi

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
