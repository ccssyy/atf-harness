/**
 * 批㊶-M 测试锚——段事实轨（优先/兜底/append 幂等）＋锚兼容三例＋四态映射纯函数＋
 * dock 分组数据选择（活跃卡过滤）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSegmentFact, hasSegmentFact, readSegmentFacts } from "../../src/core/workspace/segmentFacts.js";
import { scanRunDir } from "../../packages/extensions/atf-ui/src/server.js";
import { taskStateOf } from "../../packages/extensions/atf-ui/src/client.taskState.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-m-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-M M-3 段事实轨（webui/segments.json）", () => {
  it("append 幂等（同段同源不重复）＋读回形态 {segment,at,source}", () => {
    const runDir = tempRoot();
    appendSegmentFact(runDir, "register", "atf_admit_data");
    appendSegmentFact(runDir, "register", "atf_admit_data");
    appendSegmentFact(runDir, "training", "atf_run_training");
    const facts = readSegmentFacts(runDir);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ segment: "register", source: "atf_admit_data" });
    expect(hasSegmentFact(runDir, "register")).toBe(true);
    expect(hasSegmentFact(runDir, "split")).toBe(false);
  });

  it("段轨优先于启发式锚：segments.json 有 register 而无 registration.json → 段仍 done", () => {
    const root = tempRoot();
    const runDir = join(root, "run-fact");
    appendSegmentFact(runDir, "register", "atf_admit_data");
    const scan = scanRunDir(root, "run-fact");
    expect(scan.segments.register).toBe(true);
  });

  it("锚兜底：无事实轨时启发式照旧（registration.json 在场 done／全缺 false）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-anchor");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    expect(scanRunDir(root, "run-anchor").segments.register).toBe(true);
    expect(scanRunDir(root, "run-anchor").segments.label_qc).toBe(false);
  });

  it("坏行如实空数组（segments.json 非法 JSON 不炸不猜）", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "segments.json"), "{broken");
    expect(readSegmentFacts(runDir)).toEqual([]);
  });
});

/** 批㊶-N 段序守卫下锚兜底夹具：前序段锚全成立（守卫不抑制本段锚兜底）。 */
function seedPredecessors(runDir: string): void {
  for (const [dir, file] of [["", "registration.json"], ["", "label_qc"], ["webui", "config-snapshot.json"], ["", "contract-candidate.json"], ["", "split"], ["launch", "train.sh"]] as Array<[string, string]>) {
    mkdirSync(join(runDir, dir), { recursive: true });
    writeFileSync(join(runDir, dir, file), "{}");
  }
}

describe("批㊶-M 锚兼容三例", () => {
  it("admission：training/train.sh 在场即 done（launch/train.sh 兜底保持；前序成立下锚兜底）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-adm");
    seedPredecessors(runDir);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "train.sh"), "#!/bin/bash\n");
    expect(scanRunDir(root, "run-adm").segments.admission).toBe(true);
    const root2 = tempRoot();
    const runDir2 = join(root2, "run-adm2");
    seedPredecessors(runDir2);
    expect(scanRunDir(root2, "run-adm2").segments.admission).toBe(true);
  });

  it("evaluate：逐轮目录 eval/<round>/metrics_summary.json 在场即 done（顶层锚保持；前序成立下锚兜底）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-eval");
    seedPredecessors(runDir);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), "[]");
    mkdirSync(join(runDir, "eval", "2-20261008"), { recursive: true });
    writeFileSync(join(runDir, "eval", "2-20261008", "metrics_summary.json"), "{}");
    expect(scanRunDir(root, "run-eval").segments.evaluate).toBe(true);
    const root2 = tempRoot();
    const runDir2 = join(root2, "run-eval-top");
    seedPredecessors(runDir2);
    mkdirSync(join(runDir2, "training"), { recursive: true });
    writeFileSync(join(runDir2, "training", "loss-series.json"), "[]");
    mkdirSync(join(runDir2, "eval"), { recursive: true });
    writeFileSync(join(runDir2, "eval", "metrics_summary.json"), "{}");
    expect(scanRunDir(root2, "run-eval-top").segments.evaluate).toBe(true);
  });

  it("publish：contract-candidate.json 在场即 done（segment-* 报告兜底保持；前序成立下锚兜底）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-pub");
    seedPredecessors(runDir);
    writeFileSync(join(runDir, "contract-candidate.json"), "{}");
    expect(scanRunDir(root, "run-pub").segments.publish).toBe(true);
  });
});

describe("批㊶-M M-4 四态映射纯函数（taskStateOf）", () => {
  const run = (trainingActive: boolean, statuses: string[]) => ({
    run_id: "r",
    training: { active: trainingActive },
    segments: statuses.map((status, idx) => ({ key: "s" + idx, status })),
  });

  it("训练中→active；失败段→fail；任一 done→done；全空→idle", () => {
    expect(taskStateOf(null, run(true, ["pending", "active", "pending"]))).toBe("active");
    expect(taskStateOf(null, run(false, ["done", "fail", "pending"]))).toBe("fail");
    expect(taskStateOf(null, run(false, ["done", "pending"]))).toBe("done");
    expect(taskStateOf(null, run(false, ["pending", "pending"]))).toBe("idle");
    expect(taskStateOf(null, null)).toBe("idle");
  });
});
