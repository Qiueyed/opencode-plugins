#!/bin/bash
# untrack-pycache.sh - remove tracked __pycache__ dirs / *.pyc files from a
# repo's git index (the files stay on disk; .gitignore prevents re-tracking).
# Checks the ignore rule first, else the litter returns on the next git add -A.
#
#   untrack-pycache.sh <repo-dir> [--push]
#   untrack-pycache.sh --all          all repos under ~/Documents/github + the game
set -euo pipefail

one() {
  cd "$1"
  if ! grep -q "__pycache__" .gitignore 2>/dev/null; then
    echo "SKIP $(basename "$PWD"): no __pycache__ rule in .gitignore - add it first or they return"
    return 0
  fi
  local files
  files=$(git ls-files | grep -iE "(^|/)__pycache__/|\.pyc$" || true)
  if [ -z "$files" ]; then
    echo "clean $(basename "$PWD"): no tracked pycache/pyc"
    return 0
  fi
  printf '%s\n' "$files" | xargs git rm -q --cached
  git commit -q -m "untrack pycache bytecode ($(printf '%s\n' "$files" | wc -l | tr -d ' ') files) - regenerated locally, never belonged in the repo"
  echo "untracked $(printf '%s\n' "$files" | wc -l | tr -d ' ') file(s) in $(basename "$PWD")"
  [ "${2:-}" = "--push" ] && git push -q && echo "pushed $(basename "$PWD")"
  return 0
}

if [ "${1:-}" = "--all" ]; then
  for r in "$HOME"/Documents/github/*/ "$HOME"/Documents/Godot/*/; do
    [ -d "$r/.git" ] && one "$r" "${2:-}"
  done
else
  one "${1:?usage: untrack-pycache.sh <repo-dir> [--push] | --all}" "${2:-}"
fi
