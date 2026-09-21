import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BRIDGE_CONTRACT_VERSION } from "../../src/bridge/index.js";

/**
 * 契约文件自检（契约修订 v2 验收 §4.3 的自动化承载）：bridge.contract.yaml 为双侧唯一
 * 真相源，本测试锚定其关键不变量——零依赖（不引 YAML 解析器，按行/文本断言）。
 * 契约 v2（2026-09-13 契约修订）：
 *   - contract_version: 2；
 *   - 运行时方法面 = 握手 atf.version + 4 工具 + 2 账本方法（ledger_query/ledger_consume）；
     工具面含改名后的 atf_fact_scan；旧方法名与旧数组字段零残留；
 *   - ledger_record 原为 mock setup 基建；【K4 补登 2026-09-16】升为运行时方法面
 *     （内核 stdio-session-contract.md §13.8 对齐：setup-only 预录，补登不 bump）；
 *   - 【K3 补登 2026-09-17】atf_flow_anchor 升为运行时方法面（内核 §13.9 对齐：
 *     流程位置纯读出口，三态 current/stale/missing；INV-A：stale 不得自行推断；补登不 bump）；
 *   - atf_upstream pin = v0.7.2b0（re-pin R3 2026-09-20；pin sha＝内核 main HEAD 61631e6，tag release 0bd0348；tag/sha 自检锚定，会话协议版本轴保持 1）。
 * 契约 v2 方法面补登（2026-09-13，《ATF-Harness_Owner指令_推送授权与bind_run补登_20260913.md》）：
 *   - 运行时方法面扩为 握手 + 会话上下文（atf.bind_run）+ 4 工具 + 2 账本；
 *   - contract_version 仍为 2（方法面补登不 bump，沿用批次一先例）；
 *   - 错误码 no_run_bound / unknown_run 登记（连接保持）；绑定留痕 event session/run-bound；
 *   - atf_workspace_status / atf_fact_scan 参数为可选 run_id（显式优先于会话绑定）。
 * 版本轴修正（2026-09-13，《ATF-Harness_Owner指令_版本轴修正与推送_20260913.md》双轴裁定）：
 *   - 文件头部 contract_version = 桥接契约版本轴（= BRIDGE_CONTRACT_VERSION，自检断言锚定）；
 *   - 握手校验走会话协议版本轴（EXPECTED_SESSION_CONTRACT_VERSION = 1），不归本文件头部承载；
 *   - 契约头部须有「版本轴注记（双轴明确）」登记块。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const contractPath = join(repoRoot, "bridge.contract.yaml");

let contract = "";

beforeAll(async () => {
  contract = await readFile(contractPath, "utf8");
});

const methodKeys = (): string[] =>
  contract
    .split("\n")
    .map((line) => /^  ([A-Za-z0-9_.]+):(?:\s|$)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] as string);

describe("契约文件自检（v2）", () => {
  it("contract_version: 2（桥接契约版本轴 = BRIDGE_CONTRACT_VERSION；握手走会话协议版本轴）", () => {
    expect(contract).toMatch(/^contract_version: 2$/m);
    expect(contract).not.toMatch(/^contract_version: 1$/m);
    expect(contract).not.toMatch(/^contract_version: 3$/m);
    // 版本轴修正（2026-09-13）双轴语义：文件头部值 = 桥接契约版本轴，与 BRIDGE_CONTRACT_VERSION
    // 一致；握手校验值是另一轴（EXPECTED_SESSION_CONTRACT_VERSION = 1），不归本文件头部承载。
    expect(BRIDGE_CONTRACT_VERSION).toBe(2);
    expect(contract).toMatch(/版本轴注记（双轴明确）2026-09-13/);
    expect(contract).toMatch(/EXPECTED_SESSION_CONTRACT_VERSION/);
    expect(contract).toMatch(/BRIDGE_CONTRACT_VERSION/);
  });

  it("运行时方法面：握手 + 会话上下文（atf.bind_run）+ 7 工具（R1 增准入申请；K-Gap-2 增 propose/cluster execute）+ 2 账本 + ledger_record（K4 补登）+ atf_flow_anchor（K3 补登）", () => {
    const methods = methodKeys();
    // 握手 + 会话上下文 + 工具 + 账本运行时方法（补登 B1）
    for (const required of ["atf.version", "atf.bind_run", "atf_admit_data", "atf_gate", "atf_fact_scan", "atf_workspace_status", "atf_data_admission.request", "atf_preparation.propose", "atf_style_cluster.execute", "ledger_query", "ledger_consume"]) {
      expect(methods, `契约 methods 缺少 ${required}`).toContain(required);
    }
    // 会话方法族恰 2 个（atf. 前缀点号族；atf_data_admission.request / atf_preparation.propose /
    // atf_style_cluster.execute 属工具面、以 atf_ 前缀计；atf_flow_anchor 为下划线命名纯读出口）
    const sessionFamily = methods.filter((name) => name.startsWith("atf."));
    expect(sessionFamily).toEqual(["atf.version", "atf.bind_run"]);
    // 工具面恰 7 个（K-Gap-2 接线批 2026-09-21：方法面 10→12，内核变更单料-门对齐批；
    // atf.bind_run 不进工具面；atf_flow_anchor 不计入工具面）
    const tools = methods.filter((name) => name.startsWith("atf_") && name !== "atf_flow_anchor");
    expect(tools).toHaveLength(7);
    expect(tools).toContain("atf_data_admission.request");
    expect(tools).toContain("atf_preparation.propose");
    expect(tools).toContain("atf_style_cluster.execute");
    // ledger_record 仍在契约中登记；【K4 补登 2026-09-16】为运行时方法面（内核 §13.8，补登不 bump）
    expect(methods).toContain("ledger_record");
    expect(contract).toMatch(/ledger_record:.*# 【K4 补登 2026-09-16】运行时方法面（内核 §13.8；补登不 bump）/);
    // 【K3 补登 2026-09-17】atf_flow_anchor 为运行时方法面（内核 §13.9，补登不 bump）
    expect(methods).toContain("atf_flow_anchor");
    expect(contract).toMatch(/atf_flow_anchor:.*# 【K3 补登 2026-09-17】运行时方法面（内核 §13\.9；补登不 bump）/);
    // 【K-Gap-2 补登 2026-09-21】方法面 10→12（内核 §13.11/§13.12；补登不 bump 双轴）
    expect(contract).toMatch(/K-Gap-2 接线批补登 2026-09-21/);
    expect(contract).toMatch(/§13\.11/);
    expect(contract).toMatch(/§13\.12/);
  });

  it("补登登记：可选 run_id（显式优先于会话绑定）/ 错误码 no_run_bound+unknown_run / 留痕 event session/run-bound", () => {
    // B2：两个只读工具参数均为可选 run_id（required: []；显式 run_id 优先于会话绑定）；
    //     【K4 补登 2026-09-16】ledger_record 增第三处可选 run_id（内核 §13.0 覆盖口径，写透定位用）；
    //     【K3 补登 2026-09-17】atf_flow_anchor 增第四处可选 run_id（内核 §13.9，显式优先于会话绑定）
    expect(contract.match(/run_id: \{ type: string, required: false \}/g)).toHaveLength(4);
    expect(contract).toMatch(/显式 run_id 优先于会话绑定/);
    expect(contract).toMatch(/required: \[run_id\]/);
    // B3：错误码登记（error response，连接保持）
    expect(contract).toMatch(/- no_run_bound/);
    expect(contract).toMatch(/- unknown_run/);
    // B4：绑定留痕 event
    expect(contract).toMatch(/session\/run-bound/);
    // 编排层口径登记（本仓编排采用显式 run_id；bind_run 服务宿主/长会话场景）
    expect(contract).toMatch(/编排层口径/);
  });

  it("R2 补登（D3）：atf_admit_data 可选 pin；bump 口径固化（纯增量不 bump / 破坏性 bump）", () => {
    // 可选 pin 参数（纯增量补登，contract_version 不 bump）
    expect(contract).toMatch(/pin: \{ type: string, required: false/);
    expect(contract).toMatch(/canonical_digest\(\{dataset_id, source_ref\}\)\[:12\]/);
    // bump 口径表进版本轴注记（D3 裁决 2026-09-14）
    expect(contract).toMatch(/bump 口径固化（D3 裁决 2026-09-14）/);
    expect(contract).toMatch(/纯增量（新增方法、新增可选字段\/参数、错误码枚举扩面）→ 补登登记，不 bump/);
    expect(contract).toMatch(/破坏性（改名、删字段、改既有字段语义、收窄枚举、帧\/握手\/生命周期变更）→ bump 桥接契约版本轴/);
    // 文件头部值仍为 2（纯增量不 bump）
    expect(contract).toMatch(/^contract_version: 2$/m);
  });

  it("改名完整性：旧方法名不作方法键/字段残留（仅存于 v2 变更登记的时代说明注释行）", () => {
    // 方法键与字段键层面零残留
    expect(methodKeys()).not.toContain("atf_surface_scan");
    expect(contract).not.toMatch(/^        surface:/m);
    expect(contract).toContain("atf_fact_scan");
    expect(contract).toMatch(/        facts:/);
    // 旧名仅允许出现在注释部分（行注释或行尾 # 注释——v2 变更登记 = 显式时代说明，
    // 契约修订纪律要求点名旧方法）；代码/键位部分零残留。
    for (const line of contract.split("\n")) {
      if (!line.includes("atf_surface_scan")) continue;
      const codePart = line.split("#")[0] ?? "";
      expect(codePart.includes("atf_surface_scan"), `旧名只允许出现在注释部分，实得：${line.trim()}`).toBe(false);
    }
  });

  it("v2 关键字段登记：warn 档位 / reason_codes / source_ref / scope_ref / 审批链消费", () => {
    expect(contract).toMatch(/enum: \[pass, warn, blocked\]/);
    expect(contract).toMatch(/reason_codes:/);
    expect(contract).toMatch(/source_ref:/);
    expect(contract).not.toMatch(/^        source: \{ type: string/m); // v1 参数名零残留
    expect(contract).toMatch(/approval_ref: \{ type: string/);
    expect(contract).toMatch(/state: \{ const: consumed \}/);
    expect(contract).toMatch(/approval_already_consumed/);
    expect(contract).toMatch(/approval_record_mismatch/);
  });

  it("K3 补登（2026-09-17）：atf_flow_anchor 三态 current/stale/missing / INV-A 消费纪律 / §13.9 错误码与措辞纪律", () => {
    // 三态（missing＝run 尚无任何推进的合法态，非错误）
    expect(contract).toMatch(/anchor_status: \{ enum: \[current, stale, missing\] \}/);
    // INV-A 消费纪律：harness 收到 stale 不得自行推断最新阶段（不得重派生 phase）；
    // 最新派生投影只能由内核 writer 在下一次推进时写锚产出
    expect(contract).toMatch(/INV-A 消费纪律/);
    expect(contract).toMatch(/不得自行推断最新阶段/);
    // 锚定返回值措辞纪律＝只能写「派生投影」
    expect(contract).toMatch(/派生投影/);
    // 错误码（连接保持）：no_run_bound / unknown_run / anchor_document_invalid / facts_log_* 族透传
    expect(contract).toMatch(/- anchor_document_invalid/);
    expect(contract).toMatch(/- no_run_bound/);
    expect(contract).toMatch(/- unknown_run/);
    expect(contract).toMatch(/- facts_log_tail_corrupt/);
  });

  it("atf_upstream pin 保持 v0.7.2b0（re-pin R3 2026-09-20；pin＝main HEAD 61631e6，不追后续中间态）", () => {
    expect(contract).toMatch(/  tag: v0\.7\.2b0/);
    expect(contract).toMatch(/  commit_sha: 61631e6ae4543f35e79751f5bf4d9d5bfa2abdc5/);
    // 会话协议版本轴不随 re-pin 变动（内核方法面补登不 bump）；桥接契约版本轴恒 2（另轴）
    expect(contract).toMatch(/  contract_version: 1/);
  });
});
