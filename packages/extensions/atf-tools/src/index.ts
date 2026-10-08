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
import { resolveBridgeDeployment, kernelVersionSync } from "../../../../src/bridge/bridgeCommand.js";
import { registerApprovalExempt } from "./approvalExempt.js";
import { buildFileGuardTools, registerPathGuard } from "./fileGuardFace.js";
import { deriveFileToolRoots } from "../../../../src/agent/fileRoots.js";
import type { FileToolHost } from "../../../../src/agent/fileTools.js";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { BridgeManager, buildBridgeTools } from "./bridgeFace.js";
import { buildFileTools } from "./fileFace.js";
import { buildPipelineTool } from "./pipelineFace.js";
import { buildConfirmTools } from "./confirmFace.js";
import { buildRunTrainingTool, buildEvalTools, type TrainingToolsConfig } from "./trainingFace.js";

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
  logDir: string;
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
  logDir: z
    .string()
    .default(process.env["ATF_DSH_LOG_DIR"] ?? join(repoRoot, "tmp", "atf-logs")),
});

export function apply(ctx: any, config: AtfToolsConfig): void {
  console.log(`[atf-tools] apply()——注册 11＋2＋3 个 atf_* 工具（M2.75 增训练执行段三投影）（runsRoot=${config.runsRoot}）`);
  // （M2 时序注记：loader.create 动态行会触发 atf-ui 双 mount——已移除；atf-ui 行由 profile patch 静态装配。）
  // 批㊶-E-H 项 2.1：桥对端装配单源（src/bridge/bridgeCommand.ts）——ATF_DSH_BRIDGE_COMMAND
  // 在场即真内核 argv＋PYTHONPATH（子进程私有 env，派生自 kernelDir/src）；缺席保留 mock。
  const deployment = resolveBridgeDeployment({ commandValue: config.bridgeCommand, kernelDir: config.kernelDir, env: process.env });
  const kernelVersion = deployment.mode === "real" ? kernelVersionSync(deployment.kernelRoot) : null;
  const bridgeLine = deployment.mode === "real"
    ? `real（${deployment.argv.join(" ")}${deployment.childEnv["PYTHONPATH"] !== undefined ? ` ｜ PYTHONPATH=${deployment.childEnv["PYTHONPATH"]}` : ""}）内核 ${kernelVersion ?? "版本未知（git describe 不可用）"}`
    : `mock（${deployment.argv.join(" ")}——设 ATF_DSH_BRIDGE_COMMAND 切真内核）`;
  console.log(`[atf-tools] 桥对端: ${bridgeLine}`);
  const manager = new BridgeManager(deployment.argv, repoRoot, deployment.childEnv);

  // 批㊶-F-H 项 1：bash/write 类审批豁免 answerer（择案 A——waterfall 头部 prepend；
  // 高危治理点 atf_* 全体不进类仍走人工面板；详见 approvalExempt.ts 头注）
  if (registerApprovalExempt(ctx)) {
    console.log("[atf-tools] bash/write 免审 answerer 已挂（approval/request waterfall 头部；atf_* 契约工具审批语义零变化）");
  }

  // 批㊶-H/I：文件工具路径守卫＋A7 治理四件挂载（案 甲单轨）——白名单根＝派生集
  // （配置声明面镜像，fileRoots.ts）＋env 附加集；产品资产零具体目录（增补裁定）。
  const fileRoots = deriveFileToolRoots({ env: process.env });
  const fileHost: FileToolHost = { roots: fileRoots.roots, env: process.env };
  for (const tool of buildFileGuardTools(fileHost)) ctx.tools.register(tool);
  if (registerPathGuard(ctx, fileHost)) {
    console.log(
      `[atf-tools] 文件路径守卫已挂（tools/pre-execute prepend；守卫 glob/grep/read_image，封闭 vendor read/edit/write 改道 A7；A7 四件挂载）白名单根 ${String(fileRoots.roots.length)} 个（派生集＝配置声明面镜像＋env 附加集）`,
    );
  }

  for (const tool of buildBridgeTools(ctx, manager, { runsRoot: config.runsRoot, kernelDir: config.kernelDir, execHome: config.execHome })) ctx.tools.register(tool);
  for (const tool of buildFileTools(config.runsRoot)) ctx.tools.register(tool);
  ctx.tools.register(buildPipelineTool(ctx, config.pipelineCommand, config.pipelineTimeoutMs));
  for (const tool of buildConfirmTools({ runsRoot: config.runsRoot, ctx })) ctx.tools.register(tool);
  const trainCfg: TrainingToolsConfig = { runsRoot: config.runsRoot, logDir: config.logDir, ctx };
  ctx.tools.register(buildRunTrainingTool(ctx, trainCfg));
  for (const tool of buildEvalTools(ctx, { runsRoot: config.runsRoot, logDir: config.logDir, kernelDir: config.kernelDir })) ctx.tools.register(tool);

  // 批㊶-K 项 3：档位可见性只读工具（当前档＋部署默认档＋全部可选档两维度——
  // 零切换路径：档位/审批面变更须经界面人工操作；文案产品口径）
  ctx.tools.register(
    defineTool({
      name: "atf_permission_status",
      description:
        "查询当前会话的权限档与审批面（只读）：返回当前生效档位、部署默认档位，以及全部可选档位（每档含文件沙箱层与审批面两个维度的说明）。档位或审批面的变更须经用户在界面人工操作——本工具只读，不提供任何改档路径。当用户询问当前权限档/审批要求时调用本工具如实回答。",
      parameters: {},
      output: {
        schema: looseObjectOutput,
        render: renderAsJsonText,
      },
      async execute(_args: Record<string, unknown>, exec: { agent?: { session?: unknown } }): Promise<ReturnType<typeof asToolValue>> {
        const service = ctx.get("permissionPresets") as
          | {
              current?: (session: unknown) => string;
              defaultPreset?: string;
              config?: { presets?: Record<string, { sandbox?: string; approval?: string; name?: string }> };
              catalog?: () => { options: Array<{ value: string; name: string; description?: string }>; defaultPreset: string };
            }
          | undefined;
        if (service === undefined || typeof service.catalog !== "function") {
          return asToolValue({ error: "unavailable", message: "权限档服务未挂载（装配面缺失）——如实告知用户当前无法查询" });
        }
        const catalog = service.catalog();
        const session = exec.agent?.session;
        const current = session !== undefined && typeof service.current === "function" ? service.current(session) : undefined;
        const fallbackDefault = service.defaultPreset ?? catalog.defaultPreset;
        const presetSpecs = service.config?.presets ?? {};
        return asToolValue({
          current_preset: current ?? fallbackDefault ?? "unknown",
          deployment_default: fallbackDefault ?? "unknown",
          presets: catalog.options.map((option) => {
            const spec = presetSpecs[option.value];
            return {
              value: option.value,
              name: option.name ?? spec?.name ?? option.value,
              file_sandbox: spec?.sandbox ?? "unknown",
              approval: spec?.approval ?? "unknown",
              ...(option.description !== undefined ? { description: option.description } : {}),
            };
          }),
          note: "档位与审批面的变更须经用户在界面人工操作",
        });
      },
    }),
  );

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
