#!/usr/bin/env bash
# ============================================================================
# 部署证据门（GOVERNANCE-LEDGER B 类首闸·work/20261117-deploy-evidence-gate）
#
# 语义：「没有效测试就上线、用户真机首跑当测试员」的机器化终结——新代码上线动作
# 必须持有效证据清单（verdict PASS＋变更面→已跑测试形态映射＋证据锚＋新鲜度），
# 缺任一即拒绝部署并指明缺哪个证据、去哪个入口补跑（报错即修复指令）。
#
# 用法: check-deploy-evidence.sh <evidence.json> <repo根> [期望commit]
#   期望commit：显式 commit 发版场景（uat-deploy.sh）——清单 head_commit 必须与之一致。
#
# 证据清单形态（DeployEvidence/v1，缺省落 <ATF_KERNEL_SOURCE>/.zcode/deploy-evidence/）：
#   {
#     "schema_version": "DeployEvidence/v1",
#     "batch_slug": "<批次标识>",
#     "base_commit": "<本批次前置 HEAD>",          ← 交互面触达检测区间起点
#     "head_commit": "<本批次 HEAD commit>",
#     "verdict": {"path": "<verdict 文件路径>", "overall": "PASS"},
#     "mappings": [
#       {"face": "内核段|装配传导|交互链路|装接|非用户可见",
#        "test_form": "<语料回放 run 目录|真 spawn 回读断言输出|自动驱动器闭环 run 记录|工具闭集断言|...>",
#        "evidence_anchor": "<在盘产物路径（绝对或 repo 相对）>"}
#     ],
#     "no_new_code": {"declared": true, "reason": "<免证理由>"}   ← 与 verdict/mappings 二选一
#   }
#
# 判据:
#   ① 清单在场、可解析、schema_version=DeployEvidence/v1
#   ② no_new_code 声明（含理由）　或　verdict PASS＋mappings 非空逐条合法＋证据锚在盘
#   ③ 批次触达交互面载体（Face 面/SKILL/段脚本）而清单无「交互链路」映射 → 拦
#   ④ 新鲜度: 清单 mtime > head_commit 提交时间（旧证据不覆盖新改动）
#
# 退出: 0=通过　2=拦截（证据问题）　3=用法错误
# ============================================================================
set -euo pipefail

EVIDENCE="${1:-}"
REPO="${2:-}"
EXPECT="${3:-}"

block() { echo "DEPLOY-EVIDENCE-GATE 拦截: $1" >&2; exit 2; }
[[ -n "$EVIDENCE" && -n "$REPO" ]] || { echo "用法: check-deploy-evidence.sh <evidence.json> <repo根> [期望commit]" >&2; exit 3; }
[[ -f "$EVIDENCE" ]] || block "证据清单缺席: $EVIDENCE
  改法一: 收口时按 DeployEvidence/v1 写清单（verdict PASS＋变更面→测试形态映射＋证据锚）后重跑本入口;
  改法二: 纯非用户可见改动（测试/文档/内部重构）→ 清单内声明 no_new_code+理由。"

python3 - "$EVIDENCE" "$REPO" "$EXPECT" <<'PYEOF'
import json
import os
import subprocess
import sys

evidence_path, repo, expect = sys.argv[1], sys.argv[2], (sys.argv[3] or "")


def block(msg: str) -> None:
    print("DEPLOY-EVIDENCE-GATE 拦截: " + msg, file=sys.stderr)
    sys.exit(2)


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)


try:
    with open(evidence_path, encoding="utf-8") as fh:
        doc = json.load(fh)
except Exception as err:  # noqa: BLE001——任何解析失败都归证据不合格
    block(f"证据清单不可解析: {evidence_path}（{err}）——改法: 按 DeployEvidence/v1 修正 JSON 后重跑")

if doc.get("schema_version") != "DeployEvidence/v1":
    block(f"schema_version 必须为 DeployEvidence/v1（当前 {doc.get('schema_version')!r}）——改法: 修正后重跑")

head = doc.get("head_commit") or ""
if not head:
    block("缺 head_commit（本批次 HEAD commit）——改法: 收口回填真实 commit 后重跑")
probe = git("rev-parse", "--verify", f"{head}^{{commit}}")
if probe.returncode != 0:
    block(f"head_commit 不可达: {head}（仓 {repo}）——改法: 回填真实 commit 后重跑")
if expect and head != expect:
    block(f"head_commit({head[:12]}) 与部署目标 commit({expect[:12]}) 不一致——证据必须对准本次上线 commit")

mtime = os.path.getmtime(evidence_path)
ct_raw = git("log", "-1", "--format=%ct", head).stdout.strip()
ct = int(ct_raw) if ct_raw.isdigit() else 0
if mtime <= ct:
    block("证据清单 mtime 不晚于 head_commit 提交时间——旧证据不覆盖新改动;"
          "改法: 按本轮触达面重新取证并更新清单后重跑")

nnc = doc.get("no_new_code") or {}
declared = nnc.get("declared") is True
reason = (nnc.get("reason") or "").strip()
if declared and not reason:
    block("no_new_code.declared=true 但缺 reason——改法: 写明免证理由（如重部署既有 main/文档批次）后重跑")

mappings = doc.get("mappings") or []
if not declared:
    verdict = doc.get("verdict") or {}
    if verdict.get("overall") != "PASS":
        block(f"verdict.overall 必须 PASS（当前 {verdict.get('overall')!r}）——改法: 先收口 contract-verdict，PASS 后更新清单")
    vp = (verdict.get("path") or "").strip()
    vp_full = vp if os.path.isabs(vp) else os.path.join(repo, vp)
    if not vp or not os.path.exists(vp_full):
        block(f"verdict 文件缺席: {vp_full}——改法: verdict 落盘后在清单回填路径")
    if not mappings:
        block("mappings 空——变更面→已跑测试形态映射必须逐条落盘（face/test_form/evidence_anchor）")

faces = ("内核段", "装配传导", "交互链路", "装接", "非用户可见")
have_interaction = False
for idx, item in enumerate(mappings, 1):
    face = item.get("face")
    test_form = (item.get("test_form") or "").strip()
    anchor = (item.get("evidence_anchor") or "").strip()
    if face not in faces:
        block(f"mappings[{idx}].face 非法: {face!r}（合法闭集: {'|'.join(faces)}）")
    if not test_form:
        block(f"mappings[{idx}].test_form 空——写明已跑测试形态"
              "（语料回放 run 目录/真 spawn 回读断言输出/自动驱动器闭环 run 记录/工具闭集断言）")
    if not anchor:
        block(f"mappings[{idx}].evidence_anchor 空——写明证据锚路径（run 目录/断言输出/驱动器 run 记录/测试文件）")
    anchor_full = anchor if os.path.isabs(anchor) else os.path.join(repo, anchor)
    if not os.path.exists(anchor_full):
        block(f"mappings[{idx}].evidence_anchor 不在场: {anchor_full}——证据锚必须是真实在盘产物")
    if face == "交互链路":
        have_interaction = True

base = doc.get("base_commit") or ""
if base and not declared:
    diff = git("diff", "--name-only", f"{base}..{head}")
    if diff.returncode == 0:
        carriers = (
            "pipelineFace", "confirmFace", "trainingFace", "gpuQueueFace", "bridgeFace",
            "preflightFace", "fileGuardFace", "recordsFace", "jointTrainFace",
            "attachmentsFace", "constructionGate", "SKILL.md", "walkthrough_pipeline",
        )
        touched = [line for line in diff.stdout.splitlines() if any(c in line for c in carriers)]
        if touched and not have_interaction:
            sample = ", ".join(touched[:5]) + ("…" if len(touched) > 5 else "")
            block("批次触达交互面载体但清单无「交互链路」映射: " + sample +
                  "——改法: 补 face=交互链路 映射（证据锚=自动驱动器闭环 run 记录/预演 run 目录）后重跑")

face_counts = {}
for item in mappings:
    face_counts[item.get("face")] = face_counts.get(item.get("face"), 0) + 1
summary = "（无新代码声明）" if declared else f"（verdict PASS，映射 {len(mappings)} 条 {face_counts}，head={head[:12]}）"
print(f"DEPLOY-EVIDENCE-GATE 通过: {evidence_path}{summary}")
PYEOF
