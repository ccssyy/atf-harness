#!/usr/bin/env python3
# D11-1 真机验收（一次性承载件）：原生设置页「训练配置」section 四组迁移闭环。
# 前置：dev 实例（3080）已按 instance-restart.sh dev 净室重启（boot 锚：pin v0.7.21b0／
# 白名单 11／桥 real）。本脚本连 live 实例驱动 playwright，不改实例 env/凭据；
# train_env 写值＝真实 venv（验收后复原为空串）；atf_root 只验证确认卡弹出＋拒绝零写
# （playwright 无监听时 dialog 自动 dismiss——confirm 返回 false＝零 POST，绝不真写根目录）。
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOG = Path("/tmp/dsh-web-k28.log")
BASE = "http://127.0.0.1:3080"
OUT = Path(__import__("os").environ.get("D11_OUT", "docs/_owner/D11-1_取证_20261019"))
VENV = "/data/venv/torch291_vllm016_bnb_qwen3vl"

results = []


def check(ok, name, detail=""):
    results.append((bool(ok), name, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + ((" — " + detail) if detail else ""), flush=True)


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / name), full_page=False)
    print("[shot] " + name, flush=True)


def open_training_section(page):
    """Settings→训练配置，等待 section 内容真正加载（四组标题＋5 输入在场）。"""
    page.locator("button:has-text('Settings')").first.click()
    for _ in range(15):
        if page.get_by_text("训练配置", exact=True).count() > 0:
            break
        time.sleep(1)
    page.get_by_text("训练配置", exact=True).first.click()
    for _ in range(15):
        if page.locator("[role='dialog'] input").count() == 5:
            time.sleep(1)
            return True
        time.sleep(1)
    return False


token = re.search(r"token=(\S+)", LOG.read_text()).group(1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(10)

    # ── ① 开一个既有会话 → header：GPU／监控在，设置按钮无 ───────────────────
    for label in ("收到确认回复", "生成会话标题测试"):
        loc = page.get_by_text(label, exact=True)
        if loc.count() > 0:
            loc.first.click()
            break
    time.sleep(6)
    btn_texts = []
    for _ in range(10):
        btn_texts = page.evaluate(
            "() => Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim())"
        )
        if "GPU" in btn_texts:
            break
        time.sleep(2)
    check("GPU" in btn_texts, "①header GPU 按钮在场（会话已开）")
    check(any(t == "监控" or "监控" in t for t in btn_texts), "①header 监控按钮在场")
    check(not any(t == "设置" for t in btn_texts), "①header 无「设置」按钮")
    shot(page, "01-header-无设置按钮.png")

    # ── ② 打开原生设置页：左栏「训练配置」（末位）＋四组齐全 ─────────────────
    check(open_training_section(page), "②原生设置页「训练配置」section 打开且内容加载（5 输入在场）")
    body = page.locator("[role='dialog']").inner_text()
    for g in ("数据与存储", "运行环境", "训练基线", "只读信息"):
        check(g in body, "②分组标题在场：" + g)
    for f in ("数据根目录", "模型库位置", "训练环境（venv 绝对路径）", "评估环境（venv 绝对路径）", "训练卡数基线"):
        check(f in body, "②业务字段文案在场（零键名）：" + f)
    check("内核版本" in body and "审批记录位置" in body, "②只读信息块在场")
    check("atf_root" not in body, "②用户可见文案零键名（atf_root 不出现）")
    shot(page, "02-训练配置页-四组齐全.png")

    # ── ③ 改 train_env 保存 → GET 对账 → 重开仍在 ──────────────────────────
    inputs = page.locator("[role='dialog'] input")
    before = page.evaluate("() => fetch('/atf-ui/settings',{credentials:'same-origin'}).then(r=>r.json())")
    train_env_before = (before.get("storage", {}).get("effective", {}) or {}).get("train_env", "")
    inputs.nth(2).fill(VENV)
    page.locator("[role='dialog'] button:has-text('保存')").first.click()
    for _ in range(10):
        if "已保存" in page.locator("[role='dialog']").inner_text():
            break
        time.sleep(1)
    check("已保存" in page.locator("[role='dialog']").inner_text(), "③保存成功提示在场")
    after = page.evaluate("() => fetch('/atf-ui/settings',{credentials:'same-origin'}).then(r=>r.json())")
    train_env_after = (after.get("storage", {}).get("effective", {}) or {}).get("train_env", "")
    check(train_env_after == VENV, "③GET 对账：train_env 已落盘", f"{train_env_before!r} → {train_env_after!r}")
    shot(page, "03-train_env-保存成功态.png")

    # 重开（Escape→Settings→训练配置）——持久化
    page.keyboard.press("Escape")
    time.sleep(2)
    check(open_training_section(page), "③重开设置页且内容加载")
    inputs = page.locator("[role='dialog'] input")
    check(inputs.count() == 5 and inputs.nth(2).input_value() == VENV, "③重开仍在：train_env 持久化",
          inputs.nth(2).input_value() if inputs.count() == 5 else "input 缺席")
    shot(page, "04-重开仍在-train_env.png")

    # ── ④ 改 atf_root 弹确认（自动 dismiss＝拒绝 → 零 POST 零写盘） ─────────
    dialogs.clear()
    effective_root = page.evaluate(
        "() => fetch('/atf-ui/settings',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.storage.effective.atf_root)")
    inputs.nth(0).fill("/data/atf-root-d11-probe")
    page.locator("[role='dialog'] button:has-text('保存')").first.click()
    time.sleep(2)
    check(len(dialogs) == 1 and "根目录已改动" in dialogs[0], "④atf_root 变更触发确认卡（文案含「根目录已改动」）", str(dialogs))
    root_now = page.evaluate(
        "() => fetch('/atf-ui/settings',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.storage.effective.atf_root)")
    check(root_now == effective_root and root_now != "/data/atf-root-d11-probe", "④拒绝后零写盘（atf_root 保持生效值）",
          f"effective={effective_root!r} now={root_now!r}")
    shot(page, "05-root-确认卡拒绝后.png")

    # ── ⑤ 复原：重开 section（表单重取服务端值）→ 仅清 train_env → 保存 ────
    page.keyboard.press("Escape")
    time.sleep(2)
    check(open_training_section(page), "⑤复原前重开（表单与盘上值对齐）")
    inputs = page.locator("[role='dialog'] input")
    inputs.nth(2).fill("")
    page.locator("[role='dialog'] button:has-text('保存')").first.click()
    for _ in range(10):
        if "已保存" in page.locator("[role='dialog']").inner_text():
            break
        time.sleep(1)
    check("已保存" in page.locator("[role='dialog']").inner_text(), "⑤复原保存成功")
    final = page.evaluate("() => fetch('/atf-ui/settings',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.storage)")
    check((final.get("effective", {}) or {}).get("train_env", "") == "", "⑤GET 对账：train_env 复原为空",
          repr((final.get("effective", {}) or {}).get("train_env")))
    check((final.get("effective", {}) or {}).get("atf_root", "") != "/data/atf-root-d11-probe", "⑤atf_root 保持原值（探针路径未写入）")
    shot(page, "06-复原后-训练配置页.png")

    browser.close()

fail = [r for r in results if not r[0]]
print(f"\n==== D11-1 真机验收：{len(results) - len(fail)}/{len(results)} 过 ====", flush=True)
if errors:
    print("[pageerror]", errors[:5], flush=True)
sys.exit(1 if fail else 0)
