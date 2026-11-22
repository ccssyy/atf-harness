// B1 信息足八子面全链断言（1116 owner 闭集裁定——每子面一条 CI 断言+真机反例 fixture）。
// 子面闭集封顶：参数全/报错带改法/状态真/卡面含决策内容/结果汇报/进度足/入口足/追溯足。
// 新问题只归属不扩面（owner 硬约束 1）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 内核源路径=ATF_KERNEL_SOURCE（单版本源门同源 env；未设=内核读取面用例如实 skip
// ——stageOrder 同款形态，杜绝 worktree 绝对路径硬编码事故）
const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "";
const readKernel = (rel: string): string | null => {
  if (!kernelRoot) return null;
  try {
    return readFileSync(resolve(kernelRoot, rel), "utf-8");
  } catch {
    return null;
  }
};

const pipelineFaceSrc = readFileSync(
  resolve(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts"),
  "utf-8",
);
const trainingFaceSrc = readFileSync(
  resolve(process.cwd(), "packages/extensions/atf-tools/src/trainingFace.ts"),
  "utf-8",
);
const canonicalSrc = readFileSync(
  resolve(process.cwd(), "src/core/tools/canonical.ts"),
  "utf-8",
);

describe("B1 信息足八子面（CI 全链断言）", () => {
  it("①参数全：会话身份注入面在场（A7——exec.agent.session.id 断点根治）", () => {
    const executorSrc = readFileSync(
      resolve(process.cwd(), "src/core/tools/executor.ts"),
      "utf-8",
    );
    expect(executorSrc).toContain("options?.sessionId !== undefined");
    expect(executorSrc).toContain("this.local.host.sessionId = options.sessionId");
    // 真机反例（发现 15）：身份五环断=workspace_path 消歧死指路——声明面含该键
    expect(pipelineFaceSrc).toContain("workspace_path?: string");
  });

  it("②报错带改法：schema_violation 防御径=定位+两条改法（B11 发现 5 反例修复）", () => {
    expect(canonicalSrc).toContain("withHowToFix");
    expect(canonicalSrc).toContain("两条改法");
    // 发射点 details 全量透传（tool/message 到投影层——发现 5 反例=details 只带 error）
    const atfAgentToolsSrc = readFileSync(
      resolve(process.cwd(), "src/agent/atfAgentTools.ts"),
      "utf-8",
    );
    expect(atfAgentToolsSrc).toContain('details: { error: "schema_violation", tool: definition.name, message: paramCheck }');
  });

  it("③状态真：三态消歧（B5 发现 14 反例=假完成状态/假 checkpoint 清单）", () => {
    expect(trainingFaceSrc).toContain("已结束（训练段 done 且 loss 序列在场");
    expect(trainingFaceSrc).toContain("未启动（无 checkpoint 产物");
    expect(trainingFaceSrc).toContain("已停止（有 checkpoint 产物但 tmux 会话不在场");
    // 清单只报实存：readdirSync 实存断言（adapter_model.safetensors 在场才算）
    expect(trainingFaceSrc).toContain("adapter_model.safetensors");
  });

  it("④卡面含决策内容：label_qc 冲突对照+依据+建议（B3 发现 3/4 反例=盲批/碎片池）", () => {
    const cardSrc = readFileSync(
      resolve(process.cwd(), "src/ui/labelQcCard.ts"),
      "utf-8",
    );
    expect(cardSrc).toContain("候选：");
    expect(cardSrc).toContain("依据：");
    expect(cardSrc).toContain("内核建议：");
  });

  it.runIf(kernelRoot)("⑤结果汇报：构造产物会话流摘要行（B8 发现 10 反例=mode5 产 37 行零披露）", () => {
    const pipelineSrc = readKernel("skills/atf-admit-training-data/scripts/walkthrough_pipeline.py");
    expect(pipelineSrc, "内核 walkthrough_pipeline.py 可读").toBeTruthy();
    expect(pipelineSrc).toContain("_construction_summary_line");
    expect(pipelineSrc).toContain("构造汇总：");
    expect(pipelineSrc).toContain("mode5 短缺如实");
  });

  it("⑥进度足：progress.jsonl 机制在场（正向锚——真机轮正向 7 条之一勿回退）", () => {
    const runFactsSrc = readFileSync(
      resolve(process.cwd(), "packages/extensions/atf-core/src/runFacts.ts"),
      "utf-8",
    );
    expect(runFactsSrc).toContain("progressPathOf");
    expect(runFactsSrc).toContain("writeProgress");
  });

  it("⑦入口足：段入口唯一单源（D303 入口锚——STAGE_ORDER 单源 choices）", () => {
    const stageParams = readFileSync(
      resolve(process.cwd(), "src/core/generated/stageParams.ts"),
      "utf-8",
    );
    expect(stageParams).toContain("--stage");
    // 直跑收紧闸（A8）=执行来源可判别（入口足的执行面）
    expect(pipelineFaceSrc).not.toContain('"--lane-suffix"');
  });

  it.runIf(kernelRoot)("⑧追溯足：直跑闸+账本留痕（A8 逃生留痕+ApprovalRecord subject_components）", () => {
    const pipelineSrc = readKernel("skills/atf-admit-training-data/scripts/walkthrough_pipeline.py");
    expect(pipelineSrc, "内核 walkthrough_pipeline.py 可读").toBeTruthy();
    expect(pipelineSrc).toContain("direct-exec-audit.jsonl");
    expect(pipelineSrc).toContain("_EXEC_SOURCE_ENV");
    const launchSrc = readKernel("skills/atf-prepare-training/scripts/generate_train_launch.py");
    expect(launchSrc, "内核 generate_train_launch.py 可读").toBeTruthy();
    expect(launchSrc).toContain("subject_components");
  });
});
