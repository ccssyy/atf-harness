#!/usr/bin/env bash
# ============================================================================
# vendor/dsh patch 重同步脚本（批㊶-W F5 引入——VERIFY 2「bump 重同步脚本」交付件）
#
# 用途：vendor/dsh/deepseek-harness submodule 升级（LOCK.md 锁 commit 变更）或 UAT 发版
#       （uat-deploy.sh 步骤 1c——submodule update 每次重置 pristine，patch 集不随发版走）后，
#       将 patches/0001-0006 按序重放到新 worktree 并重建消费产物。
# 纪律：升级只走独立评估批（LOCK.md）；本脚本不检测破坏性变更——apply 失败即停
#       （上游改动冲突须人工评估后更新 patch），绝不静默跳过。
# 幂等（D85）：patch 链已全部应用（链式逆向判定——临时 index 上逆序逐个逆向验证）
#       则全 skip 并跳过重建段（产物零额外变更）；pristine 则全量重放；其余 fail-closed。
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

# —— patch 重放（D85 幂等化）——
# 三态判定模型（受控双现场：submodule update 后 pristine 重放／发版后幂等复跑）：
# ① 首 patch 正向 check 通过 ⇒ pristine（链未开始）——dirty 即守卫 die，否则全量重放；
# ② 否则链式逆向判定通过 ⇒ 全部已应用——幂等 skip，跳过重建段；
# ③ 其余 ⇒ 半应用态/上游冲突——fail-closed die。
# 为何链式而非逐 patch reverse-check：git apply 后的新增文件是 untracked（逆向删除
# 以 index 为存在性基准必误报），且 patch 链存在同文件叠加（0003/0005 于 FormPanel
# 系——工作树 blob 为叠加后像，单 patch 逆向上下文必失配）——须按 0006→0001 逆序
# 在临时 index（工作树实态，不触碰真 index、不写工作树）上逐个 check＋真逆向推进。
DIRTY=$(git status --porcelain -- packages/ | wc -l)
FIRST_PATCH="$(ls -1 "$PATCH_DIR"/0*.patch | head -1)"

all_patches_applied() {
  local tmpidx patch f
  tmpidx="$(mktemp)"
  GIT_INDEX_FILE="$tmpidx" git read-tree HEAD 2>/dev/null || { rm -f "$tmpidx"; return 1; }
  # 触达文件并集 → 工作树实态填入临时 index（untracked 新增文件由此获得存在性）
  for patch in "$PATCH_DIR"/0*.patch; do
    for f in $(git apply --numstat "$patch" 2>/dev/null | awk '{print $3}'); do
      if [[ -f "$f" ]]; then
        GIT_INDEX_FILE="$tmpidx" git update-index -q --add -- "$f" 2>/dev/null || { rm -f "$tmpidx"; return 1; }
      else
        GIT_INDEX_FILE="$tmpidx" git update-index -q --force-remove -- "$f" 2>/dev/null || { rm -f "$tmpidx"; return 1; }
      fi
    done
  done
  # 逆序链式逆向：check 过了才真逆向推进临时 index，供更早 patch 判定
  for patch in $(ls -1 "$PATCH_DIR"/0*.patch | sort -r); do
    if ! GIT_INDEX_FILE="$tmpidx" git apply --check --reverse --cached "$patch" 2>/dev/null; then
      rm -f "$tmpidx"; return 1
    fi
    GIT_INDEX_FILE="$tmpidx" git apply --reverse --cached "$patch" 2>/dev/null || { rm -f "$tmpidx"; return 1; }
  done
  rm -f "$tmpidx"
  return 0
}

if git apply --check "$FIRST_PATCH" 2>/dev/null; then
  # ① pristine 重放（原语义：dirty 守卫 fail-closed）
  if [[ "$DIRTY" -gt 0 ]]; then
    echo "[apply-patches] FAIL: worktree packages/ 有未提交改动（${DIRTY} 项）——先还原到 pristine 再重放（git checkout -- packages/ && git clean -fd packages/）" >&2
    exit 1
  fi
  for patch in "$PATCH_DIR"/0*.patch; do
    name="$(basename "$patch")"
    echo "[apply-patches] 应用 ${name}…"
    if ! git apply --check "$patch" 2>/dev/null; then
      echo "[apply-patches] FAIL: ${name} 无法应用（上游冲突——人工评估更新 patch）" >&2
      exit 1
    fi
    git apply "$patch"
  done
  echo "[apply-patches] 全部 patch 已应用——重建消费产物（host 类型链＋client bundle）…"
  corepack pnpm exec tsc -b tsconfig.host.json
  corepack pnpm exec tsc -b tsconfig.client.json
  corepack pnpm exec tsdown --env.DSH_BUILD_FACE host >/dev/null 2>&1
  corepack pnpm --filter @deepseek-ai/dsh-client-ui-user-questions run bundle >/dev/null
  # patch 触达的 client 包凡带 bundle 脚本均需重建（当前 0006＝ui-settings）。
  corepack pnpm --filter @deepseek-ai/dsh-client-ui-settings run bundle >/dev/null
else
  if all_patches_applied; then
    echo "[apply-patches] 全部 patch 均已应用（幂等 skip——链式逆向判定通过）——跳过重建段（产物零额外变更）。"
    echo "[apply-patches] 完成。"
    exit 0
  fi
  echo "[apply-patches] FAIL: worktree 处于半应用态或上游冲突（${DIRTY} 项未提交改动；首 patch 无法正向应用且 patch 链逆向判定不过）——先还原到 pristine 再重放（git checkout -- packages/ && git clean -fd packages/）" >&2
  exit 1
fi

echo "[apply-patches] 完成——回主仓跑全量测试＋boot 验证后收口。"
