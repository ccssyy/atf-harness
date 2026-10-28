#!/usr/bin/env bash
# ============================================================================
# 批㊶-OPSREPO——UAT 独立发版脚本（atf-uat 容器形态·运维资产入仓转正）
#
# 资产属性：实例层运维脚本（owner 授权微批才可变更——禁 free-run 修改）。
# 归属/调用方：owner 或 zcode 会话按微批指令执行；发版唯一触发＝owner 书面指定 commit/tag。
# 变更纪律：本脚本变更须走微批（历史：批㊶-REL1→UATD→UATD-b→OBS1→OPSREPO）。
#
# 用法：uat-deploy.sh <commit-or-tag>        （发版）
#       uat-deploy.sh --status               （查看 atf-uat 现态，不发版）
#
# 目标拓扑（批㊶-OPSREPO v2 定案）：UAT 本体＝宿主 124.220.53.207 上 atf-uat 独立容器——
#   dsh 3081（容器内 127.0.0.1）→容器内转发器 13081→宿主 docker-proxy→公网
#   http://124.220.53.207:13081；SSH 通道＝dev 容器 root@172.18.0.20:22（专用 key）。
#   冻结 checkout /data/sam/ATF-Harness-uat 与 dev 容器共享 /data（双侧同路径）。
#   dev 容器 3081＝容器化前旧 UAT，已弃用（10-16 误拉起已清）——本脚本零触碰 dev 容器
#   3080/3081（红线：dev 实例行为零变更）。
#
# 执行位置：全部发版动作经 SSH 在 atf-uat 容器内执行（checkout/引导/boot/验证）。
# boot 形态：atf-uat 容器无 tmux——setsid＋nohup 后台＋pid 文件＋组杀停旧（取舍登记
#   2026-10-16：staged tmux 2.7 实测可运行但不取——装 tmux＝容器系统态变更，nohup 形态
#   零系统变更；pid 文件＋组杀承载旧 tmux 会话语义）。
#
# launch token 口径（10-28 实测更正，旧的「零消费」结论作废）：
#   `packages/client/connection/src/browser-auth.ts:55` 的 processLaunchToken 里
#   `const fromEnv = process.env.DSH_WEB_LAUNCH_TOKEN; const created = fromEnv ?? 随机`——
#   即**有**固定绑定点；运行期读的是 `lib/index.js:247`（package main = lib/index.js）。
#   实例 env 声明该键后 token 长期固定（32 字节 base64url 无 padding ＝ 43 字符），
#   未声明则退回每 boot 随机。本脚本 boot 完成仍从日志提取 token 并打印完整公网 URL；
#   已登录浏览器凭 DSH_HOME 内 30 天签名 cookie 跨重启存续，新 token 仅新浏览器需要。
#
# 流程：校验目标 → 容器内 uat checkout fetch+checkout（pin 子模块）→ CI 非交互
#       frozen-lockfile 引导＋bin/dist 校验 → 停旧（组杀＋端口释放等待）→ 整串 canonical
#       启动 → boot 四项验证（注册行/runsRoot/commit 行/真 token 探针 303）→ 失败自动回滚。
#
# 红线：uat checkout 只准 checkout/read（禁 commit/push/改代码）；演示/同事使用时段禁发版；
#       脚本不可用时先修脚本再发版（禁手敲命令）；token/密钥真值零入仓；发版仅限 owner
#       书面授权序列。
#
# 已知地雷（批㊶-UATD/UATD-b/OPSREPO 登记防后人踩）：
#   ① commit 跨依赖树跳变需 install+build（UATD 已修：步骤 1b 引导段，耗时不计入 60s 窗口）；
#   ② pnpm 运行前 deps 检查在交互环境会卡死 boot（"Proceed? (Y/n)"）、其自动重装在
#      uat submodule 结构下必败——根因留痕：独立 checkout 的 submodule core.worktree
#      与 extensions.worktreeConfig 冲突，lefthook postinstall（install-lefthook.mjs）
#      试图 `git config extensions.worktreeConfig true` 被 git 拒绝（UATD-b 以
#      CI=true npm_config_verify_deps_before_run=false env 规避·owner 侧实测 boot 成功）；
#   ③ 旧 tmux 会话形态已废（OPSREPO：目标容器无 tmux）——停旧走 pid 文件组杀＋cmdline
#      兜底＋端口释放等待，禁再往任何 tmux 会话 send-keys。
# ============================================================================
set -uo pipefail

MAIN_REPO="/data/sam/ATF-Harness"
UAT_REPO="/data/sam/ATF-Harness-uat"
UAT_VENDOR="${UAT_REPO}/vendor/dsh/deepseek-harness"
UAT_ENV="${MAIN_REPO}/deploy/instances/uat.env"
UAT_LOG="/tmp/dsh-web-tongshi.log"
UAT_PID="/tmp/dsh-web-tongshi.pid"
UAT_PORT=3081
UAT_PUBLIC_HOST="124.220.53.207"
UAT_PUBLIC_PORT=13081
UAT_REMOTE_KEY_ENV="/root/.atf-harness/.env"
SSH_KEY="/root/.ssh/id_ed25519_a800_uat"
SSH_TARGET="root@172.18.0.20"
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
DEPLOY_TIMEOUT_S=60

log() { echo "[uat-deploy] $*"; }
die() { echo "[uat-deploy] FAIL: $*" >&2; exit 1; }
remote() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

# ---------- 入参 ----------
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "用法：uat-deploy.sh <commit-or-tag>｜--status"
  die "无参调用（fail-closed——发版唯一触发＝owner 书面指定 commit/tag）"
fi
if [[ -f "$SSH_KEY" ]]; then :; else die "SSH 专用 key 不在位：${SSH_KEY}"; fi

# ---------- --status：远端现态（不发版） ----------
if [[ "$TARGET" == "--status" ]]; then
  echo "atf-uat checkout HEAD: $(remote "git -C ${UAT_REPO} rev-parse HEAD" 2>/dev/null || echo '（SSH/仓库未就绪）')"
  echo "uat describe:          $(remote "git -C ${UAT_REPO} describe --tags" 2>/dev/null || echo '—')"
  echo "主仓 HEAD:             $(git -C "$MAIN_REPO" rev-parse HEAD 2>/dev/null || echo '—')"
  echo "dsh 进程/pid 文件:     $(remote "if [ -f ${UAT_PID} ] && kill -0 \$(cat ${UAT_PID} 2>/dev/null) 2>/dev/null; then echo alive; else echo dead; fi" 2>/dev/null || echo '—')"
  echo "实例监听:              $(remote "ss -tln 2>/dev/null | grep -q ':${UAT_PORT} ' && echo '${UAT_PORT} 在' || echo '不在'" 2>/dev/null || echo '—')"
  echo "容器内转发器:          $(remote "ss -tln 2>/dev/null | grep -q ':${UAT_PUBLIC_PORT} ' && echo '${UAT_PUBLIC_PORT} 在' || echo '不在'" 2>/dev/null || echo '—')"
  exit 0
fi

# ---------- 校验目标存在（主仓为对象源） ----------
if ! git -C "$MAIN_REPO" cat-file -e "$TARGET^{commit}" 2>/dev/null; then
  die "目标 ${TARGET} 不存在（git cat-file 校验失败——fail-closed）"
fi
TARGET_SHA=$(git -C "$MAIN_REPO" rev-parse "$TARGET")
TARGET_SHORT=$(git -C "$MAIN_REPO" rev-parse --short "$TARGET")
log "发版目标：${TARGET} → ${TARGET_SHA}（atf-uat 容器 ${SSH_TARGET}）"

# ---------- 停旧：pid 文件组杀＋cmdline 兜底＋端口释放等待（容器内） ----------
remote_stop_dsh() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$UAT_PORT" "$UAT_PID" <<'STOP_EOF'
PORT="$1"; PIDFILE="$2"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')
    [ -n "$PGID" ] && kill -TERM -- -"$PGID" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi
# cmdline 兜底（旧形态进程无 pid 文件——Oct14 boot 先例；双 pattern 盖 corepack 包装层与 node 本体）
pkill -TERM -f "apps/cli/src/bin.ts web --no-open --port ${PORT}" 2>/dev/null
pkill -TERM -f "corepack pnpm dsh web --no-open --port ${PORT}" 2>/dev/null
for i in $(seq 1 20); do
  ss -tln 2>/dev/null | grep -q ":${PORT} " || exit 0
  sleep 1
done
pkill -KILL -f "apps/cli/src/bin.ts web --no-open --port ${PORT}" 2>/dev/null
pkill -KILL -f "corepack pnpm dsh web --no-open --port ${PORT}" 2>/dev/null
for i in $(seq 1 10); do
  ss -tln 2>/dev/null | grep -q ":${PORT} " || exit 0
  sleep 1
done
echo "port ${PORT} still held" >&2
exit 1
STOP_EOF
}

# ---------- 整串 canonical 启动（容器内 net-room：nohup 形态＋pid 文件） ----------
# 非交互 env（CI=true npm_config_verify_deps_before_run=false）防地雷②；net-room 前置
# source 两环（容器内密钥 env→实例 env）。setsid 使 boot 子树自成进程组——停旧组杀有锚。
remote_boot() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cd '${UAT_VENDOR}' && set -a && source ${UAT_REMOTE_KEY_ENV} && set +a && source '${UAT_ENV}' && set +a && { setsid nohup env CI=true npm_config_verify_deps_before_run=false corepack pnpm dsh web --no-open --port ${UAT_PORT} --trusted-host ${UAT_PUBLIC_HOST} > '${UAT_LOG}' 2>&1 < /dev/null & echo \$! > '${UAT_PID}'; }"
}

remote_port_wait() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$UAT_PORT" "$DEPLOY_TIMEOUT_S" <<'WAIT_EOF'
PORT="$1"; TIMEOUT="$2"
for i in $(seq 1 $((TIMEOUT / 3))); do
  ss -tln 2>/dev/null | grep -q ":${PORT} " && exit 0
  sleep 3
done
ss -tln 2>/dev/null | grep -q ":${PORT} " && exit 0
exit 1
WAIT_EOF
}

# ---------- 步骤 0：记录当前态（回滚锚）＋前置校验 ----------
PREV_SHA=$(remote "git -C ${UAT_REPO} rev-parse HEAD" 2>/dev/null || echo "")
log "回滚锚（当前 uat HEAD）：${PREV_SHA:-（空——首次切换无回滚源，失败即如实报错）}"
remote "[ -f ${UAT_REMOTE_KEY_ENV} ]" || die "容器内密钥 env 缺失：${UAT_REMOTE_KEY_ENV}（net-room source 链第一环）"
ENV_SENTINEL=$(remote "grep -c ATF_APPROVAL_LEDGER '${UAT_ENV}'" 2>/dev/null || echo 0)
[[ "$ENV_SENTINEL" -ge 1 ]] || die "uat.env 缺 ATF_APPROVAL_LEDGER——env 束不完整（fail-closed）"
log "前置校验过（容器内密钥 env 在场·uat.env 束完整）"

# ---------- 步骤 1：uat checkout fetch＋checkout（容器内） ----------
log "uat checkout fetch origin…"
if ! remote "git -C '${UAT_REPO}' fetch origin" 2>&1 | tail -1; then
  log "fetch origin 失败（网络）——改从主仓对象源直拉"
  remote "git -C '${UAT_REPO}' fetch '${MAIN_REPO}'" 2>&1 | tail -1 || die "fetch 主仓也失败——网络与本地源均不可用"
fi
log "checkout --detach ${TARGET_SHA}…"
remote "git -C '${UAT_REPO}' checkout --detach '${TARGET_SHA}'" 2>&1 | tail -1 || die "checkout 失败"
ACTUAL_SHA=$(remote "git -C ${UAT_REPO} rev-parse HEAD" 2>/dev/null)
[[ "$ACTUAL_SHA" == "$TARGET_SHA" ]] || die "checkout 后 HEAD=${ACTUAL_SHA} ≠ 目标 ${TARGET_SHA}"
log "子模块同步…"
if ! remote "git -C '${UAT_REPO}' submodule update --init vendor/dsh/deepseek-harness" 2>&1 | tail -1; then
  # 网络被阻时 fallback：本地 vendor 对象库
  log "submodule update 失败——本地 reference 重试"
  remote "rm -rf '${UAT_REPO}/.git/modules/vendor'" || die "清 .git/modules/vendor 失败"
  remote "git -C '${UAT_REPO}' submodule update --init --reference '${MAIN_REPO}/vendor/dsh/deepseek-harness' vendor/dsh/deepseek-harness" 2>&1 | tail -1 || die "子模块同步失败"
fi
SUB_SHA=$(remote "git -C ${UAT_VENDOR} rev-parse HEAD" 2>/dev/null || echo "missing")
MAIN_SUB_SHA=$(git -C "$MAIN_REPO" rev-parse HEAD:vendor/dsh/deepseek-harness 2>/dev/null || echo "")
[[ "$SUB_SHA" == "$MAIN_SUB_SHA" ]] || log "WARN: 子模块 HEAD=${SUB_SHA} ≠ 主仓 pin ${MAIN_SUB_SHA}（继续——vendor 演进独立）"
log "checkout 完成：${ACTUAL_SHA}（子模块 ${SUB_SHA:0:7}）"

# ---------- 步骤 1b：vendor 依赖引导（批㊶-UATD T1.2——CI 非交互 frozen-lockfile，
# bin 链/dist 校验缺失补 build；耗时不计入下方 60s boot 窗口） ----------
log "vendor 依赖引导（CI 非交互 frozen-lockfile，容器内）…"
if ! remote "cd '${UAT_VENDOR}' && CI=true corepack pnpm install --frozen-lockfile" 2>&1 | tail -2; then
  die "vendor 依赖安装失败（pnpm install）——人工介入"
fi
BIN_OK=0
remote "[ -x '${UAT_VENDOR}/node_modules/.bin/tsx' ] && grep -q '\"dsh\"' '${UAT_VENDOR}/package.json' && [ -f '${UAT_VENDOR}/apps/cli/src/bin.ts' ]" && BIN_OK=1
DIST_HTML="${UAT_VENDOR}/apps/web/dist/index.html"
if [[ "$BIN_OK" != "1" || "$(remote "[ -f '${DIST_HTML}' ] && echo ok || echo missing" 2>/dev/null)" != "ok" ]]; then
  log "bin 链/dist 缺失（bin=$BIN_OK）——补 corepack pnpm build…"
  remote "cd '${UAT_VENDOR}' && corepack pnpm build" 2>&1 | tail -2 || die "pnpm build 失败——人工介入"
  [[ "$(remote "[ -f '${DIST_HTML}' ] && echo ok || echo missing" 2>/dev/null)" == "ok" ]] || die "build 后仍缺 ${DIST_HTML}——人工介入"
fi
log "依赖引导完成（bin 链可解析·dist/index.html 在场）"

# ---------- 步骤 1c：vendor patch 重放（D84——submodule update 每次重置 pristine，
# patch 集不随发版走——重放段补口；apply-patches.sh 幂等：已应用 skip、有新应用才
# 重建；失败即 die＝fail-closed，禁静默带病继续发版。插在停旧/boot 之前——重放失败
# 时实例仍在跑旧版，无需回滚；既有回滚段与回滚点记录不动） ----------
log "vendor patch 重放（apply-patches.sh——幂等；失败即 die）…"
if ! remote "cd '${UAT_VENDOR}' && bash '${UAT_REPO}/vendor/dsh/apply-patches.sh'" 2>&1 | tail -3; then
  die "vendor patch 重放失败（fail-closed——禁静默继续发版；上游冲突须人工评估更新 patch，修复后重跑发版）"
fi
log "patch 重放段通过（patch 集全部已应用）"

# ---------- 步骤 2：停旧＋启动 ----------
log "停旧 dsh（组杀＋端口释放等待）…"
remote_stop_dsh || die "端口 ${UAT_PORT} 释放失败——人工介入"
remote "rm -f '${UAT_LOG}.deploy-stamp'" 2>/dev/null
log "整串 canonical 启动（容器内 nohup 形态）…"
remote_boot || die "boot 命令下发失败（SSH/远端 shell）"
remote_port_wait || { log "FAIL: ${UAT_PORT} 未监听（${DEPLOY_TIMEOUT_S}s）"; ROLLBACK=1; }
# W1023B 窗口实测：主日志被容器内进程周期性截尾（独立文件对照 probe 60s 内消失、
# boot 头保留——发版两次同因失败自动回滚），deploy 行改写独立 stamp（`>` 覆盖写）。
remote "echo '[deploy] uat now at commit=${TARGET_SHORT}' > '${UAT_LOG}.deploy-stamp'" 2>/dev/null

# ---------- 步骤 3：boot 四项验证（容器内取证：注册行/runsRoot/commit 行/真 token 探针） ----------
ROLLBACK="${ROLLBACK:-0}"
FAIL_REASONS=""
if [[ "${ROLLBACK}" != "1" ]]; then
  VERIFY=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$UAT_PORT" "$UAT_LOG" "$TARGET_SHORT" <<'VERIFY_EOF'
PORT="$1"; LOG="$2"; SHORT="$3"
sleep 5
V1=$(grep -c "^\[atf-tools\]" "$LOG" 2>/dev/null || echo 0)
V2=$(grep -c "^\[atf-ui\]" "$LOG" 2>/dev/null || echo 0)
V3=$(grep -c "runsRoot=/data/atf/uat/runs" "$LOG" 2>/dev/null || echo 0)
DEPLOY_LINE=$(grep -c "^\[deploy\] uat now at commit=${SHORT}$" "${LOG}.deploy-stamp" 2>/dev/null || echo 0)
TOK=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
BARE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
if [ -n "$TOK" ]; then
  TOKPROBE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:${PORT}/?token=${TOK}" 2>/dev/null || echo 000)
else
  TOKPROBE=000
fi
printf 'V1=%s\nV2=%s\nV3=%s\nDEPLOY=%s\nBARE=%s\nTOKPROBE=%s\nTOK=%s\n' "$V1" "$V2" "$V3" "$DEPLOY_LINE" "$BARE" "$TOKPROBE" "$TOK"
VERIFY_EOF
)
  V1=$(sed -n 's/^V1=//p' <<<"$VERIFY")
  V2=$(sed -n 's/^V2=//p' <<<"$VERIFY")
  V3=$(sed -n 's/^V3=//p' <<<"$VERIFY")
  DEPLOY_LINE=$(sed -n 's/^DEPLOY=//p' <<<"$VERIFY")
  V4_BARE=$(sed -n 's/^BARE=//p' <<<"$VERIFY")
  V4_TOKPROBE=$(sed -n 's/^TOKPROBE=//p' <<<"$VERIFY")
  NEW_TOKEN=$(sed -n 's/^TOK=//p' <<<"$VERIFY")

  log "验证① atf-tools/atf-ui 注册行：tools=${V1} ui=${V2}"
  log "验证② runsRoot=/data/atf/uat/runs 命中：${V3}"
  log "验证③ [deploy] commit 行＝${TARGET_SHORT}：${DEPLOY_LINE}"
  log "验证④ 真 token 探针（批㊶-OPSREPO T2.2）：裸 /=${V4_BARE}（401＝auth 门在位）／/?token==${V4_TOKPROBE}（303/200 算通；401/404/000 不算通）"

  [[ "$V1" -ge 1 && "$V2" -ge 1 ]] || FAIL_REASONS+="注册行缺失;"
  [[ "$V3" -ge 1 ]] || FAIL_REASONS+="runsRoot 错误;"
  [[ "$DEPLOY_LINE" -ge 1 ]] || FAIL_REASONS+="deploy 行缺失;"
  [[ "$V4_BARE" == "401" ]] || FAIL_REASONS+="裸 / auth 门异常（期望 401·实得 ${V4_BARE}）;"
  [[ "$V4_TOKPROBE" == "303" || "$V4_TOKPROBE" == "200" ]] || FAIL_REASONS+="真 token 探针失败（${V4_TOKPROBE}——401/404/000 不算通）;"
fi

# ---------- 步骤 4：失败自动回滚 ----------
if [[ "${ROLLBACK}" == "1" || -n "$FAIL_REASONS" ]]; then
  log "发版验证失败：${FAIL_REASONS:-监听失败}——自动回滚"
  if [[ -n "$PREV_SHA" ]]; then
    remote "git -C '${UAT_REPO}' checkout --detach '${PREV_SHA}'" 2>&1 | tail -1
    log "已回滚至 ${PREV_SHA}——重启实例（回滚重启）"
    remote_stop_dsh || true
    remote_boot || die "回滚 boot 下发失败——实例已停，人工介入"
    remote_port_wait || true
    remote "echo '[deploy] uat ROLLED BACK to commit=\$(git -C ${UAT_REPO} rev-parse --short HEAD)' > '${UAT_LOG}.deploy-stamp'" 2>/dev/null
    die "已回滚——失败原因：${FAIL_REASONS:-监听失败}（详见容器内 ${UAT_LOG}）"
  else
    remote_stop_dsh || true
    die "首次切换失败且无回滚源——实例已停，人工介入（容器内 log=${UAT_LOG}）"
  fi
fi

log "发版成功：uat now at ${TARGET_SHORT}（四项验证全过·atf-uat 容器 ${SSH_TARGET}）"
if [[ -n "$NEW_TOKEN" ]]; then
  log "公网访问（同事用完整 URL；token 每 boot 轮换——已登录浏览器凭 30 天签名 cookie 存续）:"
  log "  http://${UAT_PUBLIC_HOST}:${UAT_PUBLIC_PORT}/?token=${NEW_TOKEN}"
else
  log "WARN: token 未提取到——完整 URL 请查容器内 ${UAT_LOG} 的 token= 行"
fi
exit 0
