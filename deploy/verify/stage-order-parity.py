#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""段序单源哨兵（单版本源门组件；R1 结构单源化后由五载体对账降级为生成物哨兵）。

R1 起段序为结构单源:内核 STAGE_ORDER 唯一源 → codegen 生成物(ts+js) →
六载体 import/派生,手写字面量已退役。本哨兵对账:
①内核 CLI(--print-stage-order 机器面)与 harness 生成物逐项一致;
②六载体文件不得再含手写段序字面量(防回潮——有人手写即红)。
供 check-kernel-single-source.sh 部署前调用。

用法: stage-order-parity.py <kernel_repo_root> <harness_repo_root>
一致退出 0;漂移/不可读/回潮退出 2(报文含修复指令)。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

#: R1 后的消费面文件(六载体):其中任一再出现手写段序字面量=回潮
CARRIER_FILES = [
    "packages/extensions/atf-tools/src/pipelineFace.ts",
    "packages/extensions/atf-ui/src/server.ts",
    "src/core/workspace/runFacts.ts",
    "packages/extensions/atf-ui/src/snapshot.js",
    "packages/extensions/atf-ui/src/panel.ts",
    "src/core/workspace/segmentFacts.ts",
]

#: 手写回潮特征:连续两个及以上段键的字符串字面量序列(生成物文件除外)
_HANDWRITTEN = re.compile(r"[\"'](register|label_qc)[\"]\s*,\s*[\"']")


def kernel_stages(kernel_root: str) -> list[str]:
    """经内核 CLI 机器面读段序(--print-stage-order,与 --stage choices 同源)。

    :param kernel_root: 内核仓根。
    :return: 段名列表;CLI 失败返回空列表。
    """
    script = Path(kernel_root) / "skills/atf-admit-training-data/scripts/walkthrough_pipeline.py"
    try:
        out = subprocess.run(
            ["python3", str(script), "--print-stage-order"],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        stages = json.loads(out)
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    return stages if isinstance(stages, list) and stages else []


def harness_stages(harness_root: str) -> list[str]:
    """读 harness 生成物唯一对账面(src/core/generated/stageOrder.ts)。

    :param harness_root: harness 仓根。
    :return: 段名列表;不可读/形态非法返回空列表。
    """
    path = Path(harness_root) / "src/core/generated/stageOrder.ts"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    match = re.search(r"KERNEL_STAGE_ORDER[^=]*=\s*(\[.*?\])\s*;", text, re.DOTALL)
    if not match:
        return []
    try:
        stages = json.loads(match.group(1).replace("'", '"'))
    except ValueError:
        return []
    return stages if isinstance(stages, list) and all(isinstance(s, str) for s in stages) else []


def handwritten_backsliders(harness_root: str) -> list[str]:
    """扫六载体文件,返回重新出现手写段序字面量的文件(防回潮)。

    :param harness_root: harness 仓根。
    :return: 回潮文件相对路径列表(空=无回潮)。
    """
    backsliders: list[str] = []
    for rel in CARRIER_FILES:
        try:
            text = (Path(harness_root) / rel).read_text(encoding="utf-8")
        except OSError:
            backsliders.append(rel + " (不可读)")
            continue
        if _HANDWRITTEN.search(text):
            backsliders.append(rel)
    return backsliders


def main(argv: list[str]) -> int:
    """哨兵对账:内核 CLI 与生成物一致 + 无手写回潮。

    :param argv: [内核仓根, harness 仓根]。
    :return: 一致 0;漂移/回潮 2(报文含修复指令)。
    """
    if len(argv) != 2:
        print("用法: stage-order-parity.py <kernel_repo_root> <harness_repo_root>", file=sys.stderr)
        return 2
    kernel = kernel_stages(argv[0])
    harness = harness_stages(argv[1])
    if not kernel or not harness:
        print(f"[红] 段序哨兵不可读:内核 CLI {len(kernel)} 项 / harness 生成物 {len(harness)} 项"
              "——先核对内核 --print-stage-order 与 src/core/generated/stageOrder.ts 再部署", file=sys.stderr)
        return 2
    if kernel != harness:
        print("[红] 段序漂移(内核 vs harness 生成物):", file=sys.stderr)
        print(f"    内核 CLI({len(kernel)}): {'|'.join(kernel)}", file=sys.stderr)
        print(f"    harness 生成物({len(harness)}): {'|'.join(harness)}", file=sys.stderr)
        print("    修复:内核改段序后,在 harness 仓重跑 npm run codegen:stage-order"
              " 并随批提交生成物,再部署", file=sys.stderr)
        return 2
    backsliders = handwritten_backsliders(argv[1])
    if backsliders:
        print("[红] 段序手写字面量回潮(R1 后六载体只准 import 生成物):", file=sys.stderr)
        for rel in backsliders:
            print(f"    {rel}", file=sys.stderr)
        print("    修复:删除手写字面量改为 import src/core/generated/stageOrder", file=sys.stderr)
        return 2
    print(f"[绿] 段序单源哨兵通过(内核 CLI=生成物 STAGE_ORDER={'|'.join(kernel)};六载体零手写回潮)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
