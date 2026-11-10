/**
 * D96/ADR-0021 段对齐锚——管线合同以内核 STAGE_ORDER 为权威；灯面以注册表 V2 为权威
 * （D264 owner 裁定：段灯全生命周期覆盖，取代 D96「灯面只含管线段」边界）。
 *
 * 断言面（映射表单源＋逐键相等）：
 *   ① 管线合同三清单逐键相等：pipelineFace PIPELINE_STAGES（内核 STAGE_ORDER 的 TS 权威
 *      声明）＝segmentFacts 映射表键序＝runFacts SEGMENT_ORDER＝管线 9 段（CLI 合同不变）；
 *      灯面两载体（snapshot SEGMENTS／atf-ui server SEGMENT_ORDER_KEYS）＝STAGE_REGISTRY_ORDER
 *      从 register 起 14 段（管线 9+snapshot+训练后 4）；
 *   ② 映射恒等：SEGMENT_FACT_BY_KERNEL_STAGE 逐键 值＝键（UI 段键名＝内核段名）；
 *   ③ 独立键不占灯：training/evaluate 不在任何灯面清单（训练态独立卡承载不变）；
 *   ④ 快照段灯数组＝14 元素键序一致；训练/评估态在 scanRunDir segments 返回面
 *      独立承载（不占灯但保留独立卡数据源）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIPELINE_STAGES, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { SEGMENT_ORDER } from "../../src/core/workspace/runFacts.js";
import { STAGE_REGISTRY_ORDER } from "../../src/core/generated/stageOrder.js";
import { SEGMENTS, buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { SEGMENT_ORDER_KEYS, scanRunDirAt } from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D96 段清单对齐内核 STAGE_ORDER（映射表单源＋逐键相等）", () => {
  it("① 清单对齐（G5 收敛/G1a 新序＋D264/ADR-0021 灯面全生命周期）：管线合同=9 段；灯面=注册表 register 起 14 段", () => {
    const mappingKeys = Object.keys(SEGMENT_FACT_BY_KERNEL_STAGE);
    // 管线段序 G1a 新序（工具面 CLI 合同，D264 不改——段调用面不受灯面扩域影响）
    expect(PIPELINE_STAGES).toEqual([
      "register", "label_qc", "style_split", "experiment_setup", "family_split", "candidate_build", "publish", "admission", "training_prep",
    ]);
    expect(mappingKeys).toEqual(PIPELINE_STAGES);
    expect(SEGMENT_ORDER).toEqual(PIPELINE_STAGES);
    // 灯面单源：STAGE_REGISTRY_ORDER 从 register 起（9 管线+snapshot+训练后 4=14 段）
    const lifecycleOrder = STAGE_REGISTRY_ORDER.slice(STAGE_REGISTRY_ORDER.indexOf("register"));
    expect(SEGMENT_ORDER_KEYS).toEqual(lifecycleOrder);
    expect(SEGMENTS.map((s) => s.key)).toEqual(lifecycleOrder);
    expect(lifecycleOrder).toHaveLength(14);
    // 前置 3 段（contract/ingest/inspect——batch 素材直启 run 不经过）折叠不进灯面
    for (const key of ["contract", "ingest", "inspect"]) {
      expect(SEGMENT_ORDER_KEYS).not.toContain(key);
    }
  });

  it("② 映射恒等：内核段名→同名 UI 段键（D96 键名一一对应，无第二套键）", () => {
    for (const stage of PIPELINE_STAGES) {
      expect(SEGMENT_FACT_BY_KERNEL_STAGE[stage]).toBe(stage);
    }
  });

  it("③ 训练执行/评估不占段灯：training/evaluate 不在任何段灯清单", () => {
    for (const key of ["training", "evaluate"]) {
      expect(PIPELINE_STAGES).not.toContain(key);
      expect(SEGMENT_ORDER_KEYS).not.toContain(key);
      expect(SEGMENTS.map((s) => s.key)).not.toContain(key);
    }
  });

  it("④ 快照段灯数组＝九元素键序一致；独立卡态在 scanRunDir segments 返回面承载", () => {
    const snap = buildMonitorSnapshot([
      {
        run_id: "run-d96",
        segments: {
          register: true, label_qc: true, experiment_setup: true, style_split: true,
          candidate_build: true, publish: true, family_split: true, admission: true, training_prep: true,
          training: true, evaluate: true,
        },
        training: { active: false },
      },
    ], undefined, []);
    expect(snap.runs[0]?.segments.map((s) => s.key)).toEqual(SEGMENT_ORDER_KEYS);
    expect(snap.runs[0]?.segments).toHaveLength(14);
    expect(snap.runs[0]?.segments.filter((s) => s.status === "done").map((s) => s.key)).toEqual(PIPELINE_STAGES);
    // 扫描面：launch/train.sh（admission 锚）在盘 → training/evaluate 独立键保留（false 态）
    const root = mkdtempSync(join(tmpdir(), "d96-scan-"));
    tempRoots.push(root);
    mkdirSync(join(root, "launch"), { recursive: true });
    writeFileSync(join(root, "launch", "train.sh"), "#!/bin/bash\n", "utf8");
    const scan = scanRunDirAt(root, "run-d96-scan");
    expect(scan.segments.training).toBe(false);
    expect(scan.segments.evaluate).toBe(false);
    expect(scan.segments.admission).toBe(true);
  });
});
