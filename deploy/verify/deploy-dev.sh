#!/usr/bin/env bash
# ============================================================================
# DEV 部署唯一入口（work/20261117-deploy-evidence-gate；D318 M6 部署门禁接线）
#
# 「部署即首演」模式终止的入口形态：DEV 上线必须走本入口——六步全绿才生效，
# 任一步失败即停止（fail-closed），不允许绕过任何一步手工拼装上线。
#
# 链: ①证据门(check-deploy-evidence) ②预演门(deploy-rehearsal-gate)
#     ③pinned 重建(rebuild-pinned) ④单版本源门(check-kernel-single-source)
#     ⑤实例重启(instance-restart dev) ⑥健康门(指纹/HTTP/boot 行)
#
# 用法: deploy-dev.sh --evidence <json> [--commit <sha|origin/main>] [--rehearsal-evidence <file>]
#       deploy-dev.sh --batch <slug>    …同上，证据清单按约定路径推导
#         证据清单缺省 = <ATF_KERNEL_SOURCE>/.zcode/deploy-evidence/<batch-slug>.json
#         预演证据缺省 = 同目录 <batch-slug>-rehearsal.md
#
# 各步职责:
#   ① 上线批次证据（DeployEvidence/v1——verdict PASS/映射/锚/新鲜度，本入口恒严）
#   ② 部署前用户可见行为预演证据（1117 owner 裁「部署即首演」终止；纯非用户可见
#      改动在预演证据中显式声明免演范围与理由）
#   ③ pinned 部署投影重建（缺省 origin/main；指纹/13 技能/pyproject fail-closed）
#   ④ 三指针同源自检＋段序哨兵＋锚点新鲜＋pin 指纹（dev.env；时序在重建后）
#   ⑤ 实例净室重启（instance-restart dev——键探针/漂移门禁/单源门内嵌）
#   ⑥ 健康门: pin 指纹==部署目标 commit ＋ WebUI HTTP 401/200 ＋ boot 日志
#      「L2 fatal 0 项」与「桥对端: real」在场
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
PIN_ROOT=$(env_val ATF_INSTANCE_PIN_ROOT)
[[ -n "$KERNEL_REPO" && -d "$KERNEL_REPO" ]] || die "dev.env 的 ATF_KERNEL_SOURCE 不可达: ${KERNEL_REPO:-<空>}"
[[ -n "$PIN_ROOT" ]] || die "dev.env 缺 ATF_INSTANCE_PIN_ROOT"

# 目标 commit 先行解析（证据门 ① 需要 expect 对账）
git -C "$KERNEL_REPO" fetch origin --quiet || die "git fetch 失败（内核仓 $KERNEL_REPO）"
RESOLVED=$(git -C "$KERNEL_REPO" rev-parse --verify "${COMMIT}^{commit}") || die "部署目标 commit 不可达: $COMMIT"
[[ "$EVIDENCE" != "" || "$BATCH" != "" ]] || die "缺证据清单: --evidence <json> 或 --batch <slug>（部署证据门恒严——deploy-dev 无免证通道）"
EVIDENCE="${EVIDENCE:-$KERNEL_REPO/.zcode/deploy-evidence/$BATCH.json}"
REHEARSAL="${REHEARSAL:-${EVIDENCE%.json}-rehearsal.md}"

echo "[deploy-dev ①] 证据门（expect $RESOLVED）…"
bash "$SCRIPT_DIR/check-deploy-evidence.sh" "$EVIDENCE" "$KERNEL_REPO" "$RESOLVED"

BASE_COMMIT=$(python3 -c "import json,sys;print((json.load(open(sys.argv[1])).get('base_commit') or ''))" "$EVIDENCE")
echo "[deploy-dev ②] 预演门（基准 commit ${BASE_COMMIT:-<清单未声明>}）…"
bash "$SCRIPT_DIR/deploy-rehearsal-gate.sh" "$REHEARSAL" "$BASE_COMMIT"

echo "[deploy-dev ③] pinned 重建 @ $RESOLVED…"
ATF_DEPLOY_EVIDENCE="$EVIDENCE" bash "$SCRIPT_DIR/rebuild-pinned.sh" "$KERNEL_REPO" "$PIN_ROOT" "$RESOLVED"

echo "[deploy-dev ④] 单版本源门…"
# 时序：pinned 重建之后——部署前 pin 落后于 HEAD 是正常态（上次部署后 main 前进），
# 单源门的 pin==HEAD 断言只有重建后才可能绿；三指针同源/段序哨兵/锚点新鲜不受时序影响。
bash "$SCRIPT_DIR/check-kernel-single-source.sh" "$ENV_FILE"

echo "[deploy-dev ④b] 主检出同步对账…"
LIVE_HEAD=$(git -C "$KERNEL_REPO" rev-parse HEAD)
if [[ "$LIVE_HEAD" != "$RESOLVED" ]]; then
  die "主检出 HEAD(${LIVE_HEAD:0:12}) ≠ 部署目标(${RESOLVED:0:12})——运行时内核=主检出（pinned 只是技能面投影），不同步即部署面劈叉;改法: 主检出 git pull --ff-only 到目标 commit 后重跑本入口"
fi

echo "[deploy-dev ⑤] 实例重启（dev 净室重放）…"
# 活键显式指认（owner 1115 裁定纪律：重启一律显式带 ATF_INSTANCE_KEY_ENV）——
# 缺省取 dev.env 声明的活键路径，调用方 env 显式值优先。
KEY_ENV_DECLARED=$(env_val ATF_INSTANCE_KEY_ENV)
ATF_INSTANCE_KEY_ENV="${ATF_INSTANCE_KEY_ENV:-$KEY_ENV_DECLARED}" \
  ATF_DEPLOY_EVIDENCE="$EVIDENCE" \
  bash "$HARNESS_ROOT/deploy/instances/instance-restart.sh" dev

echo "[deploy-dev ⑥] 健康门…"
ACTUAL_PIN=$(cat "$PIN_ROOT/.atf-pin-commit" 2>/dev/null || echo "")
[[ "$ACTUAL_PIN" == "$RESOLVED" ]] || die "pin 指纹 $ACTUAL_PIN != 部署目标 $RESOLVED——pinned 重建与部署目标失配"
CODE="000"
for _ in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${DEV_PORT}/" 2>/dev/null || true)
  [[ "$CODE" == "401" || "$CODE" == "200" ]] && break
  sleep 2
done
[[ "$CODE" == "401" || "$CODE" == "200" ]] || die "WebUI 未就绪（最后 HTTP ${CODE}）——查 boot 日志 $DEV_LOG"
tail -c 200000 "$DEV_LOG" 2>/dev/null | grep -q "L2 fatal 0 项" || die "boot 日志无「L2 fatal 0 项」——查 $DEV_LOG"
tail -c 200000 "$DEV_LOG" 2>/dev/null | grep -q "桥对端: real" || die "boot 日志桥对端非 real——查 $DEV_LOG"

echo "deploy-dev OK: $RESOLVED 已上线 DEV（证据 $EVIDENCE ｜ 预演 $REHEARSAL ｜ 健康 HTTP $CODE）"
