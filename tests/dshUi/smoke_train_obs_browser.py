#!/usr/bin/env python3
# 批㊶-TRAIN-OBS-FIX R1 重验冒烟——两阶段。
# Phase 1 (shell+tsx)：数据链（loss-series stub→active→obs 环→progress/trainlog）
# Phase 2 (playwright)：真实浏览器渲染验证
# 零 rm -rf 既有留证·run id 时间戳参数化·C1 断言正确。
import json, re, subprocess, sys, time
from pathlib import Path

SHOTS = Path("/tmp/trainobs-fix-shots-rerun")
SHOTS.mkdir(exist_ok=True)
BASE = "http://127.0.0.1:3080"
TS = str(int(time.time()) % 100000)
RUN_ID = "train-obs-smoke-" + TS
RUN_DIR = "/data/atf/dev/runs/" + RUN_ID
SESSION = "dev-atf-training-run-" + RUN_ID

failures = []
def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)

def shot(page, name):
    page.screenshot(path=str(SHOTS / name))
    print("[shot] " + name)

# ── Phase 1：起真训＋loss-series stub→等观测环
print("[phase1] 起短训 %s（400 步）…" % RUN_ID)
Path(RUN_DIR + "/training").mkdir(parents=True, exist_ok=True)
Path(RUN_DIR + "/webui").mkdir(parents=True, exist_ok=True)
session = SESSION
cmd = ("PYTHONUNBUFFERED=1 CUDA_VISIBLE_DEVICES=0 llamafactory-cli train "
       "--stage sft --do_train --finetuning_type lora "
       "--model_name_or_path /data/LLM_model/Qwen2.5-VL-3B-Instruct "
       "--dataset identity --dataset_dir /data/sam/LLaMA-Factory_094dev/data "
       "--template qwen2_vl --cutoff_len 1024 --max_samples 8 "
       "--output_dir " + RUN_DIR + "/training "
       "--max_steps 400 --logging_steps 20 "
       "--save_strategy no --plot_loss no --report_to none "
       "--per_device_train_batch_size 2 --gradient_accumulation_steps 1 "
       "--learning_rate 5e-5 --lora_rank 8 --lora_alpha 16 "
       "2>&1 | tee " + RUN_DIR + "/training/train-stdout.log")
subprocess.Popen(["tmux", "new-session", "-d", "-s", session, cmd],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
# 训练锚 stub（真实产品链由 startLossIngest 产出——冒烟直接建空数组锚）
Path(RUN_DIR + "/training/loss-series.json").write_text("[]\n")
print("[phase1] tmux started＋loss-series stub 写入。等观测环（~120s）…")
time.sleep(120)

# ── Phase 1 数据面断言
pp = Path(RUN_DIR + "/webui/progress.json")
check(pp.exists(), "P1 progress.json 在盘")
if pp.exists():
    prog = json.loads(pp.read_text())
    check(bool(prog.get("percentage")), "P1 progress.percentage (%s%%)" % prog.get("percentage"))
    check(bool(prog.get("eta_s")), "P1 progress.eta_s (%ss)" % prog.get("eta_s"))
    print("[phase1] progress:", json.dumps(prog, ensure_ascii=False)[:120])
tl = Path(RUN_DIR + "/webui/trainlog.tail.json")
check(tl.exists(), "P1 trainlog.tail.json 在盘")
monitor = json.loads(Path("/data/atf/dev/runs/atf-ui/monitor.json").read_text())
r_obs = next((r for r in monitor["runs"] if r["run_id"] == RUN_ID), None)
check(r_obs is not None, "P1 monitor 含 smoke run")
if r_obs:
    check(r_obs["training"]["active"] is True, "P1 training.active=true")
    check(r_obs.get("trainlog_tail") is not None, "P1 trainlog_tail 投影在")
    check(r_obs.get("progress") is not None, "P1 progress 投影在")

# ── Phase 2：真实浏览器渲染验证（playwright 非 mock remoteFace）
TOKEN = re.search(r"token=(\S+)", subprocess.run(
    ["grep", "dsh web: http", "/tmp/dsh-web-k28.log"],
    capture_output=True, text=True).stdout).group(1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1560, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/?token=" + TOKEN, wait_until="load", timeout=30000)
    time.sleep(6)
    page.locator("text=批D大库第四轮全量重训启动").first.click()
    time.sleep(8)
    shot(page, "01-session-entered.png")

    # 断点 A：快照端点从浏览器可达
    snap_status = page.evaluate("fetch('/atf-ui/snapshot',{cache:'no-store'}).then(r=>r.status)")
    check(snap_status == 200, "断点 A：snapshot 端点浏览器可达 (%s)" % snap_status)
    snap_runs = page.evaluate("fetch('/atf-ui/snapshot',{cache:'no-store'}).then(r=>r.json()).then(d=>d.monitor.runs.length)")
    check(snap_runs > 0, "断点 A：snapshot %d runs（数据实达）" % snap_runs)

    # 页内 trainlog_tail + progress 验证
    tail_check = page.evaluate("""
        fetch('/atf-ui/snapshot',{cache:'no-store'}).then(r=>r.json()).then(d=>{
            const r = d.monitor.runs.find(r=>r.run_id==='%s')
            return r ? JSON.stringify({tail: !!r.trainlog_tail, lines: r.trainlog_tail?.lines?.length ?? 0, pct: r.progress?.percentage, eta: r.progress?.eta_s, active: r.training?.active}) : 'run-not-found'
        })""" % RUN_ID)
    print("[smoke] in-page trainlog_tail:", tail_check)
    tail_data = json.loads(tail_check) if tail_check and tail_check != "run-not-found" else {}
    check(tail_data.get("tail") is True, "P2 in-page trainlog_tail 投影在")
    check(tail_data.get("pct") is not None, "P2 in-page progress.percentage 在")

    # 八段卡渲染（GPU chip 点击展开）
    chip = page.locator(".atf-gpu-card")
    check(chip.count() > 0, "P2 GpuCard 渲染（dock 行）")
    chip_text = chip.inner_text() if chip.count() > 0 else ""
    print("[smoke] chip:", chip_text[:60])
    chip.click()
    time.sleep(3)
    card = page.locator(".atf-task-card")
    card_visible = card.count() > 0 and card.is_visible()
    check(card_visible, "P2 八段卡展开渲染")
    if card_visible:
        card_text = card.inner_text()
        check("训练执行" in card_text, "P2 八段卡含训练执行段")
        shot(page, "02-training-card-expanded.png")
        # 断点 C：日志尾部折叠区（浮卡展开态内）
        tail_s = page.locator(".atf-trainlog-tail summary")
        check(tail_s.count() > 0, "C1 日志尾部折叠区渲染（训练中 trainlog_tail 在）")
        if tail_s.count() > 0:
            tail_s.first.click()
            time.sleep(1)
            pre = page.locator(".atf-trainlog-tail pre")
            check(pre.count() > 0 and len(pre.inner_text().strip()) > 0,
                  "C2 日志尾部展开有等宽内容")
            shot(page, "03-trainlog-tail-expanded.png")

    # 胶囊收起态（训练中进度可见）
    page.screenshot(path=str(SHOTS / "04-dock-training.png"))

    print("[smoke] pageerror %d 条：%s" % (len(errors), str(errors[:2])))
    browser.close()

print("[smoke] 截图：%s" % SHOTS)
print("[smoke] run 留证：%s" % RUN_DIR)
if not failures:
    print("[smoke] ALL PASS")
else:
    print("[smoke] FAILURES: %s" % failures)
sys.exit(0 if not failures else 1)
