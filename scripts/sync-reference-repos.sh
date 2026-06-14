#!/usr/bin/env bash
# =============================================================================
# sync-reference-repos.sh
# =============================================================================
# Clones (or git-pulls) confirmed external reference repos into
#   vendor/reference-repos/<name>/
# using shallow clones (--depth 1) to minimise disk usage.
#
# Repos cloned:
#   Agent Skills / 도구
#     - oh-my-claudecode  https://github.com/Yeachan-Heo/oh-my-claudecode
#     - oh-my-codex       https://github.com/Yeachan-Heo/oh-my-codex
#     - graphify          https://github.com/safishamsi/graphify
#     - lazycodex         https://github.com/code-yeongyu/lazycodex
#
#   검색 / 임베딩 엔진
#     - qmd               https://github.com/tobi/qmd
#     - pgvector          https://github.com/pgvector/pgvector
#     - pglite            https://github.com/electric-sql/pglite
#
#   LLM-Wiki 에코시스템
#     - llm_wiki          https://github.com/nashsu/llm_wiki
#     - llm_wiki_skill    https://github.com/nashsu/llm_wiki_skill
#     - karpathy-llm-wiki https://github.com/Astro-Han/karpathy-llm-wiki
#     - nvk-llm-wiki      https://github.com/nvk/llm-wiki
#     - lucasastorian-llmwiki https://github.com/lucasastorian/llmwiki
#
# Skipped (TODO verify — URL not confirmed):
#   (none currently; all listed above are confirmed)
#
# Idempotent: re-running will pull latest on already-cloned repos.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/reference-repos"

mkdir -p "${VENDOR_DIR}"

# Counters
cloned=0
updated=0
failed=0
failed_names=()

# ---------------------------------------------------------------------------
# clone_or_pull <name> <url>
# ---------------------------------------------------------------------------
clone_or_pull() {
  local name="$1"
  local url="$2"
  local dest="${VENDOR_DIR}/${name}"

  if [ -d "${dest}/.git" ]; then
    echo "[update] ${name}"
    if git -C "${dest}" pull --ff-only --quiet 2>/dev/null; then
      updated=$((updated + 1))
    else
      # shallow repos can't fast-forward; just fetch latest
      git -C "${dest}" fetch --depth 1 --quiet origin 2>/dev/null \
        && git -C "${dest}" reset --hard FETCH_HEAD --quiet 2>/dev/null \
        && updated=$((updated + 1)) \
        || { echo "  [warn] could not update ${name} — skipping"; failed=$((failed + 1)); failed_names+=("${name}"); }
    fi
  else
    echo "[clone]  ${name}  (${url})"
    if git clone --depth 1 --quiet "${url}" "${dest}" 2>/dev/null; then
      cloned=$((cloned + 1))
    else
      echo "  [error] clone failed for ${name}"
      failed=$((failed + 1))
      failed_names+=("${name}")
      rm -rf "${dest}"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Agent Skills / 도구
# ---------------------------------------------------------------------------
clone_or_pull "oh-my-claudecode"        "https://github.com/Yeachan-Heo/oh-my-claudecode"
clone_or_pull "oh-my-codex"             "https://github.com/Yeachan-Heo/oh-my-codex"
clone_or_pull "graphify"                "https://github.com/safishamsi/graphify"
clone_or_pull "lazycodex"               "https://github.com/code-yeongyu/lazycodex"

# ---------------------------------------------------------------------------
# 검색 / 임베딩 엔진
# ---------------------------------------------------------------------------
clone_or_pull "qmd"                     "https://github.com/tobi/qmd"
clone_or_pull "pgvector"                "https://github.com/pgvector/pgvector"
clone_or_pull "pglite"                  "https://github.com/electric-sql/pglite"

# ---------------------------------------------------------------------------
# LLM-Wiki 에코시스템
# ---------------------------------------------------------------------------
clone_or_pull "llm_wiki"                "https://github.com/nashsu/llm_wiki"
clone_or_pull "llm_wiki_skill"          "https://github.com/nashsu/llm_wiki_skill"
clone_or_pull "karpathy-llm-wiki"       "https://github.com/Astro-Han/karpathy-llm-wiki"
clone_or_pull "nvk-llm-wiki"            "https://github.com/nvk/llm-wiki"
clone_or_pull "lucasastorian-llmwiki"   "https://github.com/lucasastorian/llmwiki"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "  sync-reference-repos — done"
echo "========================================"
echo "  cloned : ${cloned}"
echo "  updated: ${updated}"
echo "  failed : ${failed}"
if [ ${#failed_names[@]} -gt 0 ]; then
  echo "  failed repos:"
  for n in "${failed_names[@]}"; do
    echo "    - ${n}"
  done
fi
echo "  dest   : ${VENDOR_DIR}"
echo "========================================"
