/**
 * F5 改动四 4.2 单元用例（2026-09-26）——审批 key 派生纳入内容摘要：
 * 脚本记号提取（argv/command 闭集）／内容绑定提案键（同路径重写 → key 必变；无内容 →
 * 既有 key 逐位一致）／fs 解析器（白名单定界、越界与缺失按不可读跳过）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  proposalApprovalKey,
  proposalContentDigestFromContents,
  scriptTokensFromParams,
  approvalKeyFor,
} from "../../src/core/tools/index.js";
import { contentDigestOfFiles, createProposalContentDigestFor } from "../../src/core/tools/index.js";

describe("F5 4.2 scriptTokensFromParams——脚本记号提取（保守闭集）", () => {
  it("atf_scratch_exec：argv 内 .py 记号按出现序去重", () => {
    expect(scriptTokensFromParams("atf_scratch_exec", { argv: ["python3", "peek.py", "--out", "peek.py", "other.txt"] })).toEqual(["peek.py"]);
  });

  it("atf_bash：command 按分隔符切段后取 .py/.sh 记号", () => {
    expect(scriptTokensFromParams("atf_bash", { command: "python peek.py && bash run.sh | grep x" })).toEqual(["peek.py", "run.sh"]);
  });

  it("非脚本后缀不入集（不猜无后缀可执行物）", () => {
    expect(scriptTokensFromParams("atf_bash", { command: "rm -rf build && ./run" })).toEqual([]);
  });

  it("非内容绑定工具 → 恒空（atf_write 内容在 params，既有 digest 已覆盖）", () => {
    expect(scriptTokensFromParams("atf_write", { path: "peek.py", content: "x" })).toEqual([]);
    expect(scriptTokensFromParams("atf_admit_data", { dataset_id: "ds-1" })).toEqual([]);
  });
});

describe("F5 4.2 proposalApprovalKey——内容绑定提案键", () => {
  it("无内容摘要 → key ＝ 既有 params_digest（逐位一致，零回归锚）", () => {
    const params = { command: "python peek.py" };
    const key = proposalApprovalKey("atf_bash", params);
    expect(key).toEqual({ approval_key: approvalKeyFor("atf_bash", params).params_digest, params_digest: approvalKeyFor("atf_bash", params).params_digest });
    expect(key.content_digest).toBeUndefined();
  });

  it("同 params 不同内容摘要 → key 必变（peek.py 30 次同 key 盲区修复语义）", () => {
    const params = { argv: ["python3", "peek.py"] };
    const first = proposalApprovalKey("atf_scratch_exec", params, "digest-1");
    const second = proposalApprovalKey("atf_scratch_exec", params, "digest-2");
    expect(first.approval_key).not.toBe(second.approval_key);
    expect(first.params_digest).toBe(second.params_digest); // 审计/账本 evidence_refs 面不变
    expect(first.content_digest).toBe("digest-1");
  });

  it("同 params 同内容 → key 一致（幂等重提案仍共享键——拒绝循环防护语义保持）", () => {
    const params = { command: "python peek.py" };
    expect(proposalApprovalKey("atf_bash", params, "d").approval_key).toBe(proposalApprovalKey("atf_bash", params, "d").approval_key);
  });
});

describe("F5 4.2 proposalContentDigestFromContents——摘要算法", () => {
  it("无可读内容 → undefined（key 退回既有形态）", () => {
    expect(proposalContentDigestFromContents([{ token: "a.py" }, { token: "b.py" }])).toBeUndefined();
  });

  it("部分可读 → 按可读项计算；全量算法与 contentDigestOfFiles 一致", () => {
    expect(proposalContentDigestFromContents([{ token: "a.py" }, { token: "b.py", content: "x" }]))
      .toBe(contentDigestOfFiles([{ token: "b.py", content: "x" }]));
  });
});

describe("F5 4.2 createProposalContentDigestFor——fs 解析（白名单定界）", () => {
  const env = (() => {
    const root = mkdtempSync(join(tmpdir(), "atf-f5-key-"));
    writeFileSync(join(root, "peek.py"), "print('v1')\n");
    return { root, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
  })();

  it("相对路径落主根：读到的内容进摘要；同路径重写 → 摘要变化", async () => {
    const resolver = createProposalContentDigestFor({ roots: () => [env.root] });
    const first = await resolver("atf_scratch_exec", { argv: ["python3", "peek.py"] });
    expect(first).not.toBeUndefined();
    writeFileSync(join(env.root, "peek.py"), "print('v2 — rewritten')\n");
    const second = await resolver("atf_scratch_exec", { argv: ["python3", "peek.py"] });
    expect(second).not.toBeUndefined();
    expect(first).not.toBe(second);
    // key 层面同路径重写必变
    const params = { argv: ["python3", "peek.py"] };
    expect(proposalApprovalKey("atf_scratch_exec", params, first).approval_key)
      .not.toBe(proposalApprovalKey("atf_scratch_exec", params, second).approval_key);
  });

  it("白名单外绝对路径与缺失文件按不可读跳过；全不可读 → undefined", async () => {
    const resolver = createProposalContentDigestFor({ roots: () => [env.root] });
    expect(await resolver("atf_bash", { command: "python /etc/passwd.py" })).toBeUndefined();
    expect(await resolver("atf_bash", { command: "python missing.py" })).toBeUndefined();
  });

  it("非脚本类工具 → undefined（不读盘）", async () => {
    const resolver = createProposalContentDigestFor({ roots: () => [env.root] });
    expect(await resolver("atf_write", { path: "peek.py", content: "x" })).toBeUndefined();
  });

  it("嵌套子目录脚本可读（主根相对解析）", async () => {
    const sub = join(env.root, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "s.py"), "print('sub')\n");
    const resolver = createProposalContentDigestFor({ roots: () => [env.root] });
    expect(await resolver("atf_bash", { command: "python sub/s.py" })).not.toBeUndefined();
  });
});
