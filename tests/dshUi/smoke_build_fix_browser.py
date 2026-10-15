#!/usr/bin/env python3
# 批甲-FIX T4 冒烟——思考档位按模型能力修正（真实浏览器·GLM 真会话·禁 mock）。
#
# 指令件：ATF_指令_批甲-FIX_思考档位按模型能力修正_20261015.md（sha256 前缀 37d57012）。
# 链路：净环境实例（四轴隔离：--port／ATF_DSH_RUNS_ROOT／DSH_HOME＋HOME——沿批甲-BUILD 配方）
# → 真实浏览器（cookie 鉴权流）：
#   A 取值链③＋ensure 固化：首会话无显式档位 → 链③目录顺位最低档 Off(关) 常显（glm-5.3）
#     ——「默认」态不存在（T2.2）
#   B T2.1 设置页 per-model 默认档：Models 设置页 glm-atf 卡「默认思考等级（per-model）」
#     座位（provider-card keyed 槽）→ GLM-5.3-Flash 选 Max(最高) → 保存＋GET effort_defaults 实证
#   C T2.3 模型切换回退：glm-5.3(Off) → 切 GLM-5.3-Flash（off 越界被 host 拒）→ 闭集顺位最近档
#     Low(低) 落地如实呈现 ＋ flash 三值菜单（Low/High/Max——无 Off，T1 per-model 闭集）
#   D 跨会话 sticky（宿主 agentDefaultModel.saveSelection 既有语义）：新会话延用 flash＋Max(最高)
#   E GLM 真会话一拍（flash·max 档真实回复到达——wire 生效）
# 红线遵守：vendor 零触碰；内核仓零改动；不碰 dev/uat 运行态实例与 runs 数据（全部落
# tmp/fix1-smoke 隔离根＋fix1- tmux 命名域）；key 走仓根 glm-key.env 隔离根（gitignored 0600）。
#
# 用法：python3 tests/dshUi/smoke_build_fix_browser.py
# 产出：截图（SCREENSHOT_DIR）＋ALL PASS／FAILURES 摘要；退出码 0＝全绿。
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# ── 常量（隔离轴） ────────────────────────────────────────────────────────────
REPO = "/data/sam/ATF-Harness"
SMOKE = os.path.join(REPO, "tmp", "fix1-smoke")
RUNS = os.path.join(SMOKE, "runs")
HOME_AXIS = os.path.join(SMOKE, "home")  # HOME 轴（内核 ~/.atf/config.json 随轴隔离）
DSH_HOME = os.path.join(SMOKE, "dsh-home")
LOG = "/tmp/fix1-smoke-web.log"
WEB_TMUX = "fix1-smoke-web"
PORT = 3483
PREFIX = "fix1-"  # ATF_TMUX_SESSION_PREFIX（命名域）
KEY_ENV = os.path.join(REPO, "glm-key.env")  # T3 隔离 key 根（gitignored 0600）
PIN = "/data/atf/dev/pinned"  # 实例 pin 根（只读消费——与 dev 实例同源）
VENDOR = os.path.join(REPO, "vendor", "dsh", "deepseek-harness")
BASE = f"http://127.0.0.1:{PORT}"
SCREENSHOT_DIR = os.path.join(REPO, "docs", "_owner", "screenshots", "批甲-FIX")

failures = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label, flush=True)
    if not cond:
        failures.append(label)


def shot(page, name):
    page.screenshot(path=str(Path(SCREENSHOT_DIR) / name))
    print("[shot] " + name, flush=True)


# ── Phase 0：净环境实例（幂等——先收本冒烟域旧会话） ─────────────────────────────
print("[phase0] 净环境实例启动（四轴隔离）…", flush=True)
subprocess.run(["tmux", "kill-session", "-t", WEB_TMUX], capture_output=True)
out = subprocess.run(["tmux", "ls"], capture_output=True, text=True).stdout
for line in out.splitlines():
    name = line.split(":")[0]
    if name.startswith(PREFIX):
        subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
shutil.rmtree(DSH_HOME, ignore_errors=True)  # 整 DSH_HOME 清（settings 文档/选择持久化不跨 run）
for sub in ("runs", "sessions", "logs", "home/.atf", "dsh-home/profiles/web", "home/fix1-ws", "exec-home"):
    shutil.rmtree(os.path.join(SMOKE, sub), ignore_errors=True)
for sub in ("runs", "exec-home", "sessions", "logs", "home/.atf", "dsh-home/profiles/web", "home/fix1-ws"):
    os.makedirs(os.path.join(SMOKE, sub), exist_ok=True)
json.dump({"workspace_root": SMOKE}, open(os.path.join(HOME_AXIS, ".atf", "config.json"), "w"))
glm_key = ""
for line in Path(KEY_ENV).read_text().splitlines():
    m = re.match(r"ATF_LLM_KEY_GLM=(.*)\s*$", line.strip())
    if m:
        glm_key = m.group(1).strip("\"'")
cred_doc = "version: 1\nrefs:\n  ATF_LLM_KEY_GLM: %s\n" % json.dumps(glm_key)
cred_path = os.path.join(DSH_HOME, ".credentials.yaml")
open(cred_path, "w").write(cred_doc)
os.chmod(cred_path, 0o600)
print("[phase0] 托管凭据已预置（.credentials.yaml refs.ATF_LLM_KEY_GLM；boot env 零 key 注入）", flush=True)
for f in ("cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"):
    shutil.copy(os.path.join(REPO, "poc/dsh-home/profiles/web", f), os.path.join(DSH_HOME, "profiles/web", f))

boot_env = {
    "HOME": HOME_AXIS,
    "TERM": "xterm",
    "LANG": "C.UTF-8",
    "TZ": "Asia/Shanghai",
    "PATH": os.environ["PATH"],
    "LD_LIBRARY_PATH": os.environ.get("LD_LIBRARY_PATH", ""),
    "COREPACK_HOME": "/root/.cache/node/corepack",
    # boot env 零 LLM key 注入（env 在场即凭据只读锁）——key 走托管存储 .credentials.yaml
    "ATF_INSTANCE_PIN_ROOT": PIN,
    "ATF_V1_FILE_TOOL_ROOTS": f"{PIN}:/data/LLM_model",
    "ATF_DSH_PIPELINE_COMMAND": f"python3 {PIN}/tools/walkthrough_pipeline.py",
    "ATF_DSH_BRIDGE_COMMAND": f"PYTHONPATH={PIN}/src python3 -m agentic_training_flow serve",
    "ATF_DSH_RUNS_ROOT": RUNS,
    "ATF_DSH_EXEC_HOME": os.path.join(SMOKE, "exec-home"),
    "ATF_WEBUI_SESSIONS_ROOT": os.path.join(SMOKE, "sessions"),
    "ATF_TMUX_SESSION_PREFIX": PREFIX,
    "ATF_MODEL_ROOT": "/data/LLM_model",
    "ATF_LLM_CONFIG": "/root/.atf-harness/llm-piai-walkthrough-glm.json",
    "ATF_DSH_LOG_DIR": os.path.join(SMOKE, "logs"),
    "ATF_GPU_POLL_MS": "0",
    "DSH_HOME": DSH_HOME,
}
boot_cmd = "cd '%s' && exec corepack pnpm dsh web --no-open --port %d > '%s' 2>&1" % (VENDOR, PORT, LOG)
if Path(LOG).exists():
    Path(LOG).unlink()
subprocess.run(["tmux", "new-session", "-d", "-s", WEB_TMUX,
                "env -i " + " ".join(f"{k}={json.dumps(v)}" for k, v in boot_env.items() if v is not None) + " bash -c " + json.dumps(boot_cmd)],
               capture_output=True)

token = None
for _ in range(90):
    time.sleep(2)
    try:
        text = Path(LOG).read_text()
        if "atf-tools] apply()" not in text:
            continue
        token = re.search(r"token=(\S+)", text).group(1)
        break
    except Exception:
        continue
check(token is not None, "P0 冒烟实例 boot（token 提取）")
log_text = Path(LOG).read_text()
check("桥对端: real" in log_text, "P0 桥对端 real（真内核桥）")

# ── Phase 2：真实浏览器 ───────────────────────────────────────────────────────
print("[phase2] 浏览器驱动…", flush=True)
os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def open_workspace(page):
    """净环境首启 workspace 选择；已持久化则跳过。返回 composer 非 inert 布尔。"""
    for _ in range(15):
        if page.locator("button:has-text('Choose workspace')").count() == 0:
            break
        try:
            page.locator("button:has-text('Choose workspace')").first.click()
            time.sleep(2)
            page.get_by_text("fix1-ws", exact=True).first.click()
            time.sleep(1)
            page.locator("button:has-text('Open')").last.click()
            time.sleep(3)
        except Exception as e:
            print("[workspace] choose 异常: " + str(e)[:200], flush=True)
            time.sleep(2)
    box = page.locator("[role='textbox']").first
    return box.count() > 0 and box.get_attribute("data-phase") != "inert"


def trigger_label(page_x):
    loc = page_x.locator(".atf-effort-trigger .atf-effort-v")
    return loc.first.inner_text() if loc.count() > 0 else None


def wait_trigger_label(page_x, want, tries=24):
    for _ in range(tries):
        label = trigger_label(page_x)
        if label == want:
            return True
        time.sleep(1.5)
    return False


def native_seat_title(page_x):
    """原生模型座位 caption（title＝{model} · {effort}）。"""
    cand = page_x.locator("button[title*='·']")
    for i in range(cand.count()):
        t = cand.nth(i).get_attribute("title") or ""
        if "GLM" in t:
            return t
    return None


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1560, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(6)
    check(open_workspace(page), "P2 composer 就绪（workspace fix1-ws）")

    # A 取值链③＋ensure 固化：glm-5.3 无显式档位 → Off(关)（链③声明序首位；「默认」态不存在）
    off_landed = wait_trigger_label(page, "Off(关)")
    check(off_landed, f"P2-A 取值链③＋ensure 固化：glm-5.3 首会话链值 Off(关)（实际={trigger_label(page)}）")
    body_text = page.locator("body").inner_text()
    check("默认" not in (trigger_label(page) or ""), "P2-A2 去「默认」态：触发钮无「默认」标签")
    shot(page, "01-fix-chain-off-default.png")

    # B T2.1 设置页 per-model 默认档：Models 设置页 glm-atf 卡座位 → flash 选 Max(最高)
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
    check(nav_ok, "P2-B1 设置页「模型/Models」section 导航在场")
    time.sleep(2)
    block_ok = False
    for _ in range(12):
        if page.get_by_text("默认思考等级（per-model）").count() > 0:
            block_ok = True
            break
        time.sleep(1.5)
    check(block_ok, "P2-B2 provider-card 座位「默认思考等级（per-model）」在 glm-atf 卡渲染")
    # flash 行下拉 → Max(最高)（选项＝该模型目录闭集 low/high/max——无 Off 项）
    flash_row = page.locator(".atf-ed-row", has_text="GLM-5.3-Flash").first
    row_options = flash_row.locator("option").all_inner_texts() if flash_row.count() > 0 else []
    check([o.strip() for o in row_options if o.strip() and "未设置" not in o] == ["Low(低)", "High(高)", "Max(最高)"],
          f"P2-B3 flash 行选项＝目录闭集三值（options={row_options}）")
    flash_row.locator("select").select_option("max")
    saved_ok = False
    for _ in range(12):
        if page.get_by_text("已保存：glm-5.3-flash 默认档＝Max(最高)").count() > 0:
            saved_ok = True
            break
        time.sleep(1)
    check(saved_ok, "P2-B4 保存回执在场（已保存：glm-5.3-flash 默认档＝Max(最高)）")
    ed_map = page.evaluate("() => fetch('/atf-ui/settings', {credentials:'same-origin'}).then(r => r.json()).then(d => d.effort_defaults)")
    check(ed_map is not None and ed_map.get("glm-5.3-flash") == "max", f"P2-B5 GET effort_defaults 实证（{ed_map}）")
    shot(page, "02-fix-settings-flash-default-max.png")
    page.keyboard.press("Escape")
    time.sleep(2)

    # C T2.3 模型切换越界档回退：先经 EffortSelect 显式选 Off(关)（链①落定）→ /model 命令面板
    # 切 GLM-5.3-Flash（该路径同路由保 effort——off 对 flash 越界被 host 拒）→ 闭集顺位最近档
    # Low(低) 补选落地（如实呈现，不静默跳 max）
    page.locator(".atf-effort-trigger").first.click()
    time.sleep(1)
    page.locator(".atf-effort-menu .atf-effort-row", has_text="Off(关)").first.click()
    off_explicit = wait_trigger_label(page, "Off(关)")
    check(off_explicit, "P2-C0 glm-5.3 显式选 Off(关)（链①手动切换值落定）")
    box = page.locator("[role='textbox']").first
    box.click()
    box.fill("/model")
    time.sleep(1)
    page.keyboard.press("Enter")
    flash_opt = None
    for _ in range(15):
        cand = page.locator("[role='option']", has_text="GLM-5.3-Flash")
        if cand.count() > 0:
            flash_opt = cand.first
            break
        time.sleep(1)
    check(flash_opt is not None, "P2-C0b /model 命令面板弹出且 GLM-5.3-Flash 行在场")
    if flash_opt is not None:
        flash_opt.click()
    fallback_ok = wait_trigger_label(page, "Low(低)")
    check(fallback_ok, f"P2-C1 模型切换越界档回退：glm-5.3(Off)→flash 落顺位最近档 Low(低)（实际={trigger_label(page)}）")
    seat_title = native_seat_title(page)
    check(seat_title is not None and "GLM-5.3-Flash" in seat_title, f"P2-C2 原生座位模型已切 flash（title={seat_title}）")
    # flash 三值菜单（无 Off——T1 per-model 闭集）
    page.locator(".atf-effort-trigger").first.click()
    menu_ok = False
    labels = []
    for _ in range(15):
        if page.locator(".atf-effort-menu").count() > 0:
            rows = page.locator(".atf-effort-menu .atf-effort-row")
            labels = [rows.nth(i).inner_text().replace("✓", "").strip() for i in range(rows.count())] if rows.count() > 0 else []
            if labels == ["Low(低)", "High(高)", "Max(最高)"]:
                menu_ok = True
                break
        time.sleep(1)
    check(menu_ok, f"P2-C3 flash 三值菜单无 Off（labels={labels}）")
    shot(page, "03-fix-flash-three-values-fallback-low.png")
    # 手动切 Max(最高)（顺带把 flash+max 写入 sticky 全局默认——为 D 作垫）
    page.locator(".atf-effort-menu .atf-effort-row", has_text="Max(最高)").first.click()
    max_ok = wait_trigger_label(page, "Max(最高)")
    check(max_ok, "P2-C4 flash 手动切 Max(最高)（链①手动切换值）")

    # D 跨会话 sticky：新会话延用 flash＋Max(最高)（宿主 agentDefaultModel.saveSelection）
    new_btn = page.locator("button[aria-label='新建会话'], button[aria-label='New session']").first
    check(new_btn.count() > 0 or page.get_by_text("新会话", exact=True).count() > 0 or page.get_by_text("New Session", exact=True).count() > 0,
          "P2-D1 「新会话」入口在场")
    if new_btn.count() > 0:
        new_btn.click()
    else:
        page.get_by_text("新会话", exact=True).first.click() if page.get_by_text("新会话", exact=True).count() > 0 else page.get_by_text("New Session", exact=True).first.click()
    time.sleep(5)
    sticky_ok = wait_trigger_label(page, "Max(最高)")
    seat_title2 = native_seat_title(page)
    check(sticky_ok, f"P2-D2 新会话 sticky 延用：flash＋Max(最高)（触发钮={trigger_label(page)}，座位={seat_title2}）")
    check(seat_title2 is not None and "GLM-5.3-Flash" in seat_title2 and "Max" in seat_title2,
          f"P2-D3 新会话原生座位＝GLM-5.3-Flash · Max（title={seat_title2}）")
    shot(page, "04-fix-new-session-sticky-max.png")

    # E GLM 真会话一拍（flash·max 档真实回复到达——wire 生效）
    box = page.locator("[role='textbox']").first
    question = "17乘24等于多少？只回答数字结果，不要解释。"
    box.click()
    box.fill(question)
    time.sleep(1)
    page.keyboard.press("Enter")
    t0 = time.time()
    replied = False
    for _ in range(120):
        if page.get_by_text("408", exact=False).count() > 0:
            replied = True
            break
        time.sleep(1)
    check(replied, f"P2-E GLM 真会话 flash·max 一拍回复到达（{time.time()-t0:.1f}s）" if replied else "P2-E GLM 真会话回复未达")
    shot(page, "05-fix-real-turn-flash-max.png")

    print("[phase2] pageerror %d 条：%s" % (len(errors), str(errors[:2])), flush=True)
    check(len(errors) == 0, "P2 零 pageerror")
    browser.close()

# ── Phase 5：收尾 ────────────────────────────────────────────────────────────
subprocess.run(["tmux", "kill-session", "-t", WEB_TMUX], capture_output=True)
print("[phase5] 冒烟域已收尾；隔离根留证：" + SMOKE, flush=True)
print("[smoke] 截图目录：" + SCREENSHOT_DIR, flush=True)
if not failures:
    print("[smoke] ALL PASS", flush=True)
else:
    print("[smoke] FAILURES: %s" % failures, flush=True)
sys.exit(0 if not failures else 1)
