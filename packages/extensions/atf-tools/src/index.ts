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
import { resolveBridgeDeployment, probeBridgeHandshakeVersionSync, formatBridgeBootVersionText, type BridgeBootVersionSurface } from "../../../../src/bridge/bridgeCommand.js";
import { checkApprovalLedgerStartup } from "../../../../src/core/workspace/approvalLedger.js";
import { runBootPreflight, formatPreflightFatal, BOOT_PREFLIGHT_PIPELINE_ENV, BOOT_PREFLIGHT_BRIDGE_ENV } from "../../../../src/core/workspace/bootPreflight.js";
import { resolveInstanceKernelDir, resolveInstancePinRoot } from "../../../../src/core/workspace/instancePin.js";
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { registerApprovalExempt } from "./approvalExempt.js";
import { buildFileGuardTools, registerPathGuard } from "./fileGuardFace.js";
import { deriveFileToolRoots } from "../../../../src/agent/fileRoots.js";
import type { FileToolHost } from "../../../../src/agent/fileTools.js";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { BridgeManager, buildBridgeTools } from "./bridgeFace.js";
import { buildFileTools } from "./fileFace.js";
import { buildPipelineTool } from "./pipelineFace.js";
import { buildConfirmTools } from "./confirmFace.js";
import { buildRunTrainingTool, buildEvalTools, buildPublishModelTool, type TrainingToolsConfig } from "./trainingFace.js";
import { buildRecordsQueryTool } from "./recordsFace.js";

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
    .default(resolveInstanceKernelDir(process.env, repoRoot)),
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
  // 批㊶-W：boot 环境预检分级自愈（§五/§6.3——L1 产品写权限内自动补＋留痕；L2 系统级
  // fail-fast 给可复制命令。先于账本校验与工具装配：env 补齐影响后续全部取值链；
  // L1 补齐写 preflightEnv 局部束（不写 process.env——并发实例同进程装配互踩面收敛）。
  // 批㊶-ISO-2 S1：实例 pin 根单源（resolveInstancePinRoot——env 显式＞兼容回退共享态）；
  // 预检做 worktree 实锚校验＋回退留痕（「pin 路径：回退共享态」随 notes 行进 boot 日志）。
  const instancePin = resolveInstancePinRoot(process.env, repoRoot);
  const preflight = runBootPreflight(process.env, {}, config.kernelDir, { root: instancePin.root, explicit: instancePin.source === "env" });
  console.log(`[atf-preflight] 预检完成：L1 自愈 ${preflight.autoFixed.length} 项／L2 fatal ${preflight.fatal.length} 项／观察 ${preflight.notes.length} 项`);
  for (const note of preflight.notes) console.log(`[atf-preflight] ${note}`);
  const preflightEnv: Record<string, string> = {};
  for (const fix of preflight.autoFixed) {
    preflightEnv[fix.key] = fix.value;
    console.log(`[atf-preflight] L1 ${fix.note}`);
  }
  if (preflight.fatal.length > 0) {
    throw new Error(`[atf-preflight] L2 环境缺失（fail-fast——不静默降级）：\n${formatPreflightFatal(preflight.fatal)}`);
  }
  // 批㊶-W F4/L1 自愈联动：Config 在模块加载期固化 env 缺省——preflight 注入晚于固化，
  // 命令面取值链＝preflight L1 束 ＞ env ＞ Config 固化值（mock 缺省＝测试注入路径）。
  const pipelineCommand = preflightEnv[BOOT_PREFLIGHT_PIPELINE_ENV] ?? process.env[BOOT_PREFLIGHT_PIPELINE_ENV] ?? config.pipelineCommand;
  const bridgeCommand = preflightEnv[BOOT_PREFLIGHT_BRIDGE_ENV] ?? process.env[BOOT_PREFLIGHT_BRIDGE_ENV] ?? config.bridgeCommand;
  // 批㊶Q增补三 段1②：放行账本启动校验（fail-fast）——env 显式配置而目录不可写即拒绝启动；
  // env 与 $HOME 推导不一致 → 启动即告警（两路径明示，杜绝静默分轴——10-08 在册债 cr_r2 三连败实锚）。
  const ledgerCheck = checkApprovalLedgerStartup(process.env);
  if (!ledgerCheck.dirWritable) {
    throw new Error(`[atf-tools] 放行账本目录不可写（fail-fast）：${ledgerCheck.message}`);
  }
  if (ledgerCheck.mismatch) {
    console.warn(`[atf-tools] ⚠ ${ledgerCheck.message}`);
  } else {
    console.log(`[atf-tools] ${ledgerCheck.message}`);
  }
  // （M2 时序注记：loader.create 动态行会触发 atf-ui 双 mount——已移除；atf-ui 行由 profile patch 静态装配。）
  // 批㊶-E-H 项 2.1：桥对端装配单源（src/bridge/bridgeCommand.ts）——ATF_DSH_BRIDGE_COMMAND
  // 在场即真内核 argv＋PYTHONPATH（子进程私有 env，派生自 kernelDir/src）；缺席保留 mock。
  const deployment = resolveBridgeDeployment({ commandValue: bridgeCommand, kernelDir: config.kernelDir, env: process.env });
  // 批㊶-ISO-2 S2：boot 版本行以 bridge 握手实载版本为准（atf.version→version——serve 进程
  // 实载）；kernelVersionSync describe 降交叉核对项，不一致双显＋warning（同步探针 fail-soft，
  // 握手不可达时如实降级为 describe 未核对显示）。
  const versionSurface: BridgeBootVersionSurface | null = deployment.mode === "real" ? probeBridgeHandshakeVersionSync(deployment) : null;
  const bridgeLine = deployment.mode === "real"
    ? `real（${deployment.argv.join(" ")}${deployment.childEnv["PYTHONPATH"] !== undefined ? ` ｜ PYTHONPATH=${deployment.childEnv["PYTHONPATH"]}` : ""}）内核 ${formatBridgeBootVersionText(versionSurface)}`
    : `mock（${deployment.argv.join(" ")}——设 ATF_DSH_BRIDGE_COMMAND 切真内核）`;
  console.log(`[atf-tools] 桥对端: ${bridgeLine}`);
  if (versionSurface?.mismatchWarning !== undefined && versionSurface !== null && versionSurface.mismatchWarning !== null) {
    console.warn(`[atf-tools] ${versionSurface.mismatchWarning}`);
  }
  console.log(`[atf-tools] 管线对端: ${pipelineCommand}${process.env[BOOT_PREFLIGHT_PIPELINE_ENV] !== undefined ? "（env 真命令——F4）" : "（mock 缺省——设 ATF_DSH_PIPELINE_COMMAND 切真管线）"}`);
  const manager = new BridgeManager(deployment.argv, repoRoot, deployment.childEnv);

  // 批㊶R前置 状态面：本机模型清单（启动扫描一次——boot 日志投影＋atf_run_training 描述注入；
  // 根＝env ATF_MODEL_ROOT（实例层注入）；未配置/缺席如实空清单不猜测）
  const modelInventory = scanLocalModels(process.env);
  console.log(`[atf-tools] 本机模型清单：${modelInventory.models.length} 个（${modelInventory.root}${modelInventory.error !== undefined ? `｜${modelInventory.error}` : ""}）${modelInventory.models.length > 0 ? `：${modelInventory.models.join("、")}` : ""}`);

  // 批㊶-F-H 项 1：bash/write 类审批豁免 answerer（择案 A——waterfall 头部 prepend；
  // 高危治理点 atf_* 全体不进类仍走人工面板；详见 approvalExempt.ts 头注）
  if (registerApprovalExempt(ctx)) {
    console.log("[atf-tools] bash/write 免审 answerer 已挂（approval/request waterfall 头部；atf_* 契约工具审批语义零变化）");
  }

  // 批㊶-H/I：文件工具路径守卫＋A7 治理四件挂载（案 甲单轨）——白名单根＝派生集
  // （配置声明面镜像，fileRoots.ts）＋env 附加集；产品资产零具体目录（增补裁定）。
  const fileRoots = deriveFileToolRoots({ env: process.env });
  const fileHost: FileToolHost = { roots: fileRoots.roots, env: process.env };
  // 批㊶-W W1：atf_bash 围栏取值链＝会话绑定反查（runsRoot 直传 deps）＞ env 过渡态
  for (const tool of buildFileGuardTools(fileHost, { runsRoot: config.runsRoot })) ctx.tools.register(tool);
  if (registerPathGuard(ctx, fileHost)) {
    console.log(
      `[atf-tools] 文件路径守卫已挂（tools/pre-execute prepend；守卫 glob/grep/read_image，封闭 vendor read/edit/write 改道 A7；A7 四件挂载）白名单根 ${String(fileRoots.roots.length)} 个（派生集＝配置声明面镜像＋env 附加集）`,
    );
  }

  for (const tool of buildBridgeTools(ctx, manager, { runsRoot: config.runsRoot, kernelDir: config.kernelDir, execHome: config.execHome })) ctx.tools.register(tool);
  for (const tool of buildFileTools(config.runsRoot)) ctx.tools.register(tool);
  ctx.tools.register(buildPipelineTool(ctx, pipelineCommand, config.pipelineTimeoutMs));
  for (const tool of buildConfirmTools({ runsRoot: config.runsRoot, ctx })) ctx.tools.register(tool);
  const trainCfg: TrainingToolsConfig = { runsRoot: config.runsRoot, logDir: config.logDir, ctx, models: { root: modelInventory.root, names: modelInventory.models }, bindRun: (runId) => manager.bindRun(runId) };
  ctx.tools.register(buildRunTrainingTool(ctx, trainCfg));
  for (const tool of buildEvalTools(ctx, { runsRoot: config.runsRoot, logDir: config.logDir, kernelDir: config.kernelDir, bindRun: (runId) => manager.bindRun(runId) })) ctx.tools.register(tool);
  ctx.tools.register(buildPublishModelTool(ctx, { runsRoot: config.runsRoot }));
  ctx.tools.register(buildRecordsQueryTool(ctx, { runsRoot: config.runsRoot, currentRunWorkspace: () => process.env["ATF_BASH_RUN_WORKSPACE"] ?? null }));
  console.log("[atf-tools] atf_publish_model＋atf_records_query 已挂载");

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
      description: "atf-tools 装配自检探针：返回固定问候与桥接工具清单（连通性诊断用），附本机可用模型清单（ATF_MODEL_ROOT 扫描——训练 base_model.path 选型参考）。",
      parameters: {},
      output: {
        schema: looseObjectOutput,
        render: renderAsJsonText,
      },
      async execute() {
        // 批㊶R前置 状态面 additive：本机模型清单（启动扫描结果随装配闭包携带）
        return {
          greeting: "atf-tools 已挂载", package: "@atf/dsh-atf-tools@0.1.0", tools: 11,
          local_models: { root: modelInventory.root, count: modelInventory.models.length, models: modelInventory.models, ...(modelInventory.error !== undefined ? { error: modelInventory.error } : {}) },
        };
      },
    }),
  );
}
