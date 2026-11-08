/**
 * D96 段对齐锚——UI 段清单以内核 STAGE_ORDER 为唯一权威（owner 裁定）。
 *
 * 断言面（映射表单源＋逐键相等）：
 *   ① 四清单逐键相等：pipelineFace PIPELINE_STAGES（内核 STAGE_ORDER 的 TS 权威声明）＝
 *      segmentFacts 映射表键序＝runFacts SEGMENT_ORDER＝snapshot SEGMENTS 键序＝
 *      atf-ui server SEGMENT_ORDER_KEYS；
 *   ② 映射恒等：SEGMENT_FACT_BY_KERNEL_STAGE 逐键 值＝键（UI 段键名＝内核段名）；
 *   ③ 训练执行/评估不占段灯：两清单均不含 training/evaluate；
 *   ④ 快照段灯数组＝八元素且键序一致；训练/评估态在 scanRunDir segments 返回面
 *      独立承载（不占灯但保留独立卡数据源）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIPELINE_STAGES, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { SEGMENT_ORDER } from "../../src/core/workspace/runFacts.js";
import { SEGMENTS, buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { SEGMENT_ORDER_KEYS, scanRunDirAt } from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D96 段清单对齐内核 STAGE_ORDER（映射表单源＋逐键相等）", () => {
  it("① 两族清单对齐（G5/ADR-0020）：工具面=管线 9 段新序；灯面=v2 全段 17 段", () => {
    const mappingKeys = Object.keys(SEGMENT_FACT_BY_KERNEL_STAGE);
    // 工具面(CLI 合同):KERNEL_STAGE_ORDER 管线段序(G1a 新序)
    expect(PIPELINE_STAGES).toEqual([
      "register", "label_qc", "style_split", "experiment_setup", "family_split", "candidate_build", "publish", "admission", "training_prep",
    ]);
    // 灯面(段灯/快照):映射表键=SEGMENT_ORDER=SEGMENTS 键=SEGMENT_ORDER_KEYS=v2 全段
    expect(mappingKeys).toEqual([...SEGMENT_ORDER]);
    expect(SEGMENT_ORDER).toHaveLength(17);
    expect(SEGMENT_ORDER[0]).toBe("contract");
    expect(SEGMENT_ORDER_KEYS).toEqual([...SEGMENT_ORDER]);
    expect(SEGMENTS.map((s) => s.key)).toEqual([...SEGMENT_ORDER]);
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
    expect(snap.runs[0]?.segments).toHaveLength(9);
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
