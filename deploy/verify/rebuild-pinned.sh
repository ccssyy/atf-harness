#!/usr/bin/env bash
# @Time   : 2026/11/15
# @Author : SamChen
# @File   : rebuild-pinned.sh
# 编排硬化三期批 1g:pinned 部署投影重建唯一入口(旧手工 worktree 多入口退役)。
#
# 形态:pinned=内核仓 git worktree 的部署投影检出(detach 于指定 commit,缺省 origin/main);
# 权威=内核仓 git 历史,本投影不另立判据(投影声明写入 PINNED_PROJECTION.md)。
# fail-closed:指纹(.atf-pin-commit)==实际 HEAD、13 技能在场、pyproject 在场——任一不满足
# 即退出非零并给修复指引;不做静默降级(pin 形态事故×5 的根治面)。
#
# 用法: rebuild-pinned.sh <内核仓路径> <pin目标目录> [commit(缺省 origin/main)]
set -euo pipefail

KERNEL_DIR="${1:?用法: rebuild-pinned.sh <内核仓路径> <pin目标目录> [commit]}"
PIN_DIR="${2:?缺少 pin 目标目录}"
COMMIT="${3:-origin/main}"

fail() { echo "rebuild-pinned FAILED: $1" >&2; echo "  改法一: 核对参数(内核仓路径/pin 目标)后重跑" >&2; echo "  改法二: 指纹/产物校验失败时,确认目标 commit 在内核仓 origin 可达(git fetch 后重跑)" >&2; exit 2; }

cd "$KERNEL_DIR" || fail "内核仓路径不可达:$KERNEL_DIR"
git fetch origin --quiet || fail "git fetch 失败(内核仓 origin)"
RESOLVED=$(git rev-parse --verify "${COMMIT}^{commit}" 2>/dev/null) || fail "commit 不可达:$COMMIT"

if [ -e "$PIN_DIR" ] && [ ! -d "$PIN_DIR/.git" ] && [ ! -f "$PIN_DIR/.git" ]; then
  fail "目标已存在且不是 worktree 检出:$PIN_DIR——旧手工拷贝形态已退役;备份后删除该目录再用本脚本重建(不在此静默接管)"
fi

if [ -d "$PIN_DIR" ] && { [ -f "$PIN_DIR/.git" ] || [ -d "$PIN_DIR/.git" ]; }; then
  # 已是 worktree:前移到目标 commit(唯一合法推进通道)
  git -C "$PIN_DIR" fetch origin --quiet 2>/dev/null || true
  git -C "$PIN_DIR" checkout --quiet --detach "$RESOLVED" || fail "已有 worktree 前移失败:$PIN_DIR -> $RESOLVED"
else
  git worktree add --detach "$PIN_DIR" "$RESOLVED" || fail "worktree add 失败:$PIN_DIR @ $RESOLVED"
fi

cd "$PIN_DIR"
echo "$RESOLVED" > .atf-pin-commit
cat > PINNED_PROJECTION.md <<EOF
# pinned 部署投影声明

- 权威: 内核仓 git 历史(本目录为部署投影检出,不另立判据,禁手改产物)。
- 生成: deploy/verify/rebuild-pinned.sh(唯一重建入口,旧手工 worktree 路径已退役)。
- 指纹: .atf-pin-commit = $RESOLVED;消费端校验指纹==实际 HEAD,失配即 fail-closed。
EOF

# fail-closed 终检:指纹一致+技能面在场+工程件在场
ACTUAL=$(git rev-parse HEAD)
[ "$ACTUAL" = "$RESOLVED" ] || fail "指纹失配:.atf-pin-commit=$RESOLVED 实际=$ACTUAL"
SKILL_N=$(ls skills 2>/dev/null | grep -c '^atf-' || true)
[ "$SKILL_N" -ge 13 ] || fail "技能面不全($SKILL_N/13)——目标 commit 可能不含完整 skills/"
[ -f pyproject.toml ] || fail "pyproject.toml 缺席——检出形态不完整"

echo "rebuild-pinned OK: $PIN_DIR @ $RESOLVED (skills ${SKILL_N}, 指纹已写, 投影声明在场)"
