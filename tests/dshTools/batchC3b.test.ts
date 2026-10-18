/**
 * A-C3b 测试锚——卡数规则单源（E11）＋分析入口指引（E9）。
 *
 * E11 规则面四条用例（回退/用户显式不回退/不误报/多卡）锚在 batchR.test.ts「卡数机器事实与
 * 反模式拦截」；本文件锚确认卡面（confirmFace）端到端——用户显式冲突态：nproc 值不回退、
 * 冲突原文（内核 runtime_linkage_conflict 文案单源）上审批回执、快照按用户显式值落盘，
 * 由内核侧生成/启动面 fail-closed 拒绝（harness 不代改不代拒）。
 * E9 status 返回面指引行锚在 batchS1.test.ts「闭环推荐层事实核对」。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KERNEL_RUNTIME_LINKAGE_CONFLICT_TEXT,
  KERNEL_RUNTIME_LINKAGE_REMEDY_TEXT,
} from "../../src/core/workspace/smartDefaults.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "c3b-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const findTool = (tools: unknown[], name: string): DshToolLike => {
  const tool = tools.find((entry) => (entry as DshToolLike).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}`);
  return tool as DshToolLike;
};
const fakeExec = { agent: undefined, callId: "c3b-call", signal: undefined };

/** 表单卡假件：零改动提交（按现值确认——改参收集段不产生 edits）。 */
const formAskZeroChange = (): { ask: (req: unknown) => Promise<unknown> } => ({
  ask: async () => ({ answers: [{ id: "config-confirm-run-c3b", selected: [] }] }),
});

describe("A-C3b E11——确认卡面用户显式冲突态（need_confirm 单卡×deepspeed×QLoRA）", () => {
  it("值不回退＋冲突原文上审批回执＋快照按用户显式值落盘（内核 fail-closed，harness 不代改）", async () => {
    const root = tempRoot();
    const approvalReasons: string[] = [];
    const ctx = {
      get: (service: string) => {
        if (service === "approval") return { request: async (req: { reason: string }) => { approvalReasons.push(req.reason); return "allowed-once"; } };
        if (service === "userQuestions") return formAskZeroChange();
        return undefined;
      },
    };
    const tools = buildConfirmTools({ runsRoot: root, ctx, gpuProbe: () => 8 });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-c3b", overrides: { nproc_per_node: "1" } },
      fakeExec,
    )) as { ok?: boolean; fields?: Array<{ key: string; value: string; tag: string }> };
    expect(result.ok).toBe(true);
    const byKey = Object.fromEntries((result.fields ?? []).map((f) => [f.key, f]));
    // 不回退：用户显式值原样保留（对比：非用户显式同组合回退为可用卡数——batchR 锚）
    expect(byKey["nproc_per_node"]).toMatchObject({ value: "1", tag: "need_confirm" });
    // 冲突原文上回执（文案单源＝内核 runtime_linkage_conflict 因由/补救表述）
    const receipt = approvalReasons.join("\n");
    expect(receipt).toContain("运行形态联动冲突");
    expect(receipt).toContain(KERNEL_RUNTIME_LINKAGE_CONFLICT_TEXT);
    expect(receipt).toContain("runtime_linkage_conflict");
    expect(receipt).toContain(KERNEL_RUNTIME_LINKAGE_REMEDY_TEXT);
    expect(receipt).toContain("不改用户显式值");
    // 快照按用户显式值落盘——拒绝面在内核（runtime_linkage_conflict），harness 不代改
    const snap = JSON.parse(readFileSync(join(root, "run-c3b", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["nproc_per_node"]).toBe("1");
  });
  it("非用户显式同组合（default_used）：建卡期回退可用卡数（回退呈现面既有语义不变）", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-c3b-b", "prep", "iteration-config"), { recursive: true });
    writeFileSync(
      join(root, "run-c3b-b", "prep", "iteration-config", "iteration-config.json"),
      JSON.stringify({ schema_version: "IterationConfig/v1", training: { nproc_per_node: 1 } }),
    );
    const ctx = {
      get: (service: string) => {
        if (service === "approval") return { request: async () => "allowed-once" };
        if (service === "userQuestions") {
          return { ask: async () => ({ answers: [{ id: "config-confirm-run-c3b-b", selected: [] }] }) };
        }
        return undefined;
      },
    };
    const tools = buildConfirmTools({ runsRoot: root, ctx, gpuProbe: () => 8 });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-c3b-b" },
      fakeExec,
    )) as { ok?: boolean; fields?: Array<{ key: string; value: string; tag: string }> };
    expect(result.ok).toBe(true);
    const byKey = Object.fromEntries((result.fields ?? []).map((f) => [f.key, f]));
    expect(byKey["nproc_per_node"]).toMatchObject({ value: "8", tag: "from_registry" }); // 已回退拉满
    const snap = JSON.parse(readFileSync(join(root, "run-c3b-b", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["nproc_per_node"]).toBe("8");
  });
});
