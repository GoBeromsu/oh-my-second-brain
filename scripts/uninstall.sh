#!/usr/bin/env bash
# Oh My Second Brain uninstaller — removes host adapter registrations and optionally the package.
# Usage: curl -fsSL https://raw.githubusercontent.com/Xia-Ataraxia/oh-my-second-brain/main/scripts/uninstall.sh | bash
set -euo pipefail

RUNTIME="${OMS_UNINSTALL_RUNTIME:-all}"
VAULT="${OMS_VAULT:-$PWD}"
REMOVE_PACKAGE="${OMS_REMOVE_PACKAGE:-1}"
EXECUTE="${OMS_EXECUTE_EXTERNAL:-0}"
YES="${OMS_UNINSTALL_CONFIRM:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME="${1#--runtime=}"; shift ;;
    --vault) VAULT="${2:-}"; shift 2 ;;
    --vault=*) VAULT="${1#--vault=}"; shift ;;
    --keep-package) REMOVE_PACKAGE=0; shift ;;
    --execute) EXECUTE=1; shift ;;
    -y|--yes) YES=1; shift ;;
    *) shift ;;
  esac
done

if [ "$YES" != "1" ]; then
  if [ -t 0 ]; then
    printf 'Remove Oh My Second Brain host registrations for runtime=%s? (y/N) ' "$RUNTIME"
    read -r REPLY
  elif [ -c /dev/tty ]; then
    printf 'Remove Oh My Second Brain host registrations for runtime=%s? (y/N) ' "$RUNTIME" >&2
    read -r REPLY < /dev/tty
  else
    echo "Non-interactive uninstall requires --yes or OMS_UNINSTALL_CONFIRM=1." >&2
    exit 1
  fi
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

ARGS=(uninstall --runtime "$RUNTIME" --vault "$VAULT" --yes)
if [ "$EXECUTE" = "1" ]; then
  ARGS+=(--execute)
fi

if command -v oh-my-second-brain >/dev/null 2>&1; then
  oh-my-second-brain "${ARGS[@]}"
elif command -v oms >/dev/null 2>&1; then
  oms "${ARGS[@]}"
else
  echo "Oh My Second Brain binary not found; skipping host deregistration." >&2
fi

if [ "$REMOVE_PACKAGE" = "1" ] && command -v npm >/dev/null 2>&1; then
  npm uninstall -g oh-my-second-brain || true
  npm uninstall -g oms || true
fi

echo "Oh My Second Brain uninstall complete. Vault content was not removed."
