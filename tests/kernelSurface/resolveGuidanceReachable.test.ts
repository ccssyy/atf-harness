// B4 双卡归一锚（1116 发现 3/15）：
// ①指路可达性——resolve 族工具的描述/报文引用的参数名必须在 schema properties 内
//   （发现 15 指路不可达形态机检：「带 X 重试」而 schema 无 X=死指路）；
// ②单卡形态——atf_label_qc_resolve=user_decision 单轨（ADR-0022 确认卡轨唯一），
//   凭据预检重入直通（approvalTrack 既有语义锚固化——同 tool_call_id 已 granted 不重复问询）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const toolDefSrc = readFileSync(
  resolve(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts"),
  "utf-8",
);

describe("B4 指路可达性与单卡形态", () => {
  it("resolve 族报文指路引用的参数在工具声明面内（死指路机检）", () => {
    // 报文引用形态闭集（发现 15 实锚:消歧死指路「带 workspace_path 重试」——schema 当时不收）。
    // 声明面并集=pipelineFace 段工具+toolDefinition 全工具（label_qc_resolve 定义在后者）。
    const toolDefDefinition = readFileSync(
      resolve(process.cwd(), "src/core/tools/toolDefinition.ts"),
      "utf-8",
    );
    const declaredAll = toolDefSrc + toolDefDefinition;
    const mentioned = ["workspace_path", "run_id", "report_digest", "dataset_id"];
    for (const key of mentioned) {
      const declared = new RegExp(`\\b${key}\\??:`).test(declaredAll);
      expect(
        declared,
        `报文引用的参数 ${key} 不在工具声明面（pipelineFace+toolDefinition）——死指路形态（发现 15）`,
      ).toBe(true);
    }
  });

  it("atf_label_qc_resolve=user_decision 单轨（确认卡唯一承载，无叠加审批轨）", () => {
    // 语义表单源锚:APPROVAL_SEMANTICS_BY_TOOL 映射=单轨判定出口（toolDefinition:60）
    expect(toolDefSrc.includes("atf_label_qc_resolve")).toBe(true);
    const defSrc = readFileSync(
      resolve(process.cwd(), "src/core/tools/toolDefinition.ts"),
      "utf-8",
    );
    expect(defSrc).toContain('atf_label_qc_resolve: "user_decision"');
    // ADR-0022:审批拦截轨退役——语义表存在即无叠加轨（approvalTrack 账本轨优先+问答轨单 handler）
  });

  it("approvalTrack 重入直通锚已随甲线退役（阶段1-A 删线）", () => {
    // 原用例验证 `src/core/run/approvalTrack.ts` 的重入语义；该文件已随甲线
    // core/run 在「阶段1-A 删线」退役（commit 8f33cec5）。断言改为「已退役」，
    // 防止该文件被误恢复——恢复即红，需重新评估治理面归属。
    // ADR-0022 后审批拦截轨的语义已由 vendor `ctx.approval` + 业务确认卡承载。
    let exists = true;
    try {
      readFileSync(resolve(process.cwd(), "src/core/run/approvalTrack.ts"), "utf-8");
    } catch {
      exists = false;
    }
    expect(exists, "src/core/run/approvalTrack.ts 已退役，不应被恢复").toBe(false);
  });
});
