#!/bin/bash
# janitor.sh - post-quit database janitor for OpenCode.
# POLICY: VACUUM ONLY - it never deletes a session; it reclaims space from
# orphans, dead pre-compaction rows, and stale bulky payloads.
#
# Spawned DETACHED by the janitor plugin at app STARTUP; the script simply
# waits for every OpenCode process to vanish (exit handlers proved unreliable:
# desktop quits can skip them and crashes never run them). Then it:
#   1. Waits for EVERY OpenCode.app process to be gone (max 120 s, then skips:
#      never touches a live db; a relaunch race means "try again next quit").
#      Enumeration uses "ps axo command=" per system-modification-guardrails.md
#      (macOS pgrep misses Electron main processes, and pgrep -f self-matches
#      the caller's own command line; the [.] bracket trick hides the grep).
#   2. Orphan sweep: event_sequence rows whose session no longer exists (the
#      app-UI session delete path has no FK from event_sequence to session, so
#      orphaned event streams can accumulate), plus belt-and-braces orphan
#      messages/parts. Usually a no-op; a safety net if that changes.
#      NEVER touches rows belonging to a live session (policy: vacuum only).
#   3. VACUUM, only when >= 10% of pages are free (PRAGMA page_count /
#      freelist_count), so routine runs take seconds.
# Lock: atomic mkdir lock dir; stale lock reclaimed after 24h (startup-armed
# watchers legitimately wait that long). Multi-window spawns collapse to one.
# Usage: janitor.sh [db_path]   default = the real opencode.db; tests point
#        this at a copy, with JANITOR_SKIP_WAIT=1 to bypass the app-exit wait.
# Log: one line per run -> tools/janitor.log next to this script.

DB="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}"
LOG_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$LOG_DIR/janitor.log"
LOCK="$LOG_DIR/.janitor-lock"
# Past fix: the old pattern ("OpenCode.app/Contents") matched ANY process
# under the bundle - including orphaned chrome_crashpad_handler helpers that
# OUTLIVE the app for days (found one from the previous day still alive). With
# a zombie matching, the watcher waited forever and never vacuumed even during
# a multi-hour closed window. Watch ONLY the main binary: when it is gone, the
# app is closed (helpers/crashpad may linger harmlessly).
PATTERN='OpenCode[.]app/Contents/MacOS/OpenCode'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# --- lock (atomic mkdir; reclaim a stale one after 24h - startup-armed
# janitors legitimately wait that long, so the old 10-min reclaim would kill
# the design) ---
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 86400 ]; then exit 0; fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

[ -f "$DB" ] || { log "skip: db not found ($DB)"; exit 0; }

# --- wait for app exit (relaunch-race AND crash-race resistant) ---
# Design: armed at OpenCode STARTUP (not quit). The plugin spawns
# this script detached at plugin load; it simply WAITS - possibly for days -
# until every OpenCode.app process is gone, then vacuums. No give-up cap: a
# silent sleeping loop polling `ps` every 30s costs nothing, and the mkdir
# lock (stale reclaim raised to 24h) keeps exactly one instance. This removes
# the dependency on the sidecar's exit handlers entirely: desktop quits can
# kill the sidecar without running them (observed twice in practice:
# produced zero spawns), and crash-class exits never ran them at all.
if [ -z "$JANITOR_SKIP_WAIT" ]; then
  while ps axo command= 2>/dev/null | grep -q "$PATTERN"; do
    sleep 2
  done
  sleep 1
fi

# --- orphan sweep (idempotent; guarded counts before each delete) ---
# ".timeout" dot-command = busy handler in ms, emits NO output (a chained
# "PRAGMA busy_timeout=..." SQL statement ECHOES its value and corrupts every
# parsed count - caught by a copy test).
sweep() { # table, key_col, parent_sql -> prints count deleted
  local n
  n=$(sqlite3 "$DB" ".timeout 5000" "SELECT COUNT(*) FROM $1 WHERE $2 NOT IN ($3);" 2>/dev/null | tr -d '[:space:]')
  [ -n "$n" ] && [ "$n" -gt 0 ] && sqlite3 "$DB" ".timeout 5000" "DELETE FROM $1 WHERE $2 NOT IN ($3);" 2>/dev/null
  echo "${n:-0}"
}
SEQ=$(sweep event_sequence aggregate_id "SELECT id FROM session")
MSG=$(sweep message session_id "SELECT id FROM session")
PRT=$(sweep part session_id "SELECT id FROM session")

# --- compaction trim ---
# When a session is compacted, opencode writes a summary message
# (data: mode=compaction, summary=true) and the model context continues from
# it - every message BEFORE the LAST compaction summary is dead weight (its
# content lives on inside the summary). This step deletes those messages and
# their parts, plus the events that reference them (the streaming-delta bulk
# is the largest single class of dead rows). Runs BEFORE the vacuum so freed
# pages are reclaimed in the same run.
# Policy guard: ONLY sessions that actually contain a compaction summary;
# the summary itself and everything after it are kept. Backup first (rolling,
# same file opencode-session-trim uses).
COMPACT_SESSIONS=$(sqlite3 -separator '|' "$DB" ".timeout 5000" "
SELECT s.id, m.time_created, m.rowid FROM session s
JOIN message m ON m.session_id = s.id
WHERE json_extract(m.data,'\$.mode') = 'compaction'
  AND json_extract(m.data,'\$.summary') = true
  AND m.time_created = (SELECT MAX(m2.time_created) FROM message m2
                        WHERE m2.session_id = s.id
                          AND json_extract(m2.data,'\$.mode') = 'compaction')
  AND m.rowid = (SELECT MAX(m3.rowid) FROM message m3
                 WHERE m3.session_id = s.id
                   AND json_extract(m3.data,'\$.mode') = 'compaction'
                   AND m3.time_created = m.time_created);" 2>/dev/null)
TRIM_TOTAL=0
TRIM_BACKUP_TAKEN=0
take_trim_backup() { # once per run, shared by compaction trim + UI marker trim
  if [ "$TRIM_BACKUP_TAKEN" -eq 0 ]; then
    # .backup, not cp: a plain cp of a WAL db can be inconsistent when the last
    # exit was crash-class (no checkpoint); entry-26 lesson.
    sqlite3 "$DB" ".timeout 10000" ".backup '$DB.trim-backup'" 2>/dev/null
    TRIM_BACKUP_TAKEN=1
  fi
}
if [ -n "$COMPACT_SESSIONS" ]; then
  # Backup + rewrite ONLY when rows would actually be deleted (otherwise this
  # would cp ~230MB on every quit forever - summaries exist after the first trim).
  PENDING=$(sqlite3 "$DB" ".timeout 5000" "
SELECT COUNT(*) FROM message m WHERE EXISTS (
  SELECT 1 FROM message s2 WHERE s2.session_id = m.session_id
    AND json_extract(s2.data,'\$.mode') = 'compaction'
    AND json_extract(s2.data,'\$.summary') = true
    AND (s2.time_created > m.time_created OR (s2.time_created = m.time_created AND s2.rowid > m.rowid)));" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$PENDING" ] && [ "$PENDING" -gt 0 ]; then
  SIZE_PRE_TRIM=$(stat -f %z "$DB")
  take_trim_backup
  while IFS='|' read -r SID CT CT_ROW; do
    [ -n "$SID" ] || continue
    QSID=$(echo "$SID" | sed "s/'/''/g")
    # DELETE and SELECT changes() in the SAME connection (a second connection's
    # changes() is always 0 - caught by a review; the trim worked
    # but TRIM_TOTAL stayed 0 and the log line never fired).
    N1=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM part WHERE session_id='$QSID' AND message_id IN (
  SELECT id FROM message WHERE session_id='$QSID'
    AND (time_created < $CT OR (time_created = $CT AND rowid < $CT_ROW)));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    N2=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM message WHERE session_id='$QSID'
  AND (time_created < $CT OR (time_created = $CT AND rowid < $CT_ROW));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    N3=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM event WHERE aggregate_id='$QSID' AND (
  (type LIKE 'message.updated%' AND json_extract(data,'\$.info.id') NOT IN (SELECT id FROM message WHERE session_id='$QSID'))
  OR (type LIKE 'message.part.updated%' AND json_extract(data,'\$.part.messageID') NOT IN (SELECT id FROM message WHERE session_id='$QSID'))
  OR (type LIKE 'message.removed%'));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    TRIM_TOTAL=$((TRIM_TOTAL + ${N1:-0} + ${N2:-0} + ${N3:-0}))
  done <<< "$COMPACT_SESSIONS"
  [ "$TRIM_TOTAL" -gt 0 ] && log "compaction trim: ${TRIM_TOTAL} rows removed pre-summary (backup: opencode.db.trim-backup, was $((SIZE_PRE_TRIM/1048576))MB)"
  fi
fi

# --- UI-requested trims: a session title suffixed " ⏳TRIM15" (= keep last
# 15 user turns) is trimmed at close and the marker stripped. Markers come
# from the desktop session-menu patch if installed; renaming a session to
# end with " ⏳TRIM15" does the same thing with no patch at all.
UI_MARKED=$(sqlite3 -separator '|' "$DB" ".timeout 5000" "
SELECT id, title FROM session WHERE title LIKE '%⏳TRIM%';" 2>/dev/null)
UI_TOTAL=0
if [ -n "$UI_MARKED" ]; then
  while IFS='|' read -r SID TITLE; do
    [ -n "$SID" ] || continue
    QSID=$(echo "$SID" | sed "s/'/''/g")
    KEEP=$(echo "$TITLE" | sed -n 's/.*⏳TRIM\([0-9][0-9]*\).*/\1/p')
    case "$KEEP" in
      ''|*[!0-9]*)
        # bare ⏳TRIM marker: resolve from the Plugins-menu setting
        KEEP=$(cat "$HOME/.config/opencode/trim-keep.txt" 2>/dev/null | tr -d '[:space:]')
        case "$KEEP" in ''|*[!0-9]*) KEEP=15 ;; esac
        ;;
    esac
    [ "$KEEP" -lt 1 ] && KEEP=1
    CUTOFF=$(sqlite3 -separator '|' "$DB" ".timeout 5000" "
SELECT time_created, rowid FROM message WHERE session_id='$QSID'
  AND json_extract(data,'\$.role')='user'
ORDER BY time_created DESC, rowid DESC LIMIT 1 OFFSET $((KEEP - 1));" 2>/dev/null)
    # strip the marker from the title regardless of trim outcome
    sqlite3 "$DB" ".timeout 5000" "
UPDATE session SET title = RTRIM(REPLACE(REPLACE(title, ' ⏳TRIM$KEEP', ''), ' ⏳TRIM', ''))
WHERE id = '$QSID';" 2>/dev/null
    [ -n "$CUTOFF" ] || continue
    CT=$(echo "$CUTOFF" | cut -d'|' -f1)
    CT_ROW=$(echo "$CUTOFF" | cut -d'|' -f2)
    take_trim_backup
    N1=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM part WHERE session_id='$QSID' AND message_id IN (
  SELECT id FROM message WHERE session_id='$QSID'
    AND (time_created < $CT OR (time_created = $CT AND rowid < $CT_ROW)));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    N2=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM message WHERE session_id='$QSID'
  AND (time_created < $CT OR (time_created = $CT AND rowid < $CT_ROW));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    N3=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM event WHERE aggregate_id='$QSID' AND (
  (type LIKE 'message.updated%' AND json_extract(data,'\$.info.id') NOT IN (SELECT id FROM message WHERE session_id='$QSID'))
  OR (type LIKE 'message.part.updated%' AND json_extract(data,'\$.part.messageID') NOT IN (SELECT id FROM message WHERE session_id='$QSID'))
  OR (type LIKE 'message.removed%'));
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
    UI_TOTAL=$((UI_TOTAL + ${N1:-0} + ${N2:-0} + ${N3:-0}))
  done <<< "$UI_MARKED"
  [ "$UI_TOTAL" -gt 0 ] && log "ui trim: ${UI_TOTAL} rows removed on marked session(s), keep=${KEEP} (backup: opencode.db.trim-backup)"
fi

# --- image strip: TWO triggers, both keep every message and all text
# (the images have already served their purpose once inspected):
#   a) sessions title-marked " ⏳IMGS" by the menu's "Remove images" item
#   b) AUTOMATIC: any session not touched for 48h+ (conclusions settled)
# Only image parts die (data mime image/* or type=image); their orphaned
# message.part.updated events go too. Backup once per run.
IMGS_TOTAL=0
IMGS_MB=0
take_img_backup() {
  if [ "$TRIM_BACKUP_TAKEN" -eq 0 ]; then
    sqlite3 "$DB" ".timeout 10000" ".backup '$DB.trim-backup'" 2>/dev/null
    TRIM_BACKUP_TAKEN=1
  fi
}
IMG_MARKED=$(sqlite3 -separator '|' "$DB" ".timeout 5000" "
SELECT id, title FROM session WHERE title LIKE '%⏳IMGS%';" 2>/dev/null)
if [ -n "$IMG_MARKED" ]; then
  take_img_backup
  while IFS='|' read -r SID TITLE; do
    [ -n "$SID" ] || continue
    QSID=$(echo "$SID" | sed "s/'/''/g")
    sqlite3 "$DB" ".timeout 5000" "
UPDATE session SET title = RTRIM(REPLACE(title, ' ⏳IMGS', '')) WHERE id = '$QSID';" 2>/dev/null
    B=$(sqlite3 "$DB" ".timeout 5000" "
SELECT COALESCE(SUM(LENGTH(data)),0) FROM part WHERE session_id='$QSID'
  AND (json_extract(data,'\$.mime') LIKE 'image%' OR json_extract(data,'\$.type')='image');" 2>/dev/null | tr -d '[:space:]')
    [ -n "$B" ] && [ "$B" -gt 0 ] || continue
    sqlite3 "$DB" ".timeout 5000" "
DELETE FROM part WHERE session_id='$QSID'
  AND (json_extract(data,'\$.mime') LIKE 'image%' OR json_extract(data,'\$.type')='image');" 2>/dev/null
    IMGS_TOTAL=$((IMGS_TOTAL + 1))
    IMGS_MB=$((IMGS_MB + B / 1048576))
  done <<< "$IMG_MARKED"
fi
STALE_CUTOFF=$(( $(date +%s) * 1000 - 172800000 ))
STALE_B=$(sqlite3 "$DB" ".timeout 5000" "
SELECT COALESCE(SUM(LENGTH(p.data)),0) FROM part p JOIN session s ON s.id = p.session_id
WHERE s.time_updated < $STALE_CUTOFF
  AND (json_extract(p.data,'\$.mime') LIKE 'image%' OR json_extract(p.data,'\$.type')='image');" 2>/dev/null | tr -d '[:space:]')
if [ -n "$STALE_B" ] && [ "$STALE_B" -gt 0 ]; then
  take_img_backup
  sqlite3 "$DB" ".timeout 30000" "
DELETE FROM part WHERE session_id IN (SELECT id FROM session WHERE time_updated < $STALE_CUTOFF)
  AND (json_extract(data,'\$.mime') LIKE 'image%' OR json_extract(data,'\$.type')='image');" 2>/dev/null
  IMGS_MB=$((IMGS_MB + STALE_B / 1048576))
fi
# read-tool parts count the same (the conclusion is out):
READS_B=$(sqlite3 "$DB" ".timeout 5000" "
SELECT COALESCE(SUM(LENGTH(p.data)),0) FROM part p JOIN session s ON s.id = p.session_id
WHERE s.time_updated < $STALE_CUTOFF
  AND json_extract(p.data,'\$.type')='tool' AND json_extract(p.data,'\$.tool')='read';" 2>/dev/null | tr -d '[:space:]')
if [ -n "$READS_B" ] && [ "$READS_B" -gt 0 ]; then
  take_img_backup
  sqlite3 "$DB" ".timeout 30000" "
DELETE FROM part WHERE session_id IN (SELECT id FROM session WHERE time_updated < $STALE_CUTOFF)
  AND json_extract(data,'\$.type')='tool' AND json_extract(data,'\$.tool')='read';" 2>/dev/null
  IMGS_MB=$((IMGS_MB + READS_B / 1048576))
fi
if [ "$IMGS_MB" -gt 0 ] || [ "$IMGS_TOTAL" -gt 0 ]; then
  # orphaned part events db-wide (part ids that no longer exist)
  sqlite3 "$DB" ".timeout 30000" "
DELETE FROM event WHERE type LIKE 'message.part.updated%'
  AND json_extract(data,'\$.part.id') NOT IN (SELECT id FROM part);" 2>/dev/null
  log "payload strip: ${IMGS_TOTAL} marked session(s) cleared, ~${IMGS_MB}MB removed (images + file reads, 48h stale + marked; backup: opencode.db.trim-backup)"
fi

# --- session.updated cap: title rewrites (size tags etc.) persist a
# session.updated event EVERY time, and stale ones only feed live-sync
# replays in other windows - churn. Keep the newest 5 per session
# (post-close, no live subscribers). Runs before the vacuum so the same
# run reclaims the space.
SU_CAP=5
SU_DELETED=$(sqlite3 "$DB" ".timeout 5000" "
DELETE FROM event WHERE type LIKE 'session.updated%' AND seq NOT IN (
  SELECT e2.seq FROM event e2 WHERE e2.type LIKE 'session.updated%'
    AND e2.aggregate_id = event.aggregate_id ORDER BY e2.seq DESC LIMIT $SU_CAP);
SELECT changes();" 2>/dev/null | tail -1 | tr -d '[:space:]')
[ -n "$SU_DELETED" ] && [ "$SU_DELETED" -gt 0 ] && log "session.updated cap: removed ${SU_DELETED} churn events (kept newest ${SU_CAP}/session)"

# --- vacuum only when due (>= 10% free pages) ---
read -r PC FC PSZ <<<"$(sqlite3 -separator ' ' "$DB" ".timeout 5000" "SELECT page_count, freelist_count, page_size FROM pragma_page_count, pragma_freelist_count, pragma_page_size;" 2>/dev/null)"
SIZE_BEFORE=$(stat -f %z "$DB")
if [ -n "$PC" ] && [ "$FC" -gt 0 ] && [ $(( FC * 100 / PC )) -ge 10 ]; then
  sqlite3 "$DB" ".timeout 10000" "VACUUM;" 2>/dev/null \
    && log "vacuum ok: orphans seq=$SEQ msg=$MSG part=$PRT; db $((SIZE_BEFORE/1048576))MB -> $(( $(stat -f %z "$DB") / 1048576 ))MB (freelist was ${FC}/${PC} pages)" \
    || log "vacuum FAILED: orphans seq=$SEQ msg=$MSG part=$PRT; db left at $((SIZE_BEFORE/1048576))MB"
else
  log "sweep only: orphans seq=$SEQ msg=$MSG part=$PRT; vacuum not due (freelist ${FC:-?}/${PC:-?} pages)"
fi

# --- store ghost purge ---
# The desktop app's persisted stores (*.dat) accumulate prompt history forever
# and the composer re-serializes the WHOLE store per keystroke -> typing crawl
# -> renderer OOM at ~90-140MB. The opencode-store-purge tool (optional
# install) surgically drops the ghost keys; it refuses while the app runs,
# which is why it lives HERE - post-close, when stores are safe to rewrite.
# Threshold: total store size >= 5MB (a fresh store is ~140KB).
STORE_DIR="$HOME/Library/Application Support/ai.opencode.desktop"
STORE_TOTAL=$(du -kc "$STORE_DIR"/opencode.*.dat 2>/dev/null | tail -1 | cut -f1)
if [ -n "$STORE_TOTAL" ] && [ "$STORE_TOTAL" -ge 5120 ]; then
  if [ -x "$HOME/bin/opencode-store-purge" ]; then
    PURGE_OUT=$("$HOME/bin/opencode-store-purge" 2>&1 | tr '\n' '|')
    log "store purge: ${PURGE_OUT}"
  else
    log "store purge SKIPPED: ~/bin/opencode-store-purge missing"
  fi
fi

# --- models cache capability fix (OPTIONAL): if you keep a local patch that
# edits the models.dev cache (e.g. enabling image input for a config-defined
# model the catalog wrongly lists as text-only), the app's background cache
# refresh wipes it on a ~2h cycle. Re-apply at close so the next session is
# always fixed. Self-skips when the patch file is absent. Output only when
# it actually changed.
if [ -f "$HOME/.config/opencode/patches/patch-models-cache.mjs" ]; then
  MODELS_OUT=$(node "$HOME/.config/opencode/patches/patch-models-cache.mjs" --quiet 2>&1)
  [ -n "$MODELS_OUT" ] && log "models cache: ${MODELS_OUT}"
fi

# --- external patch integrity (OPTIONAL, generalized): if you keep patched
# third-party apps (e.g. an Ollama binary tweak), an app UPDATE silently
# reverts them. If the checker script exists, run its --check at every close
# sweep and log the tell; exit 3 = reverted, exit 4 = binary shape changed.
# Re-apply stays MANUAL on purpose: a new version may change internals, so
# nothing rewrites an unknown binary automatically.
OLLAMA_BIN="/Applications/Ollama.app/Contents/MacOS/Ollama"
PATCH_SCRIPT="$HOME/.config/opencode/patches/ollama-coldstart-patch.py"
PY3="$(command -v python3 || true)"
if [ -x "$OLLAMA_BIN" ] && [ -f "$PATCH_SCRIPT" ]; then
  if [ -z "$PY3" ]; then
    log "OLLAMA PATCH CHECK skipped: python3 not on PATH of the detached janitor"
  else
    CHECK_OUT=$("$PY3" "$PATCH_SCRIPT" --check 2>&1)
    CHECK_CODE=$?
    if [ "$CHECK_CODE" -eq 3 ]; then
      log "OLLAMA PATCH REVERTED BY UPDATE: cold start will open Apps again. Re-apply: python3 ${PATCH_SCRIPT} (then: codesign --force --sign - /Applications/Ollama.app). Detail: ${CHECK_OUT}"
    elif [ "$CHECK_CODE" -eq 4 ]; then
      log "OLLAMA PATCH CHECK: unknown binary shape (update changed internals) - re-analyze before re-applying. Detail: ${CHECK_OUT}"
    fi
    # code 0 (patched ok) stays silent per house style: log only on change
  fi
fi
