# janitor

Post-quit database maintenance for OpenCode. Without something doing this,
the database grows without bound - streaming-delta events, pre-compaction
dead rows, stale image payloads and read-tool outputs, title-churn events -
until startup crawls and sessions hit unrecoverable bloat.

**Policy: VACUUM ONLY.** The janitor never deletes a session. It reclaims
space from orphans and dead weight, and it backs up before anything
destructive.

## What runs at every app close

| Step | What | Guard |
|---|---|---|
| Orphan sweep | `event_sequence` / `message` / `part` rows whose session is gone (the UI delete path leaves orphans) | never touches live-session rows |
| Compaction trim | messages + parts + events BEFORE a session's last compaction summary (their content lives inside the summary) | only sessions that actually contain a summary; summary and everything after kept |
| Trim markers | session titles ending ` ⏳TRIM15` are trimmed to the last 15 user turns, marker stripped | marker stripped even when nothing to trim; bare ` ⏳TRIM` resolves from `state/trim-keep.txt` (default 15) |
| Payload strip | image parts + read-tool parts from sessions untouched for 48h+, plus sessions marked ` ⏳IMGS` | active sessions always protected; messages and text kept |
| `session.updated` cap | keeps newest 5 per session (title-rewrite churn events) | newest kept |
| VACUUM | only when >= 10% of db pages are free | otherwise logs "not due" |
| Store ghost purge | optional: calls `opencode-store-purge` (separate tool) when the persisted stores exceed 5MB | skips if tool missing |

Safety rails, all verified the hard way: waits until every OpenCode process
is gone (watches the main binary only - crashpad helpers can linger for
days), one watcher per machine via an atomic mkdir lock (24h stale
reclaim), one rolling backup per run (`opencode.db.trim-backup`, via
`.backup` not `cp` so WAL state can't produce an inconsistent copy), busy
timeouts on every statement, and every delete is COUNT-guarded first.

## Install

```sh
mkdir -p ~/.config/opencode/tools
cp janitor.sh ~/.config/opencode/tools/
cp trim-keep ~/.config/opencode/tools/          # optional: keep-count setter
chmod +x ~/.config/opencode/tools/janitor.sh ~/.config/opencode/tools/trim-keep
cp janitor.ts ~/.config/opencode/plugins/
cp opencode-session-trim ~/bin/ && chmod +x ~/bin/opencode-session-trim   # optional CLI
```

Restart OpenCode. The plugin arms the watcher at startup; the sweep runs
after the app fully exits, then logs one line to `tools/janitor.log`.

macOS today (`stat -f`, `/bin/sh`, `ps axo`); the db path honors
`XDG_DATA_HOME`.

## Manual use (works without the plugin)

```sh
opencode-session-trim --list                  # sessions + message counts
opencode-session-trim --latest 10             # trim newest session to 10 turns
opencode-session-trim <session-id> 25         # trim one session
opencode-session-trim --strip-images all      # image parts gone, text kept
opencode-session-trim --strip-reads <id>      # read-tool parts gone
./trim-keep 25                                # default keep for bare markers
```

The tool refuses to run while OpenCode is up, backs up first, and prints a
`PRAGMA quick_check` integrity line after every write. Trigger a trim from
the UI without any patch: rename a session so its title ends with
` ⏳TRIM15` (or ` ⏳IMGS`) - the janitor picks it up at the next quit.

## Optional integrations (self-skipping)

- `patches/patch-models-cache.mjs` - if you keep a models.dev cache patch,
  the janitor re-applies it at close (the app's cache refresh wipes local
  edits on a ~2h cycle); the plugin also re-applies 45s after boot.
- An external patch checker (e.g. a patched Ollama binary): janitor runs
  `<script> --check` at close; exit 3 = "reverted by update", exit 4 =
  "binary shape changed". Re-applying is always manual by design.

## Honest limits

- `VACUUM` needs free disk space roughly equal to the db size and can take
  a minute on multi-GB databases - it only fires when 10%+ of pages are free.
- The 48h staleness rule uses `time_updated`; a session you reopen daily
  keeps its images until marked or trimmed.
- Tested against OpenCode 1.16.x desktop on macOS. Destructive steps are
  backed up, but backups are rolling (one generation) - if you want deeper
  history, add your own rotation.
