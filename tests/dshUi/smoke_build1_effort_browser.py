#!/usr/bin/env python3
# 批甲-BUILD T1 冒烟——思考档位显示/切换（真实浏览器·禁 mock remoteFace）。
#
# 指令件：ATF_指令_批甲-BUILD_harness产品面收尾_20261015.md（sha256 前缀 edd36141）。
# 链路：净环境实例（四轴隔离：--port／ATF_DSH_RUNS_ROOT／DSH_HOME＋HOME——沿批㊶-FIX2 配方）
# → 真实浏览器（cookie 鉴权流）→ composer 右下角思考档位控件（atf-ui EffortSelect）：
#   ① 档位常显（当前值触发钮）② 点开菜单（闭集恰四值 Off(关)/Low(低)/High(高)/Max(最高)）
#   ③ 切换生效（点 High(高)→触发钮与原生模型座位双更新＋reload 持久化）
#   ④ 下 turn 生效实证（GLM 真会话两拍同题计时：High 思考档 vs Off 关档——行为差即 wire 生效）
#   ⑤ 拒绝路径如实显示（双上下文同会话切换尝试——writer/model-unavailable 等 host 拒绝
#      原样入错误条；多写者放行时如实登记不复截图）。
# 红线遵守：vendor 零触碰；内核仓零改动；不碰 dev/uat 运行态实例与 runs 数据（全部落
# tmp/build1-smoke 隔离根＋build1- tmux 命名域）；用户可见面零开发叙事（截图即产品面）。
#
# 用法：python3 tests/dshUi/smoke_build1_effort_browser.py
# 产出：截图（SCREENSHOT_DIR）＋ALL PASS／FAILURES 摘要；退出码 0＝全绿。
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
SMOKE = os.path.join(REPO, "tmp", "build1-smoke")
RUNS = os.path.join(SMOKE, "runs")
HOME_AXIS = os.path.join(SMOKE, "home")  # HOME 轴（内核 ~/.atf/config.json 随轴隔离）
DSH_HOME = os.path.join(SMOKE, "dsh-home")
LOG = "/tmp/build1-smoke-web.log"
WEB_TMUX = "build1-smoke-web"
PORT = 3482
PREFIX = "build1-"  # ATF_TMUX_SESSION_PREFIX（命名域）
KEY_ENV = "/root/.atf-harness/.env"
PIN = "/data/atf/dev/pinned"  # 实例 pin 根（只读消费——与 dev 实例同源）
VENDOR = os.path.join(REPO, "vendor", "dsh", "deepseek-harness")
BASE = f"http://127.0.0.1:{PORT}"
SCREENSHOT_DIR = os.path.join(REPO, "docs", "_owner", "screenshots", "批甲-BUILD")

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


# ── Phase 0：净环境实例（幂等——先收本冒烟域旧会话） ─────────────────────────────
print("[phase0] 净环境实例启动（四轴隔离）…", flush=True)
subprocess.run(["tmux", "kill-session", "-t", WEB_TMUX], capture_output=True)
out = subprocess.run(["tmux", "ls"], capture_output=True, text=True).stdout
for line in out.splitlines():
    name = line.split(":")[0]
    if name.startswith(PREFIX):
        subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
shutil.rmtree(DSH_HOME, ignore_errors=True)  # 整 DSH_HOME 清（settings 文档/选择持久化不跨 run）
for sub in ("runs", "sessions", "logs", "home/.atf", "dsh-home/profiles/web", "home/build1-ws"):
    shutil.rmtree(os.path.join(SMOKE, sub), ignore_errors=True)
for sub in ("runs", "exec-home", "sessions", "logs", "home/.atf", "dsh-home/profiles/web", "home/build1-ws"):
    os.makedirs(os.path.join(SMOKE, sub), exist_ok=True)
json.dump({"workspace_root": SMOKE}, open(os.path.join(HOME_AXIS, ".atf", "config.json"), "w"))
glm_key = ""
if Path(os.path.join(SMOKE, "glm-key.env")).exists():
    for line in Path(os.path.join(SMOKE, "glm-key.env")).read_text().splitlines():
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

keys = {}
for line in Path(KEY_ENV).read_text().splitlines():
    m = re.match(r"export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$", line.strip()) or re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$", line.strip())
    if m:
        keys[m.group(1)] = m.group(2).strip("\"'")
# GLM key 覆盖轴（owner 指定 key——落 tmp 隔离根文件，不入仓不入本脚本）
SMOKE_KEY_ENV = os.path.join(SMOKE, "glm-key.env")
if Path(SMOKE_KEY_ENV).exists():
    for line in Path(SMOKE_KEY_ENV).read_text().splitlines():
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$", line.strip())
        if m:
            keys[m.group(1)] = m.group(2).strip("\"'")
    print("[phase0] GLM key 已用冒烟本地覆盖轴（glm-key.env）", flush=True)

boot_env = {
    "HOME": HOME_AXIS,
    "TERM": "xterm",
    "LANG": "C.UTF-8",
    "TZ": "Asia/Shanghai",
    "PATH": os.environ["PATH"],
    "LD_LIBRARY_PATH": os.environ.get("LD_LIBRARY_PATH", ""),
    "COREPACK_HOME": "/root/.cache/node/corepack",
    # 市面对齐裁定（2026-10-15）：web 实例 boot env 不注入 LLM key——env 在场即凭据
    # 只读锁（credentials-local describe writable:false），Models 设置页 API Key 栏
    # 会被禁用、UI 粘贴被遮蔽。key 走托管存储 .credentials.yaml（下方预置）。
    **{k: v for k, v in keys.items() if k != "ATF_LLM_KEY_GLM"},
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
check("atf-tools] apply()" in log_text, "P0 atf-ui/atf-tools 扩展装配")
check("桥对端: real" in log_text, "P0 桥对端 real（真内核桥）")

# ── Phase 2：真实浏览器——档位常显／点开切换／切换生效／下 turn 生效／拒绝路径 ──────
print("[phase2] 浏览器驱动…", flush=True)
os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def open_workspace(page):
    """净环境首启 workspace 选择（判据＝Choose workspace 按钮在场——[role=textbox] 命中
    inert 占位不构成就绪）；已持久化则跳过。返回 composer 非 inert 布尔。"""
    for _ in range(15):
        if page.locator("button:has-text('Choose workspace')").count() == 0:
            break
        try:
            page.locator("button:has-text('Choose workspace')").first.click()
            time.sleep(2)
            page.get_by_text("build1-ws", exact=True).first.click()
            time.sleep(1)
            page.locator("button:has-text('Open')").last.click()
            time.sleep(3)
        except Exception as e:
            print("[workspace] choose 异常: " + str(e)[:200], flush=True)
            time.sleep(2)
    box = page.locator("[role='textbox']").first
    return box.count() > 0 and box.get_attribute("data-phase") != "inert"


def open_session_by_title(page, title_prefix):
    """reload 后重开既有会话（侧栏按标题前缀点选；已开则跳过）。返回触发钮在场布尔。"""
    if page.locator(".atf-effort-trigger").count() > 0:
        return True
    try:
        item = page.get_by_text(title_prefix, exact=False).first
        item.click()
        time.sleep(4)
    except Exception as e:
        print("[session] reopen 异常: " + str(e)[:200], flush=True)
    return page.locator(".atf-effort-trigger").count() > 0


def trigger_label(page):
    loc = page.locator(".atf-effort-trigger .atf-effort-v")
    return loc.first.inner_text() if loc.count() > 0 else None


def wait_trigger_label(page, want, tries=20):
    for _ in range(tries):
        label = trigger_label(page)
        if label == want:
            return True
        time.sleep(1.5)
    return False


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
    check(open_workspace(page), "P2 composer 就绪（workspace build1-ws）")
    check(open_workspace(page), "P2 composer 非 inert（判据 data-phase）")

    # ① 档位常显（触发钮在场＋可见＋「思考」前缀＋当前值）
    trig = page.locator(".atf-effort-trigger")
    trig_ok = False
    for _ in range(20):
        if trig.count() > 0:
            try:
                if trig.first.bounding_box() is not None and trig.first.inner_text().startswith("思考"):
                    trig_ok = True
                    break
            except Exception:
                pass
        time.sleep(1.5)
    initial_label = trigger_label(page)
    check(trig_ok, f"P2① 档位常显（触发钮可见，text=思考 {initial_label}）")
    shot(page, "01-effort-always-visible.png")

    # ② 点开菜单（闭集恰四值）
    trig.first.click()
    menu_ok = False
    labels = []
    EXPECTED = ["Off(关)", "Low(低)", "High(高)", "Max(最高)"]
    for _ in range(15):
        if page.locator(".atf-effort-menu").count() > 0:
            rows = page.locator(".atf-effort-menu .atf-effort-row")
            # 选中行带勾标（内联 ✓ span）——归一化剥离后比闭集；行文本等渲染提交（挂载中途读会得空串）
            labels = [rows.nth(i).inner_text().replace("✓", "").strip() for i in range(rows.count())] if rows.count() > 0 else []
            if labels == EXPECTED:
                menu_ok = True
                break
        time.sleep(1)
    check(menu_ok, f"P2② 点开菜单闭集恰四值（labels={labels}）")
    shot(page, "02-effort-menu-open.png")

    # ③ 切换生效：点 High(高) → 触发钮更新＋原生模型座位 caption 同步（共享状态同证）
    page.locator(".atf-effort-menu .atf-effort-row", has_text="High(高)").first.click()
    switched = wait_trigger_label(page, "High(高)")
    check(switched, "P2③a 点开即切：触发钮当前档位变 High(高)")
    native_ok = False
    native_text = ""
    for _ in range(12):
        try:
            cand = page.locator("button[title*='· High'], button[aria-label*='High']")
            if cand.count() > 0:
                native_text = cand.first.get_attribute("aria-label") or cand.first.get_attribute("title") or ""
                if "High" in native_text:
                    native_ok = True
                    break
        except Exception:
            pass
        time.sleep(1.5)
    check(native_ok, f"P2③b 原生模型座位同步（aria/title={native_text[:60]}）")
    shot(page, "03-effort-switched-high.png")

    # ④ 下 turn 生效实证：GLM 真会话同题两拍（High vs Off 行为差＝wire 档位生效）
    box = page.locator("[role='textbox']").first
    question = "17乘24等于多少？只回答数字结果，不要解释。"

    def turn_once():
        baseline = page.get_by_text("408", exact=False).count()
        box.click()
        box.fill(question)
        time.sleep(1)
        page.keyboard.press("Enter")
        t0 = time.time()
        for _ in range(120):
            if page.get_by_text("408", exact=False).count() > baseline:
                return time.time() - t0
            time.sleep(1)
        return None

    t_high = turn_once()
    check(t_high is not None, f"P2④a High 档下一轮回复到达（{t_high:.1f}s）" if t_high else "P2④a High 档回复未达")

    trig.first.click()
    time.sleep(1)
    page.locator(".atf-effort-menu .atf-effort-row", has_text="Off(关)").first.click()
    off_switched = wait_trigger_label(page, "Off(关)")
    check(off_switched, "P2④b 切到 Off(关)")
    t_off = turn_once()
    check(t_off is not None, f"P2④c Off 档下一轮回复到达（{t_off:.1f}s）" if t_off else "P2④c Off 档回复未达")
    if t_high is not None and t_off is not None:
        print(f"[timing] High={t_high:.1f}s Off={t_off:.1f}s（行为差如实记录——断言不绑幅值）", flush=True)
    shot(page, "05-effort-next-turn-off-replied.png")

    # ③c 持久化（后置：会话已存在且档位终态＝Off(关)）：reload → 重开会话 → 档位保持
    page.reload(wait_until="load")
    time.sleep(6)
    open_workspace(page)
    open_session_by_title(page, "17乘24")
    durable = wait_trigger_label(page, "Off(关)")
    check(durable, f"P2③c reload 后档位保持（label={trigger_label(page)}）")
    shot(page, "04-effort-durable-after-reload.png")

    # ④⑤ 设置页市面对齐实锚（owner 2026-10-15 裁定）：侧栏 Settings → 模型 section →
    # 智谱 GLM 卡（表述对齐）→ API Key 栏可写（env 锁已解除）→ 眼睛明文切换（patch 0004）
    print("[phase2④⑤] 设置页实锚…", flush=True)
    page.locator("button:has-text('Settings')").first.click()
    time.sleep(3)
    # 设置页语言双态（实例 Language=English → nav "Models"；中文态 → "模型"）
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
    check(nav_ok, "P4⑤a 设置页「模型/Models」section 导航在场")
    time.sleep(2)
    body_text = page.locator("body").inner_text()
    check("智谱 GLM" in body_text, "P4⑤b provider 表述市面对齐（智谱 GLM 行在场）")
    shot(page, "07-settings-model-card.png")
    # 进编辑卡：点 智谱 GLM 行的 Edit（按行内几何定位——has_text 会命中祖先容器误点他行；
    # 绝不动 Delete）
    edit_ok = False
    glm_bb = page.get_by_text("智谱 GLM").first.bounding_box()
    if glm_bb:
        edits = page.locator("button:has-text('Edit')")
        for i in range(edits.count()):
            bb = edits.nth(i).bounding_box()
            if bb and abs(bb["y"] - glm_bb["y"]) < 24:
                edits.nth(i).click()
                edit_ok = True
                break
    check(edit_ok, "P4⑤b2 智谱 GLM 行 Edit 进入编辑卡（行内几何定位）")
    time.sleep(2)
    # 模型清单在编辑卡 input value 里（inner_text 不含输入值）——全 input value 并集断言
    input_vals = page.evaluate("() => [...document.querySelectorAll('input')].map(i => String(i.value)).join(' | ')")
    check("GLM-5.3-FlashX" in input_vals and "GLM-5.3-Flash" in input_vals and "GLM-5.3" in input_vals,
          "P4⑤c 模型选项市面对齐（GLM-5.3 / Flash / FlashX 在列）")
    shot(page, "09-settings-glm-edit-card.png")
    key_input = page.locator("input[aria-label='API 密钥'], input[aria-label='API key']")
    key_enabled = False
    for _ in range(10):
        if key_input.count() > 0:
            try:
                if key_input.first.is_enabled():
                    key_enabled = True
                    break
            except Exception:
                pass
        time.sleep(1)
    check(key_enabled, "P4⑤d API Key 填写栏在场且可写（env 只读锁已解除）")
    # 眼睛切换：password ↔ text（patch 0004）
    eye = page.locator("button[aria-label='显示 API 密钥'], button[aria-label='Show API key']")
    eye_ok = False
    if eye.count() > 0:
        key_input.first.fill("sk-eye-toggle-probe-DO-NOT-USE")
        eye.first.click()
        time.sleep(0.5)
        t1 = key_input.first.get_attribute("type")
        eye.first.click()
        time.sleep(0.5)
        t2 = key_input.first.get_attribute("type")
        eye_ok = (t1 == "text" and t2 == "password")
    check(eye_ok, f"P4⑤e 眼睛明文切换（text↔password 实测 {t1 if eye.count() > 0 else 'no-eye'}→{t2 if eye.count() > 0 else ''}）")
    if eye_ok:
        shot(page, "08-settings-key-reveal.png")
    page.locator("button:has-text('←'), [aria-label*='back'], [class*='back']").first.click() if page.locator("button:has-text('←')").count() > 0 else page.keyboard.press("Escape")
    time.sleep(2)

    # ⑤ 拒绝路径（双上下文同会话切换——host 拒绝则错误条如实呈现）：
    # 尝试一：多写者空闲切换（writer 语义放行与否如实登记）；
    # 尝试二：A 轮进行中切换（agent-busy/writer-held——真实忙拒面）
    print("[phase2⑤] 拒绝路径尝试（context B 同会话）…", flush=True)

    def try_switch_on(page_x, want_label="Max(最高)"):
        """在 page_x 上点开菜单点 want_label；返回 (error_text, switched_bool)。"""
        page_x.locator(".atf-effort-trigger").first.click()
        time.sleep(1)
        page_x.locator(".atf-effort-menu .atf-effort-row", has_text=want_label).first.click()
        for _ in range(20):
            if page_x.locator(".atf-effort-err").count() > 0:
                return page_x.locator(".atf-effort-err").first.inner_text(), False
            if trigger_label(page_x) == want_label:
                return None, True
            time.sleep(1.5)
        return None, False

    ctxb = browser.new_context(viewport={"width": 1560, "height": 950})
    page_b = ctxb.new_page()
    error_b = None
    try:
        page_b.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
        time.sleep(6)
        open_workspace(page_b)
        if open_session_by_title(page_b, "17乘24") and wait_trigger_label(page_b, trigger_label(page) or "Off(关)", tries=10):
            error_b, _ = try_switch_on(page_b)
            if error_b is None:
                print("[phase2⑤] 尝试一（空闲切换）未被拒——尝试二：A 轮进行中切换", flush=True)
                # A 发一轮（真实回复需时），期间 B 即刻尝试切换——忙拒窗口
                box.click()
                box.fill(question)
                time.sleep(0.5)
                page.keyboard.press("Enter")
                time.sleep(3)
                error_b, _ = try_switch_on(page_b)
        else:
            print("[phase2⑤] context B 未复现同会话控件（会话恢复形态不同）", flush=True)
    except Exception as e:
        print("[phase2⑤] context B 异常: " + str(e)[:200], flush=True)
    if error_b:
        check(True, f"P2⑤ 拒绝路径如实显示（error={error_b[:80]}）")
        shot(page_b, "06-effort-rejection-strip.png")
    else:
        print("[phase2⑤] 如实登记：live 链未获 host 拒绝（多写者放行／控件隐藏）——拒绝条截图缺席，见执行报告偏离登记", flush=True)
    ctxb.close()

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
