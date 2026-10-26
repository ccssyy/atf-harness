/**
 * 卡数收尾回归锚（owner 2026-10-26：内核已删卡数缺省，harness 不许再用 8 派生）。
 *
 * 三情形（验收锚）：
 *  ① 用户填 4 卡 + 卡位 4 个 → accum 按 4 派生（256 ÷ (bs×4)）；
 *  ② 用户填 4 卡 + 卡位 8 个 → 当场拒（visible_devices_inconsistency）；
 *  ③ 未填卡数 → 不派生 accum、卡面「待定（先定卡数）」、**不预填 8**（机器事实有 8 卡也不用）。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { deriveGradAccum, oomFallbackParams } from "../../src/core/workspace/smartDefaults.js";

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: { session: { id: "nproc" } }, callId: "nproc-1", signal: undefined };

/** 隔离实例设置面：不读真实 $HOME/.atf/webui-settings.json（那里的训练卡数基线会让「未填卡数」构造不出来）。 */
process.env["ATF_DSH_SETTINGS"] = join(mkdtempSync(join(tmpdir(), "nproc-settings-")), "webui-settings.json");

/** 手动档 ctx：无设置面基线、无快照；ask 记录入参并提交空编辑（按现值确认）。 */
const manualCtx = (asked: Array<Record<string, unknown>>) => ({
  get: (service: string) => {
    if (service === "approval") return { request: async () => "allowed-once" };
    if (service === "userQuestions") {
      return {
        ask: async (request: Record<string, unknown>) => {
          asked.push(request);
          return { answers: [{ id: "config-confirm-x", selected: [] }] };
        },
      };
    }
    return undefined;
  },
});

const toolOf = (ctx: Record<string, unknown>, runsRoot: string, gpuCount: number) =>
  (buildConfirmTools({ runsRoot, ctx: ctx as never, gpuProbe: () => gpuCount }) as unknown as Array<{
    name: string;
    execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
  }>).find((tool) => tool.name === "atf_config_confirm")!;

type Row = { key: string; value?: string; hint?: string; placeholder?: string };

describe("卡数收尾：不许再用 8 派生", () => {
  it("派生函数与 OOM 兜底都不再接受「卡数缺省」（NPROC_DEFAULT 已删）", () => {
    // 显式传入才派生；语义仍是 256 ÷ (bs×nproc)
    expect(deriveGradAccum(2, 4)).toEqual({ accum: 32, globalBatch: 256 });
    expect(oomFallbackParams(4)).toEqual({ bs: 1, accum: 64, globalBatch: 256 });
    // 除不尽不静默取整（内核同语义）
    expect("error" in deriveGradAccum(3, 4)).toBe(true);
  });

  it("① 用户填 4 卡 + 卡位 4 个 → accum 按 4 派生（bs=2 → 32）", async () => {
    const root = tempRoot("nproc-a-");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(manualCtx(asked), root, 8);
    const result = await tool.execute(
      { action: "present", run_id: "nproc-a", overrides: { nproc_per_node: "4", visible_devices: "0-3" } },
      fakeExec,
    );
    expect(result["ok"]).toBe(true);
    const fields = (result["fields"] ?? []) as Array<{ key: string; value: string }>;
    const get = (key: string): string | undefined => fields.find((field) => field.key === key)?.value;
    expect(get("nproc_per_node")).toBe("4");
    expect(get("per_device_train_batch_size")).toBe("2");
    expect(get("gradient_accumulation_steps")).toBe("32");
  });

  it("② 用户填 4 卡 + 卡位 8 个 → 当场拒（visible_devices_inconsistency，不静默取其一）", async () => {
    const root = tempRoot("nproc-b-");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(manualCtx(asked), root, 8);
    const result = await tool.execute(
      { action: "present", run_id: "nproc-b", overrides: { nproc_per_node: "4", visible_devices: "0-7" } },
      fakeExec,
    );
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("visible_devices_inconsistency");
    expect(String(result["note"])).toContain("卡位个数（8 张：0-7）与训练卡数（4）不一致");
    expect(asked.filter((request) => ((request["questions"] as Array<{ intent?: unknown }>)[0]?.intent) !== undefined)).toHaveLength(0); // 卡前就拒，没进表单卡
  });

  it("③ 未填卡数 → 不派生 accum、卡面「待定（先定卡数）」、不预填 8（机器 8 卡也不用）", async () => {
    const root = tempRoot("nproc-c-");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(manualCtx(asked), root, 8);
    const result = await tool.execute({ action: "present", run_id: "nproc-c" }, fakeExec);
    expect(result["ok"]).toBe(true);
    const fields = (result["fields"] ?? []) as Array<{ key: string; value: string }>;
    const get = (key: string): string | undefined => fields.find((field) => field.key === key)?.value;
    expect(get("nproc_per_node") ?? "").toBe(""); // 不预填 8
    expect(get("gradient_accumulation_steps") ?? "").toBe(""); // 不派生
    // 卡面：累积行标注「待定（先定卡数）」，卡数行不给「值来源」
    const formAsk = asked.find((request) => ((request["questions"] as Array<{ intent?: unknown }>)[0]?.intent) !== undefined)!;
    const question = (formAsk["questions"] as Array<{ intent?: { fields?: Row[] }; detail?: string }>)[0]!;
    const rows = question.intent?.fields ?? [];
    const accum = rows.find((row) => row.key === "gradient_accumulation_steps");
    expect(accum?.hint ?? "").toContain("待定（先定卡数）");
    const nproc = rows.find((row) => row.key === "nproc_per_node");
    expect(nproc?.hint ?? "").not.toContain("值来源");
    expect(String(question.detail)).toContain("梯度累积：待定（先定卡数）");
    expect(String(question.detail)).toContain("给卡数或给卡位后自动补齐");
  });

  it("卡数来自卡位个数时标注来源「卡位个数」，且不被机器可用卡数拉满改写", async () => {
    const root = tempRoot("nproc-d-");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(manualCtx(asked), root, 8);
    const result = await tool.execute(
      { action: "present", run_id: "nproc-d", overrides: { visible_devices: "0-3" } },
      fakeExec,
    );
    expect(result["ok"]).toBe(true);
    const fields = (result["fields"] ?? []) as Array<{ key: string; value: string }>;
    expect(fields.find((field) => field.key === "nproc_per_node")?.value).toBe("4");
    expect(fields.find((field) => field.key === "gradient_accumulation_steps")?.value).toBe("32");
    const formAsk = asked.find((request) => ((request["questions"] as Array<{ intent?: unknown }>)[0]?.intent) !== undefined)!;
    const question = (formAsk["questions"] as Array<{ intent?: { fields?: Row[] } }>)[0]!;
    const nproc = (question.intent?.fields ?? []).find((row) => row.key === "nproc_per_node");
    expect(nproc?.hint ?? "").toContain("值来源：卡位个数");
  });

  it("用户填写时标注来源「你填写」；整除组合正常派生（8 卡 × bs2 → 16）", async () => {
    const root = tempRoot("nproc-e-");
    const asked: Array<Record<string, unknown>> = [];
    const tool = toolOf(manualCtx(asked), root, 8);
    const result = await tool.execute(
      { action: "present", run_id: "nproc-e", overrides: { nproc_per_node: "8" } },
      fakeExec,
    );
    expect(result["ok"]).toBe(true);
    const fields = (result["fields"] ?? []) as Array<{ key: string; value: string }>;
    expect(fields.find((field) => field.key === "gradient_accumulation_steps")?.value).toBe("16");
    const formAsk = asked.find((request) => ((request["questions"] as Array<{ intent?: unknown }>)[0]?.intent) !== undefined)!;
    const question = (formAsk["questions"] as Array<{ intent?: { fields?: Row[] } }>)[0]!;
    const nproc = (question.intent?.fields ?? []).find((row) => row.key === "nproc_per_node");
    expect(nproc?.hint ?? "").toContain("值来源：你填写");
  });
});
