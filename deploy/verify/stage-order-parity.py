#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""段序双源对账探针（单版本源门组件，1107 第二轮实锚机制化）。

内核 STAGE_ORDER(walkthrough_pipeline.py)与 harness PIPELINE_STAGES
(pipelineFace.ts)是跨仓双源——内核加 style_split 而 harness 闭集未同步时，
agent 编排会整段跳过新段（真机实锚：全类分组前置断言失效）。本探针供
check-kernel-single-source.sh 部署前调用，逐项对账。

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


def harness_stages(harness_root: str) -> list[str]:
    """读 harness PIPELINE_STAGES 闭集。

    :param harness_root: harness 仓根。
    :return: 段名列表；不可读返回空列表。
    """
    path = Path(harness_root) / "packages/extensions/atf-tools/src/pipelineFace.ts"
    try:
        match = re.search(
            r"PIPELINE_STAGES: readonly string\[\] = \[([\s\S]*?)\];",
            path.read_text(encoding="utf-8"))
    except OSError:
        return []
    return re.findall(r'"([a-z_]+)"', match.group(1)) if match else []


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
    print("[红] 段序双源漂移:", file=sys.stderr)
    print(f"    内核 STAGE_ORDER({len(kernel)}): {'|'.join(kernel)}", file=sys.stderr)
    print(f"    harness PIPELINE_STAGES({len(harness)}): {'|'.join(harness)}", file=sys.stderr)
    print("    段名闭集是跨仓双源——改内核 STAGE_ORDER 时必须同批同步 pipelineFace.ts"
          " 的 PIPELINE_STAGES（含 STAGE_BUSINESS 业务话）再部署", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
