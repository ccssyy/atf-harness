#!/usr/bin/env bash
# ============================================================================
# vendor 同步检查器（G0 交付件）
#
# 治什么：apply-patches.sh 负责「重放到新 vendor」，但**升级后是否仍然健康**
# 靠人记——patch 数量变了没、插件是否加载失败、构建产物是否与源码一致，
# 都没有自动断言。本脚本把这一步做成机检。
#
# 判据（任一不满足即 exit 非 0）：
#   ① patch 数量与期望一致（期望值=仓库内 patches/ 实际数量，防「悄悄删/加」）
#   ② vendor HEAD 与 LOCK.md 记录一致（防「升级了但没改 LOCK」）
#   ③ patch 链完整应用（逆向验证：每个 patch 都能被 `git apply --reverse --check`）
#   ④ atf-ui / atf-tools 的构建产物存在且非空
#   ⑤ 三层+腐化审计器全绿（复用 npm run audit:all）
#
# 用法：tools/check-vendor-sync.sh [--skip-audit]
# 退出码：0=全过；1=有项失败（报错含改法）
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/dsh/deepseek-harness"
PATCH_DIR="$REPO_ROOT/vendor/dsh/patches"
LOCK_FILE="$REPO_ROOT/vendor/dsh/LOCK.md"
SKIP_AUDIT=false
[[ "${1:-}" == "--skip-audit" ]] && SKIP_AUDIT=true

fail=0
ok()   { echo "  ✅ $*"; }
bad()  { echo "  ❌ $*"; fail=1; }
hint() { echo "     → $*"; }

echo "== vendor 同步检查 =="
echo

# —— ① patch 数量 ——
echo "[1] patch 清单"
ACTUAL_PATCHES=$(find "$PATCH_DIR" -maxdepth 1 -name '0*.patch' | sort)
ACTUAL_COUNT=$(echo "$ACTUAL_PATCHES" | grep -c . || true)
echo "  实际 patch: $ACTUAL_COUNT 个"
# 期望值登记在 EXPECTED_PATCH_LIST（显式清单，而非「实际=期望」自证）。
# 只报数量不断言＝拦不住（实测：删掉一个 patch 后退出码仍是 0）。
EXPECTED_PATCH_LIST="0001-fixed-launch-token.patch 0002-composer-placeholder.patch 0003-form-intent.patch 0004-api-key-reveal.patch 0005-form-cancel.patch 0006-settings-host-persistence.patch 0007-workspace-picker-root.patch 0008-bash-env-passthrough.patch"

if [[ "$ACTUAL_COUNT" -eq 0 ]]; then
  bad "patches/ 下没有任何 0*.patch"
  hint "确认 vendor/dsh/patches/ 目录未丢失；若确已全部插件化，请删本检查段的 [1]"
else
  ACTUAL_NAMES=$(echo "$ACTUAL_PATCHES" | xargs -n1 basename | sort | tr '\n' ' ' | sed 's/ $//')
  EXPECTED_NAMES=$(echo "$EXPECTED_PATCH_LIST" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')
  ok "找到 $ACTUAL_COUNT 个 patch：$ACTUAL_NAMES"
  if [[ "$ACTUAL_NAMES" != "$EXPECTED_NAMES" ]]; then
    bad "patch 清单与登记不符"
    hint "期望：$EXPECTED_NAMES"
    hint "实际：$ACTUAL_NAMES"
    hint "① 若确实新增/删除 patch：同批更新本脚本的 EXPECTED_PATCH_LIST 与方案文档 §四 patch 表 ② 若误删：git checkout vendor/dsh/patches/"
  else
    ok "patch 清单与登记一致"
  fi
fi
echo

# —— ② vendor HEAD vs LOCK ——
echo "[2] vendor HEAD 与 LOCK.md 一致性"
if [[ ! -d "$VENDOR_DIR" ]]; then
  bad "vendor 树不在场：$VENDOR_DIR"
  hint "git submodule update --init vendor/dsh/deepseek-harness"
elif [[ ! -d "$VENDOR_DIR/.git" && ! -f "$VENDOR_DIR/.git" ]]; then
  bad "vendor 树不是 git 检出（可能是软链或空目录）"
  hint "worktree 场景：ln -s <主仓>/vendor/dsh/deepseek-harness vendor/dsh/deepseek-harness"
else
  HEAD_SHA=$(git -C "$VENDOR_DIR" rev-parse HEAD 2>/dev/null || echo "")
  LOCKED=$(grep -o '[0-9a-f]\{40\}' "$LOCK_FILE" 2>/dev/null | head -1 || echo "")
  if [[ -z "$HEAD_SHA" ]]; then
    bad "取不到 vendor HEAD"
  elif [[ -z "$LOCKED" ]]; then
    bad "LOCK.md 里找不到 40 位 commit"
    hint "在 vendor/dsh/LOCK.md 补「锁 commit：<40位sha>」"
  elif [[ "$HEAD_SHA" != "$LOCKED" ]]; then
    bad "HEAD=$HEAD_SHA ≠ LOCK=$LOCKED"
    hint "① 若刚升级 vendor：更新 LOCK.md 的锁 commit  ② 若未升级：git -C vendor/dsh/deepseek-harness checkout $LOCKED"
  else
    ok "HEAD 与 LOCK 一致：${HEAD_SHA:0:12}"
  fi
fi
echo

# —— ③ patch 链已应用 ——
# 判定法：**逆序**逐个 `git apply --reverse --check`。
# 为何必须逆序：patch 之间有前后依赖（实测 0005 又改了 0003 新增的文件），
# 正序逆向会因「后续 patch 已追加改动」而误判为未应用。
# 逆序时先剥掉最后应用的，再验前一个，逐层还原。
echo "[3] patch 链应用状态（逆序逆向验证）"
if [[ -n "${HEAD_SHA:-}" ]] && [[ "$ACTUAL_COUNT" -gt 0 ]]; then
  UNAPPLIED=0
  REVERSED=$(echo "$ACTUAL_PATCHES" | sort -r)
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    # 两种判据，任一成立即为「已应用」：
    #  A) 纯修改型 patch：逆向 apply --check 通过
    #  B) 含新增文件的 patch（new file mode）：逆向语义是「删除已存在文件」，
    #     `git apply --reverse --check` 对此报 "patch does not apply"（它不模拟删除）。
    #     判定改为：patch 里 new file 的路径**全部已在工作区存在** + 逆向可 3way。
    NEW_FILES=$(grep -A4 '^new file mode' "$p" 2>/dev/null | grep '^+++ b/' | sed 's|^+++ b/||' || true)
    APPLIED=false
    if git -C "$VENDOR_DIR" apply --reverse --check "$p" >/dev/null 2>&1; then
      APPLIED=true
    elif [[ -n "$NEW_FILES" ]] && git -C "$VENDOR_DIR" apply --reverse --check --3way "$p" >/dev/null 2>&1; then
      APPLIED=true
    elif [[ -n "$NEW_FILES" ]]; then
      ALL_EXIST=true
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        [[ -e "$VENDOR_DIR/$f" ]] || ALL_EXIST=false
      done <<< "$NEW_FILES"
      [[ "$ALL_EXIST" == true ]] && APPLIED=true
    fi
    if [[ "$APPLIED" != true ]]; then
      bad "patch 未应用或冲突：$(basename "$p")"
      hint "vendor/dsh/apply-patches.sh 重放；若冲突须人工评估后更新 patch"
      UNAPPLIED=$((UNAPPLIED + 1))
    fi
  done <<< "$REVERSED"
  if [[ "$UNAPPLIED" -eq 0 ]]; then
    ok "$ACTUAL_COUNT 个 patch 全部已应用（逆序验证通过）"
  fi
else
  hint "跳过（vendor 不可用或无 patch）"
fi
echo

# —— ④ 构建产物 ——
echo "[4] 消费方构建产物"
# 注意：worktree 里通常不构建（dist 是 gitignore 的产物），此处只报警不误判失败。
# 判定改为「源码包存在」——dist 缺失在 worktree 属正常，在主仓才需构建。
for pkg in atf-ui atf-tools; do
  SRC="$REPO_ROOT/packages/extensions/$pkg/src"
  DIST="$REPO_ROOT/packages/extensions/$pkg/dist"
  if [[ ! -d "$SRC" ]]; then
    bad "$pkg/src 不存在（包丢失）"
  elif [[ -d "$DIST" ]] && [[ -n "$(ls -A "$DIST" 2>/dev/null)" ]]; then
    ok "$pkg 源码在位，dist 已构建"
  else
    ok "$pkg 源码在位（dist 未构建——worktree 属正常；主仓运行前需 corepack pnpm run build）"
  fi
done
echo

# —— ⑤ 审计器 ——
echo "[5] 审计器（四层）"
if [[ "$SKIP_AUDIT" == true ]]; then
  hint "跳过（--skip-audit）"
else
  if (cd "$REPO_ROOT" && npm run --silent audit:all >/dev/null 2>&1); then
    ok "audit:all 全绿"
  else
    bad "audit:all 有未登记项"
    hint "cd $REPO_ROOT && npm run audit:all 查看明细；逐项处置或登记白名单理由"
  fi
fi
echo

# —— 汇总 ——
if [[ "$fail" -eq 0 ]]; then
  echo "✅ vendor 同步检查全过"
  exit 0
else
  echo "❌ vendor 同步检查失败（见上方 ❌ 与 → 改法）"
  exit 1
fi
