# Changelog

## 2026-09-29

- **notify.ts** joins the cluster: provider peak-rate banners (verified GLM schedule, auth-based provider detection, atomic cross-instance claims, HID-idle suppression, OpenCode-attributed delivery) + opt-in permission auto-grant (default OFF).
- **edit-candidates patch v2.1**: edit-tool errors now carry grouped candidate hints (L2, L4, L6 (100% after trim)), range summaries for swarms, degenerate-needle guards (no mass-replace hints for single letters), CRLF detection, indentation-mismatch labels. In-place upgrade path v1 to v2.1; 12-assertion harness.
- **session-menu patch published**: Trim-and-clean session submenu writing the janitors trim markers (the last private piece - the marker contract is now end-to-end public).
- **state.json architecture**: scattered marker/value files collapse into state/state.json (sessionTrimKeep, visionGuardBypass, peakBannerDisabled, notifyAutogrant). Menu checkboxes gain a stateKey/stateValue shape (live at build); state-toggle is the atomic toggle backend; trim-keep edits the registry; per-plugin settings moved under state/<name>.settings.json. Claim files and append ledgers stay as files (atomic-create / append-only semantics).
- **Repo hygiene**: janitor gains WAL-safe backups + lock liveness checks (review round); local caffeinate/godot copies upgraded to the public settings-feature versions.
- **gate.ts** (offload hub): session.idle runs tiered verification on files touched by edit/write calls - shellcheck on shell files, tsc strict on touched plugins, class-sweep fast on config/repo touches, full bundle pairing when a patcher was touched. Silent when clean, toasts findings, menu kill switch.
- **tools/class-sweep.sh**: the bug-class playbook as deterministic checks (bare require in ESM, stale root paths, version-pinned chunk paths, non-atomic asar writes, per-patcher gates, registry validity) - exit 1 on any hit; upstream-first, runs shellcheck when installed.
- **tests/fuzz/**: hostile-value batteries (notify window math, 23 cases with shadowed-Date slices; CLI tools, 16 cases in HOME sandboxes) + crash-proof run-all.mjs suite entry.
- **tools/gd-sweep.sh**: GDScript trap scanner (Godot-3 keywords, float literal equality, randi() % modulo bias, string get_node paths, _process vs _physics_process, connect error handling) - born on a 53k-line game.
- **tools/** batch: plugin-manager (enable/disable, opencode has none natively) + notifier-config (atomic editor for the community notifier).
- **Upstream-first + fixed-bug mandate**: generic checks defer to shellcheck/semgrep/eslint; every fixed bug gets a regression lock, changelog entry, and playbook class. Playbook published as docs/bug-hunting-playbook.md.

## 2026-09-28 and earlier

- Initial cluster: vision-guard, caffeinate, image-shrink, session-size, error-root-cause, session-guard, godot-gate-guard, janitor (post-quit DB maintenance + trim markers), desktop-patch kit (desktop-ui asar patcher, oc-ui, Plugins menu, session menu, edit-candidates).
