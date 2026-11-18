#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# @Time   : 2026/11/18
# @Author : SamChen
# @File   : build_decisions_replay.py
"""M6 预演回放资产：外部 fixture 加载→内核单源产 IterationDecisionSet/v1 完整集。

数据件=同目录 fixtures/wave2-replay.json（改法①：运行时从外部用例加载——
evals-guard 指路形态）；assess status=evidence_gap（诚实停止）也是合法 propose
产物——C2 内容闸按 status 同源对账。引擎替身调用（不经 LLM），驱动器步骤内
如实记录。

用法: build_decisions_replay.py <输出decisions目录>
"""
import json
import os
import sys
from pathlib import Path

# 内核 src 由调用方 PYTHONPATH 注入（D318 verdict blocker②：本文件零硬编码主机路径）
sys.path.insert(0, os.environ.get("ATF_KERNEL_SRC", ""))
from agentic_training_flow.application.agent_mainline.wave2_suggestion import (  # noqa: E402
    assess_wave2_workspace,
    write_wave2_suggestion_artifacts,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "wave2-replay.json"


def build(output_dir: Path) -> str:
    """加载 fixture 构造最小 Wave2 工作区并产出 decisions 集。

    :param output_dir: decisions 输出目录（run 的 analysis/decisions）。
    :return: assessment status（evidence_gap=诚实停止形态）。
    """
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    workspace = output_dir.parent / "wave2-replay-workspace"
    _write_json(workspace / "output" / "metric-parity.json", fixture["metric_parity"])
    _write_json(workspace / "output" / "agent-work-result.json", fixture["agent_work_result"])
    _write_json(workspace / "input-output-manifest.json", {
        "schema_version": "Wave2LiveIntegrationInputOutputManifest/v1",
        "inputs": fixture["manifest_inputs"],
        "outputs": fixture["manifest_outputs"],
    })
    assessment = assess_wave2_workspace(workspace)
    write_wave2_suggestion_artifacts(assessment, output_dir)
    return str(assessment.status)


def _write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: build_decisions_replay.py <输出decisions目录>", file=sys.stderr)
        raise SystemExit(3)
    print(f"decisions set written: status={build(Path(sys.argv[1]))}")
