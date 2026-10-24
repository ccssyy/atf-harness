#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_prelaunch_report mock 对端（E4-乙 H3/改动 3 测试基建，非内核代码）：
模拟内核 b9 前瞻形态——param_sources 来源串校验宽松面（接受 user-specified／default:*／
carried-from:* 与 b9 新文法 user_confirmed(ref=stage:training_overrides)；自由文本仍拒
——b8 validate_param_sources 闭集之外的单点前瞻，re-pin b9 后可切真件对账）。
argv：--config/--launch-dir/--out；渲染「需确认 L1」逐项来源表（内核 :147-150 同构）落 --out。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# b9 前瞻宽松文法：user_confirmed(ref=...) 任意括号形态放行（内核 training_prep 段落账串）
KNOWN_SOURCE = re.compile(
    r"^(user-specified|user_confirmed(\(ref=[^)]*\))?|default:.+|carried-from:[A-Za-z0-9][A-Za-z0-9._-]*)$"
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--launch-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    training = config.get("training") or {}
    sources = config.get("param_sources") or {}
    for key, text in sources.items():
        if not KNOWN_SOURCE.match(str(text)):
            print(f"param_source_invalid:param_source_malformed:{key}:{text}", file=sys.stderr)
            return 1
    lines = [
        "# 训练启动前报告（mock·b9 前瞻形态）",
        "",
        "### 需确认(L1:本轮/环境声明,逐项过目)",
        "",
        "| 参数 | 值 | 来源 |",
        "|---|---|---|",
    ]
    for key, value in training.items():
        origin = sources.get(key, "无确认记录(需逐项确认)")
        lines.append(f"| {key} | `{value}` | {origin} |")
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    sys.stdout.write(f"prelaunch report written: {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
