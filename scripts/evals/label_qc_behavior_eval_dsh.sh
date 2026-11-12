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

# pinned 自对齐（D284 载体自愈）:内核 main 每次前进都会让 pinned 指纹旁路失配
# （atf-tools 预检 L2 fatal→扩展不激活→工具面全缺——1112 实锚），eval 驱动前先对齐。
git -C /data/sam/AgenticTrainingFlow fetch origin main >/dev/null 2>&1
PIN_HEAD=$(git -C /data/sam/AgenticTrainingFlow rev-parse origin/main)
git -C /data/atf/dev/pinned fetch origin main >/dev/null 2>&1
git -C /data/atf/dev/pinned checkout "$PIN_HEAD" >/dev/null 2>&1
echo "$PIN_HEAD" > /data/atf/dev/pinned/.atf-pin-commit
echo "[driver] pinned 已对齐内核 origin/main: $PIN_HEAD"
export ATF_V1_REAL_LLM_AUTHORIZED=1
# D284 形态①开关:headless 无人值守——扩展免审判定的 env basis
# （env 声明+config chainTools 双确认→链上工具放行留账；清单外 fail-closed）。
export ATF_HEADLESS_PRESET=atf-unattended
# D284:headless 无审批面板——base bundle 的 approval service 按 DSH_PERMISSION_MODE
# 定 policy（danger-full-access→never=自动放行；缺省 ask 在 headless 即 unavailable）。
export DSH_PERMISSION_MODE=danger-full-access

INSTRUCTION=$(cat <<'EOF'
对本工作区做段级登记与标签质检（两段都用 atf_pipeline_stage 段级入口）：① register 段：--stage register --source-root /data/atf/dev/eval-ws/label-qc-eval2-ws/batch --doc-type bl --run-id eval-l2-dsh-01 --experiment bl-qc-eval2（workspace_path=/data/atf/dev/eval-ws/label-qc-eval2-ws）；② label_qc 段：--stage label_qc 同参重跑。批内 3 页航空提单标注（图片与 json 成对）。label_qc 双通道走完（机械检测+看图核查）：逐页看图核对框位/值/归属，写 LabelQcVisualCheck/v1 核查件后带 --visual-check 重跑；核查发现的标注抄录误差类 issue 在核查件条目带 resolution（action=set_value+field/page/old_value/new_value/basis 看图依据）交内核自动修正；机械冲突裁决项在全部检查完成后汇总为一次 atf_label_qc_resolve 提交。段 ok 后输出结论：每页发现什么问题、怎么处置的。
EOF
)

cd "$VENDOR"
node --import tsx/esm apps/cli/src/bin.ts headless "$INSTRUCTION" 2>&1 | tee /tmp/l2-eval-dsh.log
