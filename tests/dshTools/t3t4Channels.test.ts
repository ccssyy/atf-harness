/**
 * T3/T4 通道回归锚（owner 2026-10-26 第二轮）。
 *
 * T3 卡位通道：training_prep 段 visible_devices 的「显式 > 确认快照 > 不下传」来源链
 *   （此前快照里的卡位永远到不了启动件——「卡面选了卡位却不生效」）；形态非法即拒。
 * T4 像素对不变量：段参数通道补两条硬约束（上限两档闭集／下限锚定惯例基线），
 *   越界即拒、不静默纠正（此前只有确认卡 overrides 分支有）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool, resolveVisibleDevices, snapshotVisibleDevicesOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { TRAINING_PIN_CONSTANTS } from "../../src/core/workspace/smartDefaults.js";

const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "t3t4-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface DshToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const fakeExec = { agent: { session: { id: "t3t4" } }, callId: "t3t4-1", signal: undefined };
const approvalCtx = (record: string[]) => ({
  get: (service: string) => (service === "approval" ? { request: async (req: { reason?: string }) => { record.push(req?.reason ?? ""); return "allowed-once"; } } : undefined),
});
const toolOf = (record: string[] = []): DshToolLike =>
  buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike;
const summaryArgv = (result: unknown): string[] => ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);
const writeSnapshot = (runDir: string, confirmed: Record<string, string>): void => {
  mkdirSync(join(runDir, "webui"), { recursive: true });
  writeFileSync(join(runDir, "webui", "config-snapshot.json"), `${JSON.stringify({ schema_version: "WebUiConfigSnapshot/v1", confirmed }, null, 1)}\n`, "utf8");
};

describe("T3 卡位通道（显式 > 确认快照 > 不下传）", () => {
  it("纯函数：显式优先；快照兜底；两者皆无＝deploy_default", () => {
    const runDir = join(tempRoot(), "runs", "r1");
    writeSnapshot(runDir, { visible_devices: "4,5,6,7" });
    expect(resolveVisibleDevices({ visible_devices: "0-1" }, runDir)).toEqual({ ok: true, value: "0-1", source: "user_specified" });
    expect(resolveVisibleDevices({}, runDir)).toEqual({ ok: true, value: "4,5,6,7", source: "config_snapshot" });
    expect(resolveVisibleDevices({}, join(tempRoot(), "runs", "absent"))).toEqual({ ok: true, value: "", source: "deploy_default" });
    expect(snapshotVisibleDevicesOf(join(tempRoot(), "runs", "absent"))).toBe("");
  });
  it("纯函数：形态非法即拒（显式与快照两侧；不静默纠正）", () => {
    const runDir = join(tempRoot(), "runs", "r2");
    writeSnapshot(runDir, { visible_devices: "4,4" });
    const fromExplicit = resolveVisibleDevices({ visible_devices: "8,9" }, runDir);
    expect(fromExplicit.ok).toBe(false);
    expect(fromExplicit.ok === false && fromExplicit.error).toBe("visible_devices_invalid");
    const fromSnapshot = resolveVisibleDevices({}, runDir);
    expect(fromSnapshot.ok).toBe(false);
    expect(fromSnapshot.ok === false && fromSnapshot.note).toContain("确认快照");
  });
  it("段通道：快照有卡位而参数没给 → argv 带 --visible-devices；返回体 source=config_snapshot；卡面行可见", async () => {
    const ws = tempRoot();
    const runDir = join(ws, "runs", "t3-snap");
    writeSnapshot(runDir, { visible_devices: "4,5,6,7" });
    const record: string[] = [];
    const result = (await toolOf(record).execute(
      { stage: "training_prep", run_id: "t3-snap", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    )) as Record<string, unknown>;
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--visible-devices") + 1]).toBe("4,5,6,7");
    expect(result["visible_devices"]).toBe("4,5,6,7");
    expect(result["visible_devices_source"]).toBe("config_snapshot");
    expect(record.join("\n")).toContain("训练绑卡：4,5,6,7（确认快照）");
  });
  it("段通道：显式压过快照；两者皆无 → 不下传（回退部署层）且返回体如实标注", async () => {
    const ws = tempRoot();
    const runDir = join(ws, "runs", "t3-exp");
    writeSnapshot(runDir, { visible_devices: "4,5,6,7" });
    const record: string[] = [];
    const explicit = (await toolOf(record).execute(
      { stage: "training_prep", run_id: "t3-exp", workspace_path: ws, base_model_path: join(ws, "model"), visible_devices: "0-1" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(explicit)[summaryArgv(explicit).indexOf("--visible-devices") + 1]).toBe("0-1");
    expect(explicit["visible_devices_source"]).toBe("user_specified");

    const bare = (await toolOf().execute(
      { stage: "training_prep", run_id: "t3-bare", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(bare)).not.toContain("--visible-devices");
    expect(bare["visible_devices"]).toBeNull();
    expect(bare["visible_devices_source"]).toBe("deploy_default");
  });
  it("段通道：非 training_prep 段带该参不下传、不加返回键", async () => {
    const result = (await toolOf().execute(
      { stage: "label_qc", run_id: "t3-other", workspace_path: tempRoot(), visible_devices: "4,5,6,7" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(result)).not.toContain("--visible-devices");
    expect(result["visible_devices_source"]).toBeUndefined();
  });
});

describe("T4 像素对不变量（段参数通道：越界即拒，不静默纠正）", () => {
  const base = (): Record<string, unknown> => ({ stage: "experiment_setup", run_id: "t4", workspace_path: tempRoot() });
  it("上限不在两档闭集 → pixel_pair_max_not_in_closed_set（不 clamp）", async () => {
    const result = (await toolOf().execute(
      { ...base(), image_min_pixels: TRAINING_PIN_CONSTANTS.image_min_pixels, image_max_pixels: 1234567 },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("pixel_pair_max_not_in_closed_set");
    expect(String(result["note"])).toContain("不静默纠正");
  });
  it("下限偏离惯例基线 → pixel_pair_min_not_pinned（原则一：训练/评估同一对值）", async () => {
    const result = (await toolOf().execute(
      { ...base(), image_min_pixels: 1024, image_max_pixels: TRAINING_PIN_CONSTANTS.image_max_pixels[0] },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("pixel_pair_min_not_pinned");
  });
  it("基线对合法 → 通过并随 argv 下传（两档上限均可）", async () => {
    for (const maxPixels of TRAINING_PIN_CONSTANTS.image_max_pixels) {
      const result = (await toolOf().execute(
        { ...base(), image_min_pixels: TRAINING_PIN_CONSTANTS.image_min_pixels, image_max_pixels: maxPixels },
        fakeExec,
      )) as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      const argv = summaryArgv(result);
      expect(argv[argv.indexOf("--image-max-pixels") + 1]).toBe(String(maxPixels));
    }
  });
});
