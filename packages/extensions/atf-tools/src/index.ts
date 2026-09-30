/**
 * 批⑱-M1——atf_* 工具投影迁移为 DSH tool 插件（指令 e73b4966）。
 *
 * 形态：DSH Cordis 扩展包（name/inject/Config/apply），仓侧消费 vendor/dsh 协议
 * （@deepseek-ai/dsh-tools 的 defineTool——本仓经 node_modules symlink 消费其构建
 * 产物，vendor 源码零改动）。
 *
 * 逻辑零重写：桥接 6 工具复用 src/agent/atfAgentTools.ts 执行径（参数校验 → 桥接
 * request → canonical 校验 → 结构化 rejected 回填）；文件 4 工具复用
 * src/webui/readOnlyTools.ts 纯函数；审批判定沿 src/core/tools 的 requiresApprovalFor
 * 单源语义。
 *
 * 审批（指令要求 2）：atf_scratch_exec / atf_admit_data / atf_pipeline_stage（及
 * requiresApprovalFor 判定为真的调用，如 gate advance）走 DSH user-approval seam
 * ——确认卡由 DSH 原生 ui-approval 呈现；无审批服务时 fail-closed 拒绝。
 */
import z from "@deepseek-ai/schemastery";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { BridgeManager, buildBridgeTools } from "./bridgeFace.js";
import { buildFileTools } from "./fileFace.js";
import { buildPipelineTool } from "./pipelineFace.js";
import { buildConfirmTools } from "./confirmFace.js";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "atf-tools";

/** 依赖的 DSH service：tools＝工具注册表（approval 以 ctx.get 可选消费——缺失时敏感工具 fail-closed）。 */
export const inject = ["tools"];

/** 仓根（packages/extensions/atf-tools/src → 上四级）。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface AtfToolsConfig {
  runsRoot: string;
  kernelDir: string;
  execHome: string;
  bridgeCommand: string;
  pipelineCommand: string;
  pipelineTimeoutMs: number;
}

export const Config = z.object({
  runsRoot: z
    .string()
    .default(process.env["ATF_DSH_RUNS_ROOT"] ?? join(repoRoot, "tmp", "webui-runs")),
  kernelDir: z
    .string()
    .default(process.env["ATF_DSH_KERNEL_DIR"] ?? process.env["ATF_CLI_PATH"] ?? join(repoRoot, ".atf-pinned")),
  execHome: z
    .string()
    .default(process.env["ATF_DSH_EXEC_HOME"] ?? join(repoRoot, "tmp", "atf-exec-home")),
  bridgeCommand: z
    .string()
    .default(process.env["ATF_DSH_BRIDGE_COMMAND"] ?? `node ${join(repoRoot, "tests", "fixtures", "mock_atf.mjs")}`),
  pipelineCommand: z
    .string()
    .default(process.env["ATF_DSH_PIPELINE_COMMAND"] ?? `node ${join(repoRoot, "tests", "fixtures", "mock_pipeline.mjs")}`),
  pipelineTimeoutMs: z.number().default(120_000),
});

export function apply(ctx: any, config: AtfToolsConfig): void {
  console.log(`[atf-tools] apply()——注册 11＋2 个 atf_* 工具（M2 增 atf_config_confirm/atf_publish_confirm）（runsRoot=${config.runsRoot}）`);
  // （M2 时序注记：loader.create 动态行会触发 atf-ui 双 mount——已移除；atf-ui 行由 profile patch 静态装配。）
  const manager = new BridgeManager(bridgeArgv(config.bridgeCommand), repoRoot);

  for (const tool of buildBridgeTools(ctx, manager, { runsRoot: config.runsRoot, kernelDir: config.kernelDir, execHome: config.execHome })) ctx.tools.register(tool);
  for (const tool of buildFileTools(config.runsRoot)) ctx.tools.register(tool);
  ctx.tools.register(buildPipelineTool(ctx, config.pipelineCommand, config.pipelineTimeoutMs));
  for (const tool of buildConfirmTools({ runsRoot: config.runsRoot, ctx })) ctx.tools.register(tool);

  // 连通性自检探针（M1 验收辅助；保留为装配诊断面）
  ctx.tools.register(
    defineTool({
      name: "atf_hello",
      description: "atf-tools 装配自检探针：返回固定问候与桥接工具清单（连通性诊断用）。",
      parameters: {},
      output: {
        schema: looseObjectOutput,
        render: renderAsJsonText,
      },
      async execute() {
        return { greeting: "atf-tools 已挂载", package: "@atf/dsh-atf-tools@0.1.0", tools: 11 };
      },
    }),
  );
}

/** 命令串 → argv（首词为可执行，余词按空格切分——Config 面保持简单；带引号路径走 env 形态的 node 包装）。 */
const bridgeArgv = (command: string): string[] => command.trim().split(/\s+/);
