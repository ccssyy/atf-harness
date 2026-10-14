#!/usr/bin/env python3
# 批㊶-TRAIN-OBS-FIX 真实浏览器冒烟（非注入路径）——断点 A/B/C 修复验证。
# playwright headless Chrome 驱动 dev 实例（真实 DSH 壳＋atf-ui 插件＋cookie 鉴权流）。
import json, re, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

SHOTS = Path("/tmp/trainobs-fix-shots")
SHOTS.mkdir(exist_ok=True)
BASE = "http://127.0.0.1:3080"
TOKEN = re.search(r"token=(\S+)", subprocess.run(
    ["grep", "dsh web: http", "/tmp/dsh-web-k28.log"],
    capture_output=True, text=True).stdout).group(1)

failures = []

def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1560, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE + "/?token=" + TOKEN, wait_until="load", timeout=30000)
    time.sleep(6)
    page.locator("text=批D大库第四轮全量重训启动").first.click()
    time.sleep(6)
    page.screenshot(path=str(SHOTS / "01-session-entered.png"))

    # 断点 A 主验证：GpuCard 渲染且文本非空（mon 非 null = 读取链通）
    chip = page.locator(".atf-gpu-card")
    check(chip.count() > 0, "A1 GpuCard 元素在 DOM（mon 非 null 读取链通）")
    chip_text = chip.inner_text() if chip.count() > 0 else ""
    check(len(chip_text.strip()) > 0, "A2 GpuCard 文本非空 (%s)" % chip_text.strip()[:40])
    print("[smoke] GpuCard:", chip_text.strip()[:60])

    # 展开八段卡
    chip.click()
    time.sleep(2)
    card = page.locator(".atf-task-card")
    check(card.count() > 0 and card.is_visible(), "A3 八段卡展开渲染")
    card_text = card.inner_text() if card.count() > 0 else ""
    check("登记" in card_text or "训练执行" in card_text or "段" in card_text,
          "A4 八段卡含段数据（非空壳）")
    page.screenshot(path=str(SHOTS / "02-task-card-expanded.png"))
    close_btn = page.locator(".atf-task-card button", has_text="⤢").first
    if close_btn.count() > 0:
        close_btn.click()
        time.sleep(1)

    # 起真实短训 r15
    RUN_ID = "train-obs-smoke-r15"
    RUN_DIR = "/data/atf/dev/runs/" + RUN_ID
    print("[smoke] 起短训 %s（400 步）…" % RUN_ID)
    subprocess.run(["rm", "-rf", RUN_DIR], check=False)
    Path(RUN_DIR + "/training").mkdir(parents=True, exist_ok=True)
    Path(RUN_DIR + "/webui").mkdir(parents=True, exist_ok=True)
    session = "dev-atf-training-run-" + RUN_ID
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
    print("[smoke] 等 loss-series→active→观测链→progress→SSE→卡面（~90s）…")
    time.sleep(90)
    time.sleep(10)

    # 服务端数据面断言
    monitor = json.loads(Path("/data/atf/dev/runs/atf-ui/monitor.json").read_text())
    r15 = next((r for r in monitor["runs"] if r["run_id"] == RUN_ID), None)
    prog = (r15 or {}).get("progress") or {}
    check(bool(prog.get("percentage")),
          "T1 progress.percentage (%s%%)" % prog.get("percentage"))
    check(bool(prog.get("eta_s")),
          "T1 progress.eta_s (%ss)" % prog.get("eta_s"))
    check((r15 or {}).get("training", {}).get("active") is True,
          "T1 training.active=true（观测环驱动）")
    tail = (r15 or {}).get("trainlog_tail")
    check(tail is not None and len(tail.get("lines", [])) > 0,
          "T3 trainlog_tail 投影（%d 行）" % (len(tail.get("lines", [])) if tail else 0))

    # 浏览器面：训练中刷新→全链验证
    page.reload(wait_until="load", timeout=30000)
    time.sleep(10)
    chip2 = page.locator(".atf-gpu-card")
    chip2_text = chip2.inner_text() if chip2.count() > 0 else ""
    print("[smoke] 训练中 GpuCard:", chip2_text.strip()[:60])
    check("无训练进行中" not in chip2_text,
          "A5 训练中 GpuCard 非「无训练进行中」（数据到达卡面）")
    page.screenshot(path=str(SHOTS / "03-training-gpu-card.png"))

    chip2.click()
    time.sleep(2)
    card2 = page.locator(".atf-task-card")
    check(card2.count() > 0 and card2.is_visible(), "A6 训练中八段卡展开")
    card2_text = card2.inner_text() if card2.count() > 0 else ""
    check("训练执行" in card2_text, "A7 八段卡含训练执行段")
    page.screenshot(path=str(SHOTS / "04-training-segments.png"))

    # 断点 C：日志尾部折叠区（浮卡展开态内）
    tail_s = page.locator(".atf-trainlog-tail summary")
    if tail_s.count() > 0:
        tail_s.first.click()
        time.sleep(1)
        pre = page.locator(".atf-trainlog-tail pre")
        check(pre.count() > 0 and len(pre.inner_text().strip()) > 0,
              "C1 日志尾部展开有内容")
        page.screenshot(path=str(SHOTS / "05-trainlog-tail.png"))
    else:
        check(tail_s.count() > 0, "C1 日志尾部折叠区未渲染")

    print("[smoke] pageerror %d 条" % len(errors))
    browser.close()

print("[smoke] 截图：%s" % SHOTS)
if not failures:
    print("[smoke] ALL PASS")
else:
    print("[smoke] FAILURES: %s" % failures)
sys.exit(0 if not failures else 1)
