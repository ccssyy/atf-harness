/**
 * D15——evalStatus 选轮四锚：完成轮与最新轮分值（eval_round=最新有 metrics 的轮；
 * latest_round=名称最新；latest_round_incomplete 标记）；只有部分轮 → eval_round=null＋note；
 * 无轮 → 原行为不变；files/service/summary 全取完成轮（不混入部分轮）。不删任何轮目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalStatus } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d15-rounds-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造轮目录：complete=true 写 orch/eval/metrics_summary.json（＋service manifest）；
 *  部分轮可带 stray 文件（不得混入完成轮返回面）。 */
const seedRound = (root: string, runId: string, name: string, complete: boolean, stray = false): void => {
  const orchEval = join(root, runId, "eval", name, "orch", "eval");
  mkdirSync(orchEval, { recursive: true });
  if (complete) {
    writeFileSync(join(orchEval, "metrics_summary.json"), JSON.stringify({ model: `${runId}_c1`, micro: { f1: 0.5 } }));
    const svc = join(root, runId, "eval", name, "service", "service");
    mkdirSync(svc, { recursive: true });
    writeFileSync(join(svc, "service_receipt.json"), JSON.stringify({ status: "ready" }));
    const svcRoot = join(root, runId, "eval", name, "service");
    writeFileSync(join(svcRoot, "service_manifest.json"), JSON.stringify({ expected_model_names: [`${runId}_c1`] }));
    for (const f of ["raw_predictions.jsonl", "badcases.jsonl", "indexes.csv"]) writeFileSync(join(orchEval, f), "{}\n");
  }
  if (stray) writeFileSync(join(orchEval, "raw_predictions.jsonl"), "{}\n"); // 部分轮散件
};

const cfg = (runsRoot: string) => ({ runsRoot, kernelDir: runsRoot });

describe("D15 evalStatus 选轮", () => {
  it("①完整轮＋其后两个部分轮 → eval_round=完整轮、latest_round=最后部分轮、incomplete=true", async () => {
    const root = tempRoot();
    seedRound(root, "r1", "1-20260101", true);
    seedRound(root, "r1", "2-20260102", false);
    seedRound(root, "r1", "3-20260103", false);
    const out = await evalStatus("r1", cfg(root)) as Record<string, unknown>;
    expect(out.eval_round).toBe(join(root, "r1", "eval", "1-20260101"));
    expect(out.latest_round).toBe("3-20260103");
    expect(out.latest_round_incomplete).toBe(true);
    expect(out.files).toEqual(["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]);
    expect(out.metrics_summary).toMatchObject({ model: "r1_c1" });
  });

  it("②只有部分轮 → eval_round=null＋note「尚无完成的评估轮」＋latest_round 有值", async () => {
    const root = tempRoot();
    seedRound(root, "r2", "5-20260201", false);
    seedRound(root, "r2", "6-20260202", false);
    const out = await evalStatus("r2", cfg(root)) as Record<string, unknown>;
    expect(out.eval_round).toBeNull();
    expect(out.note).toBe("尚无完成的评估轮");
    expect(out.latest_round).toBe("6-20260202");
    expect(out.latest_round_incomplete).toBe(true);
    expect(out.files).toBeUndefined();
    expect(out.metrics_summary).toBeUndefined();
  });

  it("③无轮 → 原行为不变（note 无评估轮目录；无 latest_round）", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "r3"), { recursive: true });
    const out = await evalStatus("r3", cfg(root)) as Record<string, unknown>;
    expect(out.note).toBe("无评估轮目录——先 start");
    expect(out.eval_round).toBeUndefined();
    expect(out.latest_round).toBeUndefined();
  });

  it("④files/service/summary 全取完成轮（部分轮 stray 文件不混入）；单完成轮＝latest 同值无 incomplete 标记", async () => {
    const root = tempRoot();
    seedRound(root, "r4", "1-20260101", false, true); // 部分轮带 stray raw_predictions
    seedRound(root, "r4", "2-20260102", true);
    const out = await evalStatus("r4", cfg(root)) as Record<string, unknown>;
    expect(out.eval_round).toBe(join(root, "r4", "eval", "2-20260102"));
    expect(out.latest_round).toBe("2-20260102");
    expect(out.latest_round_incomplete).toBeUndefined();
    expect(out.files).toEqual(["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]);
    const svc = out.service as Record<string, unknown>;
    expect(svc).toMatchObject({ status: "ready" });
    expect(out.model_matches_manifest).toBe(true);
  });
});
