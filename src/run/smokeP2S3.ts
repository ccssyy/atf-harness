/**
 * P2-S3 手工冒烟命令（任务书 §4 / 启动决议 §4 口径 #9）：多 provider 热切换全链路。
 *
 * 分支 1（交替）：同会话两 provider（faux → faux-alt → faux）交替完成三个 turn，
 *   两次段边界合法切换（provider/switch 落盘）；
 * 分支 2（越界反例）：turn 内 provider_switch 请求被拒（provider_switch_out_of_boundary），
 *   不落 switch 事件，原 provider 继续（非终局）。
 *
 * 断言面（决议验收 1–2）：载荷逐字段（口径 #4 定死形态）/ 越界不落事件 / 原子性
 * （switch 事件存在 ⟺ 新 provider 生效）/ 切换后首 turn 归属新 provider（含决策文本
 * 实证）/ digest 连续（replay 零 ref_invalid + 零 block）。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:p2s3
 *
 * 退出码：全部通过 = 0；任一步失败 = 1。
 * 全程零 GPU、零真实 Provider、零网络调用（两个 provider 均脚本化 Faux）。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario, type Scenario } from "../llm/index.js";
import type { SessionEvent } from "../core/session/index.js";
import { ScenarioRunner, type BranchRunReport, type ProviderSwitchPayload, type SwitchRecord } from "../core/run/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scenarioPath = join(repoRoot, "scenarios", "provider-alternation.json");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

let failed = false;
const step = (label: string, pass: boolean, detail?: string): void => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failed = true;
};

const switchEvents = (events: readonly SessionEvent[]): SessionEvent[] =>
  events.filter((event) => event.type === "provider/switch");

const isSwitchPayload = (payload: unknown): payload is ProviderSwitchPayload => {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const from = p["from"] as Record<string, unknown> | undefined;
  const to = p["to"] as Record<string, unknown> | undefined;
  const boundary = p["boundary"] as Record<string, unknown> | undefined;
  return (
    typeof from?.["provider_id"] === "string" &&
    typeof to?.["provider_id"] === "string" &&
    Number.isInteger(boundary?.["turn_index"]) &&
    Number.isInteger(boundary?.["after_event_id"]) &&
    (p["reason"] === undefined || typeof p["reason"] === "string")
  );
};

const runBranch = async (scenario: Scenario, branchId: string): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(scenario, branchId, {
    runsRoot: join(repoRoot, "tmp", "runs", `smoke-p2s3-${randomUUID()}`),
    mockCommand: ["node", mockPath],
  });
  if (!ran.ok) throw new Error(`runner 失败: ${ran.error.message}`);
  return ran.value;
};

const smoke = async (): Promise<void> => {
  console.log(`[1] 加载场景脚本: ${scenarioPath}`);
  const parsed = parseScenario(JSON.parse(await readFile(scenarioPath, "utf8")));
  step("场景脚本解析（七类步骤白名单 + segments 段声明）", parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.error));
  if (!parsed.ok) {
    process.exitCode = 1;
    return;
  }
  const scenario = parsed.value;

  console.log("[2] ALT 交替分支：faux → faux-alt → faux 三 turn 两切换");
  const alt = await runBranch(scenario, "ALT_two_provider_alternation");
  step("分支完成（outcome=completed, exit=0）", alt.outcome.kind === "completed" && alt.exit_code === 0);

  const switches = switchEvents(alt.events);
  step("provider/switch 事件恰 2 条（两次段边界切换）", switches.length === 2, `count=${String(switches.length)}`);
  step(
    "载荷逐字段符合口径 #4 定死形态（from/to/boundary + 可选 reason，无凭据无端点）",
    switches.every((event) => isSwitchPayload(event.payload)),
  );

  const turns = alt.turns ?? [];
  step(
    "turn 归属 = [faux, faux-alt, faux]（切换后首 turn 归属新 provider）",
    turns.length === 3 && turns[0]?.provider_id === "faux" && turns[1]?.provider_id === "faux-alt" && turns[2]?.provider_id === "faux",
    JSON.stringify(turns.map((turn) => turn.provider_id)),
  );

  const t2FirstMessage = alt.events.find(
    (event) => event.type === "assistant/message" && event.id > (turns[1]?.first_event_id ?? 0),
  );
  step(
    "切换后首 turn 决策实证出自新 provider 脚本（faux-alt 段首条文本）",
    t2FirstMessage !== undefined && (t2FirstMessage.payload as { text?: string }).text === "faux-alt T2：核对工作区状态",
    t2FirstMessage !== undefined ? JSON.stringify((t2FirstMessage.payload as { text?: string }).text) : "无",
  );

  const boundaryShapeOk = switches.every((event) => {
    const payload = event.payload as ProviderSwitchPayload;
    const before = alt.events.find((candidate) => candidate.id === event.id - 1);
    const after = alt.events.find((candidate) => candidate.id === event.id + 1);
    return (
      before?.type === "turn/end" &&
      after?.type === "turn/start" &&
      payload.boundary.after_event_id === before.id &&
      (before.payload as { reason?: string }).reason === "provider_switch"
    );
  });
  step("切换边界形态：switch 前邻 turn/end(provider_switch)、后邻 turn/start，after_event_id 精确指认", boundaryShapeOk);
  step(
    "boundary.turn_index = 被关闭 turn 序号（1、2）",
    (switches[0]?.payload as ProviderSwitchPayload | undefined)?.boundary.turn_index === 1 &&
      (switches[1]?.payload as ProviderSwitchPayload | undefined)?.boundary.turn_index === 2,
  );
  step(
    "原子性：switched 记录与事件一一对应，无半生效",
    (alt.switches ?? []).filter((record): record is Extract<SwitchRecord, { status: "switched" }> => record.status === "switched").length === switches.length,
  );
  step(
    "digest 连续：replay 成功、零 ref_invalid block（准入事实引用跨切换可复核）",
    alt.replay?.kind === "replayed" && alt.replay.blocks.length === 0 && alt.events.every((event) => event.ref_invalid === undefined),
  );
  step(
    "reason 原文随事件留痕（审计可答「为何切换」）",
    (switches[0]?.payload as ProviderSwitchPayload | undefined)?.reason === "轮换到备选 provider 执行核对" &&
      (switches[1]?.payload as ProviderSwitchPayload | undefined)?.reason === "切回主 provider 收束",
  );

  console.log("[3] ALT 越界反例：turn 内切换请求被拒，不落事件，原 provider 继续（非终局）");
  const oob = await runBranch(scenario, "ALT_out_of_boundary_rejected");
  step("分支完成（非终局：outcome=completed, exit=0）", oob.outcome.kind === "completed" && oob.exit_code === 0);
  const oobSwitches = switchEvents(oob.events);
  step("越界切换不落事件（全流零 provider/switch）", oobSwitches.length === 0, `count=${String(oobSwitches.length)}`);
  const oobRecords = oob.switches ?? [];
  step(
    "结构化 block = provider_switch_out_of_boundary",
    oobRecords.length === 1 && oobRecords[0]?.status === "rejected" && oobRecords[0]?.block.reason === "provider_switch_out_of_boundary",
    JSON.stringify(oobRecords.map((record) => (record.status === "rejected" ? record.block.reason : record.status))),
  );
  step(
    "原 provider 继续：单一 turn（faux）完成收束",
    (oob.turns ?? []).length === 1 && oob.turns?.[0]?.provider_id === "faux" && oob.turns[0]?.decision_count === 3,
  );

  if (failed) process.exitCode = 1;
  else console.log("P2-S3 冒烟通过 ✓（交替切换 + 越界拒绝 + 载荷/边界/digest/原子性断言全过）");
};

await smoke();
