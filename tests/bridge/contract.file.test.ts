import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * 契约文件自检（契约修订 v2 验收 §4.3 的自动化承载）：bridge.contract.yaml 为双侧唯一
 * 真相源，本测试锚定其关键不变量——零依赖（不引 YAML 解析器，按行/文本断言）。
 * 契约 v2（2026-09-13 契约修订）：
 *   - contract_version: 2；
 *   - 运行时方法面 = 握手 atf.version + 4 工具 + 2 账本方法（ledger_query/ledger_consume）；
     工具面含改名后的 atf_fact_scan；旧方法名与旧数组字段零残留；
 *   - ledger_record 为 mock setup 基建（非运行时方法面）；
 *   - atf_upstream pin 保持 v0.2.0b7 不动（re-pin 另行指令）。
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
  it("contract_version: 2（契约修订 v2）", () => {
    expect(contract).toMatch(/^contract_version: 2$/m);
    expect(contract).not.toMatch(/^contract_version: 1$/m);
  });

  it("运行时方法面：握手 + 4 工具（含 atf_fact_scan）+ 2 账本；ledger_record 为 setup 基建", () => {
    const methods = methodKeys();
    // 握手 + 工具 + 账本运行时方法
    for (const required of ["atf.version", "atf_admit_data", "atf_gate", "atf_fact_scan", "atf_workspace_status", "ledger_query", "ledger_consume"]) {
      expect(methods, `契约 methods 缺少 ${required}`).toContain(required);
    }
    // 工具面恰 4 个（严格 4 工具，owner 口径 #5）
    const tools = methods.filter((name) => name.startsWith("atf_"));
    expect(tools).toHaveLength(4);
    // ledger_record 仍在契约中登记，且标注为 setup 基建（非运行时方法面）
    expect(methods).toContain("ledger_record");
    expect(contract).toMatch(/ledger_record:.*# mock 测试\/冒烟 setup 基建，非运行时方法面/);
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

  it("atf_upstream pin 保持 v0.2.0b7 不动（re-pin 另行指令）", () => {
    expect(contract).toMatch(/  tag: v0\.2\.0b7/);
    expect(contract).toMatch(/  commit_sha: a628f8b8e23beff104b42b5c80088416ea78b394/);
  });
});
