#!/usr/bin/env bash
# G6 预合入门禁（纯代码批可跑；rehearsal 为可选步骤）
#
# 形态：单入口脚本，逐项 PASS/FAIL，任一 FAIL 退出码 1。
# 为什么不是「把 npm run rehearsal 直接塞进 CI」：
#   真机预演需要 (a) 已 re-pin 的 dev 实例环境（ATF_DSH_* 一套 env + pin 版本串一致）、
#   (b) GPU 段、 (c) 真内核仓 checkout。这些在纯代码批的合入路径上不成立——
#   实测在未 re-pin 的窗口里 `npm run rehearsal` 直接 fail-fast 于
#   `pin_version_consistency`（pin 树 describe=v0.7.27b47-9-g85e2c827 与
#   __version__=0.7.27b47 不一致），与本次改动无关。
#   故本脚本把 rehearsal 做成**可选步骤**（默认跑，缺前提时如实 SKIP 而非假绿，
#   --require-rehearsal 可把 SKIP 升级成 FAIL——发版批用这个档）。
#
# 用法:
#   deploy/verify/pregate.sh                 # 预合入档：L0/L1 必跑，rehearsal 前提缺则 SKIP
#   deploy/verify/pregate.sh --require-rehearsal  # 发版档：rehearsal SKIP 也算 FAIL
#   deploy/verify/pregate.sh --fast          # 只跑 tsc + evals（秒级，本地循环用）
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

REQUIRE_REHEARSAL=0
FAST=0
for arg in "$@"; do
  case "$arg" in
    --require-rehearsal) REQUIRE_REHEARSAL=1 ;;
    --fast) FAST=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

FAILED=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
skip() { printf 'SKIP  %s\n' "$1"; }

echo "=== G6 预合入门禁 ==="

# ── 1 类型面（全仓）────────────────────────────────────────────────────────
if npx tsc --noEmit >/tmp/pregate-tsc.log 2>&1; then
  pass "tsc --noEmit（0 错）"
else
  fail "tsc --noEmit（见 /tmp/pregate-tsc.log）"
  tail -20 /tmp/pregate-tsc.log
fi

# ── 2 分层 evals（L0 结构 / L1 轨迹 / L2 语料 / L3 事故）────────────────────
if npx vitest run tests/evals >/tmp/pregate-evals.log 2>&1; then
  # vitest 输出带 ANSI 色彩码——剥掉再取计数
  eval_count=$(sed -E 's/\x1b\[[0-9;]*m//g' /tmp/pregate-evals.log | sed -n 's/.*Tests *\([0-9][0-9]*\) passed.*/\1/p' | tail -1)
  pass "tests/evals（${eval_count:-?} 项通过）"
else
  fail "tests/evals（见 /tmp/pregate-evals.log）"
  grep -E '×|AssertionError' /tmp/pregate-evals.log | head -20
fi

if [[ "$FAST" -eq 1 ]]; then
  echo "=== --fast 结束：FAILED=$FAILED ==="
  exit "$FAILED"
fi

# ── 3 结构审计（机制重复三层）──────────────────────────────────────────────
if npm run audit:all >/tmp/pregate-audit.log 2>&1; then
  pass "npm run audit:all（退出码 0）"
else
  fail "npm run audit:all（见 /tmp/pregate-audit.log）"
  tail -20 /tmp/pregate-audit.log
fi

# ── 4 A5 生成物确定性（连两次生成 diff 干净）────────────────────────────────
if [[ -n "${ATF_KERNEL_SOURCE:-}" ]]; then
  node tools/codegen-reason-categories.mjs >/dev/null 2>&1
  if git diff --exit-code -- src/core/generated >/dev/null 2>&1; then
    pass "A5 codegen 第 1 次生成 diff 干净"
  else
    fail "A5 codegen 第 1 次生成有漂移（生成物未随源更新？）"
  fi
  node tools/codegen-reason-categories.mjs >/dev/null 2>&1
  if git diff --exit-code -- src/core/generated >/dev/null 2>&1; then
    pass "A5 codegen 第 2 次生成 diff 干净（确定性）"
  else
    fail "A5 codegen 第 2 次生成有漂移（不确定性回归）"
  fi
else
  skip "A5 codegen（ATF_KERNEL_SOURCE 未设置——内核源不在场）"
fi

# ── 5 真机预演（可选档：前提缺则 SKIP，--require-rehearsal 升为 FAIL）──────
# pin 树退役后（D9，2026-11-22）前提探测改判「内核目录在场」——
# 原 pin 版本一致性门（describe tag ↔ __version__）已随 bootPreflight 删除，
# 保留对账只会拿一个不再是加载源的目录做 veto（A9 断引用）。
kernel_ready() {
  local kernel="${ATF_DSH_KERNEL_DIR:-${ATF_KERNEL_SOURCE:-}}"
  [[ -n "$kernel" && -d "$kernel" ]] || return 1
  # 内核入口在场才算就绪（不猜路径；解析失败即 SKIP/FAIL，不静默降级）
  [[ -d "$kernel/src/agentic_training_flow" || -d "$kernel/agentic_training_flow" ]]
}

if [[ -n "${ATF_DSH_PIPELINE_COMMAND:-}" ]] && kernel_ready; then
  if npm run rehearsal >/tmp/pregate-rehearsal.log 2>&1; then
    pass "npm run rehearsal（JOURNEY GREEN）"
  else
    fail "npm run rehearsal（JOURNEY RED，见 /tmp/pregate-rehearsal.log）"
    grep -E 'JOURNEY RED|FAIL' /tmp/pregate-rehearsal.log | head -10
  fi
else
  if [[ "$REQUIRE_REHEARSAL" -eq 1 ]]; then
    fail "npm run rehearsal（前提不在场：需 ATF_DSH_PIPELINE_COMMAND + pin 树版本串一致；本档要求必须跑）"
  else
    skip "npm run rehearsal（前提不在场：需 dev 实例 env 与 pin 版本串一致；发版批请加 --require-rehearsal）"
  fi
fi

echo "=== 门禁结束：FAILED=$FAILED ==="
exit "$FAILED"
