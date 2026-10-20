#!/usr/bin/env python3
# B2 真机验收（一次性承载件）：绑定 UI 八幕——未绑定空态/继续上次/切 run 同步/全部只读/
# 状态逐字一致/改名三处同步/display.json 落盘/解除 cleared/未绑定胶囊弹面板零工具调用。
# 前置：dev 实例（3080）已按 instance-restart.sh dev 净室重启（boot 锚：pin v0.7.21b0／
# 白名单 11／绑定端点注册）。连 live 实例驱动 playwright，不改实例 env/凭据。
# vendor 布局事实（探针实锚）：未发首条消息的草稿会话不渲染 header.utilities 座位——
# 幕①空白/未绑定语义用「未绑定既有会话」等价驱动，随报告登记。
# 清理：账本新会话键摘除；display.json 若测试前不存在则复原删除；改名走产品写面复原。
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOG = Path("/tmp/dsh-web-k28.log")
BASE = "http://127.0.0.1:3080"
OUT = Path("docs/_owner/B2_取证_20261020")
LEDGER = Path("/data/atf/instances/dev/atf-home/atf-state/session-bindings.json")
RUNS_ROOT = Path("/data/atf/dev/runs")
SESSION_LABEL = "回复两个字：收到"  # 未绑定既有会话（幕①～⑧载体）

results = []


def check(ok, name, detail=""):
    results.append((bool(ok), name, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + ((" — " + detail) if detail else ""), flush=True)


def shot(page, name, narrow=False):
    OUT.mkdir(parents=True, exist_ok=True)
    suffix = "-460" if narrow else ""
    page.screenshot(path=str(OUT / f"{name}{suffix}.png"), full_page=False)
    print("[shot] " + name + suffix, flush=True)


def ledger_snapshot():
    try:
        return json.loads(LEDGER.read_text())
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def find_disp_path(run_id):
    if not run_id:
        return None
    direct = RUNS_ROOT / run_id / "webui" / "display.json"
    if direct.exists():
        return direct
    for bucket in RUNS_ROOT.iterdir():
        d = bucket / run_id / "webui" / "display.json"
        if d.exists():
            return d
    return None


def carrier_record(snapshot, window_s=180):
    """载体会话记录＝ smoke 期间 updated_at 最新且在窗内的绑定记录（绑定时 updated_at 刷新）。"""
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    best_k = None
    best_t = None
    for k, v in snapshot.get("sessions", {}).items():
        if not isinstance(v, dict):
            continue
        ts = v.get("updated_at")
        if not isinstance(ts, str):
            continue
        try:
            t = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        age = (now - t).total_seconds()
        if 0 <= age <= window_s and (best_t is None or t > best_t):
            best_k = k
            best_t = t
    return best_k


def wait_chip(page, timeout_s=30):
    for _ in range(timeout_s * 2):
        chip = page.locator("button.atf-bchip")
        if chip.count() > 0:
            txt = (chip.first.text_content() or "").strip()
            if "░" not in txt and txt != "":
                return chip.first
        time.sleep(0.5)
    return None


def open_panel(page):
    chip = wait_chip(page)
    if chip is None:
        return None
    chip.click()
    for _ in range(20):
        if page.locator(".atf-bp").count() > 0:
            return page.locator(".atf-bp").first
        time.sleep(0.5)
    return None


def close_panel(page):
    if page.locator(".atf-bp").count() > 0:
        page.locator(".atf-bp-h button", has_text="×").first.click()
        time.sleep(1)


token = re.search(r"token=(\S+)", LOG.read_text()).group(1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(10)

    ledger_before = ledger_snapshot()
    ledger_keys_before = set(ledger_before.get("sessions", {}).keys())

    # ── 幕①：未绑定会话 → 空态（不自动选 run）────────────────────────────────
    sess_btn = page.get_by_text(SESSION_LABEL, exact=True)
    check(sess_btn.count() > 0, "幕① 载体会话在场", SESSION_LABEL)
    sess_btn.first.click()
    time.sleep(8)
    chip = wait_chip(page)
    chip_txt = (chip.text_content() or "").strip() if chip is not None else ""
    check("选择实验" in chip_txt, "幕① 未绑定 chip＝选择实验", chip_txt)
    page.locator("button:has-text('监控')").first.click()
    time.sleep(4)
    body = page.locator("body").text_content() or ""
    check("未选择实验" in body or "已解除绑定" in body, "幕① 监控未绑定空态（new/cleared 两态之一）",
          "未选择实验" if "未选择实验" in body else "已解除绑定（上轮残留 cleared）")
    check("继续上次" in body, "幕① 空态含「继续上次」（跨会话全局最近）")
    check("最近实验" in body, "幕① 空态含「最近实验」")
    check("新建实验" in body, "幕① 空态含「新建实验」")
    check("机器 GPU" in body, "幕① 空态含机器 GPU 一行（只读）")
    check(page.locator(".atf-m-kpis").count() == 0, "幕① 空态零假 KPI")
    check(page.locator(".atf-gpu-grid").count() == 0, "幕① 空态零 GPU 细卡")
    shot(page, "08-幕1-空态-常规宽")

    # ── 幕②：点「继续上次」→ chip＝title（＋工作区徽标，有工作区标注时）监控跟随 ──
    panel = open_panel(page)
    check(panel is not None, "幕② 面板打开")
    last_btn = page.locator(".atf-bp button.atf-bp-main").filter(has_text="上次：").first
    check(last_btn.count() > 0, "幕② 继续上次行在场")
    if last_btn.count() > 0:
        last_btn.click()
        time.sleep(3)
        chip2 = wait_chip(page)
        chip2_txt = (chip2.text_content() or "").strip() if chip2 is not None else ""
        check(chip2_txt != "" and "选择实验" not in chip2_txt, "幕② chip 进入已绑定态", chip2_txt)
        time.sleep(1)
        carrier_key = carrier_record(ledger_snapshot())
        bound_run_id = None
        bound_ws = None
        if carrier_key is not None:
            rec = ledger_snapshot()["sessions"][carrier_key]
            bound_run_id = rec.get("active_run_id")
            bound_ws = rec.get("workspace")
        check(carrier_key is not None, "幕② 载体记录可追踪（updated_at 窗口）", str(carrier_key))
        if bound_ws:
            badge = page.locator(".atf-bchip-ws")
            check(badge.count() > 0, "幕② 工作区徽标在场（有工作区标注）",
                  badge.first.get_attribute("title") if badge.count() > 0 else "无")
        else:
            check(True, "幕② 工作区徽标（本次绑定 run 无工作区标注——徽标按设计缺席）", str(bound_run_id))
        time.sleep(6)  # 监控下一拍跟随绑定
        pane_txt = page.locator("body").text_content() or ""
        check("运行监控" in pane_txt, "幕② 监控面板在场")
        shot(page, "09-幕2-继续上次绑定")

    # ── 幕③：从 chip 切到另一 run（最近实验组）→ chip/监控同步＋账本 history 增条 ──
    panel = open_panel(page)
    target_row = None
    target_run_id = ""
    target_title = ""
    if panel is not None:
        recent_rows = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="最近实验")).locator("button.atf-bp-main")
        chip_now = (wait_chip(page).text_content() or "")
        for i in range(recent_rows.count()):
            row = recent_rows.nth(i)
            sub = row.locator(".atf-bp-sub").text_content() or ""
            rid = sub.split("·")[-1].strip()
            if rid not in chip_now:
                target_row = row
                target_run_id = rid
                target_title = (row.locator(".atf-bp-title").text_content() or "").strip()
                break
    check(target_row is not None, "幕③ 可切换的最近 run 在场", target_run_id)
    if target_row is not None:
        target_row.click()
        time.sleep(3)
        chip3 = (wait_chip(page).text_content() or "").strip()
        check(target_title.split(" · ")[0] in chip3, "幕③ chip 切换到新 run", chip3)
        time.sleep(1)
        hit = None
        led3 = ledger_snapshot()
        if carrier_key is not None and carrier_key in led3.get("sessions", {}):
            hit = led3["sessions"][carrier_key]
        check(hit is not None and hit.get("active_run_id") == target_run_id, "幕③ 账本 active_run_id＝新 run（载体键）",
              json.dumps(hit, ensure_ascii=False)[:140] if hit else "carrier key 缺席")
        check(hit is not None and len(hit.get("history", [])) >= 2, "幕③ history 增条（≥2）",
              json.dumps(hit.get("history", []), ensure_ascii=False)[:120] if hit else "")
        shot(page, "10-幕3-切run同步")

    # ── 幕④：「全部」组点选只预览（零绑定）→ 只读横幅 → 设为当前才绑定 ─────────
    ledger_before4 = ledger_snapshot()
    panel = open_panel(page)
    check(panel is not None, "幕④ 面板打开")
    row4 = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例")).locator("button.atf-bp-main").nth(1)
    row4_title = (row4.locator(".atf-bp-title").text_content() or "").strip()
    row4.click()
    time.sleep(4)
    body = page.locator("body").text_content() or ""
    check("全部实例（只读视图）" in body, "幕④ 只读横幅出现")
    check(json.dumps(ledger_snapshot(), sort_keys=True) == json.dumps(ledger_before4, sort_keys=True),
          "幕④ 浏览零 POST（账本零变化）")
    check(row4_title.split(" · ")[0] in body, "幕④ 预览 run 切换", row4_title)
    setcur = page.locator("button.atf-m-ro-bind")
    check(setcur.count() > 0, "幕④ 横幅「设为当前」在场")
    if setcur.count() > 0:
        setcur.first.click()
        time.sleep(3)
        check(json.dumps(ledger_snapshot(), sort_keys=True) != json.dumps(ledger_before4, sort_keys=True),
              "幕④ 设为当前 → 账本变化（显式动作）")
    shot(page, "11-幕4-全部只读")

    # ── 幕⑦：chip 与监控头状态逐字一致 ────────────────────────────────────────
    chip7 = (wait_chip(page).text_content() or "").strip()
    pane_status = page.locator(".atf-m-status")
    pane7 = (pane_status.first.text_content() or "").strip() if pane_status.count() > 0 else ""
    pct_chip = re.search(r"(\d+)%", chip7)
    pct_pane = re.search(r"(\d+)%", pane7)
    state_chip = "训练中" if "训练中" in chip7 else ("异常" if "异常" in chip7 else "空闲")
    state_pane = "训练中" if "训练中" in pane7 else ("异常" if "异常" in pane7 else "空闲")
    check(state_chip == state_pane and (pct_chip is None) == (pct_pane is None)
          and (pct_chip is None or pct_chip.group(1) == pct_pane.group(1)),
          "幕⑦ chip 与监控头状态逐字一致", f"chip={chip7} / pane={pane7}")
    shot(page, "12-幕7-状态一致")

    # ── 幕⑥：改名 → chip/选择器/监控头三处同步；display.json 落盘（后复原）─────
    panel = open_panel(page)
    check(panel is not None, "幕⑥ 面板打开")
    pencil = page.locator(".atf-bp button.atf-bp-act", has_text="✎")
    check(pencil.count() > 0, "幕⑥ 改名铅笔在场")
    new_title = "B2 验收改名"
    chip6 = (wait_chip(page).text_content() or "").strip()
    orig_title = chip6.split(" · ")[0] if chip6 else ""
    target6 = None
    led6 = ledger_snapshot()
    key6 = carrier_record(led6) or carrier_key
    if key6 is not None and key6 in led6.get("sessions", {}):
        target6 = led6["sessions"][key6].get("active_run_id")
    disp_path = find_disp_path(target6)
    disp_pre_exists = disp_path is not None
    if pencil.count() > 0:
        pencil.first.click()
        time.sleep(1)
        page.locator(".atf-bp-rename-in").fill(new_title)
        page.locator(".atf-bp button.atf-bp-act", has_text="确定").first.click()
        time.sleep(3)
        chip6b = (wait_chip(page).text_content() or "").strip()
        check(new_title in chip6b, "幕⑥ chip 同步新名", chip6b)
        time.sleep(6)  # monitor 下一拍
        check(new_title in (page.locator("body").text_content() or ""), "幕⑥ 监控头同步新名")
        panel6 = open_panel(page)
        check(panel6 is not None and new_title in (panel6.text_content() or ""), "幕⑥ 选择器同步新名")
        close_panel(page)
        disp_now = find_disp_path(target6)
        check(disp_now is not None and new_title in disp_now.read_text(), "幕⑥ display.json 落盘", str(target6))
        shot(page, "13-幕6-改名三处同步")
        # 复原：产品写面改回原名
        panel_r = open_panel(page)
        if panel_r is not None:
            page.locator(".atf-bp button.atf-bp-act", has_text="✎").first.click()
            time.sleep(1)
            page.locator(".atf-bp-rename-in").fill(orig_title or "未命名实验")
            page.locator(".atf-bp button.atf-bp-act", has_text="确定").first.click()
            time.sleep(3)
            close_panel(page)

    # ── 幕⑤：解除绑定 → 空态（cleared）＋撤销入口 ─────────────────────────────
    panel = open_panel(page)
    check(panel is not None, "幕⑤ 面板打开")
    page.locator(".atf-bp button", has_text="解除绑定").first.click()
    time.sleep(3)
    chip5 = (wait_chip(page).text_content() or "").strip()
    check("选择实验" in chip5, "幕⑤ 解除后 chip 回未绑定", chip5)
    body = page.locator("body").text_content() or ""
    check("已解除绑定" in body, "幕⑤ cleared 空态文案")
    check("撤销解除" in body, "幕⑤ 撤销解除入口在场")
    shot(page, "14-幕5-解除cleared")

    # ── 幕⑧：未绑定会话点 run 相关胶囊（禁用态）→ 弹面板，零工具调用 ───────────
    pill = page.locator("button.atf-pill[data-run-related='1']").first
    check(pill.count() > 0, "幕⑧ run 相关胶囊在场")
    aria_dis = pill.get_attribute("aria-disabled")
    check(aria_dis == "true", "幕⑧ 未绑定 run 胶囊禁用态（aria-disabled）", str(aria_dis))
    composer_before = page.evaluate(
        "() => { const el = document.querySelector('[contenteditable=\"true\"]'); return el ? el.textContent : ''; }"
    )
    pill.click(force=True)  # aria-disabled 按钮 playwright 可点性检查拒绝——force 直点（真实浏览器可点）
    time.sleep(2)
    check(page.locator(".atf-bp").count() > 0, "幕⑧ 点击弹选择面板")
    composer_after = page.evaluate(
        "() => { const el = document.querySelector('[contenteditable=\"true\"]'); return el ? el.textContent : ''; }"
    )
    check((composer_after or "") == "" and composer_before == composer_after, "幕⑧ 零工具调用（composer 未填入）",
          f"after={composer_after!r}")
    shot(page, "15-幕8-胶囊弹面板")

    # ── 460px 窄宽一组（chip＋监控空态＋面板）─────────────────────────────────
    ctx2 = browser.new_context(viewport={"width": 460, "height": 900})
    page2 = ctx2.new_page()
    page2.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(10)
    sess2 = page2.get_by_text(SESSION_LABEL, exact=True)
    if sess2.count() > 0:
        sess2.first.click()
        time.sleep(6)
    shot(page2, "16-窄宽-chip", narrow=True)
    if page2.locator("button:has-text('监控')").count() > 0:
        page2.locator("button:has-text('监控')").first.click()
        time.sleep(4)
        shot(page2, "17-窄宽-监控空态", narrow=True)
    chip_n = wait_chip(page2)
    if chip_n is not None:
        chip_n.click()
        for _ in range(10):
            if page2.locator(".atf-bp").count() > 0:
                break
            time.sleep(0.5)
        shot(page2, "18-窄宽-面板", narrow=True)

    check(len(errors) == 0, "页面零 JS 错误", "; ".join(errors[:3]))

    # ── 清理：账本新键摘除；display.json 测试前不存在则删；零运行目录残留 ──────
    ledger_after = ledger_snapshot()
    removed = 0
    if "sessions" in ledger_after:
        new_keys = [k for k in ledger_after["sessions"].keys() if k not in ledger_keys_before]
        for k in new_keys:
            ledger_after["sessions"].pop(k, None)
            removed += 1
        tmp = LEDGER.with_suffix(".json.tmp-clean")
        tmp.write_text(json.dumps(ledger_after, indent=1) + "\n")
        tmp.replace(LEDGER)
    print(f"[clean] 账本新会话键摘除 {removed} 个（载体既有记录留原状——解除后 cleared 即测试前等价态）", flush=True)
    if not disp_pre_exists and target6:
        d = find_disp_path(target6)
        if d is not None:
            d.unlink()
            print(f"[clean] display.json 删除（测试前不存在）：{d}", flush=True)

    print("\n==== B2 真机验收汇总 ====")
    passed = sum(1 for ok, _, _ in results if ok)
    print(f"{passed}/{len(results)} PASS")
    for ok, name, detail in results:
        if not ok:
            print(f"  [FAIL] {name} — {detail}")
    browser.close()
    sys.exit(0 if passed == len(results) else 1)
