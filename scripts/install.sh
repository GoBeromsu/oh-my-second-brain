#!/usr/bin/env bash
# Oh My Second Brain installer — installs the package and registers host adapters.
# Usage: curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash
set -euo pipefail

PACKAGE_SPEC="${OMS_PACKAGE_SPEC:-oh-my-second-brain@latest}"
NODE_RUNTIME="${OMS_NODE_RUNTIME:-24}"
RUNTIME="${OMS_INSTALL_RUNTIME:-auto}"
VAULT="${OMS_VAULT:-$PWD}"
EXECUTE="${OMS_EXECUTE_EXTERNAL:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME="${1#--runtime=}"; shift ;;
    --vault) VAULT="${2:-}"; shift 2 ;;
    --vault=*) VAULT="${1#--vault=}"; shift ;;
    --package) PACKAGE_SPEC="${2:-}"; shift 2 ;;
    --package=*) PACKAGE_SPEC="${1#--package=}"; shift ;;
    --execute) EXECUTE=1; shift ;;
    *) shift ;;
  esac
done

if ! command -v volta >/dev/null 2>&1; then
  echo "Error: Volta is required so OMS and its native dependencies keep one Node runtime." >&2
  echo "Install Volta from https://docs.volta.sh/guide/getting-started and retry." >&2
  exit 1
fi

echo "Oh My Second Brain Installer"
echo "  package: $PACKAGE_SPEC"
echo "  node:    $NODE_RUNTIME (Volta-pinned for OMS only)"
echo "  runtime: $RUNTIME"
echo "  vault:   $VAULT"
echo

PREVIOUS_NODE="$(volta list node --default --format plain 2>/dev/null || true)"
case "$PREVIOUS_NODE" in
  "runtime node@"*" (default)")
    PREVIOUS_NODE="${PREVIOUS_NODE#runtime node@}"
    PREVIOUS_NODE="${PREVIOUS_NODE% (default)}"
    ;;
  *) PREVIOUS_NODE="" ;;
esac

# `volta install node@X` changes the user's DEFAULT Node, so the restore has to
# be armed before the first mutation and run on every exit path. Restoring only
# on the success path leaves a failed install with the user's default rewritten.
restore_default_node() {
  if [ -n "$PREVIOUS_NODE" ] && [ "$PREVIOUS_NODE" != "$NODE_RUNTIME" ]; then
    volta install "node@$PREVIOUS_NODE" || true
  fi
}
trap restore_default_node EXIT

volta install "node@$NODE_RUNTIME"
volta install "$PACKAGE_SPEC"

ARGS=(host install --runtime "$RUNTIME" --vault "$VAULT" --yes)
if [ "$EXECUTE" = "1" ]; then
  ARGS+=(--execute)
fi

volta run oms "${ARGS[@]}"

echo
echo "Oh My Second Brain install complete. Run: oh-my-second-brain doctor --vault \"$VAULT\""
