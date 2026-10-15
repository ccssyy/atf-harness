#!/usr/bin/env python3
# 批㊶-TRAIN-OBS-FIX2 T2 冒烟——WebUI 链 bind_run 补齐呈现验证（真实浏览器·禁 mock）。
#
# 指令件：ATF_指令_批㊶-TRAIN-OBS-FIX2_WebUI链bind_run补齐_20261015.md（sha256 前缀 8e56c543）。
# 链路：净环境实例（四轴隔离：--port／ATF_DSH_RUNS_ROOT／DSH_HOME＋HOME——HOME 轴同时承载
# 内核 ~/.atf/config.json workspace_root，使冒烟 run 对内核可见、atf.bind_run 真成功）→
# 夹具（train.sh $TMUX 判别真跑分支——沿仓内冒烟先例·隔离账本放行记录）→ 真实浏览器
# WebUI 会话内经 GLM agent 调 atf_run_training start → danger 卡 Allow once → 真训启动
# （tmux 作用域会话）→ binding.json＋内核侧绑定 → 进度/ETA/日志尾部/dock chip/流程卡
# 双形态呈现 → 五截图名实一致。
#
# 红线遵守：vendor 零触碰；内核仓零改动（pin 只读消费）；appendBinding 语义零改动；
# 不碰 dev/uat 运行态实例与 runs 数据（全部落 tmp/fix2-smoke 隔离根＋fix2- tmux 命名域）。
# 用户可见面零开发叙事（截图即产品面）。
#
# 用法：python3 tests/dshUi/smoke_train_obs_fix2_browser.py
# 产出：截图 5 张（SCREENSHOT_DIR）＋ALL PASS／FAILURES 摘要；退出码 0＝全绿。
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

# ── 常量（隔离轴） ────────────────────────────────────────────────────────────
REPO = "/data/sam/ATF-Harness"
SMOKE = os.path.join(REPO, "tmp", "fix2-smoke")
RUNS = os.path.join(SMOKE, "runs")
HOME_AXis = os.path.join(SMOKE, "home")  # HOME 轴（内核 ~/.atf/config.json 随轴隔离）
DSH_HOME = os.path.join(SMOKE, "dsh-home")
LOG = "/tmp/fix2-smoke-web.log"
WEB_TMUX = "fix2-smoke-web"
PORT = 3480
PREFIX = "fix2-"  # ATF_TMUX_SESSION_PREFIX（launch/probe 命名域）
KEY_ENV = "/root/.atf-harness/.env"
PIN = "/data/atf/dev/pinned"  # 实例 pin 根（只读消费——与 dev 实例同源）
VENDOR = os.path.join(REPO, "vendor", "dsh", "deepseek-harness")
BASE = f"http://127.0.0.1:{PORT}"
SCREENSHOT_DIR = os.path.join(REPO, "docs", "_owner", "screenshots", "TRAIN-OBS-FIX2")
MODEL = "/data/LLM_model/Qwen2.5-VL-3B-Instruct"
DATASET_DIR = "/data/sam/LLaMA-Factory_094dev/data"

failures = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label, flush=True)
    if not cond:
        failures.append(label)


def shot(page, name):
    page.screenshot(path=str(Path(SCREENSHOT_DIR) / name))
    print("[shot] " + name, flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def tmux_ok(args):
    return subprocess.run(["tmux", "has-session", "-t", args], capture_output=True).returncode == 0


# ── Phase 0：净环境实例（幂等——先收本冒烟域旧会话） ─────────────────────────────
print("[phase0] 净环境实例启动（四轴隔离）…", flush=True)
subprocess.run(["tmux", "kill-session", "-t", WEB_TMUX], capture_output=True)
out = subprocess.run(["tmux", "ls"], capture_output=True, text=True).stdout
for line in out.splitlines():
    name = line.split(":")[0]
    if name.startswith(PREFIX):
        subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
for sub in ("runs", "sessions", "logs", "ledger", "home/.atf", "dsh-home/profiles/web", "home/fix2-ws"):
    shutil.rmtree(os.path.join(SMOKE, sub), ignore_errors=True)
for sub in ("runs", "exec-home", "sessions", "logs", "ledger", "home/.atf", "dsh-home/profiles/web", "home/fix2-ws"):
    os.makedirs(os.path.join(SMOKE, sub), exist_ok=True)
json.dump({"workspace_root": SMOKE}, open(os.path.join(HOME_AXis, ".atf", "config.json"), "w"))
for f in ("cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"):
    shutil.copy(os.path.join(REPO, "poc/dsh-home/profiles/web", f), os.path.join(DSH_HOME, "profiles/web", f))

keys = {}
for line in Path(KEY_ENV).read_text().splitlines():
    m = re.match(r"export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$", line.strip()) or re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$", line.strip())
    if m:
        keys[m.group(1)] = m.group(2).strip("\"'")

master_port = free_port()
boot_env = {
    "HOME": HOME_AXis,
    "TERM": "xterm",
    "LANG": "C.UTF-8",
    "TZ": "Asia/Shanghai",
    "PATH": os.environ["PATH"],
    "LD_LIBRARY_PATH": os.environ.get("LD_LIBRARY_PATH", ""),
    "COREPACK_HOME": "/root/.cache/node/corepack",
    **keys,
    "ATF_INSTANCE_PIN_ROOT": PIN,
    "ATF_V1_FILE_TOOL_ROOTS": f"{PIN}:/data/LLM_model",
    "ATF_DSH_PIPELINE_COMMAND": f"python3 {PIN}/tools/walkthrough_pipeline.py",
    "ATF_DSH_BRIDGE_COMMAND": f"PYTHONPATH={PIN}/src python3 -m agentic_training_flow serve",
    "ATF_DSH_RUNS_ROOT": RUNS,
    "ATF_DSH_EXEC_HOME": os.path.join(SMOKE, "exec-home"),
    "ATF_WEBUI_SESSIONS_ROOT": os.path.join(SMOKE, "sessions"),
    "ATF_TMUX_SESSION_PREFIX": PREFIX,
    "ATF_APPROVAL_LEDGER": os.path.join(SMOKE, "ledger/training-release.jsonl"),
    "ATF_MODEL_ROOT": "/data/LLM_model",
    "ATF_LLM_CONFIG": "/root/.atf-harness/llm-piai-walkthrough-glm.json",
    "ATF_DSH_LOG_DIR": os.path.join(SMOKE, "logs"),
    "ATF_GPU_POLL_MS": "0",  # 直启旁路（无排队无琥珀卡——danger 卡守门不变）
    "DSH_HOME": DSH_HOME,
}
boot_cmd = "cd '%s' && exec corepack pnpm dsh web --no-open --port %d > '%s' 2>&1" % (VENDOR, PORT, LOG)
if Path(LOG).exists():
    Path(LOG).unlink()  # 旧 boot 日志清场——token 循环只认本轮新内容
subprocess.run(["tmux", "new-session", "-d", "-s", WEB_TMUX,
                "env -i " + " ".join(f"{k}={json.dumps(v)}" for k, v in boot_env.items() if v is not None) + " bash -c " + json.dumps(boot_cmd)],
               capture_output=True)

token = None
for _ in range(90):
    time.sleep(2)
    try:
        text = Path(LOG).read_text()
        if "atf-tools] apply()" not in text:  # 装配未完成不取 token（防半截内容）
            continue
        token = re.search(r"token=(\S+)", text).group(1)
        break
    except Exception:
        continue
check(token is not None, "P0 冒烟实例 boot（token 提取）")
log_text = Path(LOG).read_text()
check("atf-tools] apply()" in log_text, "P0 atf-tools 扩展装配")
check("桥对端: real" in log_text, "P0 桥对端 real（真内核桥）")
check(f"runsRoot={RUNS}" in log_text, "P0 runsRoot 隔离轴生效")

# ── Phase 1：夹具（run 目录＋train.sh＋隔离账本放行记录） ────────────────────────
print("[phase1] 夹具构建…", flush=True)
run_id = "fix2-obs-" + uuid.uuid4().hex[:8]
run_dir = os.path.join(RUNS, run_id)
os.makedirs(run_dir + "/prep", exist_ok=True)
os.makedirs(run_dir + "/launch", exist_ok=True)
os.makedirs(run_dir + "/training", exist_ok=True)
gpu_out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used,memory.total", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
gpu = max(((int(i), int(t) - int(u)) for i, u, t in (l.split(", ") for l in gpu_out.strip().splitlines())), key=lambda x: x[1])[0]
json.dump({"base_model": {"path": MODEL}}, open(run_dir + "/prep/iteration-config.json", "w"), ensure_ascii=False, indent=1)
open(run_dir + "/launch/prelaunch-report.md", "w").write("# 训练前报告（fix2 冒烟夹具）\n- DRY_RUN 已过\n- 模型本地在位\n")
import hashlib
subject = hashlib.sha256(("fix2-smoke-release:" + run_id).encode()).hexdigest()
train_sh = """#!/usr/bin/env bash
# fix2 冒烟夹具（非产品链产物）：$TMUX 判别真跑分支（工具 start 链裸跑前置零副作用——沿仓内冒烟先例）
set -Eeuo pipefail
export FORCE_TORCHRUN=1 NNODES=1 NPROC_PER_NODE=1
export NODE_RANK=${NODE_RANK:-0} MASTER_ADDR=127.0.0.1
export MASTER_PORT=${MASTER_PORT:-%d}
export CUDA_VISIBLE_DEVICES=%d

python3 - <<'ADMIT'
import json, hashlib
from pathlib import Path
d = Path('%s')
info = json.loads((d / 'dataset_info.json').read_text())
assert 'identity' in info, 'dataset_info 缺条目'
p = d / info['identity']['file_name']
assert p.is_file(), '数据文件缺失'
hashlib.sha256(p.read_bytes()).hexdigest()
print('SHA=pass entries=1')
print('ADMISSION=pass keys=1')
ADMIT

TRAIN_CMD=(
  'llamafactory-cli' 'train'
  '--stage' 'sft' '--do_train' '--finetuning_type' 'lora'
  '--model_name_or_path' '%s'
  '--dataset' 'identity' '--dataset_dir' '%s'
  '--template' 'qwen2_vl' '--cutoff_len' '1024' '--max_samples' '8'
  '--output_dir' '%s/training'
  '--max_steps' '400' '--logging_steps' '20'
  '--save_strategy' 'no' '--plot_loss' 'no' '--report_to' 'none'
  '--per_device_train_batch_size' '2' '--gradient_accumulation_steps' '1'
  '--learning_rate' '5e-5' '--lora_rank' '8' '--lora_alpha' '16'
)

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf 'COMMAND='; printf '%%q ' "${TRAIN_CMD[@]}"; printf '\\n'
  exit 0
fi
if [[ -z "${TMUX:-}" ]]; then
  printf 'COMMAND='; printf '%%q ' "${TRAIN_CMD[@]}"; printf '\\n'
  exit 0
fi
approval_ledger="${ATF_APPROVAL_LEDGER:-${HOME:-}/.atf/approval-ledger/training-release.jsonl}"
if ! grep -q '"subject_sha256": *"%s"' "$approval_ledger" 2>/dev/null; then
  echo "真实训练缺少用户放行记录(subject=%s)" >&2
  exit 78
fi
exec "${TRAIN_CMD[@]}"
""" % (master_port, gpu, DATASET_DIR, MODEL, DATASET_DIR, run_dir, subject, subject)
open(run_dir + "/launch/train.sh", "w").write(train_sh)
os.chmod(run_dir + "/launch/train.sh", 0o755)
rec = json.dumps({"subject_sha256": subject, "run_id": run_id, "by": "fix2-smoke-fixture",
                  "note": "TRAIN-OBS-FIX2 T2 冒烟放行（隔离账本）"})
open(os.path.join(SMOKE, "ledger/training-release.jsonl"), "a").write(rec + "\n")
dry = subprocess.run(["bash", run_dir + "/launch/train.sh"], capture_output=True, text=True,
                     env={**os.environ, "DRY_RUN": "1"})
check(dry.returncode == 0 and "ADMISSION=pass" in dry.stdout, "P1 夹具 train.sh DRY_RUN 自检（ADMISSION=pass）")
print(f"[phase1] run_id={run_id} gpu={gpu} master_port={master_port}", flush=True)

# ── Phase 2：真实浏览器——WebUI 会话内起短训（GLM agent×工具链×danger 卡） ─────────
print("[phase2] 浏览器驱动（WebUI 会话真短训）…", flush=True)
os.makedirs(SCREENSHOT_DIR, exist_ok=True)
session_id_seen = None
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1560, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.type + ": " + m.text[:220]) if m.type == "error" else None)
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(6)
    # workspace 选择（净环境首启必有 Choose workspace；已持久化则跳过）
    if page.locator("[role='textbox']").count() == 0:
        page.locator("button:has-text('Choose workspace')").first.click()
        time.sleep(2)
        page.get_by_text("fix2-ws", exact=True).first.click()
        time.sleep(1)
        page.locator("button:has-text('Open')").last.click()
        time.sleep(3)
    check(page.locator("[role='textbox']").count() > 0, "P2 composer 就绪（workspace fix2-ws）")
    instr = (f"调用 atf_run_training 工具启动本机训练：action=\"start\"，train_sh=\"{run_dir}/launch/train.sh\"，"
             f"run_id=\"{run_id}\"。该 train.sh 已通过 DRY_RUN 校验且账本已放行（本机重跑场景）。"
             "直接调用该工具，不要做其他准备步骤，不要调用其他工具。")
    box = page.locator("[role='textbox']").first
    box.click()
    box.fill(instr)
    time.sleep(1)
    page.keyboard.press("Enter")
    # 审批卡（danger 必确认——任何档位不豁免）呈现留证后放行
    allow_seen = False
    for _ in range(60):
        time.sleep(5)
        if page.locator("button:has-text('Allow once')").count() > 0:
            allow_seen = True
            break
    check(allow_seen, "P2 danger 审批卡呈现（真实 GPU 代价人工确认守门）")
    if allow_seen:
        shot(page, "01-approval-danger-card.png")  # 附加留证（放行前卡面；非五截图计内）
        page.locator("button:has-text('Allow once')").first.click()
    # 启动确认：tmux 作用域会话在场（主判据）＋聊天面探活文案（辅证——卡面折叠态可能不含）
    started = False
    train_session = None
    for _ in range(36):
        out = subprocess.run(["tmux", "ls"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            name = line.split(":")[0]
            if name.startswith(PREFIX + "atf-training") and run_id in name:
                train_session = name
                started = True
                break
        if started:
            break
        time.sleep(5)
    if not started:
        body = page.locator("body").inner_text()
        started = "进料确认 OK" in body or "训练已启动" in body
    check(started, "P2 训练经产品链启动（tmux 作用域会话在场／探活进料确认）")

    # ── Phase 3：数据链断言（binding.json＋内核侧绑定静默＋monitor 投影） ────────
    print("[phase3] 数据链断言…", flush=True)
    binding_path = Path(run_dir) / "webui" / "binding.json"
    bound = None
    for _ in range(24):
        if binding_path.exists():
            try:
                entries = json.loads(binding_path.read_text())
                if entries:
                    bound = entries[-1]
                    break
            except Exception:
                pass
        time.sleep(5)
    check(bound is not None, "P3 binding.json 在盘（WebUI 会话绑定——N-5）")
    if bound:
        session_id_seen = bound.get("session_id")
        print("[phase3] session_id=" + str(session_id_seen), flush=True)
    log2 = Path(LOG).read_text()
    check("atf.bind_run fail-open" not in log2, "P3 atf.bind_run 内核侧绑定静默成功（run 对内核可见·零 fail-open 留痕）")
    monitor_path = Path(RUNS) / "atf-ui" / "monitor.json"
    m_run = None
    for _ in range(24):
        try:
            mon = json.loads(monitor_path.read_text())
            hit = [r for r in mon.get("runs", []) if r.get("run_id") == run_id]
            if hit and hit[0].get("training", {}).get("active") is True:
                m_run = hit[0]
                break
        except Exception:
            pass
        time.sleep(5)
    check(m_run is not None, "P3 monitor.json 含 smoke run 且 training.active=true")
    if m_run:
        check(session_id_seen in (m_run.get("bound_sessions") or []), "P3 monitor bound_sessions 含本会话（scoped 池入池）")
    # 进度写链（trainer_log→progress 5s 环——模型加载后出步）
    progress = None
    for _ in range(90):
        try:
            progress = json.loads((Path(run_dir) / "webui" / "progress.json").read_text())
            if isinstance(progress.get("percentage"), (int, float)):
                break
        except Exception:
            progress = None
        time.sleep(5)
    check(progress is not None and isinstance(progress.get("percentage"), (int, float)),
          f"P3 progress.json 步进在写（percentage={progress.get('percentage') if progress else None}）")
    check(bool(progress and progress.get("eta_s") is not None), f"P3 progress eta_s 在（{progress.get('eta_s') if progress else None}s）")
    tail = None
    for _ in range(24):
        try:
            mon = json.loads(monitor_path.read_text())
            hit = [r for r in mon.get("runs", []) if r.get("run_id") == run_id]
            t = hit[0].get("trainlog_tail") if hit else None
            if t and isinstance(t.get("lines"), list) and len(t["lines"]) > 0:
                tail = t
                break
        except Exception:
            pass
        time.sleep(5)
    check(tail is not None and 0 < len(tail["lines"]) <= 40, f"P3 trainlog_tail 投影在（{len(tail['lines']) if tail else 0} 行≤40）")

    # ── Phase 4：呈现五截图（名实一致） ────────────────────────────────────────
    print("[phase4] 呈现截图…", flush=True)
    time.sleep(6)  # 等一拍客户端轮询/SSE 合流
    # ④① dock"训练进行中"chip（.atf-gpu-card——训练态文本＝run 尾段·第 N 轮·loss，琥珀色）
    chip = page.locator(".atf-gpu-card")
    chip_ok = False
    chip_text = ""
    for _ in range(24):
        if chip.count() > 0:
            chip_text = chip.first.inner_text()
            if ("无训练进行中" not in chip_text) and ("训练" in chip_text or "轮" in chip_text or "loss" in chip_text or "段" in chip_text):
                chip_ok = True
                break
        time.sleep(5)
    check(chip_ok, f"P4 dock 训练中 chip（text={chip_text[:40] if chip_text else 'absent'}）")
    shot(page, "02-dock-chip-training.png")
    # ④② 收起态胶囊徽标＝进度百分比（.atf-task-card-collapsed 含 % 徽标）
    pill = page.locator(".atf-task-card-collapsed")
    pill_ok = False
    pill_text = ""
    for _ in range(24):
        if pill.count() > 0:
            pill_text = pill.first.inner_text()
            if re.search(r"\d+\s*%", pill_text):
                pill_ok = True
                break
        time.sleep(5)
    check(pill_ok, f"P4 收起胶囊徽标进度百分比（text={pill_text[:40] if pill_text else 'absent'}）")
    shot(page, "03-pill-badge-progress.png")
    # ④③ 展开态八段卡全景（点胶囊展开——八段＋segDetail 进度行 %＋预计剩；5s tick 重渲染竞态重试）
    card = page.locator(".atf-task-card")
    card_ok = False

    def card_present():
        try:
            # 可见判定＝bounding_box 非空（is_visible 对 fixed 层叠态误报——实锚 20261015）
            return card.count() > 0 and card.first.bounding_box() is not None
        except Exception:
            return False

    # 展开双入口：dock chip（store.taskCardOpen——R1 实证通道）优先，胶囊点击候补；
    # 命中后窗口轮询（useMonitor 5s 拉取周期存在 mon 空窗瞬时卸载——单点判定会踩空）
    for opener in (lambda: chip.first.click(timeout=3000, force=True),
                   lambda: pill.first.click(timeout=3000, force=True)):
        try:
            opener()
        except Exception:
            pass
        for _ in range(10):
            time.sleep(1)
            if card_present():
                card_ok = True
                break
        if card_ok:
            break
    check(card_ok, "P4 浮卡展开态八段卡渲染")
    if not card_ok:
        dom = page.evaluate("""() => {
          const el = document.querySelector('.atf-task-card');
          if (!el) return {present: false};
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {present: true, x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex};
        }""")
        print("[debug] expand 失败现场 card-style=" + json.dumps(dom), flush=True)
        page.screenshot(path=str(Path(SCREENSHOT_DIR) / "debug-expand-failure.png"))
        print("[debug] console errors=" + json.dumps(console_errors[-6:], ensure_ascii=False), flush=True)
    if card_ok:
        card_text = card.first.inner_text()
        check("训练执行" in card_text, "P4 八段卡含训练执行段")
        check(re.search(r"\d+\s*%", card_text) is not None and "预计剩" in card_text,
              "P4 展开卡进度行（百分比＋预计剩 ETA）")
        shot(page, "04-eight-seg-card-eta.png")
        # ④④ 进度行 ETA 特写（segDetail 行 clip——边距放宽防换行截头）
        loc = page.get_by_text(re.compile(r"\d+\s*%.*预计剩|预计剩.*\d+%")).last
        try:
            bb = loc.bounding_box()
            if bb:
                page.screenshot(path=str(Path(SCREENSHOT_DIR) / "05-progress-row-eta-closeup.png"),
                                clip={"x": max(0, bb["x"] - 16), "y": max(0, bb["y"] - 20),
                                      "width": min(bb["width"] + 32, 1560), "height": min(bb["height"] + 40, 950 - max(0, bb["y"] - 20))})
                print("[shot] 05-progress-row-eta-closeup.png")
        except Exception:
            shot(page, "05-progress-row-eta-closeup.png")
        # ④⑤ 日志尾部折叠区展开（40 行等宽）
        summ = page.locator(".atf-task-card .atf-trainlog-tail summary, .atf-trainlog-tail summary")
        tail_ok = summ.count() > 0
        check(tail_ok, "P4 日志尾部折叠区渲染（浮卡入口）")
        if tail_ok:
            summ.first.click()
            time.sleep(1)
            pre = page.locator(".atf-trainlog-tail pre")
            check(pre.count() > 0 and len(pre.first.inner_text().strip()) > 0, "P4 日志尾部展开有等宽内容")
            shot(page, "06-trainlog-tail-expanded.png")
    print("[phase4] pageerror %d 条：%s" % (len(errors), str(errors[:2])), flush=True)
    browser.close()

# ── Phase 5：收尾（本冒烟域训练会话终止——GPU 归零；web 实例保留供 owner 复查至脚本尾） ──
subprocess.run(["tmux", "kill-session", "-t", train_session], capture_output=True)
subprocess.run(["tmux", "kill-session", "-t", WEB_TMUX], capture_output=True)
print("[phase5] 冒烟域已收尾（训练会话＋web 实例）；run 留证：" + run_dir, flush=True)
print("[smoke] 截图目录：" + SCREENSHOT_DIR, flush=True)
if not failures:
    print("[smoke] ALL PASS", flush=True)
else:
    print("[smoke] FAILURES: %s" % failures, flush=True)
sys.exit(0 if not failures else 1)
