/**
 * atf_pipeline_stage：按段驱动 walkthrough_pipeline 段模式（内核 tag v0.7.18b0 起的
 * --stage 单段执行面，修复批A2.2b 落点单源改造；tag v0.7.19b0 起 K-E14a base 模型语义
 * 拆分——本工具 A-E14b 增 training_prep 段 base_model_path 显式下传；内核 main E10a
 * （2eed2c2，未发版，pin 不动）起 family_split 段 --auto-style-cluster 三态——本工具
 * E10b 增 auto_style_cluster 透传；内核 main E10e/E10f 拒绝带 user_message 业务文案＋
 * --allow-small-cluster-test——本工具 E10d 拒绝面业务化：user_message 原样透传
 * （未带按业务语言兜底并标注来源）、note 改「原样告知 user_message」指引、增
 * allow_small_cluster_test 透传；D89 增 experiment_setup 段 grouping_preset 透传
 * （内核 argparse --grouping-preset A/B，缺省 B——「缺省不静默」：未给按内核缺省处理
 * 并在返回体标注分组来源，审批卡呈现分组方案）。
 *
 * 接口契约（引自内核件 K-A2.2a §二，双件同步；A-E14b 增补 K-E14a 命令面；E10b 增补
 * E10a 命令面；E10d 增补 E10f 命令面；D89 增补 --grouping-preset 命令面）：
 *   段名闭集（权威＝内核 STAGE_ORDER，八项，禁增删改序）＝register／label_qc／
 *   experiment_setup／candidate_build／publish／family_split／admission／training_prep。
 *   命令面（段模式）：--workspace 必填／--stage 八段之一／--run-id 建议显式／
 *   --source-root 仅 register 必填其余可省／--base-model 仅 training_prep（本地模型目录
 *   绝对路径；K-E14a 拆分后渲染位吃 --base-model-family，内核段模式另有盘上只读再水合，
 *   harness 案 a＝必填显式值卡前快败）／--auto-style-cluster 仅 family_split（三态
 *   auto|on|off，缺省 auto；其它段不下传不报错）／--grouping-preset 仅 experiment_setup
 *   （A|B，缺省 B；未给不下传——按内核缺省处理，D89）。本工具下传 argv 只含上述参数，禁传内核未声明
 *   参数、禁拼第二套路径。
 *   落点（唯一）＝<workspace_path>/runs/<run_id>——本工具内 resolveRunDir 退役
 *   （内核与 harness 同一决定者，其余工具不受影响）。
 *   退出码：0 贯通／2 有拒绝（越序等，blocked）／3 环境错误。
 *   摘要面（E10b）：真内核段模式摘要落盘不落 stdout——stdout 解析缺席时回读内核
 *   缺省落点 <runDir>/stage-<段>.summary.json（同一份内核摘要；run_id/stage 双对账
 *   防陈旧件），rejections／聚类证据五键等既有透传面据此在真跑下生效。
 *
 * 事实轨与绑定（A2/A3 延续）：exit 0 → appendSegmentFact(runDir, 映射键, 本工具)＋
 *   appendBinding(runDir, sessionId)（sessionId 取不到如实跳过）；exit 2/3 一律零写入。
 *   映射表（kernel stage → UI segment）：experiment_setup→experiment_config、
 *   candidate_build→candidate、family_split→split、training_prep→null（只落事实轨
 *   不点灯——null 即按内核原文名落事实，该名不在前缀闭包读面）；candidate 键亦不在
 *   前缀闭包内（闭包语义不动）。
 *
 * D24h：段放行调用追加账本身份三参——--actor sessionIdOf(exec)??unattributed（会话缺失
 * 如实 unattributed，不伪造 owner 字面量）／--approval-mode ui／--round-dir runDir（本段
 * 落点 run 目录，内核账本 round_dir 字段面）；内核 stdout 携 approval_id 时回传返回体
 * approval_entry_id（解析失败省略键不阻断段回报，stderr 记一条）；卡面追加放行权属行
 * 「仅 owner 可点；执行方不得代点」。
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { appendSegmentFact, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { scanKernelErrorFace } from "../../../../src/core/workspace/kernelErrorFace.js";
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

/** kernel stage → UI segment 映射表（A2.2b 落常量；D3/D4 起单源迁 src/core/workspace/
 *  segmentFacts.ts——import＋re-export 同一常量，atf-ui 兜底源同表消费，禁第二套）。 */
export { SEGMENT_FACT_BY_KERNEL_STAGE };

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

// ── E10b：family_split 段版式聚类三态透传（内核 main E10a 命令面）──

/** auto_style_cluster 词汇闭集（权威＝内核 argparse choices；缺省 auto 同源）。 */
export const AUTO_STYLE_CLUSTER_VALUES: readonly string[] = ["auto", "on", "off"];

/** 聚类证据提取：内核段摘要在 results[].raw_response.style_cluster_state 随段留痕
 *  （blocked/通过/异常三路统一嵌套，五键形态）——本工具只透传 {state,pages_total,
 *  pages_with_cluster} 三键供解释「为什么没开」；summary 不携带或形态不合法一律
 *  undefined（不猜值不造默认）。 */
export const styleClusterStateOf = (
  summary: unknown,
): { state: string; pages_total: number; pages_with_cluster: number } | undefined => {
  const results = (summary as Record<string, unknown> | null)?.["results"];
  if (!Array.isArray(results)) return undefined;
  for (const entry of results) {
    const raw = (entry as Record<string, unknown> | null)?.["raw_response"];
    const evidence = (raw as Record<string, unknown> | null)?.["style_cluster_state"];
    if (evidence === null || typeof evidence !== "object") continue;
    const state = (evidence as Record<string, unknown>)["state"];
    const pagesTotal = (evidence as Record<string, unknown>)["pages_total"];
    const pagesWithCluster = (evidence as Record<string, unknown>)["pages_with_cluster"];
    if (typeof state === "string" && typeof pagesTotal === "number" && typeof pagesWithCluster === "number") {
      return { state, pages_total: pagesTotal, pages_with_cluster: pagesWithCluster };
    }
  }
  return undefined;
};

/** 聚类状态拒绝码识别（rejections 数组或单对象两形态都认——内核数组、mock 对象）。
 *  闭集＝三态拒绝三码（E10a 两码＋E10e-1 off 矛盾新码——同属「版式分组状态确认」
 *  决策面，note／user_message 兜底同触发；E10d 扩面登记）。 */
export const styleClusterRejectionOf = (rejections: unknown): boolean => {
  const items = Array.isArray(rejections) ? rejections : [rejections];
  const CLUSTER_CODES: readonly string[] = [
    "style_cluster_state_not_clustered",
    "style_cluster_state_ambiguous",
    "style_cluster_declared_but_absent",
  ];
  for (const item of items) {
    const codes = (item as Record<string, unknown> | null)?.["reason_codes"];
    if (!Array.isArray(codes)) continue;
    if (codes.some((code) => CLUSTER_CODES.includes(code as string))) return true;
  }
  return false;
};

/** 聚类拒绝回流指引（E10d 改版——agent 面产品口径）：内核 user_message 原样告知用户，
 *  用户回答后按其选择重试；不向用户展示内部选项名。 */
export const STYLE_CLUSTER_REJECTION_NOTE =
  "把 user_message 原样告知用户；用户回答后按其选择重试（已分组→直接分层；未分组→先分组再分层）。" +
  "不要向用户展示 auto/on/off 等内部选项名。";

/** user_message 业务兜底（内核未携带时——旧版本/异常；E10d）：业务语言，零内部词。 */
export const STYLE_CLUSTER_USER_MESSAGE_FALLBACK =
  "这批数据的版式分组状态无法确认，请确认数据是否已按版式分组后再试。";

/** user_message 提取：内核拒绝在 raw_response.user_message 携带业务文案（E10e 起，
 *  与 reason_code 并列随段记录）——原样取出，不加工不拼接；无串/形态非法＝undefined。 */
export const userMessageOf = (summary: unknown): string | undefined => {
  const results = (summary as Record<string, unknown> | null)?.["results"];
  if (!Array.isArray(results)) return undefined;
  for (const entry of results) {
    const raw = (entry as Record<string, unknown> | null)?.["raw_response"];
    const message = (raw as Record<string, unknown> | null)?.["user_message"];
    if (typeof message === "string" && message !== "") return message;
  }
  return undefined;
};

// ── D89：experiment_setup 段分组方案（内核 argparse --grouping-preset A/B）──

/** grouping_preset 词汇闭集（权威＝内核 argparse choices：A/B；内核缺省 B 同源——
 *  A＝3 组·按单据层级，B＝2 组·单据级 vs 条目级，仅 experiment_setup 段消费）。 */
export const GROUPING_PRESET_VALUES: readonly string[] = ["A", "B"];

/** 分组方案组构成（审批卡/摘要文案单源——组构成与内核 build_experiment_setup 产出
 *  experiment-config.json 的 grouping 面同源，两处禁第二套文案）。 */
const GROUPING_PRESET_PROFILE: Readonly<Record<string, string>> = {
  A: "3 组·按单据层级：doc_identifier／page_summary／goods_item",
  B: "2 组·单据级 vs 条目级：goods_item／doc_level",
};

/** 审批卡分组方案行（仅 experiment_setup 段追加——分组方案是 owner 卡上要确认的决策点；
 *  「缺省不静默」：未给时明示将按内核缺省 B 处理，不让缺省偷偷生效；B 文案单源复用）。 */
export const groupingPresetApprovalLine = (preset: string): string => {
  const profile = GROUPING_PRESET_PROFILE[preset];
  if (profile !== undefined) return `分组方案：${preset}（${profile}）`;
  return `分组方案：未指定——将按内核缺省 B（${GROUPING_PRESET_PROFILE["B"]}）`;
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
      `family_split 段另支持 auto_style_cluster 三态（缺省 auto，其它段忽略该参）：` +
      `auto＝先检测——已聚类则不复聚；未聚类/状态不明会拒绝并指路。` +
      `experiment_setup 段另支持 grouping_preset 分组方案（缺省按内核缺省 B 处理，其它段忽略该参；` +
      `返回体如实标注分组来源，审批卡呈现分组方案供确认）。` +
      `收到版式聚类状态类拒绝（style_cluster_state_not_clustered／style_cluster_state_ambiguous／` +
      `style_cluster_declared_but_absent）时，必须先问用户「这批数据做过版式聚类吗？」，` +
      `确认后再传 on（未聚类——内核自动补簇并产出 StyleClusterManifest/v1，按簇分层）或 off（已聚类——不再聚）重跑；` +
      `禁止在 auto 被拒后自行猜一个值重跑。` +
      `doc_type／lane_suffix／field_config 三件可缺省（缺省不上送，各段均有效）：` +
      `不传 doc_type 时内核按数据/登记面推断单据类型，无法确定即 blocked（会带业务文案指路）——` +
      `需显式指定或补登记面后重跑；field_config 须为字段配置文件显式路径。` +
      `越序段会被内核拒绝（blocked，exit 2）——按段序逐段触发。段成功退出（exit 0）即在落点 run 目录落段事实与会话绑定` +
      `（胶囊数据源；experiment_setup/candidate_build/training_prep 按映射口径落事实，点灯以内核段序闭包为准）；` +
      `exit 2（blocked）／exit 3（环境错误）一律零写入。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的内核管线段（八段原文，单段）" },
      run_id: { type: "string", required: true, description: "run 标识（落点 <workspace_path>/runs/<run_id>）" },
      workspace_path: { type: "string", required: true, description: "workspace 根（必填绝对路径——内核贯通 workspace；落点单源起点）" },
      source_root: { type: "string", description: "源文档根（仅 register 段必填；其余段可省）" },
      base_model_path: { type: "string", description: "本地模型目录绝对路径（含 config.json）；模型家族名（如 qwen3_vl）不可当路径用（training_prep 段必填，其它段忽略）" },
      auto_style_cluster: {
        type: "string",
        enum: [...AUTO_STYLE_CLUSTER_VALUES],
        description:
          "版式聚类三态（仅 family_split 段有意义，其它段忽略该参）：auto＝先检测（缺省）——已聚类则不复聚；" +
          "未聚类/状态不明会拒绝并指路。on＝显式开启内核自动补簇（问明未聚类后用）。off＝不再聚（问明已聚类后用）。" +
          "收到版式聚类状态类拒绝（style_cluster_state_not_clustered／style_cluster_state_ambiguous／" +
          "style_cluster_declared_but_absent）时，必须先问用户「这批数据做过版式聚类吗？」，" +
          "确认后再传 on 或 off 重跑；禁止在 auto 被拒后自行猜一个值重跑。" +
          "对用户表述用业务语言：问「这批数据是否已经按版式分好组」，不要念枚举值",
      },
      allow_small_cluster_test: {
        type: "boolean",
        description:
          "当所有版式分组都太小、无法留出测试集时，用户坚持要测试集才用；每个小类只留 1 页，测试样本很少" +
          "（仅 family_split 段有意义，其它段忽略；缺省不开，不由系统自动推断）",
      },
      grouping_preset: {
        type: "string",
        enum: [...GROUPING_PRESET_VALUES],
        description:
          "实验分组方案（仅 experiment_setup 段有意义，其它段忽略该参）：A＝3 组·按单据层级" +
          "（doc_identifier／page_summary／goods_item）；B＝2 组·单据级 vs 条目级（goods_item／doc_level）。" +
          "不给时按内核缺省 B 处理（不静默——返回体如实标注分组来源，审批卡亦明示）",
      },
      doc_type: { type: "string", description: "单据类型（可缺省——缺省不上送，内核按数据/登记面推断，无法确定即 blocked；给了则显式指定）" },
      lane_suffix: { type: "string", description: "lane 后缀（可缺省——缺省不上送，内核自行推断）" },
      field_config: { type: "string", description: "字段配置文件显式路径（可缺省——缺省不上送，内核走 run 内/登记面既有来源）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: { stage: string; run_id: string; workspace_path?: string; source_root?: string; base_model_path?: string; auto_style_cluster?: string; allow_small_cluster_test?: boolean; grouping_preset?: string; doc_type?: string; lane_suffix?: string; field_config?: string },
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
      // D89：分组方案取值（审批前定——卡面要呈现分组方案行；「按未给处理」＝trim 后空串
      // 一律视同未指定，内核缺省 B 生效。harness 不复制枚举外的校验，choices 越界由框架
      // enum 校验与内核 argparse 双闸）。
      const groupingPreset = typeof args.grouping_preset === "string" ? args.grouping_preset.trim() : "";
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage",
        buildApprovalReason({
          action: "触发管线段",
          target: `「${args.stage}」（run ${args.run_id}）`,
          effect: "在 run 目录内写该段产物（register 段另读源文档根）",
          reversible: "段产物可人工清理；已写数据面不自动回滚",
          cost: "按任务卡",
          // D24h：卡面追加放行权属行（与评估 EVAL_RELEASE 卡同款——点卡权属只在 owner）
        })
        // D89：分组方案行仅 experiment_setup 段呈现（其它段该参无意义不上卡）
        + (args.stage === "experiment_setup" ? `\n${groupingPresetApprovalLine(groupingPreset)}` : "")
        + "\n仅 owner 可点；执行方不得代点");
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      // 落点单源（A2.2b）：与内核同一决定者 <workspace_path>/runs/<run_id>；resolveRunDir 本工具内退役。
      const runDir = join(workspacePath, "runs", args.run_id);
      // argv 只传内核声明参数（register 时含 --source-root；training_prep 时含 --base-model
      // ——A-E14b，其它段不追加；family_split 时含 --auto-style-cluster——E10b，缺省 auto
      // 也显式上线解析值；E10d：allow_small_cluster_test 仅 family_split 且 true 才追加
      // 开关，缺省不出现在 argv，其它段不追加不报错）；禁拼第二套路径。
      const argv: string[] = ["--workspace", workspacePath, "--run-id", args.run_id, "--stage", args.stage];
      if (args.stage === "register") argv.push("--source-root", (args.source_root as string).trim());
      if (needsBaseModel) argv.push("--base-model", baseModelPath);
      if (args.stage === "family_split") argv.push("--auto-style-cluster", args.auto_style_cluster ?? "auto");
      if (args.stage === "family_split" && args.allow_small_cluster_test === true) argv.push("--allow-small-cluster-test");
      // D82：单据类型三件透传（给才追加、trim 后非空才上线，缺省不上送——内核自行推断，
      // doc_type 推断不出即 blocked；各段均有效）。与上方段特定追加逻辑并存，零触碰其语义。
      const docType = typeof args.doc_type === "string" ? args.doc_type.trim() : "";
      if (docType !== "") argv.push("--doc-type", docType);
      const laneSuffix = typeof args.lane_suffix === "string" ? args.lane_suffix.trim() : "";
      if (laneSuffix !== "") argv.push("--lane-suffix", laneSuffix);
      const fieldConfig = typeof args.field_config === "string" ? args.field_config.trim() : "";
      if (fieldConfig !== "") argv.push("--field-config", fieldConfig);
      // D89：分组方案透传（仅 experiment_setup 段；显式给且 trim 非空才追加——未给不追加，
      // 内核缺省 B 生效；其它段忽略该参不下传不报错）。与上方段特定/全局追加逻辑并存。
      if (args.stage === "experiment_setup" && groupingPreset !== "") argv.push("--grouping-preset", groupingPreset);
      // D24h：放行登记带会话身份与 ui 模式（actor＝会话 id，缺失＝unattributed——不伪造 owner）；
      // round_dir＝本段落点 run 目录（内核账本 round_dir 字段面，与评估 D20 同构）
      argv.push("--actor", sessionIdOfExec(exec) ?? "unattributed", "--approval-mode", "ui", "--round-dir", runDir);
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
      // E10b：真内核段模式摘要落盘不落 stdout（内核 main 缺省落点
      // <runDir>/stage-<段>.summary.json）——stdout 缺席时回读该落盘原文（同一份内核
      // 摘要，零二次解释；run_id/stage 双对账，陈旧件/他 run 件一律不采纳）。
      // 摘要在场（stdout 或落盘）即走既有透传面：rejections／style_cluster_state 等。
      if (summary === null && (result.code === 0 || result.code === 2)) {
        try {
          const disk = JSON.parse(readFileSync(join(runDir, `stage-${args.stage}.summary.json`), "utf8")) as Record<string, unknown>;
          if (disk["run_id"] === args.run_id && disk["stage"] === args.stage) summary = disk;
        } catch { /* 落盘摘要不在场＝如实 null */ }
      }
      // D24h：内核 stdout 账本 approval_id 回传返回体（只认 stdout——落盘摘要回读面不承担
      // 账本回传；解析失败省略键不阻断段回报——stderr 记一条）
      let approvalEntryId: unknown;
      if (jsonStart >= 0) {
        try { approvalEntryId = (JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>)["approval_id"]; }
        catch { console.error("[atf-pipeline-stage] 内核 stdout 非 JSON——返回体省略 approval_entry_id（不阻断段回报）"); }
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
      // 批次 R H1-3：失败输出扫描内核错误码（token_budget_* / token_gate_not_configured——
      // 提前接线：内核 v0.7.24b0 未发版，当前无真实来源；发版后经 stdout/stderr 流回即人话）。
      const kernelFace = result.code !== 0 ? scanKernelErrorFace([result.stdout, result.stderr]) : null;
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
        // D24h：账本 approval_id 回传（解析失败/缺席省略键——typert lossless 拒 undefined 键）
        ...(approvalEntryId !== undefined ? { approval_entry_id: approvalEntryId } : {}),
        // A-E14b：base_model 对账值（explicit＝显式下传优先；对端摘要携带 source 时透传）
        ...(baseModelSourceOf(needsBaseModel, summary) !== undefined ? { base_model_source: baseModelSourceOf(needsBaseModel, summary) } : {}),
        // D89：分组方案标注（仅 experiment_setup 段）——「缺省不静默」：显式给标注 explicit，
        // 未给按内核缺省 B 标注 kernel_default（可见、可对账；其它段不加两键）
        ...(args.stage === "experiment_setup"
          ? {
              grouping_preset: groupingPreset !== "" ? groupingPreset : "B",
              grouping_preset_source: groupingPreset !== "" ? "explicit" : "kernel_default",
            }
          : {}),
        // E10b：聚类证据三键透传（内核摘要携带时）——「为什么没开/为什么开」的解释面
        ...(styleClusterStateOf(summary) !== undefined ? { style_cluster_state: styleClusterStateOf(summary) } : {}),
        // E10d：内核拒绝的 user_message 原样透传（不加工不拼接）；聚类状态拒绝未携带时
        // 按业务语言兜底并标注来源 fallback
        ...(userMessageOf(summary) !== undefined ? { user_message: userMessageOf(summary) } : {}),
        ...(userMessageOf(summary) === undefined && styleClusterRejectionOf(rejections)
          ? { user_message: STYLE_CLUSTER_USER_MESSAGE_FALLBACK, user_message_source: "fallback" }
          : {}),
        ...(summary !== null ? { summary } : {}),
        ...(result.code === 2 && rejections !== null ? { rejections } : {}),
        ...(result.code === 2 && rejections === null ? { note: "内核拒绝（blocked）——零写入；摘要未含 rejections 原文" } : {}),
        // E10d：聚类状态拒绝的回流指引（把 user_message 原样告知用户，不展示内部选项名）
        ...(result.code === 2 && styleClusterRejectionOf(rejections) ? { note: STYLE_CLUSTER_REJECTION_NOTE } : {}),
        ...(result.code === 3 || result.code === null
          ? { stderr_tail: result.stderr.slice(-2000), note: "环境错误（exit 3）——零写入；核管线环境（python 依赖/数据在位）后重试" }
          : {}),
        ...(summary === null && result.code === 0 ? { note: "段命令成功退出但无 JSON 摘要输出", stdout_head: trimmed.slice(0, 2000) } : {}),
        // 批次 R H1-3：内核错误码人话回流（提前接线——token_budget_missing /
        // token_budget_inconsistent:<detail> / token_gate_not_configured 构造期码命中即转
        // 人话 note（覆盖上方笼统 note——更具体的用户文案优先）；未命中＝既有 note 不变。
        // D77：完整码不进模型可见返回体——模型照抄进散文即用户可见；对账面＝scratch 观测账。
        ...(kernelFace !== null ? { note: kernelFace.note } : {}),
      });
    },
  });
