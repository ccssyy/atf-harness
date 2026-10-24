#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_prelaunch_report mock 对端（E4-乙 H3/改动 3 测试基建，非内核代码）：
模拟内核 b9 形态——param_sources 来源串双形态校验（b9 K4）：字符串历史形态
（user-specified／default:*／carried-from:*）＋结构化映射形态 ``{source, ref}``
（source 闭集 user_confirmed／experiment_train／convention[:<who>]／default[:<依据>]，
ref 必填非空）；自由文本仍拒。「需确认 L1」表把结构化形态投影为 ``source(ref)``
（内核 :150-158 同构）。argv：--config/--launch-dir/--out；渲染落 --out。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_CARRIED_FROM = re.compile(r"^carried-from:[A-Za-z0-9][A-Za-z0-9._-]*$")
# b9 K4 结构化来源 source 闭集（param_sources.py _DICT_SOURCE_EXACT 同构）
_DICT_SOURCE_OK = ("user_confirmed", "experiment_train", "convention", "default")


def _source_ok(raw: object) -> bool:
    """单键来源校验（字符串历史形态＋结构化映射形态；与内核 validate_param_sources 同构）。"""
    if isinstance(raw, str):
        text = raw
        return (
            text.startswith("user-specified")
            or (text.startswith("default:") and text[len("default:"):].strip())
            or _CARRIED_FROM.match(text) is not None
        )
    if isinstance(raw, dict):
        source = str(raw.get("source") or "")
        shaped = (
            source in _DICT_SOURCE_OK
            or source.startswith("convention:")
            or source.startswith("user-specified")
            or (source.startswith("default:") and source[len("default:"):].strip())
        )
        ref = raw.get("ref")
        return shaped and ref is not None and str(ref).strip() != ""
    return False


def _render_source(raw: object) -> str:
    """来源投影（内核 b9 同构：结构化形态渲染为 source(ref)，字符串原样）。"""
    if isinstance(raw, dict):
        source = str(raw.get("source") or "")
        ref = raw.get("ref")
        return f"{source}({ref})" if ref else source
    return str(raw)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--launch-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    training = config.get("training") or {}
    sources = config.get("param_sources") or {}
    for key, raw in sources.items():
        if not _source_ok(raw):
            print(f"param_source_invalid:param_source_malformed:{key}:{raw}", file=sys.stderr)
            return 1
    lines = [
        "# 训练启动前报告（mock·b9 形态）",
        "",
        "### 需确认(L1:本轮/环境声明,逐项过目)",
        "",
        "| 参数 | 值 | 来源 |",
        "|---|---|---|",
    ]
    for key, value in training.items():
        origin = _render_source(sources[key]) if key in sources else "无确认记录(需逐项确认)"
        lines.append(f"| {key} | `{value}` | {origin} |")
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    sys.stdout.write(f"prelaunch report written: {args.out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
