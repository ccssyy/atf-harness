#!/usr/bin/env python3
# 合并窗真机验收（一次性承载件）：D15 评估状态选轮（模块脚本已单测）／B2a 面板去重／
# D11-2a 环境块与双线可分。dev 实例 3080（build→instance-restart.sh dev 已做，boot 锚
# pin v0.7.21b0／白名单 11）。清理：账本新键摘除（沿 B2 承载件同款）。
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOG = Path("/tmp/dsh-web-k28.log")
BASE = "http://127.0.0.1:3080"
OUT = Path("docs/_owner/合并窗取证_20261020")
LEDGER = Path("/data/atf/instances/dev/atf-home/atf-state/session-bindings.json")
SESSION_LABEL = "回复两个字：收到"

results = []


def check(ok, name, detail=""):
    results.append((bool(ok), name, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + ((" — " + detail) if detail else ""), flush=True)


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    print("[shot] " + name, flush=True)


def ledger_snapshot():
    try:
        return json.loads(LEDGER.read_text())
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


token = re.search(r"token=(\S+)", LOG.read_text()).group(1)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(10)

    ledger_keys_before = set(ledger_snapshot().get("sessions", {}).keys())

    # ── D11-2a／B2a 载体：开会话＋开监控 ────────────────────────────────────────
    page.get_by_text(SESSION_LABEL, exact=True).first.click()
    time.sleep(8)
    page.locator("button:has-text('监控')").first.click()
    time.sleep(4)

    def open_panel():
        chip = page.locator("button.atf-bchip")
        if chip.count() == 0:
            return None
        chip.first.click()
        for _ in range(20):
            if page.locator(".atf-bp").count() > 0:
                break
            time.sleep(0.5)
        # 等全部组行就绪（面板挂载拍 useMonitor 异步取数——首帧全部组为空属预期）
        for _ in range(20):
            if page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例")).locator("button.atf-bp-main").count() > 0:
                break
            time.sleep(0.5)
        return page.locator(".atf-bp").first if page.locator(".atf-bp").count() > 0 else None

    def close_panel():
        if page.locator(".atf-bp").count() > 0:
            page.locator(".atf-bp-h button", has_text="×").first.click()
            time.sleep(1)

    # ── D11-2a④：选 run-regress-large-pl → 环境块真实值 ───────────────────────
    panel = open_panel()
    check(panel is not None, "D11-2a 面板打开")
    all_group = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例"))
    row = all_group.locator("button.atf-bp-main").filter(has_text="run-regress-large-pl").first
    check(row.count() > 0, "D11-2a 目标 run 行在场（全部组）")
    if row.count() > 0:
        row.click(force=True)  # 全部组＝只读预览（同步监控选择器）；预览后重开面板时该行可能因已绑定变 disabled
        time.sleep(5)
        body = page.locator("body").text_content() or ""
        check("运行环境" in body, "D11-2a 环境块在场（run-regress-large-pl）")
        check("Qwen3-VL-32B-Instruct" in body, "D11-2a 基模型真实值")
        check("walkthrough-pl_pl_goods" in body, "D11-2a 数据集真实值")
        check("ds_z3_offload" in body, "D11-2a 并行真实值")
        check("pl_goods" in body, "D11-2a 通道真实值")
        env_txt = (page.locator(".atf-env-grid").text_content() or "") if page.locator(".atf-env-grid").count() > 0 else ""
        check("deepspeed" not in env_txt and "base_model" not in env_txt and "dataset_keys" not in env_txt and "lane" not in env_txt,
              "D11-2a 环境块零键名")
        hint = page.locator(".atf-sec-hint", has_text="权限档位")
        check(hint.count() > 0, "D11-2a 权限档位 hint 在场", (hint.first.text_content() or "") if hint.count() > 0 else "")
        shot(page, "mw-01-环境块-真实值")

    # ── D11-2a①：展开 GPU → 双线可分（polyline y 差 ≥1.5）────────────────────
    more = page.locator(".atf-gpu-more button", has_text="展开")
    if more.count() > 0:
        more.first.click()
        # 展开挂载拍 useGpuHistory 异步取数（pane 重挂/openResource 竞态窗）——轮询至双线落地
        for _ in range(16):
            if page.locator(".atf-gpu-spark polyline").count() >= 2:
                break
            time.sleep(0.5)
        sparks = page.locator(".atf-gpu-spark")
        check(sparks.count() >= 1, "D11-2a 展开态 spark 容器在场（8 卡）", f"count={sparks.count()}")
        def ys(points):
            return [float(p.split(",")[1]) for p in (points or "").split(" ") if p]
        max_diff = 0.0
        max_detail = ""
        two_line_cards = 0
        for si in range(sparks.count()):
            lines = sparks.nth(si).locator("polyline")
            if lines.count() != 2:
                continue
            two_line_cards += 1
            u = ys(lines.nth(0).get_attribute("points"))
            m = ys(lines.nth(1).get_attribute("points"))
            d = abs((u[0] if u else 0) - (m[0] if m else 0))
            if d > max_diff:
                max_diff = d
                max_detail = f"card{si}: util_y={u[:1]} mem_y={m[:1]}"
        check(two_line_cards >= 1, "D11-2a 双 sparkline 卡在场", f"two_line_cards={two_line_cards}")
        check(max_diff >= 1.5, "D11-2a 存在卡两线 y 差 ≥1.5（viewBox 单位）", f"max_diff={max_diff:.2f} {max_detail}")
        shot(page, "mw-02-GPU双线可分")

    # ── D11-2a⑤：切 env 全—的 run（a3smoke1017）→ 块隐藏 ──────────────────────
    panel = open_panel()
    if panel is not None:
        all_group2 = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例"))
        row2 = all_group2.locator("button.atf-bp-main").filter(has_text="a3smoke1017").first
        if row2.count() > 0:
            row2.click(force=True)  # 全部组预览
            time.sleep(5)
            check(page.locator(".atf-env-grid").count() == 0, "D11-2a env 全— run 环境块隐藏（a3smoke1017）")
            body = page.locator("body").text_content() or ""
            check("运行环境" not in body, "D11-2a 无「运行环境」标题残留")
            shot(page, "mw-03-环境块隐藏")
        else:
            check(False, "D11-2a a3smoke1017 行缺席")
    close_panel()

    # ── B2a：绑定目标 run（显式动作）→ 面板组间无重复 ──────────────────────────
    panel = open_panel()
    check(panel is not None, "B2a 面板打开")
    if panel is not None:
        chip_b = (page.locator("button.atf-bchip").first.text_content() or "")
        all_group3 = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例"))
        row3_title = all_group3.locator("button.atf-bp-main").filter(has_text="run-regress-large-pl").first.locator(".atf-bp-title").text_content() or ""
        if row3_title != "" and row3_title.split(" · ")[0] in chip_b:
            check(True, "B2a chip 已绑定目标 run（显示名——前次 设为当前 已生效）", chip_b.strip())
        else:
            all_group3 = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text="全部实例"))
            row3 = all_group3.locator("button.atf-bp-main").filter(has_text="run-regress-large-pl").first
            row3.click(force=True)  # 全部组只预览
            time.sleep(3)
            setcur = page.locator("button.atf-m-ro-bind")
            check(setcur.count() > 0, "B2a 只读横幅「设为当前」在场")
            if setcur.count() > 0:
                setcur.first.click()
                time.sleep(3)
        chip_c = (page.locator("button.atf-bchip").first.text_content() or "")
        check("选择实验" not in chip_c and chip_c.strip() != "", "B2a chip 进入已绑定态（title 面）", chip_c.strip())
    panel = open_panel()
    check(panel is not None, "B2a 重开面板")
    if panel is not None:
        def group_rids(name):
            group = page.locator(".atf-bp-group", has=page.locator(".atf-bp-gh", has_text=name))
            if group.count() == 0:
                return None, []
            rows = group.locator("button.atf-bp-main")
            rids = []
            for i in range(rows.count()):
                sub = rows.nth(i).locator(".atf-bp-sub").text_content() or ""
                rids.append(sub.split("·")[-1].strip())
            return True, rids
        recent_ok, recent_rids = group_rids("最近实验")
        others_ok, others_rids = group_rids("本工作区其他")
        check(recent_ok is not None, "B2a 最近实验组在场")
        if others_ok is not None and recent_ok is not None:
            dup = set(recent_rids) & set(others_rids)
            check(len(dup) == 0, "B2a 最近实验 × 本工作区其他 零重复",
                  json.dumps({"recent": recent_rids, "others": others_rids}, ensure_ascii=False))
        # 本会话组与最近实验亦不重复
        cur_ok, cur_rids = group_rids("本会话")
        if cur_ok and recent_ok is not None:
            dup2 = set(cur_rids) & set(recent_rids)
            check(len(dup2) == 0, "B2a 本会话 × 最近实验 零重复", json.dumps({"cur": cur_rids}, ensure_ascii=False))
        # 全部组保持全量（含 active）
        _, all_rids = group_rids("全部实例（只读）")
        check("run-regress-large-pl" in all_rids, "B2a 全部组保持全量（含当前绑定）")
        shot(page, "mw-04-面板去重")

    check(len(errors) == 0, "页面零 JS 错误", "; ".join(errors[:3]))

    # ── 清理：smoke 期间新增的账本键摘除 ──────────────────────────────────────
    ledger_after = ledger_snapshot()
    removed = 0
    if "sessions" in ledger_after:
        for k in [k for k in ledger_after["sessions"].keys() if k not in ledger_keys_before]:
            ledger_after["sessions"].pop(k, None)
            removed += 1
        tmp = LEDGER.with_suffix(".json.tmp-clean")
        tmp.write_text(json.dumps(ledger_after, indent=1) + "\n")
        tmp.replace(LEDGER)
    print(f"[clean] 账本新会话键摘除 {removed} 个", flush=True)

    print("\n==== 合并窗真机验收汇总（浏览器面）====")
    passed = sum(1 for ok, _, _ in results if ok)
    print(f"{passed}/{len(results)} PASS")
    for ok, name, detail in results:
        if not ok:
            print(f"  [FAIL] {name} — {detail}")
    browser.close()
    sys.exit(0 if passed == len(results) else 1)
