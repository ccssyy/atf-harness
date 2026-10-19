#!/usr/bin/env python3
# D11-2 真机验收（一次性承载件）：监控面板逐区块＋GPU 历史 60s 增长＋断流演练＋产物打开。
# 前置：npm run build → instance-restart.sh dev（顺序不可反）；本脚本连 live 3080。
import json
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LOG = Path("/tmp/dsh-web-k28.log")
BASE = "http://127.0.0.1:3080"
OUT = Path(__import__("os").environ.get("D11_OUT", "docs/_owner/D11-2_取证_20261019"))
HIST = Path("/data/atf/dev/runs/atf-ui")

results = []


def check(ok, name, detail=""):
    results.append((bool(ok), name, detail))
    print(("[PASS] " if ok else "[FAIL] ") + name + ((" — " + detail) if detail else ""), flush=True)


def shot(page, name, element=None):
    OUT.mkdir(parents=True, exist_ok=True)
    if element is not None:
        element.screenshot(path=str(OUT / name))
    else:
        page.screenshot(path=str(OUT / name))
    print("[shot] " + name, flush=True)


token = re.search(r"token=(\S+)", LOG.read_text()).group(1)
dev_pid = int(subprocess.run(["pgrep", "-f", "apps/cli/src/bin.ts web --no-open --port 3080"], capture_output=True, text=True).stdout.split()[0])

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1600, "height": 950})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    popups = []
    ctx.on("page", lambda p: popups.append(p))
    page.goto(BASE + "/?token=" + token, wait_until="load", timeout=30000)
    time.sleep(10)

    # 开一个会话（顶栏按钮属会话头）
    for label in ("收到确认回复", "生成会话标题测试"):
        loc = page.get_by_text(label, exact=True)
        if loc.count() > 0:
            loc.first.click()
            break
    time.sleep(6)

    # ① 顶栏去重：只留「监控」
    btns = page.evaluate("() => Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim())")
    check("监控" in btns, "①顶栏「监控」按钮在场")
    check("GPU" not in btns, "①顶栏「GPU」按钮已删（并入面板）")
    check("设置" not in btns, "①顶栏「设置」按钮零残留")
    shot(page, "01-顶栏-只留监控.png")

    # ② 打开监控 tab → 面板逐区块
    page.locator("button:has-text('监控')").first.click()
    time.sleep(8)
    panel = page.locator(".atf-m-root")
    check(panel.count() > 0, "②监控面板挂载（atf-m-root）")
    # 未绑定 run 会话＝引导空态（状态矩阵）——点「全部」切全量使 run 入选
    allpill = page.locator(".atf-m-runbox button:has-text('全部')")
    if allpill.count() > 0 and "atf-pill-on" not in (allpill.first.get_attribute("class") or ""):
        allpill.first.click()
        time.sleep(4)
    for _ in range(10):
        if page.locator(".atf-m-seg").count() == 8:
            break
        time.sleep(1)
    body = page.locator(".atf-m-root").inner_text()
    for seg in ("数据登记", "标注体检", "实验配置", "契约发布", "数据切分", "准入检查", "训练执行", "评估与可视化"):
        check(seg in body, "②八段在位：" + seg)
    for k in ("步进", "Loss", "指标 F1", "显存"):
        check(k in body, "②KPI 键：" + k)
    check(page.locator("svg.atf-loss-chart").count() > 0 or "等待首个 loss 点" in body, "②Loss 曲线或空态骨架在场")
    check(page.locator(".atf-loss-toggle button").count() == 2, "②Loss 原始/平滑开关")
    # 刻度文本节点：有 loss 点才画图（dev 现无训练 run＝空态骨架为正确形态——刻度结构锚由 jsdom 用例承载）
    if page.locator("svg.atf-loss-chart").count() > 0:
        check(page.locator(".atf-chart-tick").count() >= 8, "②Loss 等距刻度文本节点", str(page.locator(".atf-chart-tick").count()))
    else:
        check("等待首个 loss 点" in body, "②Loss 空态骨架（无点不画假线）")
    grid = page.locator(".atf-gpu-grid")
    check(grid.count() > 0 and grid.get_attribute("data-expanded") == "0", "②GPU 网格默认 4 列（data-expanded=0）")
    tiles = page.locator(".atf-gpu-tile")
    check(tiles.count() == 8, "②GPU 8 卡全显示（含空闲卡温度/功耗）", "tiles=" + str(tiles.count()))
    check("训练产物" in body and "训练日志" in body, "②产物区＋日志区在场")
    shot(page, "02-面板-460对照-整面板.png", element=panel.element_handle())

    # ③ 展开进程与历史曲线 → 2 列
    page.locator(".atf-gpu-more button").first.click()
    time.sleep(3)
    check(page.locator(".atf-gpu-grid").get_attribute("data-expanded") == "1", "③展开后 data-expanded=1（2 列类切换）")
    check(page.locator(".atf-gpu-grid.atf-gpu-grid-expanded").count() == 1, "③expanded 类在位")
    shot(page, "03-面板-展开态.png", element=panel.element_handle())
    # 收起还原（后续观察段回到默认形态）
    page.locator(".atf-gpu-more button").first.click()
    time.sleep(2)

    # ④ GPU 历史 ≥60s 观察行数增长（≈12 行/分钟）＋刷新后历史仍在
    hist_file = HIST / time.strftime("gpu-history-%Y%m%d.jsonl")
    n1 = len([l for l in hist_file.read_text().splitlines() if l.strip()]) if hist_file.exists() else 0
    time.sleep(65)
    n2 = len([l for l in hist_file.read_text().splitlines() if l.strip()]) if hist_file.exists() else 0
    check(n2 > n1, "④历史文件增长（60s）", f"{n1} → {n2} 行（{hist_file.name}）")
    check(n2 - n1 >= 8, "④增速≈12 行/分钟（≥8 容忍）", f"Δ={n2 - n1}")
    # 展开看 sparkline 走势（此时历史已积累）
    page.locator(".atf-gpu-more button").first.click()
    time.sleep(3)
    sparks = page.locator(".atf-spark-svg")
    check(sparks.count() >= 2, "④展开后 sparkline 有走势（≥2 条）", "sparks=" + str(sparks.count()))
    shot(page, "04-展开-历史曲线.png", element=panel.element_handle())
    # 刷新 → 历史仍在（展开态重放；reload 后作用域复位——重切「全部」等八段入位再展开）
    page.reload(wait_until="load")
    time.sleep(10)
    page.locator("button:has-text('监控')").first.click()
    time.sleep(6)
    allpill2 = page.locator(".atf-m-runbox button:has-text('全部')")
    if allpill2.count() > 0 and "atf-pill-on" not in (allpill2.first.get_attribute("class") or ""):
        allpill2.first.click()
    for _ in range(10):
        if page.locator(".atf-m-seg").count() == 8:
            break
        time.sleep(1)
    page.locator(".atf-gpu-more button").first.click()
    time.sleep(3)
    sparks2 = page.locator(".atf-spark-svg")
    check(sparks2.count() >= 2, "④刷新后历史仍在（sparkline 重放）", "sparks=" + str(sparks2.count()))

    # ⑤ 断流演练：SIGSTOP 同步器 40s → 「数据陈旧 Ns」角标；SIGCONT 恢复后消失
    subprocess.run(["kill", "-STOP", str(dev_pid)])
    time.sleep(40)
    stale_txt = page.locator(".atf-m-stale")
    check(stale_txt.count() == 1 and "数据陈旧" in stale_txt.inner_text(), "⑤断流 40s 出「数据陈旧」角标", stale_txt.inner_text() if stale_txt.count() > 0 else "缺席")
    shot(page, "05-断流-数据陈旧角标.png")
    subprocess.run(["kill", "-CONT", str(dev_pid)])
    time.sleep(15)
    check(page.locator(".atf-m-stale").count() == 0, "⑤恢复后角标消失（不清屏不崩页）")
    check(page.locator(".atf-m-root").count() == 1, "⑤面板仍在（保留快照）")

    # ⑥ 产物点击 → run-file 打开（vendor openResource 不收 http 资源——同步抛错→window.open 回退）。
    # noopener 窗不进 CDP popup；playwright 物理点击与 5s 重渲竞态——改 JS 合成 click（React 委托可靠触发），
    # 遍历行至命中服务 200（evaluate 注入自身伪迹 'null' 调用过滤）。
    # 切到有可服务产物的 run（a31-ready-run 的 launch manifest 在盘）；等 5s 轮询带入产物行
    sel = page.locator(".atf-m-runbox select")
    if sel.count() > 0:
        opts = sel.first.locator("option").all_text_contents()
        target = next((o for o in opts if "a31-ready-run" in o), None)
        if target:
            sel.first.select_option(label=target)
            for _ in range(12):
                if "launch manifest" in page.locator(".atf-m-root").inner_text():
                    break
                time.sleep(1)
    page.evaluate("window.__d11opened = []; window.open = function(u, t, f) { window.__d11opened.push(String(u)); return null }")
    rows = page.locator(".atf-art2-row")
    try:
        print("[diag] selected=" + str(sel.first.input_value()) + " rows=" + str(rows.count()) + " row0=" + (rows.first.inner_text().replace(chr(10), " ") if rows.count() > 0 else "-"), flush=True)
    except Exception as e:
        print("[diag] err " + str(e), flush=True)
    check(rows.count() > 0, "⑥产物行入列", "rows=" + str(rows.count()))
    hit200 = None
    abs_leak = False
    n_rows = rows.count()
    for i in range(n_rows):
        page.evaluate("(i => { const r = document.querySelectorAll('.atf-art2-row')[i]; r.dispatchEvent(new MouseEvent('click', { bubbles: true })) })", i)
        time.sleep(1)
        urls = [u for u in page.evaluate("window.__d11opened") if u.startswith("/atf-ui/run-file?")]
        if not urls:
            continue
        url = urls[-1]
        if "/data/" in url:
            abs_leak = True
        srv = page.evaluate("u => fetch(u, {credentials:'same-origin'}).then(r => r.status.toString())", url)
        if srv == "200" and hit200 is None:
            hit200 = url
    check(hit200 is not None, "⑥产物打开（run-file 200）", hit200 or "无行命中 200")
    check(not abs_leak, "⑥URL 零绝对路径回显")
    if hit200:
        ctype = page.evaluate("u => fetch(u, {credentials:'same-origin'}).then(r => r.headers.get('content-type'))", hit200)
        check("json" in (ctype or "") or "text" in (ctype or ""), "⑥content-type 白名单面", str(ctype))
        print("[row] 命中产物=" + hit200, flush=True)
    try:
        page.evaluate("window.open = window.__d11origOpen")
    except Exception:
        pass

    browser.close()

fail = [r for r in results if not r[0]]
print(f"\n==== D11-2 真机验收：{len(results) - len(fail)}/{len(results)} 过 ====", flush=True)
if errors:
    print("[pageerror]", errors[:5], flush=True)
sys.exit(1 if fail else 0)
