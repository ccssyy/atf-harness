#!/usr/bin/env python3
# 批㊶-S4b-T4b——GPU 排队补挂编排主路径·dev 真环境六步冒烟 v3（非注入路径）。
# T4b（owner「1甲」）：BRIDGE_TOOL_NAMES 六件→七件（atf_launch_execute 对 DSH 面开放）——
# 工具步经 WebUI 面真实可达（前批 UNKNOWN_TOOL 阻断面随补投影消除）。
# 模型面替身（如实登记）：ScriptedPiAiEndpoint 序列脚本会被会话标题旁路请求吃项（T4 实证），
# 故改按内容路由端点（tests/dshTools/s4b_router_driver.mjs·真 HTTP 回环·openai-completions
# wire）——只替代「发起工具调用」一步；工具链零注入（真审批面/真排队轮询/真通报/真 handler）。
# 六步：①占卡（真 CUDA 进程 GPU7·compute-apps 可见）②触发（工具审批卡 Allow once）
# ③排队通报（需 8·空闲 7<8 → gpu_queue warn）④释放 ⑤命中琥珀卡（8≥8＋7s 复探）
# ⑥琥珀放行→launch.sh 执行→queued_hit。
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = "/data/sam/ATF-Harness"
# agent 消息不带 run_id → localHostFor 解析 runId="default"（平铺 runs/default）——
# launch.sh 桩与 alerts 落点据此铺设（T4b 实证：handler 实际解析路径）。
RUN_DIR = "/data/atf/dev/runs/default"
LOG = "/tmp/dsh-web-k28.log"
OCCPID = int(Path("/tmp/s4b-occpid").read_text().strip()) if Path("/tmp/s4b-occpid").exists() else 47118
BASE = "http://127.0.0.1:3080"
SHOT = os.path.join(REPO, "docs", "_owner", "screenshots", "批㊶-S4b")

failures = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label, flush=True)
    if not cond:
        failures.append(label)


def shot(page, name):
    page.screenshot(path=str(Path(SHOT) / name))
    print("[shot] " + name, flush=True)


token = re.search(r"token=([A-Za-z0-9_-]+)", Path(LOG).read_text()).group(1)
alerts_path = Path(RUN_DIR, "webui", "alerts.json")


def alerts():
    try:
        return json.loads(alerts_path.read_text())
    except Exception:
        return []


def click_allow_once(page_x, timeout_s=60):
    for _ in range(timeout_s * 2):
        for label in ("Allow once", "允许一次", "Allow Once"):
            btns = page_x.locator("button:has-text('" + label + "')")
            if btns.count() > 0:
                try:
                    btns.last.click()
                    return True
                except Exception:
                    pass
        time.sleep(0.5)
    return False


ep = subprocess.Popen(["node", "/data/sam/ATF-Harness/tests/dshTools/s4b_router_driver.mjs"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
port = None
for _ in range(20):
    line = ep.stdout.readline().strip() if ep.poll() is None else ""
    if line.startswith("PORT="):
        port = line.split("=")[1]
        break
    time.sleep(0.5)
check(port is not None, "P0 脚本化端点启动（真 HTTP 回环）")
print("[endpoint] port=" + str(port), flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1560, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(8)

    page.locator("button:has-text('Settings')").first.click()
    time.sleep(3)
    nav_ok = False
    for _ in range(10):
        for label in ("Models", "模型"):
            if page.get_by_text(label, exact=True).count() > 0:
                page.get_by_text(label, exact=True).first.click()
                nav_ok = True
                break
        if nav_ok:
            break
        time.sleep(1)
    check(nav_ok, "PB1 设置页 Models 导航")
    time.sleep(2)
    add_btn = page.locator("button:has-text('Add model provider'), button:has-text('添加模型提供商')").first
    skip_provision = os.environ.get("S4B_SKIP_PROVISION") == "1"
    if skip_provision:
        # provisioning 外置（router 固定端口＋部署件 baseURL 对齐＋实例重启）——UI 面零操作
        print("[provider] S4B_SKIP_PROVISION=1——跳过 Phase B（provider 由部署件承载）", flush=True)
        check(page.get_by_text("S4B Local", exact=False).count() > 0, "PB-skip S4B Local 行在场（部署件投影）")
    else:
        already = page.get_by_text("S4B Local", exact=False).count() > 0
        add_btn = page.locator("button:has-text('Add model provider'), button:has-text('添加模型提供商')").first
        add_found = False
        for _ in range(10):
            if add_btn.count() > 0:
                add_found = True
                break
            time.sleep(1)
        check(add_found, "PB2 添加提供商入口在场")
        if already:
            print("[provider] S4B Local 已在场——Edit 卡更新 baseURL 至本轮端点", flush=True)
            edit_btn = page.locator("button[aria-label*='S4B Local'], button[aria-label*='s4blocal']").first
            edit_btn.click()
            time.sleep(2)
            bu = page.locator("input[aria-label='Base URL']:visible, input[aria-label='API 地址']:visible").first
            bu.fill("http://127.0.0.1:" + str(port))
            time.sleep(0.5)
            page.locator("button:has-text('Save'):visible, button:has-text('保存'):visible").last.click()
            time.sleep(3)
        else:
            add_btn.click()
            time.sleep(2)
            custom_btn = page.locator("button:has-text('Custom model API'), button:has-text('自定义模型 API')").first
            if custom_btn.count() > 0:
                custom_btn.click()
                time.sleep(2)
            page.locator("input[aria-label='Provider ID']:visible, input[aria-label='提供方 ID']:visible").first.fill("s4blocal")
            time.sleep(0.5)
            page.locator("input[aria-label='Display name']:visible, input[aria-label='显示名称']:visible").first.fill("S4B Local")
            time.sleep(0.5)
            api_sel = page.locator("select[aria-label*='API']:visible, select[aria-label*='协议']:visible").first
            if api_sel.count() > 0:
                api_sel.select_option("openai-completions")
                print("[provider] api=openai-completions", flush=True)
            page.locator("input[aria-label='Base URL']:visible, input[aria-label='API 地址']:visible").first.fill("http://127.0.0.1:" + str(port))
            time.sleep(0.5)
            add_model_btn = page.locator("button:has-text('Add model'):visible, button:has-text('添加模型'):visible").first
            try:
                handle = add_model_btn.element_handle(timeout=8000)
                if handle is None:
                    raise RuntimeError("Add model 钮缺席")
                page.evaluate("el => el.scrollIntoView({ block: 'center' })", handle)
                time.sleep(0.5)
                add_model_btn.click(force=True, timeout=5000)
                time.sleep(1)
            except Exception as cause:
                print("[provider] Add model 点击异常（" + str(cause)[:80] + "）——试缺省模型行", flush=True)
            model_input = page.locator("input[aria-label='Model ID 1']:visible, input[aria-label='模型 ID 1']:visible, input[aria-label='Model ID']:visible").first
            handle2 = model_input.element_handle(timeout=8000)
            if handle2 is None:
                raise RuntimeError("Model ID 输入行缺席（Add model 未生效）")
            page.evaluate("el => el.scrollIntoView({ block: 'center' })", handle2)
            model_input.fill("s4b-smoke")
            time.sleep(0.5)
            key_input = page.locator("input[aria-label='API key']:visible, input[aria-label='API 密钥']:visible").first
            if key_input.count() > 0:
                key_input.fill("sk-s4b-scripted-fake")
                print("[provider] key 已填（fake）", flush=True)
            time.sleep(0.5)
            page.locator("button:has-text('Create provider'), button:has-text('创建提供方'), button:has-text('Save'), button:has-text('保存')").last.click()
            time.sleep(4)
            body_text = page.locator("body").inner_text()
            check("S4B Local" in body_text or "s4blocal" in body_text, "PB3 provider 保存（S4B Local 行在场）")
    shot(page, "00-s4b-provider-added.png")
    page.keyboard.press("Escape")
    time.sleep(2)
    back = page.locator("button:has-text('←'), [aria-label*='back']").first
    if back.count() > 0:
        back.click()
        time.sleep(2)

    seat = page.locator("button[title*='GLM']").first
    if seat.count() == 0:
        seat = page.locator("button[class*='trigger'][aria-haspopup='menu']").first
    seat.click()
    time.sleep(1.5)
    model_cell = page.locator("[role='menuitem']", has_text="模型").first
    if model_cell.count() == 0:
        model_cell = page.locator("[role='menuitem']", has_text="Model").first
    model_cell.click()
    time.sleep(1.5)
    model_row = page.locator("[role='menuitemradio'][title='s4b-smoke']").first
    row_found = False
    for _ in range(10):
        if model_row.count() > 0:
            row_found = True
            break
        time.sleep(1)
    check(row_found, "PC1 模型目录含 s4b-smoke（目录刷新生效）")
    if row_found:
        model_row.click()
        time.sleep(3)
    shot(page, "00b-s4b-model-switched.png")

    new_btn = page.locator("button[aria-label='新建会话'], button[aria-label='New session']").first
    if new_btn.count() > 0:
        new_btn.click()
    time.sleep(4)
    box = page.locator("[role='textbox']").first
    check(box.count() > 0 and box.get_attribute("data-phase") != "inert", "SD0 composer 就绪")
    box.click()
    box.fill("开始执行。")
    time.sleep(1)
    page.keyboard.press("Enter")
    print("[smoke] 指令已发——等待工具审批卡…", flush=True)

    ok_first = click_allow_once(page, timeout_s=90)
    check(ok_first, "SD2 atf_launch_execute 工具审批卡放行（Allow once）")
    time.sleep(5)
    shot(page, "01-s4b-tool-approved-queue-start.png")

    queue_seen = False
    for _ in range(40):
        hit = [a for a in alerts() if a.get("kind") == "gpu_queue"]
        if any("空闲不足" in str(a.get("reason", "")) or "现空闲 7" in str(a.get("reason", "")) for a in hit):
            queue_seen = True
            break
        time.sleep(3)
    check(queue_seen, "SD3 排队通报在场（需 8·空闲 7<8 → warn；gpu_queue=" + str(len([a for a in alerts() if a.get('kind') == 'gpu_queue'])) + " 条）")
    shot(page, "02-s4b-queue-waiting.png")

    subprocess.run(["kill", str(OCCPID)], capture_output=True)
    time.sleep(2)
    gone = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True, text=True).stdout
    check(str(OCCPID) not in gone, "SD4 占卡进程已释放")

    amber_seen = False
    for _ in range(45):
        body = page.locator("body").inner_text()
        if "GPU 窗口命中" in body:
            amber_seen = True
            break
        time.sleep(2)
    check(amber_seen, "SD5 命中琥珀确认卡在场（GPU 窗口命中）")
    shot(page, "03-s4b-amber-card.png")

    ok_amber = click_allow_once(page, timeout_s=30)
    check(ok_amber, "SD6a 琥珀卡放行（Allow once）")
    queued_hit = False
    for _ in range(60):
        body = page.locator("body").inner_text()
        if "queued_hit" in body:
            queued_hit = True
            break
        time.sleep(2)
    check(queued_hit, "SD6b 工具结果 queued_hit 在场")
    state_ok = Path(RUN_DIR, "scratch", "out", "launch", "state.json").exists()
    check(state_ok, "SD6c launch.sh 已执行（state.json 落盘）")
    final_alerts = [a for a in alerts() if a.get("kind") == "gpu_queue"]
    info_hit = [a for a in final_alerts if a.get("level") == "info"]
    check(len(info_hit) >= 1, "SD6d 命中侧 gpu_queue info 通报在场（info " + str(len(info_hit)) + "/共 " + str(len(final_alerts)) + "）")
    shot(page, "04-s4b-launched-result.png")

    print("[phase] pageerror " + str(len(errors)) + " 条：" + str(errors[:2]), flush=True)
    check(len(errors) == 0, "零 pageerror")
    browser.close()

ep.terminate()
print("[smoke] run dir: " + RUN_DIR, flush=True)
print("[smoke] alerts：" + json.dumps(alerts(), ensure_ascii=False)[:700], flush=True)
if not failures:
    print("[smoke] ALL PASS", flush=True)
else:
    print("[smoke] FAILURES: " + str(failures), flush=True)
sys.exit(0 if not failures else 1)
