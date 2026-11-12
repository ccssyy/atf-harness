#!/usr/bin/env bash
# ============================================================================
# D284 层②载体：L2 行为 eval 驱动（dsh headless 一次性宿主——§4.5 正规载体）。
#
# 用法（A800）：
#   bash scripts/evals/label_qc_behavior_eval_dsh.sh
# 前置：atf-headless 载体（实例 home profiles/headless/，见任务书
#   20261112-atf-headless-profile.md）；pinned 指纹对齐内核 HEAD。
# 判据：docs/testing/eval-l2-adjudication-behavior-20261111.md（J1/J2/J3）。
# 输出：轨迹与结论 tee 到 /tmp/l2-eval-dsh.log；断言在盘面（判据文件回填）。
# ============================================================================
set -euo pipefail

REPO="/data/sam/ATF-Harness"
VENDOR="$REPO/vendor/dsh/deepseek-harness"

set -a
source /root/.atf-harness/.env
source "$REPO/deploy/instances/dev.env"
set +a
export ATF_V1_REAL_LLM_AUTHORIZED=1
# D284:headless 无审批面板——base bundle 的 approval service 按 DSH_PERMISSION_MODE
# 定 policy（danger-full-access→never=自动放行；缺省 ask 在 headless 即 unavailable）。
export DSH_PERMISSION_MODE=danger-full-access

INSTRUCTION=$(cat <<'EOF'
对本工作区做段级登记与标签质检（两段都用 atf_pipeline_stage 段级入口）：① register 段：--stage register --source-root /data/atf/dev/eval-ws/label-qc-eval2-ws/batch --doc-type bl --run-id eval-l2-dsh-01 --experiment bl-qc-eval2（workspace_path=/data/atf/dev/eval-ws/label-qc-eval2-ws）；② label_qc 段：--stage label_qc 同参重跑。批内 3 页航空提单标注（图片与 json 成对）。label_qc 双通道走完（机械检测+看图核查）：逐页看图核对框位/值/归属，写 LabelQcVisualCheck/v1 核查件后带 --visual-check 重跑；核查发现的标注抄录误差类 issue 在核查件条目带 resolution（action=set_value+field/page/old_value/new_value/basis 看图依据）交内核自动修正；机械冲突裁决项在全部检查完成后汇总为一次 atf_label_qc_resolve 提交。段 ok 后输出结论：每页发现什么问题、怎么处置的。
EOF
)

cd "$VENDOR"
node --import tsx/esm apps/cli/src/bin.ts headless "$INSTRUCTION" 2>&1 | tee /tmp/l2-eval-dsh.log
