#!/usr/bin/env bash
# ============================================================================
# harness worktree 依赖环境装配脚本（scripts/setup-worktree-deps.sh）
#
# 用途：git worktree add 之后跑一次，把测试/typecheck 所需依赖环境补齐。
#   worktree 检出不带 node_modules 与 vendor 实体（vendor/dsh/deepseek-harness 是
#   gitlink，submodule 路径拒绝符号链接——软链会让 git status 直接报错），本脚本用
#   硬链从主仓检出复制（同设备零额外磁盘占用）。
#
# 装配内容（与主仓可跑形态同构）：
#   1. <worktree>/node_modules                          ← 主仓根 node_modules 硬链
#   2. vendor/dsh/deepseek-harness/node_modules         ← 绝对路径软链（vendor 内部，
#                                                        不进 git status 的 gitlink
#                                                        路径本身，安全）
#   3. vendor/dsh/deepseek-harness/vendor/*             ← cordis/cosmokit 等实体两层硬链
#   4. vendor/dsh/deepseek-harness/packages/*           ← dsh-* 包两层硬链（含 lib 构建产物）
#
# 用法：scripts/setup-worktree-deps.sh <worktree 绝对路径>
# 幂等：已存在的条目跳过；重复执行零副作用。
# 注意：仅限 A800 dev 容器同设备场景（硬链跨设备无效）；主仓必须先完成 pnpm install
#   与 vendor 构建（lib/ 产物在位）。
# ============================================================================
set -euo pipefail

MAIN_REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="$(cd "$1" && pwd)"
VENDOR_SRC="$MAIN_REPO/vendor/dsh/deepseek-harness"
VENDOR_DST="$WORKTREE/vendor/dsh/deepseek-harness"

if [[ ! -d "$VENDOR_SRC/packages/core/tools/lib" ]]; then
  echo "[setup-worktree-deps] 主仓 vendor 构建产物缺失（$VENDOR_SRC/packages/core/tools/lib）——先在主仓完成 vendor 构建" >&2
  exit 1
fi

# 1. 根 node_modules 硬链
if [[ ! -d "$WORKTREE/node_modules" ]]; then
  cp -al "$MAIN_REPO/node_modules" "$WORKTREE/node_modules"
  echo "[setup-worktree-deps] node_modules 硬链完成"
else
  echo "[setup-worktree-deps] node_modules 已在，跳过"
fi

# 2. vendor 内部 node_modules（软链——gitlink 路径之下，不触发 submodule 检查）
mkdir -p "$VENDOR_DST"
if [[ ! -e "$VENDOR_DST/node_modules" ]]; then
  ln -sfn "$VENDOR_SRC/node_modules" "$VENDOR_DST/node_modules"
  echo "[setup-worktree-deps] vendor node_modules 软链完成"
else
  echo "[setup-worktree-deps] vendor node_modules 已在，跳过"
fi

# 3/4. vendor 实体（两层：vendor/* 与 packages/*/*——覆盖 alias 表全部目标与传递依赖）
# 注意：cp -al 不自动创建多级缺失父目录——先显式建层（缺失父目录会被 || true 静默吞掉）
mkdir -p "$VENDOR_DST/vendor" "$VENDOR_DST/packages"
for layer in vendor packages; do
  for d in "$VENDOR_SRC/$layer"/*/; do
    n="$(basename "$d")"
    if [[ ! -e "$VENDOR_DST/$layer/$n" ]]; then
      cp -al "$d" "$VENDOR_DST/$layer/$n" 2>/dev/null || true
    fi
  done
  for d in "$VENDOR_SRC/$layer"/*/; do
    n="$(basename "$d")"
    for s in "$d"*/; do
      s="$(basename "$s")"
      if [[ ! -e "$VENDOR_DST/$layer/$n/$s" && -d "${d}${s}" ]]; then
        cp -al "${d}${s}" "$VENDOR_DST/$layer/$n/$s" 2>/dev/null || true
      fi
    done
  done
done
echo "[setup-worktree-deps] vendor 实体两层硬链完成（vendor/*+packages/*/*）"

# 就绪自检：vitest alias 表四个关键目标在位即视为可用
for probe in "$VENDOR_DST/packages/core/tools/lib/index.js" \
             "$VENDOR_DST/vendor/cordis/lib/index.js" \
             "$VENDOR_DST/packages/llm/llm/lib/index.js" \
             "$WORKTREE/node_modules/@deepseek-ai/dsh-tools"; do
  if [[ ! -e "$probe" ]]; then
    echo "[setup-worktree-deps] 自检失败：$probe 不在位" >&2
    exit 1
  fi
done
echo "[setup-worktree-deps] 就绪自检通过：$WORKTREE 可跑 vitest/typecheck"
