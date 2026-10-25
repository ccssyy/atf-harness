/**
 * E9a·H1b parity——docSlots.listDocSlots 与内核 tools/list_doc_slots.py --json 对账
 * （ADR-0017 决定 12：两侧任何一张另起路径表即本次漂移复现——本测试是那颗钉）。
 *
 * 三 fixture（N=1／N=2／legacy 平铺）自建于 tmpdir，逐类 12 键逐项相等（路径绝对串、
 * 未发布 None 化、lanes 排序）；legacy fallback 面（根级候选＋publish 直下 8hex）同比对。
 * 运行前提：ATF_CLI_PATH 指向 pin 上的内核树（缺省 .atf-pinned；不在场整组跳过——
 * 与 contract.pin.test.ts 同式；收口批 CI 恒在场，不等即红）。
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atfCliPathFromEnv } from "../../src/bridge/atfCommand.js";
import {
  listDocSlots,
  legacyCandidatePath,
  legacyPublishWorkspaces,
  type DocSlot,
} from "../../packages/extensions/atf-ui/src/docSlots.js";

const cliPath = atfCliPathFromEnv();
const describeIfPinned = cliPath.ok ? describe : describe.skip;

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e9a-parity-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 单类槽位夹具（对齐内核 b13+ canonical 产物面）：train.jsonl＋field-config＋
 *  发布工作区（含 manifest lanes 与 eval 资产目录）。attempt＝8hex。 */
const seedClass = (
  runDir: string,
  docType: string,
  opts: { lanes?: string[]; published?: boolean } = {},
): void => {
  mkdirSync(join(runDir, "prep", "variants", docType), { recursive: true });
  writeFileSync(join(runDir, "prep", "variants", docType, "train.jsonl"), '{"row":"x"}\n');
  mkdirSync(join(runDir, "experiment-setup", docType), { recursive: true });
  writeFileSync(join(runDir, "experiment-setup", docType, "field-config.json"), "{}\n");
  if (opts.published === false) return;
  const attempt = `a1b2c3${docType.length === 2 ? "0" + docType[0] : "0d0"}`.slice(0, 8);
  const ws = join(runDir, "publish", docType, attempt);
  mkdirSync(join(ws, "eval"), { recursive: true });
  const lanes = Object.fromEntries((opts.lanes ?? [`${docType}_goods`]).map((lane) => [lane, { rows: 1 }]));
  writeFileSync(join(ws, "training-data-manifest.json"), `${JSON.stringify({ lanes }, null, 1)}\n`);
  writeFileSync(join(ws, "split-manifest.json"), "{}\n");
  writeFileSync(join(ws, "eval", "eval_labels.jsonl"), '{"label":"x"}\n');
};

/** 内核 CLI --json 输出（单行 JSON；退出码非 0 即失败）。 */
const kernelSlotsJson = (runDir: string): Promise<{
  doc_slots: Array<Record<string, unknown>>;
  legacy: { candidate_path: string; publish_workspaces: string[] };
}> =>
  new Promise((resolve, reject) => {
    execFile(
      "python3",
      [join(cliPath.ok ? cliPath.value : "", "tools", "list_doc_slots.py"), "--run", runDir, "--json"],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`list_doc_slots.py 失败: ${String(stderr).slice(0, 500)}`));
        else resolve(JSON.parse(String(stdout)) as Parameters<typeof resolve>[0]);
      },
    );
  });

/** 单类 12 键逐项相等断言（harness DocSlot ↔ 内核投影）。 */
const expectSlotEqual = (ours: DocSlot, theirs: Record<string, unknown>, context: string): void => {
  expect(
    {
      doc_type: ours.doc_type,
      slot_dir: ours.slot_dir,
      candidate_path: ours.candidate_path,
      variants_dir: ours.variants_dir,
      train_jsonl: ours.train_jsonl,
      field_config: ours.field_config,
      publish_ws: ours.publish_ws,
      attempt: ours.attempt,
      eval_assets_dir: ours.eval_assets_dir,
      split_manifest: ours.split_manifest,
      training_data_manifest: ours.training_data_manifest,
      lanes: ours.lanes,
    },
    `${context}:${ours.doc_type} 12 键投影不等`,
  ).toEqual(theirs);
};

describeIfPinned("E9a·H1b parity——docSlots.ts ↔ tools/list_doc_slots.py --json（三 fixture 逐项相等，不等即红）", () => {
  it("N=1：单类全产物（发布＋manifest lanes）逐键相等；legacy 面空 publish", async () => {
    const runDir = tempRoot();
    seedClass(runDir, "do", { lanes: ["do_goods"] });
    const [ours, theirs] = await Promise.all([Promise.resolve(listDocSlots(runDir)), kernelSlotsJson(runDir)]);
    expect(ours).toHaveLength(1);
    expect(theirs.doc_slots).toHaveLength(1);
    expectSlotEqual(ours[0]!, theirs.doc_slots[0]!, "N=1");
    expect(theirs.legacy.publish_workspaces).toEqual([]);
    expect(theirs.legacy.candidate_path).toBe(legacyCandidatePath(runDir));
  });

  it("N=2：两类（含双 lane 类与未发布类混合——未发布四键 None 化/空表不造假）逐键相等", async () => {
    const runDir = tempRoot();
    seedClass(runDir, "do", { lanes: ["do_goods"] });
    seedClass(runDir, "swb", { lanes: ["swb_goods", "swb_docs"] });
    // 未发布类：槽位在（train.jsonl）但无 attempt——评估面四键 None/空表
    mkdirSync(join(runDir, "prep", "variants", "raw"), { recursive: true });
    writeFileSync(join(runDir, "prep", "variants", "raw", "train.jsonl"), '{"row":"x"}\n');
    const [ours, theirs] = await Promise.all([Promise.resolve(listDocSlots(runDir)), kernelSlotsJson(runDir)]);
    expect(ours.map((slot) => slot.doc_type)).toEqual(["do", "raw", "swb"]);
    for (let i = 0; i < ours.length; i += 1) expectSlotEqual(ours[i]!, theirs.doc_slots[i]!, "N=2");
    const raw = ours.find((slot) => slot.doc_type === "raw")!;
    expect(raw.publish_ws).toBeNull();
    expect(raw.eval_assets_dir).toBeNull();
    expect(raw.split_manifest).toBeNull();
    expect(raw.training_data_manifest).toBeNull();
    expect(raw.lanes).toEqual([]);
    const swb = ours.find((slot) => slot.doc_type === "swb")!;
    expect(swb.lanes).toEqual(["swb_docs", "swb_goods"]); // 排序与内核 sorted 同式
  });

  it("legacy 平铺：无单据子目录 → 两侧槽位表均空；legacy fallback 面（根候选＋publish 直下 8hex）相等", async () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "prep", "variants"), { recursive: true });
    writeFileSync(join(runDir, "prep", "variants", "train.jsonl"), '{"row":"x"}\n'); // run 级合并件不构成类
    writeFileSync(join(runDir, "contract-candidate.json"), "{}\n");
    mkdirSync(join(runDir, "publish", "0a1b2c3d"), { recursive: true });
    const [ours, theirs] = await Promise.all([Promise.resolve(listDocSlots(runDir)), kernelSlotsJson(runDir)]);
    expect(ours).toEqual([]);
    expect(theirs.doc_slots).toEqual([]);
    expect(theirs.legacy.candidate_path).toBe(legacyCandidatePath(runDir));
    expect(theirs.legacy.publish_workspaces).toEqual(legacyPublishWorkspaces(runDir));
    expect(theirs.legacy.publish_workspaces).toEqual([join(runDir, "publish", "0a1b2c3d")]);
  });
});
