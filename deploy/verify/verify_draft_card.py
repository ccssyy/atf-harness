#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证据脚本 · B2c 草稿态「回到上次实验」卡（门 R0 I 项）真环境走查。

属性：ops 取证工具，**不进 CI、不参与 npm build**；容器内已装 Python Playwright
与 chromium（`/usr/local/bin/playwright`、`~/.cache/ms-playwright`），零新增依赖。

做的事（只读，不发消息、不建会话、不写服务端状态）：
  1) 用 boot token 打开实例首页（草稿态）；
  2) 断言草稿卡可见且文案为用户语言（含「回到上次实验」）；
  3) 点击「继续这次实验」，断言按钮转「已选 ✓」（pending 只落客户端）；
  4) 统计 `/atf-ui/` 前缀 POST（必须为 0）与 pageerror / console.error（必须为空）；
  5) 落截图与机读结果。

用法：
  DSH_TOKEN=<boot token> python3 verify_draft_card.py [--base-url URL] [--shot-dir DIR] [--json-out FILE]

boot token 取得（每次 boot 轮换，env 里固定那份是死配置）：
  grep -h 'dsh web: ' /tmp/dsh-web-k28.log | tail -1     # dev
  grep -h 'dsh web: ' /tmp/dsh-web-tongshi.log | tail -1 # uat（容器内）

退出码：0=PASS；1=FAIL；2=用法/环境错。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

CARD_SELECTOR = '[data-draft-resume="1"]'
CARD_GO_SELECTOR = '[data-draft-resume-go="1"]'
DRAFT_CARD_TITLE = "回到上次实验"
PENDING_LABEL = "已选"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="B2c 草稿卡真环境取证（门 R0 I 项）")
    parser.add_argument("--base-url", default="http://127.0.0.1:3080",
                        help="实例根地址（默认 dev 3080；uat 走容器内 3081）")
    parser.add_argument("--token", default=os.environ.get("DSH_TOKEN"),
                        help="boot token（缺省取 env DSH_TOKEN）")
    parser.add_argument("--shot-dir", default="./tmp/verify",
                        help="截图与结果落点（默认 ./tmp/verify，勿落 run 目录）")
    parser.add_argument("--json-out", default=None, help="机读结果路径（缺省 <shot-dir>/draft-card.json）")
    parser.add_argument("--timeout-ms", type=int, default=45000, help="页面/选择器等待上限")
    return parser.parse_args(argv)


def check(args: argparse.Namespace) -> dict:
    from playwright.sync_api import sync_playwright

    shot_dir = Path(args.shot_dir)
    shot_dir.mkdir(parents=True, exist_ok=True)
    url = f"{args.base_url.rstrip('/')}/?token={args.token}"
    result: dict = {"url": args.base_url, "card": None, "after_click": None,
                    "atf_ui_posts": [], "pageerrors": [], "console_errors": []}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: result["pageerrors"].append(str(error)))
        page.on("console", lambda message: result["console_errors"].append(message.text)
                if message.type == "error" else None)
        # 只认 /atf-ui/ 前缀：vendor 侧读接口本身也是 POST，宽口径会淹掉真信号（首版假 FAIL 的根因）。
        page.on("request", lambda request: result["atf_ui_posts"].append(f"{request.method} {request.url}")
                if request.method == "POST" and "/atf-ui/" in request.url else None)

        page.goto(url, wait_until="domcontentloaded", timeout=args.timeout_ms)
        page.wait_for_selector(CARD_SELECTOR, state="visible", timeout=args.timeout_ms)

        card = page.locator(CARD_SELECTOR)
        box = card.bounding_box() or {}
        result["card"] = {
            "visible": card.is_visible(),
            "text": " | ".join(line.strip() for line in card.inner_text().splitlines() if line.strip()),
            "box": {key: round(value, 1) for key, value in box.items()},
        }
        page.screenshot(path=str(shot_dir / "I-1-draft-card.png"))

        page.locator(CARD_GO_SELECTOR).click()
        page.wait_for_timeout(600)
        result["after_click"] = {
            "button_text": page.locator(CARD_GO_SELECTOR).inner_text().strip(),
            "card_text": " | ".join(line.strip() for line in card.inner_text().splitlines() if line.strip()),
        }
        page.screenshot(path=str(shot_dir / "I-2-pending.png"))
        browser.close()
    return result


def verdict_of(result: dict) -> str:
    card = result.get("card") or {}
    after = result.get("after_click") or {}
    passed = (
        card.get("visible") is True
        and DRAFT_CARD_TITLE in str(card.get("text") or "")
        and PENDING_LABEL in str(after.get("button_text") or "")
        and not result.get("atf_ui_posts")
        and not result.get("pageerrors")
    )
    return "PASS" if passed else "FAIL"


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.token:
        print("usage_error: 缺 boot token（--token 或 env DSH_TOKEN）；"
              "取法见本文件头注释", file=sys.stderr)
        return 2
    try:
        result = check(args)
    except Exception as error:  # noqa: BLE001 —— 取证工具：任何异常都落成 FAIL 证据，不吞不崩
        result = {"error": f"{type(error).__name__}: {error}"}
    result["verdict"] = verdict_of(result) if "error" not in result else "FAIL"
    payload = json.dumps(result, ensure_ascii=False, indent=1)
    out = Path(args.json_out) if args.json_out else Path(args.shot_dir) / "draft-card.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
