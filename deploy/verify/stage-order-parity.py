#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""段序双源对账探针（单版本源门组件，1107 第二轮实锚机制化）。

内核 STAGE_ORDER(walkthrough_pipeline.py)与 harness 的**五个段序载体**
（pipelineFace.PIPELINE_STAGES / atf-ui server.SEGMENT_ORDER_KEYS /
core runFacts.SEGMENT_ORDER / atf-ui snapshot.SEGMENTS / atf-ui panel.SEGMENTS）
是跨仓多源——内核加 style_split 而任一 harness 载体未同步时，agent 编排或
UI 段灯会整段跳过新段（真机两轮实锚）。本探针供 check-kernel-single-source.sh
部署前调用，全部载体逐项对账。

用法: stage-order-parity.py <kernel_repo_root> <harness_repo_root>
一致性退出 0（stdout 打印绿行）；漂移退出 2 并打印双清单+修复指令。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def kernel_stages(kernel_root: str) -> list[str]:
    """读内核 STAGE_ORDER 闭集。

    :param kernel_root: 内核仓根。
    :return: 段名列表；不可读返回空列表。
    """
    path = Path(kernel_root) / "skills/atf-admit-training-data/scripts/walkthrough_pipeline.py"
    try:
        match = re.search(r"STAGE_ORDER = \((.*?)\)", path.read_text(encoding="utf-8"), re.DOTALL)
    except OSError:
        return []
    return re.findall(r'"([a-z_]+)"', match.group(1)) if match else []


#: harness 段序载体清单:文件相对路径 → 段名提取正则。
HARNESS_CARRIERS: list[tuple[str, str]] = [
    ("packages/extensions/atf-tools/src/pipelineFace.ts",
     r"PIPELINE_STAGES: readonly string\[\] = \[([\s\S]*?)\];"),
    ("packages/extensions/atf-ui/src/server.ts",
     r"SEGMENT_ORDER_KEYS: readonly string\[\] = \[([\s\S]*?)\];"),
    ("src/core/workspace/runFacts.ts",
     r"SEGMENT_ORDER: readonly string\[\] = \[([\s\S]*?)\];"),
    ("packages/extensions/atf-ui/src/snapshot.js",
     r"export const SEGMENTS = \[([\s\S]*?)\];"),
    ("packages/extensions/atf-ui/src/panel.ts",
     r"const SEGMENTS = \[([\s\S]*?)\];"),
]


def harness_stages(harness_root: str) -> list[str]:
    """读 harness 五个段序载体，全部一致才返回（任一缺失/分歧返回空表=按漂移处置）。

    :param harness_root: harness 仓根。
    :return: 一致的段名列表；任一载体不可读或载体间分歧返回空列表。
    """
    readings: list[list[str]] = []
    for rel, pattern in HARNESS_CARRIERS:
        path = Path(harness_root) / rel
        try:
            match = re.search(pattern, path.read_text(encoding="utf-8"))
        except OSError:
            return []
        readings.append(re.findall(r"['\"]([a-z_]+)['\"]", match.group(1)) if match else [])
    first = readings[0]
    if not first or any(r != first for r in readings[1:]):
        return []
    return first


def main(argv: list[str]) -> int:
    """对账双源段序。

    :param argv: [内核仓根, harness 仓根]。
    :return: 一致 0；漂移或不可读 2（漂移报文含修复指令）。
    """
    if len(argv) != 2:
        print("用法: stage-order-parity.py <kernel_repo_root> <harness_repo_root>", file=sys.stderr)
        return 2
    kernel = kernel_stages(argv[0])
    harness = harness_stages(argv[1])
    if not kernel or not harness:
        print(f"[红] 段序探针不可读:内核 {len(kernel)} 项 / harness {len(harness)} 项"
              "（双源解析失败即按漂移处置——先核对两个源文件再部署）", file=sys.stderr)
        return 2
    if kernel == harness:
        print(f"[绿] 段序双源一致(STAGE_ORDER={'|'.join(kernel)})")
        return 0
    print("[红] 段序多源漂移(内核或 harness 某载体不一致):", file=sys.stderr)
    print(f"    内核 STAGE_ORDER({len(kernel)}): {'|'.join(kernel)}", file=sys.stderr)
    print(f"    harness 载体读数({'一致' if harness else '载体缺失/分歧'}): {'|'.join(harness) if harness else '(空)'}", file=sys.stderr)
    print("    段序跨仓多源(五载体)——改内核 STAGE_ORDER 时必须同批同步 harness 全部载体"
          "(pipelineFace.PIPELINE_STAGES/server.SEGMENT_ORDER_KEYS/runFacts.SEGMENT_ORDER/"
          "snapshot.SEGMENTS/panel.SEGMENTS,含 STAGE_BUSINESS 业务话)再部署", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
