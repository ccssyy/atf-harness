#!/usr/bin/env bash
# ============================================================================
# vendor/dsh patch 重同步脚本（批㊶-W F5 引入——VERIFY 2「bump 重同步脚本」交付件）
#
# 用途：vendor/dsh/deepseek-harness submodule 升级（LOCK.md 锁 commit 变更）后，
#       将 patches/0001-0003 按序重放到新 worktree 并重建消费产物。
# 纪律：升级只走独立评估批（LOCK.md）；本脚本不检测破坏性变更——apply 失败即停
#       （上游改动冲突须人工评估后更新 patch），绝不静默跳过。
#
# 用法：vendor/dsh/apply-patches.sh
# 前提：submodule 已检出目标 commit 且 corepack pnpm install 完成。
# ============================================================================
set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "$0")/deepseek-harness" && pwd)"
PATCH_DIR="$(cd "$(dirname "$0")/patches" && pwd)"

cd "$VENDOR_DIR"
echo "[apply-patches] vendor HEAD: $(git rev-parse HEAD)"
echo "[apply-patches] 锁 commit 校验：与 ../LOCK.md 记录比对（升级批改 LOCK 后此处跟随）"
LOCKED=$(grep -o '[0-9a-f]\{40\}' "$PATCH_DIR/../LOCK.md" | head -1 || true)
if [[ -n "$LOCKED" && "$LOCKED" != "$(git rev-parse HEAD)" ]]; then
  echo "[apply-patches] WARN: HEAD=$(git rev-parse HEAD) ≠ LOCK.md 记录 ${LOCKED}（升级批未同步 LOCK？）"
fi

DIRTY=$(git status --porcelain -- packages/ | wc -l)
if [[ "$DIRTY" -gt 0 ]]; then
  echo "[apply-patches] FAIL: worktree packages/ 有未提交改动（${DIRTY} 项）——先还原到 pristine 再重放（git checkout -- packages/ && git clean -fd packages/）" >&2
  exit 1
fi

for patch in "$PATCH_DIR"/0*.patch; do
  echo "[apply-patches] 应用 $(basename "$patch")…"
  git apply --check "$patch" || { echo "[apply-patches] FAIL: $(basename "$patch") 无法应用（上游冲突——人工评估更新 patch）" >&2; exit 1; }
  git apply "$patch"
done

echo "[apply-patches] 全部 patch 已应用——重建消费产物（host 类型链＋client bundle）…"
corepack pnpm exec tsc -b tsconfig.host.json
corepack pnpm exec tsc -b tsconfig.client.json
corepack pnpm exec tsdown --env.DSH_BUILD_FACE host >/dev/null 2>&1
corepack pnpm --filter @deepseek-ai/dsh-client-ui-user-questions run bundle >/dev/null

echo "[apply-patches] 完成——回主仓跑全量测试＋boot 验证后收口。"
