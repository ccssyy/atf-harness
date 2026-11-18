#!/usr/bin/env bash
# 部署预演门禁（1117 owner 裁：「部署即首演」模式终止——真机形态预演是 2 个月来反复
# 强调的验收口径，此前无拦截点=执行侧裸奔。本闸装在部署动作的生产端：无预演证据，
# 部署被拦。教训机制化纪律形态=拦截点，非文档记录。）
#
# 用法: deploy-rehearsal-gate.sh <evidence文件> <基准commit>
#   evidence=本轮部署触达的用户可见行为清单+逐项预演结果（真机形态预演/fixture 端到端
#   轨迹留证，含 PASS 标记；纯非用户可见改动[测试/文档]可显式声明免演范围与理由）。
# 判据:
#   ① evidence 在场；② mtime 晚于基准 commit（旧证据不覆盖新改动）；
#   ③ 含 PASS 逐项记录且无 FAIL。
set -euo pipefail
EVIDENCE="${1:?用法: deploy-rehearsal-gate.sh <evidence文件> <基准commit>}"
SINCE="${2:?缺少基准 commit（本轮部署触达改动的前置 HEAD）}"
if [[ ! -f "$EVIDENCE" ]]; then
  echo "REHEARSAL-GATE 拦截:预演证据文件缺席:$EVIDENCE" >&2
  echo "  改动触达的用户可见行为必须先在预演环境真实执行留证再部署。两条改法:" >&2
  echo "  ①按预演清单执行全链留证（用户可见形态逐项:卡面/回执/落账/产物）后重跑本闸;" >&2
  echo "  ②纯非用户可见改动（测试/文档/内部重构）:在 evidence 中显式声明免演范围与理由。" >&2
  exit 2
fi
EVIDENCE_MTIME=$(stat -c %Y "$EVIDENCE")
COMMIT_TIME=$(git log -1 --format=%ct "$SINCE" 2>/dev/null || echo 0)
if (( EVIDENCE_MTIME <= COMMIT_TIME )); then
  echo "REHEARSAL-GATE 拦截:预演证据($EVIDENCE)不晚于本轮改动($SINCE)——旧证据不覆盖新改动" >&2
  echo "  改法:按本轮触达面重新预演并更新 evidence 后重跑本闸。" >&2
  exit 2
fi
if grep -q 'FAIL' "$EVIDENCE"; then
  echo "REHEARSAL-GATE 拦截:预演含 FAIL 项——先修复或显式豁免(附理由)再部署" >&2
  exit 2
fi
grep -q 'PASS' "$EVIDENCE" || { echo "REHEARSAL-GATE 拦截:预演证据无 PASS 记录(逐项预演结果必须落盘)" >&2; exit 2; }
echo "REHEARSAL-GATE 通过:预演证据 $EVIDENCE 覆盖本轮改动($(grep -c 'PASS' "$EVIDENCE") 项 PASS)"
