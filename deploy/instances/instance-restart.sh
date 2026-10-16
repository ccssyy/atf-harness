#!/usr/bin/env bash
# ============================================================================
# 批㊶-ISO-2 S3——实例净室重启（env -i 净室重放；遗留 export 穿透通道关闭）
#
# 资产属性：实例层运维脚本（批㊶-OPSREPO T0 入仓转正——owner 授权微批才可变更；
# 归属/调用方＝owner 或 zcode 会话按微批指令；历史：ISO-2→UATD→UATD-b→OBS1→OPSREPO）。
#
# 审计实锚（门1件 §一.S3）：dev live 进程的 RUNS_ROOT 等来自 tmux 会话遗留 export——
# canonical「整串重放」不做 unset/净化，旧值穿透。本脚本以 env -i 净室重建环境：
# 白名单（HOME/TERM/LANG/TZ/PATH）→ set -a source 密钥 env → source 实例 env →
# canonical 启动命令重放。ATF_*/DSH_* 遗留值一律不可穿透（净室语义强于 unset 白名单）。
#
# 用法：
#   instance-restart.sh <dev|uat>             净室重启（停旧→净室重放）
#   instance-restart.sh --env-cmd <dev|uat>   仅打印净室命令（预检/净化锚用——不执行）
#   instance-restart.sh --env-dump <dev|uat>  净室环境自检（source 链后打印 env——不启动）
#
# 实例拓扑（批㊶-OPSREPO v2 定案）：
#   dev ＝本容器 tmux 会话 atf-dsh＋3080（MAIN checkout vendor）——行为零变更（红线）；
#   uat ＝atf-uat 独立容器（宿主 124.220.53.207）内 dsh 3081：SSH 通道
#         root@172.18.0.20:22（专用 key id_ed25519_a800_uat），UAT 冻结 checkout vendor
#         （/data/sam/ATF-Harness-uat——双容器共享 /data 同路径），密钥 env 在容器内
#         /root/.atf-harness/.env；boot 形态＝setsid＋nohup＋pid 文件（容器无 tmux；
#         staged tmux 2.7 实测可运行但不取——装 tmux＝容器系统态变更，2026-10-16 登记）。
#
# launch token 轮换口径（批㊶-OPSREPO T2 源码定案）：vendor `dsh web` 无固定 token
# 绑定点（launch token 每进程随机——DSH_WEB_LAUNCH_TOKEN 零消费），token 每 boot
# 轮换；uat 重启完成打印完整公网 URL，已登录浏览器凭 30 天签名 cookie 存续。
#
# 纪律（沿 uat-deploy.sh 先例）：演示/同事使用时段禁重启；脚本不可用时先修脚本再重启；
# 本脚本不回写任何 env 文件。
# 测试：tests/deploy/instanceRestart.test.ts（净化锚——--env-dump 走 fixture 密钥 env，
# 不触真实密钥；真实 dev/uat 重启只在生效窗口由 owner 指令触发）。
# ============================================================================
set -euo pipefail

MAIN_REPO="/data/sam/ATF-Harness"
VENDOR_DIR="${MAIN_REPO}/vendor/dsh/deepseek-harness"
KEY_ENV="${ATF_INSTANCE_KEY_ENV:-/root/.atf-harness/.env}"

usage_die() { echo "用法: instance-restart.sh <dev|uat>|--env-cmd <dev|uat>|--env-dump <dev|uat>" >&2; exit 2; }

MODE="${1:-}"
case "$MODE" in
  dev|uat) SHIFT=0 ;;
  --env-cmd|--env-dump) SHIFT=1 ;;
  *) usage_die ;;
esac

INSTANCE="${2:-}"
if [[ "$SHIFT" == "0" ]]; then INSTANCE="$MODE"; MODE="restart"; fi

# 批㊶-UATD-b T1/T2：boot 非交互 env（仅 uat——dev 行为零变更红线）。地雷②：pnpm 运行前
# deps 检查在交互环境弹 "Proceed? (Y/n)" 卡死 boot、其自动重装在 uat submodule 结构下
# 必败（core.worktree 与 extensions.worktreeConfig 冲突——lefthook install-lefthook.mjs
# 试图 git config extensions.worktreeConfig true 被 git 拒绝）；node_modules 经 uat-deploy.sh
# 引导段安装后是健康的，env 只屏蔽误伤性自动重装。
BOOT_ENV_PREFIX=""
if [[ "$INSTANCE" == "uat" ]]; then
  BOOT_ENV_PREFIX="CI=true npm_config_verify_deps_before_run=false "
fi
[[ "$SHIFT" == "1" ]] && [[ -z "$INSTANCE" ]] && usage_die

# 批㊶-OPSREPO：uat 分支远端常量（atf-uat 容器）——SSH 通道/容器内密钥 env/UAT 冻结
# checkout vendor/pid 文件。dev 常量（3080/tmux atf-dsh）一字未动（红线）。
UAT_SSH_KEY="/root/.ssh/id_ed25519_a800_uat"
UAT_SSH_TARGET="root@172.18.0.20"
UAT_KEY_ENV="/root/.atf-harness/.env"
UAT_REPO="/data/sam/ATF-Harness-uat"
UAT_VENDOR="${UAT_REPO}/vendor/dsh/deepseek-harness"
UAT_PID="/tmp/dsh-web-tongshi.pid"
UAT_PUBLIC_HOST="124.220.53.207"
UAT_PUBLIC_PORT=13081

case "$INSTANCE" in
  dev)
    ENV_FILE="${MAIN_REPO}/deploy/instances/dev.env"
    PORT=3080
    TMUX_SESSION="atf-dsh"
    LOG="/tmp/dsh-web-k28.log"
    TRUSTED_ARG=""
    ;;
  uat)
    ENV_FILE="${MAIN_REPO}/deploy/instances/uat.env"
    PORT=3081
    LOG="/tmp/dsh-web-tongshi.log"
    TRUSTED_ARG="--trusted-host 124.220.53.207"
    ;;
  *) usage_die ;;
esac

if [[ "$INSTANCE" == "uat" ]]; then
  # 共享 /data——ENV_FILE 双侧同路径同视图；密钥 env 属容器内文件，重启执行前远端
  # fail-closed 校验（--env-cmd/--env-dump 仅打印/自检，不做 SSH 依赖校验）
  [[ -f "$ENV_FILE" ]] || { echo "[instance-restart] FAIL: 实例 env 不存在: $ENV_FILE" >&2; exit 2; }
else
  [[ -f "$ENV_FILE" ]] || { echo "[instance-restart] FAIL: 实例 env 不存在: $ENV_FILE" >&2; exit 2; }
  [[ -f "$KEY_ENV" ]] || { echo "[instance-restart] FAIL: 密钥 env 不存在: $KEY_ENV（net-room source 链第一环）" >&2; exit 2; }
fi

# 单引号安全包装（内嵌引号/空白路径安全——'"'"' 标准转义）
sq() { printf "'%s'" "${1//\'/\'\"\'\"\'}"; }

# 净室 prologue：白名单外全裸 → source 密钥 env → source 实例 env（均 set -a 导出）
PROLOGUE="set -a; source $(sq "$KEY_ENV"); set +a; source $(sq "$ENV_FILE"); set +a"

if [[ "$INSTANCE" == "uat" ]]; then
  # —— uat 远端净室（atf-uat 容器内执行）——
  # PATH 自愈首环：env -i 净室只给系统最小 PATH，boot 前从容器内 nvm 安装目录解析 node
  # （版本无关——glob 任一 node 在场即前置；net-room 语义不变，只加白 PATH 解析）。
  UAT_PATH_HEAL="for d in \"\$HOME\"/.nvm/versions/node/*/bin; do [ -x \"\$d/node\" ] && PATH=\"\$d:\$PATH\" && export PATH && break; done;"
  if [[ "$MODE" == "--env-dump" ]]; then
    INNER="${UAT_PATH_HEAL} set -a; source $(sq "$UAT_KEY_ENV"); set +a; source $(sq "$ENV_FILE"); set +a; env | LC_ALL=C sort"
  else
    INNER="${UAT_PATH_HEAL} set -a; source $(sq "$UAT_KEY_ENV"); set +a; source $(sq "$ENV_FILE"); set +a; cd $(sq "$UAT_VENDOR") && { setsid nohup env ${BOOT_ENV_PREFIX}corepack pnpm dsh web --no-open --port ${PORT} ${TRUSTED_ARG} > $(sq "$LOG") 2>&1 < /dev/null & echo \$! > $(sq "$UAT_PID"); }"
  fi
  # env -i 白名单 PATH＝容器内系统最小集（nvm 面由 INNER 自愈解析，版本无关）。
  # 远端段整体单引号（BUMP17B 修复）：ssh 把多 argv 空格拼接后由远端默认 shell 再解析，
  # INNER 多语句（for/do 分号链）在无外层 quoting 时拆词破碎（`syntax error near 'do'`
  # 实锚）——外层 sq 包整个 env -i … bash -c '<INNER>' 串，远端解析还原双层结构。
  NET_CMD="ssh -i ${UAT_SSH_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${UAT_SSH_TARGET} $(sq "env -i HOME=/root TERM=$(sq "${TERM:-xterm}") LANG=$(sq "${LANG:-C.UTF-8}") TZ=$(sq "${TZ:-Asia/Shanghai}") PATH=/usr/bin:/bin:/usr/sbin:/sbin bash -c $(sq "$INNER")")"
else
  case "$MODE" in
    --env-cmd)
      INNER="${PROLOGUE}; cd '${VENDOR_DIR}' && exec ${BOOT_ENV_PREFIX}corepack pnpm dsh web --no-open --port ${PORT} ${TRUSTED_ARG} > '${LOG}' 2>&1"
      ;;
    --env-dump)
      INNER="${PROLOGUE}; env | LC_ALL=C sort"
      ;;
    restart)
      INNER="${PROLOGUE}; cd '${VENDOR_DIR}' && exec ${BOOT_ENV_PREFIX}corepack pnpm dsh web --no-open --port ${PORT} ${TRUSTED_ARG} > '${LOG}' 2>&1"
      ;;
    *) usage_die ;;
  esac

  # 净室白名单：HOME/TERM/LANG/TZ/PATH ＋ LD_LIBRARY_PATH（系统运行时必需轴——真机实锚
  # 2026-10-13 生效段：/usr/bin/python3 需 libpython3.10.so.1.0，库路径在执行时环境
  # LD_LIBRARY_PATH（/usr/local/lib…），净室缺它即 python3 探活 fail-fast boot 拒绝；
  # 未设则不传——净室语义不变）
  NET_CMD="env -i HOME=$(sq "$HOME") TERM=$(sq "${TERM:-xterm}") LANG=$(sq "${LANG:-C.UTF-8}") TZ=$(sq "${TZ:-Asia/Shanghai}") PATH=$(sq "$PATH") ${LD_LIBRARY_PATH:+LD_LIBRARY_PATH=$(sq "$LD_LIBRARY_PATH") }bash -c \"${INNER}\""
fi

if [[ "$MODE" == "--env-cmd" || "$MODE" == "--env-dump" ]]; then
  printf '%s\n' "$NET_CMD"
  exit 0
fi

# —— 重启（停旧 → 净室重放）——
if [[ "$INSTANCE" == "uat" ]]; then
  # 批㊶-OPSREPO：uat 分支＝atf-uat 容器内停旧（pid 文件组杀＋cmdline 兜底＋端口释放等待）
  # ＋SSH net-room 重放（nohup 形态）；dev 分支行为零变更（tmux 流程原样，红线）。
  echo "[instance-restart] ${INSTANCE}: 前置校验（容器内密钥 env/实例 env）…"
  ssh -i "${UAT_SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${UAT_SSH_TARGET}" "[ -f '${UAT_KEY_ENV}' ] && [ -f '${ENV_FILE}' ]" || {
    echo "[instance-restart] FAIL: 容器内 env 缺失（${UAT_KEY_ENV} 或 ${ENV_FILE}——net-room source 链第一环）" >&2
    exit 2
  }
  echo "[instance-restart] ${INSTANCE}: 停旧（pid 组杀→cmdline 兜底→端口释放等待）…"
  ssh -i "${UAT_SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${UAT_SSH_TARGET}" bash -s -- "${PORT}" "${UAT_PID}" <<'STOP_EOF' || { echo "[instance-restart] FAIL: 端口 ${PORT} 释放失败——人工介入" >&2; exit 2; }
PORT="$1"; PIDFILE="$2"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')
    [ -n "$PGID" ] && kill -TERM -- -"$PGID" 2>/dev/null
  fi
  rm -f "$PIDFILE"
fi
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
  echo "[instance-restart] ${INSTANCE}: 净室重放 canonical 启动（SSH→atf-uat 容器·日志 ${LOG}）…"
  eval "$NET_CMD" || { echo "[instance-restart] FAIL: boot 命令下发失败（SSH/远端 shell）" >&2; exit 2; }
  sleep 8
  TOK=$(ssh -i "${UAT_SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${UAT_SSH_TARGET}" "grep -o 'token=[A-Za-z0-9_-]*' '$LOG' 2>/dev/null | tail -1 | cut -d= -f2")
  if ssh -i "${UAT_SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${UAT_SSH_TARGET}" "ss -tln 2>/dev/null | grep -q ':${PORT} '"; then
    echo "[instance-restart] ${INSTANCE}: boot 监听 ${PORT} ✓"
  else
    echo "[instance-restart] WARN: ${PORT} 尚未监听——稍后复核容器内 ${LOG}" >&2
  fi
  # uat 便利：boot 完成打印公网带 token 完整 URL（token 每 boot 轮换——批㊶-OPSREPO T2 轮换口径）
  if [[ -n "$TOK" ]]; then
    echo "[instance-restart] uat 公网访问: http://${UAT_PUBLIC_HOST}:${UAT_PUBLIC_PORT}/?token=${TOK}"
  else
    echo "[instance-restart] uat: token 未就绪——稍后执行（容器内）: grep -o 'token=[A-Za-z0-9_-]*' $LOG | tail -1"
  fi
else
  # —— dev 分支（行为零变更——tmux 会话内停旧 → 净室重放，原样保留）——
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "[instance-restart] FAIL: tmux 会话不在: $TMUX_SESSION" >&2
    exit 2
  fi
  echo "[instance-restart] ${INSTANCE}: 停旧（C-c → ${TMUX_SESSION}）…"
  tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
  sleep 2
  echo "[instance-restart] ${INSTANCE}: 净室重放 canonical 启动（日志 ${LOG}）…"
  tmux send-keys -t "$TMUX_SESSION" "$NET_CMD" Enter
  echo "[instance-restart] ${INSTANCE}: 已发送——boot 验证沿实例规程（监听 ${PORT}/boot 行/净室留痕）"
fi
