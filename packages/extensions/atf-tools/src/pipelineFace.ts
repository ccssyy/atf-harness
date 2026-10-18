/**
 * atf_pipeline_stage：按段驱动 walkthrough_pipeline 段模式（内核 tag v0.7.18b0 起的
 * --stage 单段执行面，修复批A2.2b 落点单源改造；tag v0.7.19b0 起 K-E14a base 模型语义
 * 拆分——本工具 A-E14b 增 training_prep 段 base_model_path 显式下传）。
 *
 * 接口契约（引自内核件 K-A2.2a §二，双件同步；A-E14b 增补 K-E14a 命令面）：
 *   段名闭集（权威＝内核 STAGE_ORDER，八项，禁增删改序）＝register／label_qc／
 *   experiment_setup／candidate_build／publish／family_split／admission／training_prep。
 *   命令面（段模式）：--workspace 必填／--stage 八段之一／--run-id 建议显式／
 *   --source-root 仅 register 必填其余可省／--base-model 仅 training_prep（本地模型目录
 *   绝对路径；K-E14a 拆分后渲染位吃 --base-model-family，内核段模式另有盘上只读再水合，
 *   harness 案 a＝必填显式值卡前快败）。本工具下传 argv 只含上述参数，禁传内核未声明
 *   参数、禁拼第二套路径。
 *   落点（唯一）＝<workspace_path>/runs/<run_id>——本工具内 resolveRunDir 退役
 *   （内核与 harness 同一决定者，其余工具不受影响）。
 *   退出码：0 贯通／2 有拒绝（越序等，blocked）／3 环境错误。
 *
 * 事实轨与绑定（A2/A3 延续）：exit 0 → appendSegmentFact(runDir, 映射键, 本工具)＋
 *   appendBinding(runDir, sessionId)（sessionId 取不到如实跳过）；exit 2/3 一律零写入。
 *   映射表（kernel stage → UI segment）：experiment_setup→experiment_config、
 *   candidate_build→candidate、family_split→split、training_prep→null（只落事实轨
 *   不点灯——null 即按内核原文名落事实，该名不在前缀闭包读面）；candidate 键亦不在
 *   前缀闭包内（闭包语义不动）。
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { join } from "node:path";

/** 段名闭集（权威＝内核 STAGE_ORDER 八项——禁增删改序；旧六段名别名不保留）。 */
export const PIPELINE_STAGES: readonly string[] = [
  "register",
  "label_qc",
  "experiment_setup",
  "candidate_build",
  "publish",
  "family_split",
  "admission",
  "training_prep",
];

/** kernel stage → UI segment 映射表（A2.2b 落常量）。null＝只落事实轨不点灯
 *  （training_prep 按内核原文名落事实；candidate_build 落 candidate——两键均不在
 *  SEGMENT_ORDER_KEYS 前缀闭包读面，闭包语义不动）。 */
export const SEGMENT_FACT_BY_KERNEL_STAGE: Readonly<Record<string, string | null>> = {
  register: "register",
  label_qc: "label_qc",
  experiment_setup: "experiment_config",
  candidate_build: "candidate",
  publish: "publish",
  family_split: "split",
  admission: "admission",
  training_prep: null,
};

/** 会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过——confirmFace 同款）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

// ── A-E14b：training_prep 段 base_model_path（案 a 配合 K-E14a 语义拆分）──

/** 卡前快败指路文案（base_model_path_missing）：本地模型目录绝对路径语义＋可用模型清单
 *  来源＝ATF_MODEL_ROOT env（清单经既有 scanLocalModels 单源扫取，零写死模型根、零绝对路径
 *  字面量；清单缺失时只指路 env，不猜）。 */
export const baseModelPathGuidance = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const head =
    "training_prep 段必填 base_model_path——本地模型目录绝对路径（目录内须有 config.json）；模型家族名（如 qwen3_vl）不可当路径用";
  const inv = scanLocalModels(env);
  if (inv.models.length > 0) {
    const listing = `${inv.models.slice(0, 3).join("、")}${inv.models.length > 3 ? `（共 ${inv.models.length} 个）` : ""}`;
    return `${head}；可用模型清单（来源 ATF_MODEL_ROOT，前三）：${listing}`;
  }
  return `${head}；可用模型清单来源＝环境变量 ATF_MODEL_ROOT（未设置或无模型时先配置模型存放根再重试）`;
};

/** 返回面 base_model_source 对账值：explicit＝harness 显式下传 --base-model（显式值优先——
 *  内核对显式值不再再水合）；kernel_rehydrated＝内核盘上只读再水合（K-E14a）——对端摘要
 *  携带 base_model_source 字段时透传（对账词汇；本工具 training_prep 必填显式值，
 *  该分支为对端如实回流保留）。 */
export const baseModelSourceOf = (explicit: boolean, summary: unknown): "explicit" | "kernel_rehydrated" | undefined => {
  if (explicit) return "explicit";
  const src = (summary as Record<string, unknown> | null)?.["base_model_source"];
  return src === "kernel_rehydrated" || src === "explicit" ? src : undefined;
};

const runPipeline = (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, ...rest] = command.split(" ");
    execFile(
      file ?? command,
      [...rest, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // 非零退出也返回（如实回报；超时时 code 为 null）
        const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const buildPipelineTool = (
  ctx: { get(service: string): unknown },
  pipelineCommand: string,
  pipelineTimeoutMs: number,
): unknown =>
  defineTool({
    name: "atf_pipeline_stage",
    description:
      `按段驱动 walkthrough_pipeline 段模式（审批必经）：单段触发 ${PIPELINE_STAGES.join("/")} 之一。` +
      `落点＝<workspace_path>/runs/<run_id>（与内核同源唯一落点）；workspace_path 必填绝对路径（贯通内核 workspace），` +
      `run_id 必填；source_root 仅 register 段必填（其余段可省——缺了也不影响非 register 段）；` +
      `base_model_path 仅 training_prep 段必填（本地模型目录绝对路径，含 config.json；模型家族名（如 qwen3_vl）不可当路径用——` +
      `缺参/非绝对路径在审批卡前快败，指路 ATF_MODEL_ROOT 可用模型清单；其它段忽略该参）。` +
      `越序段会被内核拒绝（blocked，exit 2）——按段序逐段触发。段成功退出（exit 0）即在落点 run 目录落段事实与会话绑定` +
      `（胶囊数据源；experiment_setup/candidate_build/training_prep 按映射口径落事实，点灯以内核段序闭包为准）；` +
      `exit 2（blocked）／exit 3（环境错误）一律零写入。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的内核管线段（八段原文，单段）" },
      run_id: { type: "string", required: true, description: "run 标识（落点 <workspace_path>/runs/<run_id>）" },
      workspace_path: { type: "string", required: true, description: "workspace 根（必填绝对路径——内核贯通 workspace；落点单源起点）" },
      source_root: { type: "string", description: "源文档根（仅 register 段必填；其余段可省）" },
      base_model_path: { type: "string", description: "本地模型目录绝对路径（含 config.json）；模型家族名（如 qwen3_vl）不可当路径用（training_prep 段必填，其它段忽略）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: { stage: string; run_id: string; workspace_path?: string; source_root?: string; base_model_path?: string },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      // fail-closed 参数面（先于审批——坏参数不消耗放行）：workspace_path 必填绝对路径；
      // register 段 source_root 必填；training_prep 段 base_model_path 必填（A-E14b 卡前快败）。
      const workspacePath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
      if (workspacePath === "") {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "workspace_path_missing", note: "workspace_path 必填（绝对路径，内核贯通 workspace 根）——落点＝<workspace_path>/runs/<run_id>，不做 env 隐式缺省" });
      }
      if (!isAbsolute(workspacePath)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "workspace_path_not_absolute", note: `workspace_path 须为绝对路径（得 ${workspacePath}）` });
      }
      if (args.stage === "register" && (args.source_root === undefined || args.source_root.trim() === "")) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "source_root_missing", note: "register 段必填 source_root（源文档根绝对路径）——其余段可省略该参数" });
      }
      // A-E14b：base_model_path——training_prep 段必填（卡前快败 base_model_path_missing，
      // 指路 ATF_MODEL_ROOT 清单；不触审批面板）；其它段忽略该参（不报错、不下传）。
      // harness 只查非空与绝对路径（家族名形态在此 fail-closed，不等内核 exit 2）——
      // 路径是否合法（目录在位/config.json 在位）＝内核闸单源，harness 不复制。
      const needsBaseModel = args.stage === "training_prep";
      const baseModelPath = typeof args.base_model_path === "string" ? args.base_model_path.trim() : "";
      if (needsBaseModel && baseModelPath === "") {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "base_model_path_missing", note: baseModelPathGuidance() });
      }
      if (needsBaseModel && !isAbsolute(baseModelPath)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "base_model_path_not_absolute", note: `base_model_path 须为本地模型目录绝对路径（得 ${baseModelPath}）——模型家族名（如 qwen3_vl）不可当路径用；目录内须有 config.json（合法性由内核闸复核）` });
      }
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage",
        buildApprovalReason({
          action: "触发管线段",
          target: `「${args.stage}」（run ${args.run_id}）`,
          effect: "在 run 目录内写该段产物（register 段另读源文档根）",
          reversible: "段产物可人工清理；已写数据面不自动回滚",
          cost: "按任务卡",
        }));
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      // 落点单源（A2.2b）：与内核同一决定者 <workspace_path>/runs/<run_id>；resolveRunDir 本工具内退役。
      const runDir = join(workspacePath, "runs", args.run_id);
      // argv 只传内核声明参数（register 时含 --source-root；training_prep 时含 --base-model
      // ——A-E14b，其它段不追加）；禁拼第二套路径。
      const argv: string[] = ["--workspace", workspacePath, "--run-id", args.run_id, "--stage", args.stage];
      if (args.stage === "register") argv.push("--source-root", (args.source_root as string).trim());
      if (needsBaseModel) argv.push("--base-model", baseModelPath);
      const result = await runPipeline(pipelineCommand, argv, pipelineTimeoutMs);
      let summary: unknown = null;
      const trimmed = result.stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart >= 0) {
        try {
          summary = JSON.parse(trimmed.slice(jsonStart)) as unknown;
        } catch {
          summary = null;
        }
      }
      // 失败语义：exit 2（blocked——越序等拒绝）／exit 3（环境错误）一律零写入；
      // exit 0 → 段事实（映射键）＋会话绑定。
      const rejections =
        summary !== null && typeof summary === "object" && (summary as Record<string, unknown>)["rejections"] !== undefined
          ? (summary as Record<string, unknown>)["rejections"]
          : null;
      let segment_fact_recorded = false;
      let session_bound = false;
      let fact_segment: string | null = null;
      if (result.code === 0) {
        const mapped = SEGMENT_FACT_BY_KERNEL_STAGE[args.stage] ?? args.stage;
        fact_segment = mapped;
        try {
          appendSegmentFact(runDir, mapped, "atf_pipeline_stage");
          segment_fact_recorded = true;
        } catch { /* fail-open（事实轨写失败不阻塞段回报） */ }
        const sessionId = sessionIdOfExec(exec);
        if (sessionId !== undefined) {
          appendBinding(runDir, sessionId);
          session_bound = true;
        }
      }
      return asToolValue({
        stage: args.stage,
        run_id: args.run_id,
        workspace_path: workspacePath,
        run_dir: runDir,
        ok: result.code === 0,
        exit_code: result.code,
        segment_fact_recorded,
        session_bound,
        ...(fact_segment !== null ? { fact_segment } : {}),
        // A-E14b：base_model 对账值（explicit＝显式下传优先；对端摘要携带 source 时透传）
        ...(baseModelSourceOf(needsBaseModel, summary) !== undefined ? { base_model_source: baseModelSourceOf(needsBaseModel, summary) } : {}),
        ...(summary !== null ? { summary } : {}),
        ...(result.code === 2 && rejections !== null ? { rejections } : {}),
        ...(result.code === 2 && rejections === null ? { note: "内核拒绝（blocked）——零写入；摘要未含 rejections 原文" } : {}),
        ...(result.code === 3 || result.code === null
          ? { stderr_tail: result.stderr.slice(-2000), note: "环境错误（exit 3）——零写入；核管线环境（python 依赖/数据在位）后重试" }
          : {}),
        ...(summary === null && result.code === 0 ? { note: "段命令成功退出但无 JSON 摘要输出", stdout_head: trimmed.slice(0, 2000) } : {}),
      });
    },
  });
