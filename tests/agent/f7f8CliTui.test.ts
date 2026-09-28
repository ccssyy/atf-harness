/**
 * 批② F7＋F8 测试锚（2026-09-28，指令 1eb91324；走查报告 v078 §五 F7/F8-B1/B2 实锚）。
 *
 * F7 CLI 模型面接线：①lane 模型面＝装配注入面（sessionMirror 旧硬编码 deepseek/faux-spike
 * 与实际模型面断接——会话落盘文件不得再现 faux-spike，须再现注入面 provider/model）；
 * ②assistant 消息来自注入 streamFn（issued 计数＝循环实际发起）；③空 assistant 文本且无
 * 工具调用 → failed(empty_final_answer)（禁静默 completed/exit 0）。
 * F8-B2：turn 终局交互续跑判定（TTY 交互 completed/turn_failed/failed/aborted 回新指令
 * 循环；suspended/approval_missing/session_rejected 保留退出；非 TTY 恒退出）。
 */
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/index.js";
import { runV1Headless, type AssembleV1Deps } from "../../src/agent/cli.js";
import { laneModelFaceNow } from "../../src/agent/sessionMirror.js";
import { createFauxStreamFn, fauxFinalAnswer, type FauxStreamFn } from "../../src/agent/fauxStream.js";
import { continuesInteractive } from "../../src/ui/turnContinuation.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockAtf = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const openConnections: AtfBridgeConnection[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const spawnMockBridge = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

/** runV1Headless 全量落盘文本（session JSONL＋lane 配置——断言直接读落盘事实）。 */
const runAndCollect = async (
  streamFn: FauxStreamFn,
  providerConfig: { provider_id: string; model: string; base_url: string; api_key: string } | undefined,
): Promise<{ exit: number; errLines: string; sessionsRoot: string; dump: string }> => {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "f7-"));
  tempRoots.push(sessionsRoot);
  const errLines: string[] = [];
  const bridge = await spawnMockBridge();
  const exit = await runV1Headless({
    bridge,
    sessionsRoot,
    instruction: "F7 复现指令",
    maxTurns: 4,
    streamFn: streamFn as unknown as AssembleV1Deps["streamFn"],
    ...(providerConfig !== undefined ? { providerConfig } : {}),
    approval: { kind: "headless" },
    steeringMode: "all",
    followUpMode: "all",
    contextTokens: 24_000,
    keepRecentTokens: 8_000,
    out: () => undefined,
    err: (line: string) => errLines.push(line),
  });
  const dump = await dumpDir(sessionsRoot);
  return { exit, errLines: errLines.join("\n"), sessionsRoot, dump };
};

const dumpDir = async (root: string): Promise<string> => {
  const chunks: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else chunks.push(await readFile(full, "utf8").catch(() => ""));
    }
  };
  await walk(root);
  return chunks.join("\n");
};

describe("F7：CLI 模型面接线（走查 v078 实锚复现）", () => {
  it("lane 模型面＝装配注入面（落盘再现注入 provider/model，faux-spike 断接信号消失）；assistant 来自注入 streamFn", async () => {
    // 注入 streamFn 的 assistant 携带专属模型面（repro-provider/repro-model-x）——
    // 与 providerConfig.model 一致（runV1Headless 的 modelTag 消费链）。
    const injected: AssistantMessage = {
      ...fauxFinalAnswer("F7 复现回复（来自注入 streamFn）"),
      provider: "repro-provider",
      model: "repro-model-x",
    };
    const streamFn = createFauxStreamFn([injected]);
    const { exit, dump } = await runAndCollect(streamFn, {
      provider_id: "repro-provider",
      model: "repro-model-x",
      base_url: "http://127.0.0.1:9",
      api_key: "test",
    });
    // assistant 来自注入 streamFn：循环实际发起 1 次、终局 completed（final answer 在场）
    expect(streamFn.issued).toBe(1);
    expect(exit).toBe(0);
    // lane 模型面＝注入面：会话落盘再现 repro-provider/repro-model-x（lane 配置＋transcript），
    // 旧硬编码断接信号 faux-spike 不再出现（修复前本断言失败——lane 恒写 deepseek/faux-spike）。
    expect(dump).toContain("repro-model-x");
    expect(dump).toContain("repro-provider");
    expect(dump).not.toContain("faux-spike");
    // 装配单点注入的当前面（诊断只读面）与 providerConfig.model 一致
    expect(laneModelFaceNow()).toEqual({ provider: "repro-provider", modelId: "repro-model-x" });
  });

  it("空 assistant 文本且无工具调用 → failed(empty_final_answer)，不静默 completed/exit 0", async () => {
    const streamFn = createFauxStreamFn([fauxFinalAnswer("")]);
    const { exit, errLines } = await runAndCollect(streamFn, {
      provider_id: "repro-provider",
      model: "repro-model-x",
      base_url: "http://127.0.0.1:9",
      api_key: "test",
    });
    expect(exit).toBe(1);
    expect(errLines).toContain("empty_final_answer");
  });
});

describe("F8-B2：turn 终局交互续跑判定（continuesInteractive）", () => {
  it("TTY 交互：completed/turn_failed/failed/aborted 回新指令循环；suspended/approval_missing/session_rejected 退出；非 TTY 恒退出", () => {
    const ttyKinds: Array<[Parameters<typeof continuesInteractive>[0], boolean]> = [
      ["completed", true],
      ["turn_failed", true],
      ["failed", true],
      ["aborted", true],
    ];
    for (const [kind, expected] of ttyKinds) {
      expect(continuesInteractive(kind, true)).toBe(expected);
    }
    expect(continuesInteractive("suspended", true)).toBe(false);
    expect(continuesInteractive("approval_missing", true)).toBe(false);
    expect(continuesInteractive("session_rejected", true)).toBe(false);
    // 非 TTY（冒烟/headless）恒退出——既有退出码语义零变化
    for (const kind of ["completed", "turn_failed", "failed", "aborted", "suspended", "approval_missing", "session_rejected"] as const) {
      expect(continuesInteractive(kind, false)).toBe(false);
    }
  });
});
