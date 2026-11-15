#!/usr/bin/env bash
# ============================================================================
# vendor/dsh 契约冒烟放行门（批 4 C3/C4；UTF-8）。
#
# 用途：patch 变更／升级重放后的放行判据入口（LOCK.md「bump 重同步」四步 SOP ③的
#       正式化单入口）——「解禁」=通道正式化：改 vendor 只走 patch 通道，patch 全集
#       应用后的放行=本门全绿（三期方案 §3.2 批 4）。
# 四段（前三段任一红即整体红）：
#   ① vendor 守护七用例（应用态/登记对账/明细对账/演练逐字节等价）
#   ② server 起＋atf 工具面在场探针（临时端口起 dsh web→HTTP 探活→启动日志
#      marker 断言→杀进程；不调 LLM）
#   ③ 管线回放·三层四 case（内核仓 scripts/evals/replay_corpus_1113.py；exit 0=绿）
#   ④ 重评触发器三信号现状（C4：报告段，超限提示启动独立评估批，不拦截）
# 用法：bash scripts/vendor-smoke-gate.sh [--skip-replay]
#       --skip-replay 跳段③（回放资产不在场时）；段①②④仍全跑。
# 退出码：0=全绿放行；1=段①②③有红。触发器超限不改变退出码（重评是决策不是错误）。
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/dsh/deepseek-harness"
PATCH_DIR="$REPO_ROOT/vendor/dsh/patches"
ENV_FILE="${ATF_SMOKE_ENV:-$REPO_ROOT/deploy/instances/dev.env}"
SMOKE_PORT="${SMOKE_PORT:-39877}"

SKIP_REPLAY=0
[[ "${1:-}" == "--skip-replay" ]] && SKIP_REPLAY=1

fail() { echo "[vendor-smoke-gate] FAIL: $1" >&2; exit 1; }

# —— 段①：vendor 守护七用例 ——
echo "=== 段① vendor 守护（tests/tools/testVendorPatchConsolidation.test.ts）==="
( cd "$REPO_ROOT" && npx vitest run tests/tools/testVendorPatchConsolidation.test.ts ) \
  || fail "守护测试红——按用例报错内的修复指令处理（应用态被改=重放 patch；对账红=补 LOCK 登记或同步闭集快照）"

# —— 段②：server 起＋atf 工具面在场探针 ——
echo "=== 段② server 起＋atf 工具面在场探针（端口 $SMOKE_PORT，不调 LLM）==="
# 旧探针残留清理（幂等）
pkill -TERM -f "dsh web --no-open --port $SMOKE_PORT" 2>/dev/null || true
SMOKE_LOG="$(mktemp /tmp/vendor-smoke-gate.XXXXXX.log)"
cleanup() {
  pkill -TERM -f "dsh web --no-open --port $SMOKE_PORT" 2>/dev/null || true
}
trap cleanup EXIT

# server 面 env（launch token/passthrough 等 patch env 面）来自实例 env；扩展装配
# 依赖 pinned/单版本源 env——探活与 marker 断言用与 dev 实例同源的 env 面。
set -a; source "$ENV_FILE" >/dev/null 2>&1 || true; set +a
( cd "$VENDOR_DIR" && setsid nohup corepack pnpm dsh web --no-open --port "$SMOKE_PORT" \
    > "$SMOKE_LOG" 2>&1 < /dev/null & )
# 探活两步：retry 阶段只看连通（-w 在多次尝试下会拼接输出，不可作单值判据），连上后单次取码
if curl -s -o /dev/null --retry 10 --retry-delay 1 --retry-connrefused --max-time 90 \
     "http://127.0.0.1:$SMOKE_PORT/" 2>/dev/null; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$SMOKE_PORT/" || echo 000)"
else
  CODE="000"
fi
[[ "$CODE" != "000" ]] \
  || fail "server 探活失败（90s 内无 HTTP 应答）——查 $SMOKE_LOG；若为 patch/升级后首次：确认 apply-patches.sh 已重放＋构建产物已重建（LOCK.md bump SOP 步骤②）"
echo "[vendor-smoke-gate] server 探活：http_code=$CODE（任意应答=进程活）"
grep -F '[atf-tools] apply()' "$SMOKE_LOG" >/dev/null \
  || fail "atf 工具面不在场（启动日志无「[atf-tools] apply()」marker）——扩展 fail-closed 未激活：查 $SMOKE_LOG 的 [atf-preflight] 段（pinned 指纹失配=对齐内核 main；env 缺失=查 $ENV_FILE）"
echo "[vendor-smoke-gate] atf 工具面在场：[atf-tools] apply() marker 命中"
grep -F '[atf-ui] 桥类型: real' "$SMOKE_LOG" | head -1 || true

# —— 段③：管线回放·三层四 case ——
if [[ "$SKIP_REPLAY" == "1" ]]; then
  echo "=== 段③ 管线回放：--skip-replay 跳过（本门未全跑，放行判据不成立）==="
else
  KERNEL_ROOT="${ATF_KERNEL_SOURCE:-/data/sam/AgenticTrainingFlow}"
  echo "=== 段③ 管线回放·三层四 case（$KERNEL_ROOT/scripts/evals/replay_corpus_1113.py）==="
  ( cd "$KERNEL_ROOT" && PYTHONPATH=src python3 scripts/evals/replay_corpus_1113.py ) \
    || fail "回放红（exit=$?）——内核段行为回归；判据面见回放清单，与 vendor 面相关时按 LOCK.md SOP 步骤④走真机回归"
fi

# —— 段④：重评触发器三信号现状（C4；报告段不拦截） ——
echo "=== 段④ 重评触发器三信号（超限→启动独立评估批评 fork 替换，不在业务批夹带）==="
python3 - "$PATCH_DIR" "$REPO_ROOT" <<'PYEOF'
import re, subprocess, sys, time
from pathlib import Path

patch_dir, repo_root = Path(sys.argv[1]), Path(sys.argv[2])
lock = (patch_dir.parent / "LOCK.md").read_text(encoding="utf-8")
patches = sorted(p.name for p in patch_dir.glob("0*.patch"))

# 信号 1：近 30 天新增 patch 落盘数（阈值：月均 ≥2 个非缺陷修复类新 patch——分类需人工判读，此处报总数）
since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 30 * 86400))
log = subprocess.run(["git", "-C", str(repo_root), "log", f"--since={since}", "--name-only",
                      "--format=", "--", str(patch_dir.relative_to(repo_root))],
                     capture_output=True, text=True).stdout
recent = sorted({l.strip().rsplit("/", 1)[-1] for l in log.splitlines()
                 if re.search(r"0\d{3}-[^/]+\.patch$", l.strip())})
print(f"  信号1 近30天新增 patch：{len(recent)} 件 {recent}（阈值=月均≥2 件非缺陷修复类；口径=git 首次入库时间——存量收编入库非新增，人工判读时排除，2026-11-15 收编批入库 8 件属此类）")

# 信号 2：触达文件/包数 vs 闭集基线（基线 18 文件/10 包——批 4 机检实锚更正 LOCK 旧记「8 包」；阈值为基线 1.5 倍=27 文件/15 包）
touched, pkgs = set(), set()
for name in patches:
    out = subprocess.run(["git", "apply", "--numstat", str(patch_dir / name)], cwd=repo_root,
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        f = line.split("\t")[2] if "\t" in line else ""
        if f:
            touched.add(f)
            m = re.match(r"packages/([^/]+(?:/[^/]+)?)/", f)
            if m: pkgs.add(m.group(1))
print(f"  信号2 触达面：{len(touched)} 文件/{len(pkgs)} 包（基线=18 文件/10 包；阈值=1.5 倍即 27 文件/15 包）")

# 信号 3：同文件被 ≥3 个 patch 叠加（重放链脆弱信号）
per_file = {}
for name in patches:
    out = subprocess.run(["git", "apply", "--numstat", str(patch_dir / name)], cwd=repo_root,
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        f = line.split("\t")[2] if "\t" in line else ""
        if f: per_file.setdefault(f, []).append(name[:4])
stacked = {f: n for f, n in per_file.items() if len(n) >= 3}
print(f"  信号3 同文件 ≥3 patch 叠加：{stacked or '无'}（阈值=任一文件命中）")
hits = []
if len(recent) >= 2: hits.append("信号1")
if len(touched) > 27 or len(pkgs) > 15: hits.append("信号2")
if stacked: hits.append("信号3")
print(f"  触发器判定：{'⚠ ' + '、'.join(hits) + ' 命中——启动独立评估批（评估建镜像仓转 fork 模式），不在业务批夹带' if hits else '三信号均未命中'}")
PYEOF

if [[ "$SKIP_REPLAY" == "1" ]]; then
  echo "[vendor-smoke-gate] 段①②绿；段③回放被跳过——放行判据不成立，patch 变更放行前须完整跑本门"
else
  echo "[vendor-smoke-gate] 全绿：patch 应用态合法（段①守护＋段②工具面在场＋段③管线回放），放行"
fi
