#!/usr/bin/env bash
# ============================================================================
# DEV 部署唯一入口（work/20261117-deploy-evidence-gate；D318 M6 部署门禁接线）
#
# 「部署即首演」模式终止的入口形态：DEV 上线必须走本入口——六步全绿才生效，
# 任一步失败即停止（fail-closed），不允许绕过任何一步手工拼装上线。
#
# 链: ①证据门(check-deploy-evidence) ②预演门(deploy-rehearsal-gate)
#     ③单版本源门(check-kernel-single-source) ④主检出同步对账
#     ⑤实例重启(instance-restart dev) ⑥健康门(部署目标/HTTP/boot 行)
# G7／D9：pin 树退役——原「pinned 重建」步与 pin 指纹健康判据已删（不再是加载源）。
#
# 用法: deploy-dev.sh --evidence <json> [--commit <sha|origin/main>] [--rehearsal-evidence <file>]
#       deploy-dev.sh --batch <slug>    …同上，证据清单按约定路径推导
#   G7 双仓（2026-11-23）：--commit 默认指内核仓；harness 侧基线用清单 head_commit_harness，
#   其可达性由证据门验（第 4 参数 harness 仓根）。部署目标 commit 仍以内核仓为准——
#   运行时内核＝主检出（唯一加载源）；harness 代码改动经证据门 head_commit_harness 对账。
#         证据清单缺省 = <ATF_KERNEL_SOURCE>/.zcode/deploy-evidence/<batch-slug>.json
#         预演证据缺省 = 同目录 <batch-slug>-rehearsal.md
#
# 各步职责:
#   ① 上线批次证据（DeployEvidence/v1——verdict PASS/映射/锚/新鲜度，本入口恒严）
#   ② 部署前用户可见行为预演证据（1117 owner 裁「部署即首演」终止；纯非用户可见
#      改动在预演证据中显式声明免演范围与理由）
#   ③ 三指针同源自检＋段序哨兵＋锚点新鲜（dev.env）
#   ④ 主检出 HEAD == 部署目标 commit（运行时内核＝主检出，唯一加载源）
#   ⑤ 实例净室重启（instance-restart dev——键探针/漂移门禁/单源门内嵌）
#   ⑥ 健康门: 主检出 HEAD==部署目标 commit ＋ WebUI HTTP 401/200 ＋ boot 日志
#      「L2 fatal 0 项」与「MCP/桥 对端: real」在场
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$HARNESS_ROOT/deploy/instances/dev.env"
DEV_PORT=3080
DEV_LOG="/tmp/dsh-web-k28.log"

die() { echo "deploy-dev 拦截: $1" >&2; exit 2; }

EVIDENCE=""; BATCH=""; COMMIT="origin/main"; REHEARSAL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence) EVIDENCE="${2:?--evidence 缺值}"; shift 2 ;;
    --batch) BATCH="${2:?--batch 缺值}"; shift 2 ;;
    --commit) COMMIT="${2:?--commit 缺值}"; shift 2 ;;
    --rehearsal-evidence) REHEARSAL="${2:?--rehearsal-evidence 缺值}"; shift 2 ;;
    *) die "未知参数: $1（用法见脚本头）" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || die "实例 env 不存在: $ENV_FILE"
env_val() { grep -E "^export $1=" "$ENV_FILE" | tail -1 | sed -E "s/^export $1=['\"]?([^'#]*)['\"]?.*/\1/" | xargs; }
KERNEL_REPO=$(env_val ATF_KERNEL_SOURCE)
[[ -n "$KERNEL_REPO" && -d "$KERNEL_REPO" ]] || die "dev.env 的 ATF_KERNEL_SOURCE 不可达: ${KERNEL_REPO:-<空>}"

# 目标 commit 先行解析（证据门 ① 需要 expect 对账）
git -C "$KERNEL_REPO" fetch origin --quiet || die "git fetch 失败（内核仓 $KERNEL_REPO）"
RESOLVED=$(git -C "$KERNEL_REPO" rev-parse --verify "${COMMIT}^{commit}") || die "部署目标 commit 不可达: $COMMIT"
[[ "$EVIDENCE" != "" || "$BATCH" != "" ]] || die "缺证据清单: --evidence <json> 或 --batch <slug>（部署证据门恒严——deploy-dev 无免证通道）"
EVIDENCE="${EVIDENCE:-$KERNEL_REPO/.zcode/deploy-evidence/$BATCH.json}"
REHEARSAL="${REHEARSAL:-${EVIDENCE%.json}-rehearsal.md}"

echo "[deploy-dev ①] 证据门（expect $RESOLVED）…"
bash "$SCRIPT_DIR/check-deploy-evidence.sh" "$EVIDENCE" "$KERNEL_REPO" "$RESOLVED" "$HARNESS_ROOT"

BASE_COMMIT=$(python3 -c "import json,sys;print((json.load(open(sys.argv[1])).get('base_commit') or ''))" "$EVIDENCE")
echo "[deploy-dev ②] 预演门（基准 commit ${BASE_COMMIT:-<清单未声明>}）…"
bash "$SCRIPT_DIR/deploy-rehearsal-gate.sh" "$REHEARSAL" "$BASE_COMMIT"

echo "[deploy-dev ③] 单版本源门…"
bash "$SCRIPT_DIR/check-kernel-single-source.sh" "$ENV_FILE"

echo "[deploy-dev ④] 主检出同步对账…"
LIVE_HEAD=$(git -C "$KERNEL_REPO" rev-parse HEAD)
if [[ "$LIVE_HEAD" != "$RESOLVED" ]]; then
  die "主检出 HEAD(${LIVE_HEAD:0:12}) ≠ 部署目标(${RESOLVED:0:12})——运行时内核=主检出（唯一加载源），不同步即部署面劈叉;改法: 主检出 git pull --ff-only 到目标 commit 后重跑本入口"
fi

echo "[deploy-dev ⑤] 实例重启（dev 净室重放）…"
# 活键显式指认（owner 1115 裁定纪律：重启一律显式带 ATF_INSTANCE_KEY_ENV）——
# 缺省取 dev.env 声明的活键路径，调用方 env 显式值优先。
KEY_ENV_DECLARED=$(env_val ATF_INSTANCE_KEY_ENV)
ATF_INSTANCE_KEY_ENV="${ATF_INSTANCE_KEY_ENV:-$KEY_ENV_DECLARED}" \
  ATF_DEPLOY_EVIDENCE="$EVIDENCE" \
  bash "$HARNESS_ROOT/deploy/instances/instance-restart.sh" dev

echo "[deploy-dev ⑥] 健康门…"
# G7／D9：健康门判据由「pin 指纹==部署目标」改为「主检出 HEAD==部署目标」——pin 树不再是
# 加载源，用主检出对齐才能证「在跑的就是本次目标」。
ACTUAL_HEAD=$(git -C "$KERNEL_REPO" rev-parse HEAD 2>/dev/null || echo "")
[[ "$ACTUAL_HEAD" == "$RESOLVED" ]] || die "主检出 HEAD $ACTUAL_HEAD != 部署目标 $RESOLVED——部署面与目标失配"
CODE="000"
for _ in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${DEV_PORT}/" 2>/dev/null || true)
  [[ "$CODE" == "401" || "$CODE" == "200" ]] && break
  sleep 2
done
[[ "$CODE" == "401" || "$CODE" == "200" ]] || die "WebUI 未就绪（最后 HTTP ${CODE}）——查 boot 日志 $DEV_LOG"
tail -c 200000 "$DEV_LOG" 2>/dev/null | grep -q "L2 fatal 0 项" || die "boot 日志无「L2 fatal 0 项」——查 $DEV_LOG"
# G5 后日志串已从「桥对端: real」改为「MCP 对端: real」（传输层换 MCP）；
# 兼容两种写法（过渡期/回滚态）。
tail -c 200000 "$DEV_LOG" 2>/dev/null | grep -qE "(MCP|桥) 对端: real" || die "boot 日志对端非 real（MCP/桥）——查 $DEV_LOG"

echo "deploy-dev OK: $RESOLVED 已上线 DEV（证据 $EVIDENCE ｜ 预演 $REHEARSAL ｜ 健康 HTTP $CODE）"
