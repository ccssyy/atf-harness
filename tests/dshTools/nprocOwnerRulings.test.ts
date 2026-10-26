/**
 * 卡数收尾·owner 三条裁定回归锚（2026-10-26 第三轮裁定）。
 *
 *  ① 已确认值（快照/iteration-config 沿用）**不被「拉满偏置」改写**——有主值（用户填写／卡位个数／
 *     已确认方案）一律不改写，只有实例基线／agent 推荐这类无主值保留旧回退；
 *  ② 实例基线预填是合法来源，但卡面必须一眼看出「不是你填的」；
 *  ③ 梯度累积空值在 web 摘要也显示「待定（先定卡数）」（与卡面同句，单源）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { configFieldDisplayValueOf } from "../../src/webui/configConfirm.js";
import { renderChatEvent } from "../../src/webui/chatModel.js";

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: { session: { id: "pin" } }, callId: "pin-1", signal: undefined };

type Row = { key: string; value?: string; hint?: string };

const runCard = async (
  root: string,
  settingsPath: string,
  overrides: Record<string, string> = {},
): Promise<{ fields: Array<{ key: string; value: string }>; rows: Row[] }> => {
  process.env["ATF_DSH_SETTINGS"] = settingsPath;
  const asked: Array<Record<string, unknown>> = [];
  const ctx = {
    get: (service: string) => {
      if (service === "approval") return { request: async () => "allowed-once" };
      if (service === "userQuestions") {
        return { ask: async (request: Record<string, unknown>) => { asked.push(request); return { answers: [{ id: "x", selected: [] }] }; } };
      }
      return undefined;
    },
  };
  const tool = (buildConfirmTools({ runsRoot: root, ctx: ctx as never, gpuProbe: () => 8 }) as unknown as Array<{
    name: string;
    execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>>;
  }>).find((entry) => entry.name === "atf_config_confirm")!;
  const result = await tool.execute({ action: "present", run_id: "pin", overrides }, fakeExec);
  const formAsk = asked.find((request) => ((request["questions"] as Array<{ intent?: unknown }>)[0]?.intent) !== undefined);
  const question = formAsk === undefined ? undefined : (formAsk["questions"] as Array<{ intent?: { fields?: Row[] } }>)[0];
  return {
    fields: (result["fields"] ?? []) as Array<{ key: string; value: string }>,
    rows: question?.intent?.fields ?? [],
  };
};

const writeSnapshot = (root: string, confirmed: Record<string, string>): void => {
  mkdirSync(join(root, "pin", "webui"), { recursive: true });
  writeFileSync(join(root, "pin", "webui", "config-snapshot.json"), JSON.stringify({ schema_version: "WebUiConfigSnapshot/v1", confirmed }, null, 1));
};

describe("裁定：有主值的卡数不被拉满改写", () => {
  it("① 已确认快照 4 卡 → 仍为 4（不被机器 8 卡改写）；来源标「已确认的方案」；accum=32", async () => {
    const root = tempRoot("pin-snap-");
    const settingsPath = join(tempRoot("pin-set-"), "webui-settings.json");
    writeSnapshot(root, { nproc_per_node: "4", per_device_train_batch_size: "2" });
    const { fields, rows } = await runCard(root, settingsPath);
    expect(fields.find((field) => field.key === "nproc_per_node")?.value).toBe("4");
    expect(fields.find((field) => field.key === "gradient_accumulation_steps")?.value).toBe("32");
    const nprocRow = rows.find((row) => row.key === "nproc_per_node");
    expect(nprocRow?.hint ?? "").toContain("值来源：已确认的方案（沿用上次确认值）");
  });

  it("② 实例基线 8 → 预填 8 但标「实例基线，不是你填的，可改」", async () => {
    const root = tempRoot("pin-setbase-");
    const settingsDir = tempRoot("pin-set-");
    const settingsPath = join(settingsDir, "webui-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ storage: { atf_root: "", model_root: "", train_env: "", eval_env: "", train_gpu_baseline: "8" } }));
    const { fields, rows } = await runCard(root, settingsPath);
    expect(fields.find((field) => field.key === "nproc_per_node")?.value).toBe("8");
    const nprocRow = rows.find((row) => row.key === "nproc_per_node");
    expect(nprocRow?.hint ?? "").toContain("值来源：实例基线，不是你填的，可改");
    // 8 卡 × bs2 → accum 16（这是派生结果，不是猜的）
    expect(fields.find((field) => field.key === "gradient_accumulation_steps")?.value).toBe("16");
  });
});

describe("裁定：累积空值文案单源", () => {
  it("configFieldDisplayValueOf：累积空值＝「待定（先定卡数）」，其它键原样", () => {
    expect(configFieldDisplayValueOf("gradient_accumulation_steps", "")).toBe("待定（先定卡数）");
    expect(configFieldDisplayValueOf("gradient_accumulation_steps", "  ")).toBe("待定（先定卡数）");
    expect(configFieldDisplayValueOf("gradient_accumulation_steps", "32")).toBe("32");
    expect(configFieldDisplayValueOf("learning_rate", "")).toBe("");
  });

  it("web 摘要（确认卡渲染）同句：累积空值显示「待定（先定卡数）」", () => {
    const html = renderChatEvent({
      seq: 1,
      kind: "confirm_card",
      cardType: "config_confirm",
      title: "本次训练方案",
      fields: [
        { key: "nproc_per_node", value: "", tag: "default_used" },
        { key: "gradient_accumulation_steps", value: "", tag: "default_used" },
      ],
      pending: true,
      at: "2026-10-26T00:00:00Z",
    } as never);
    expect(html).toContain("待定（先定卡数）");
    expect(html).toContain("gradient_accumulation_steps");
  });
});
