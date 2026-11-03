#!/usr/bin/env bash
# 单版本源自检（批4 部署收敛 #22——r2 教训：pipeline/bridge/scratch 三指针三版本，
# 删参与行为漂移的温床 #8m/#21）。部署序列一步：实例重启前跑，三指针不同源即非零退出。
#
# 用法: bash deploy/verify/check-kernel-single-source.sh <instance.env>
#   例: bash deploy/verify/check-kernel-single-source.sh deploy/instances/dev.env
# 判据:
#   ① ATF_KERNEL_SOURCE 在场（单源声明——三指针的派生根）;
#   ② kernelDir / 段 CLI / bridge 三指针解析出的内核根全部同源（含 $ATF_KERNEL_SOURCE）;
#   ③ kernelDir 实跑 import agentic_training_flow 探版本成功（部署日志对账面）。
set -euo pipefail

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "用法: $0 <instance.env>（例 deploy/instances/dev.env）" >&2
  exit 3
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

fail=0
if [[ -z "${ATF_KERNEL_SOURCE:-}" ]]; then
  echo "[红] ATF_KERNEL_SOURCE 缺席——实例 env 未做 #22 单源化（三指针独立声明=漂移温床）" >&2
  exit 2
fi
echo "[绿] 单源根: ATF_KERNEL_SOURCE=$ATF_KERNEL_SOURCE"

# 三指针同源判定：每个指针值必须包含单源根。
check_contains() {
  local label="$1" value="$2"
  if [[ "$value" == *"$ATF_KERNEL_SOURCE"* ]]; then
    echo "[绿] $label 同源: $value"
  else
    echo "[红] $label 不同源: $value（不含 $ATF_KERNEL_SOURCE——改用单源派生）" >&2
    fail=1
  fi
}

check_contains "kernelDir(scratch PYTHONPATH/preflight/attachments)" "${ATF_DSH_KERNEL_DIR:-}"
check_contains "段 CLI" "${ATF_DSH_PIPELINE_COMMAND:-}"
check_contains "bridge" "${ATF_DSH_BRIDGE_COMMAND:-}"

# kernelDir 实跑版本探测（部署日志对账：三面 import 的是同一份 agentic_training_flow）。
KERNEL_VERSION="$(PYTHONPATH="${ATF_DSH_KERNEL_DIR:-$ATF_KERNEL_SOURCE}/src" python3 -c 'import agentic_training_flow; print(agentic_training_flow.__version__)' 2>/dev/null || true)"
if [[ -n "$KERNEL_VERSION" ]]; then
  echo "[绿] 内核版本(实跑 import): $KERNEL_VERSION"
else
  echo "[红] kernelDir 实跑 import agentic_training_flow 失败（PYTHONPATH=$ATF_DSH_KERNEL_DIR/src）" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "单版本源自检失败——先修指针再重启（一次切换只改 ATF_KERNEL_SOURCE）" >&2
  exit 2
fi
echo "单版本源自检通过：三指针同源 $ATF_KERNEL_SOURCE（版本 $KERNEL_VERSION）"
