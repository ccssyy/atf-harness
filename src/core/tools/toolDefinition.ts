/**
 * ToolDefinition（任务书 S3-2）：模型可见 schema（白名单）+ canonical output 声明 +
 * 桥接方法名 + 审批要求。内部字段（canonical_output / requires_approval / method /
 * execution 相关的一切）绝不进入模型可见形态——toModelVisible 白名单投影（owner 口径 #5）。
 */
import { type SchemaNode } from "./canonical.js";

export interface ToolDefinition {
  /** 工具名 = 桥接方法名（契约 methods 段登记） */
  name: string;
  /** 模型可见描述 */
  description: string;
  /** 模型可见参数白名单（JSON Schema 方言，见 canonical.ts） */
  parameters: SchemaNode;
  /** 审批轨要求：写动作/闸门推进 = true（调用前须账本预录且未消费）；只读 = false。
   *  基准旗标——当 requiresApproval 谓词存在时以其为准（见下）。 */
  requires_approval: boolean;
  /** L1b B7 N1（owner 裁定 2026-09-17）：按 params 分派的审批谓词（存在时优先于
   *  requires_approval）。atf_gate：action=="advance"（推进）须审批；action=="query"
   *  （只读）免审批、模型自主执行——对齐 L1 门 2 VERIFY 4「模型自主只读」与
   *  L1b-D1=A 写类界定。定性＝实现修正到已裁口径，非放宽「逐工具审批」红线
   *  （advance 仍走问答轨；账本轨优先/CAS/一次性消费零改动）。 */
  requiresApproval?: (params: unknown) => boolean;
  /** canonical output schema（成功返回值逐次校验，失败 = err(schema_violation)） */
  canonical_output: SchemaNode;
}

/** 模型可见形态：仅 { name, description, parameters }——内部字段一律不发。 */
export interface ModelVisibleTool {
  name: string;
  description: string;
  parameters: SchemaNode;
}

/** 审批判定单一出口：谓词存在以其为准，否则退回基准旗标（executor 消费点唯一）。 */
export const requiresApprovalFor = (definition: ToolDefinition, params: unknown): boolean =>
  definition.requiresApproval !== undefined ? definition.requiresApproval(params) : definition.requires_approval;

/** atf_gate 审批谓词：仅 action=="advance"（推进＝状态变更）须审批；query 只读免审批。
 *  action 缺失/非法 → 按须审批处置（fail-closed，不猜只读）。 */
const gateRequiresApproval = (params: unknown): boolean => {
  const action = typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as { action?: unknown }).action
    : undefined;
  return action !== "query";
};

export const toModelVisible = (definition: ToolDefinition): ModelVisibleTool => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
});

/** 无参工具的公共 parameters（只读查询面）。 */
const NO_PARAMS: SchemaNode = { type: "object", required: [], properties: {} };

const STRING_ARRAY: SchemaNode = { type: "array", items: { type: "string" } };

const HEX64 = "^[0-9a-f]{64}$";

/** 合法 GateId 清单（三件小批 D-2/D-1 单源常量，2026-09-21）：
 *  权威来源＝内核 GateId 枚举（contracts/models.py，v0.1.0 固定七组实验完整性 Gate，冻结面）
 *  ＋G1–G4 命名分流（数据准入闸，大小写不敏感）。atf_gate 描述文本与 turn 失败摘要 hint
 *  两处消费本常量（一处定义，防漂移）；内核增删 GateId 属破坏性变更，经 re-pin/契约审同步。 */
export const GATE_LEGAL_IDS: readonly string[] = [
  "G1（数据准入闸，命名分流）",
  "G2（数据准入闸，命名分流）",
  "G3（数据准入闸，命名分流）",
  "G4（数据准入闸，命名分流）",
  "extraction-contract-valid",
  "source-identity-valid",
  "split-integrity-valid",
  "training-data-valid",
  "training-preflight-valid",
  "evaluation-preflight-valid",
  "evaluation-evidence-valid",
];

/** 七组完整性 GateId（严格匹配面；G1–G4 为命名分流路由，大小写不敏感）。 */
export const INTEGRITY_GATE_IDS: readonly string[] = [
  "extraction-contract-valid",
  "source-identity-valid",
  "split-integrity-valid",
  "training-data-valid",
  "training-preflight-valid",
  "evaluation-preflight-valid",
  "evaluation-evidence-valid",
];

/** 工具面 9 个（R-3 接线批 2026-09-23：方法面 12→14——新增 atf_label_qc_inspect（写需审批）
 *  与 atf_label_qc_resolve（写需审批）；契约登记段同步补登不 bump，对齐内核 stdio-session-contract
 *  §13.13/§13.14。前序：K-Gap-2 接线批 2026-09-21 方法面 10→12。
 *  契约 v2（2026-09-13）：证据面扫描工具改名 atf_fact_scan（数组 facts）、
 *  atf_gate 增补 warn 与附加字段、atf_admit_data source → source_ref、
 *  atf_workspace_status 增补 scope_ref。 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "atf_admit_data",
    // 登记面双形态补丁（2026-09-21，对齐内核件B v0.7.2b0 实测面 main 61631e6；门 1 全案放行）：
    // 显式 {dataset_id, source_ref?, pin?}＝引用式登记（不可供准入定位）；
    // 自动（推荐，真实数据校验前）＝不传 dataset_id，传真实 source_root/split_root——
    // 内核按双树内容寻址派生 ds-<digest12>，refs 写双源根，atf_data_admission_request 凭
    // 返回的 dataset_id 定位执行。两形态互斥由内核 fail-closed 校验（invalid_params 回流），
    // harness schema 只做描述层指引＋字段声明（D-b 原则：不引入第二权威）。
    description:
      "数据集登记（真实数据校验的第一步）：推荐用自动形态——不传 dataset_id，传真实 source_root（成对标注来源包根）与 split_root（split manifest 根），二者必须为已存在的目录；内核按内容寻址派生 dataset_id（ds-<digest12>）并从返回值读取。显式形态（仅登记引用、不支持真实数据校验）：传 dataset_id（注册标识符，非文件路径、无 @）与可选 source_ref（来源引用字符串，非文件路径要求）。两形态互斥。业务拒绝回流（如 *_missing／invalid_params）附有一行指引：按指引修参；缺料（*_missing 类）时勿重复探查——如实向用户说明缺什么并停止。先探测/查看实际数据形态（可用 atf_workspace_status，也可自行列目录），再决定取哪个目录、以及如何整备成训练流程所需格式。",
    parameters: {
      type: "object",
      required: [],
      properties: {
        dataset_id: {
          type: "string",
          optional: true,
          description:
            "仅显式形态：注册标识符（如 ds-swb-20260920），非文件路径、不含 @。自动形态（推荐，真实数据校验前）勿传——由内核按双树内容寻址派生，从返回值 dataset_id 读取",
        },
        source_ref: {
          type: "string",
          optional: true,
          description:
            "仅显式形态：来源引用字符串（存入登记记录 refs 作档案；不被真实数据校验消费）。与自动形态字段互斥；需要真实数据校验请改用自动形态",
        },
        source_root: {
          type: "string",
          optional: true,
          description:
            "仅自动形态（推荐）：成对标注样本（图片＋同名标注文件）所在的目录，必须为已存在的目录；与 dataset_id/source_ref 互斥",
        },
        split_root: {
          type: "string",
          optional: true,
          description:
            "仅自动形态（推荐）：split manifest 根（须含契约要求的产物文件名：global_assignment.csv 与 global_plan.json），必须为已存在的目录",
        },
        label: {
          type: "string",
          optional: true,
          description: "仅自动形态：人类可读展示名（只进登记记录，不参与 dataset_id 派生）",
        },
        // R2 补登（D3 决议 20260914）：与契约 atf_admit_data.params 对等——
        // 显式 pin 优先，缺省由内核按 canonical_digest 推导（两形态通用）。
        pin: { type: "string", optional: true },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      required: ["ok", "journal_type", "fact_id", "sha256_digest"],
      properties: {
        ok: { const: true },
        journal_type: { type: "string" },
        fact_id: { type: "string" },
        sha256_digest: { type: "string", pattern: HEX64 },
        dataset_id: { type: "string", optional: true },
      },
    },
  },
  {
    name: "atf_data_admission_request",
    // R1 接线批（D-5，2026-09-20）：模型面工具名用下划线（provider 函数名不允许 "."），
    // RPC 方法经 executor 显式映射到 atf_data_admission.request（内核冻结面 main 61631e6）。
    description:
      "数据准入申请：对已登记数据集执行真实 source-backed 数据校验并落盘判定结果（可能因标注冲突需要人工裁决；结果含 G1–G4 判定投影）。dataset_id/pin 取自 atf_admit_data 登记结果 fact_id（形如 <dataset_id>@<pin>）或事实索引中的登记事实；勿要求用户手敲；不接受文件路径。返回 *_missing 类业务拒绝（缺料）时：不要重复探查——如实向用户说明缺什么并停止（系统会呈现缺口卡）。先探测/查看实际数据形态（可用 atf_workspace_status，也可自行列目录），再决定取哪个目录、以及如何整备成训练流程所需格式。",
    parameters: {
      type: "object",
      required: ["dataset_id"],
      properties: {
        dataset_id: {
          type: "string",
          description:
            "注册标识符：取自 atf_admit_data 登记结果 fact_id（形如 <dataset_id>@<pin>）或事实索引中的登记事实；勿要求用户手敲；不接受文件路径（路径类信息不属于本参数）",
        },
        pin: {
          type: "string",
          optional: true,
          description: "显式 pin（fact_id 的 @ 后段）；同数据集多 pin 登记时必须显式给出，缺省取唯一登记 pin",
        },
        // K-Gap-2 接线批（2026-09-21）：可选 split_policy 确认态——完整 payload 透传，
        // 深度校验归内核（DatasetSplitPolicy/v1|v2、target_ratios 和为 1、
        // style_cluster_assignment_ref 非空、unit 全覆盖）。policy 取值优先级＝确认态 >
        // 登记面 skills 建议 > 诚实拒绝（split_policy_missing），harness 不实现优先级逻辑。
        split_policy: {
          type: "object",
          optional: true,
          strict: false,
          description:
            "经用户确认的完整划分策略 payload 对象（骨架以 atf_preparation_propose 返回的 policy_template 为基准，默认 训练:测试 = 8:2 可改；不接受自由文本）。缺省＝按登记面 skills 建议划分；两者皆无时内核拒绝（split_policy_missing）。用户对划分方式的要求必须落为本字段（Agent 译 payload），勿省略用户已确认的修改",
        },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      strict: false, // K-Gap-2 返回扩展字段（policy/human_summary/partition_counts 等）与内核可空语义透传——深形态归内核
      required: ["ok", "run_id", "dataset_id", "pin", "fact_id", "status", "summary_ref", "summary_sha256", "gates"],
      properties: {
        ok: { const: true },
        run_id: { type: "string" },
        dataset_id: { type: "string" },
        pin: { type: "string" },
        fact_id: { type: "string" },
        status: { enum: ["not_required", "waiting_on_human", "adjudicated", "temporarily_excluded"] },
        summary_ref: { type: "string" },
        summary_sha256: { type: "string", pattern: HEX64 },
        gates: {
          type: "array",
          items: {
            type: "object",
            required: ["gate_id", "verdict", "reason_codes"],
            properties: {
              gate_id: { type: "string" },
              verdict: { type: "string" },
              reason_codes: { type: "array", items: { type: "string" } },
            },
          },
        },
        requests: { type: "array", optional: true },
        // K-Gap-2 补登：返回体双层（machine＋human_summary 六键闭集，见 humanSummary 模块）
        human_summary: { type: "object", optional: true, strict: false },
        policy: { type: "object", optional: true, strict: false },
        style_cluster_source: { enum: ["skills", "kernel", null], optional: true },
        allocation_unit_source: { type: "string", optional: true },
        // partition_counts：内核实测可为 null（分区未产出时不编造）——不入 properties，由根 strict:false 透传
      },
    },
  },
  {
    name: "atf_preparation_propose",
    // K-Gap-2 接线批（2026-09-21）：方法面 10→12 之 S1。模型面工具名下划线（R1 D-1 同例），
    // RPC 经 executor 显式映射到 atf_preparation.propose。纯读：不写盘、不执行、锚不写。
    description:
      "数据准备阶段判定（纯读，免审批）：返回当前阶段（聚类确认/划分确认）、阶段模板（聚类参数模板或划分策略模板，默认 训练:测试 = 8:2）、事实性说明与人读报告。聚类阶段缺料时→确认参数后调用 atf_style_cluster_execute 落料；划分阶段→向用户确认划分方式（用户要求译为 split_policy payload 交 atf_data_admission_request）。不写盘、不执行任何动作。",
    parameters: {
      type: "object",
      required: ["dataset_id"],
      properties: {
        dataset_id: {
          type: "string",
          description: "注册标识符：取自 atf_admit_data 登记结果 fact_id 的 dataset_id 段；非文件路径、不含 @",
        },
        pin: {
          type: "string",
          optional: true,
          description: "显式 pin；同数据集多 pin 登记时必须显式给出",
        },
      },
    },
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "dataset_id", "pin", "fact_id", "stage", "cluster_material", "explanation", "human_summary"],
      properties: {
        ok: { const: true },
        dataset_id: { type: "string" },
        pin: { type: "string" },
        fact_id: { type: "string" },
        stage: { enum: ["cluster_confirmation", "split_confirmation"] },
        cluster_material: { enum: ["skills_ready", "absent"] },
        cluster_params_template: { type: "object", optional: true, strict: false },
        policy_template: { type: "object", optional: true, strict: false },
        explanation: { type: "object", strict: false, },
        human_summary: { type: "object", strict: false, },
      },
    },
  },
  {
    name: "atf_style_cluster_execute",
    // K-Gap-2 接线批（2026-09-21）：方法面 10→12 之 S2。写动作：确定性版式聚类→落料→汇报＋留痕。
    description:
      "执行版式聚类（写动作，须审批）：按逐项显式声明的聚类参数执行确定性聚类并把产物落登记面（style-cluster-assignment.json），返回簇清单、聚类摘要与人读报告。cluster_params 六项逐项显式声明（无隐式缺省），合法取值以 atf_preparation_propose 返回的 cluster_params_template 为准；执行后可复查 propose 进入划分确认阶段。内核只做确定性版式聚类，不读图片内容、不做模型推理。",
    parameters: {
      type: "object",
      required: ["dataset_id", "cluster_params"],
      properties: {
        dataset_id: {
          type: "string",
          description: "注册标识符：取自 atf_admit_data 登记结果 fact_id 的 dataset_id 段；非文件路径、不含 @",
        },
        pin: {
          type: "string",
          optional: true,
          description: "显式 pin；同数据集多 pin 登记时必须显式给出",
        },
        cluster_params: {
          type: "object",
          required: ["algorithm_version", "granularity", "metric", "linkage", "threshold", "min_cluster_size"],
          properties: {
            algorithm_version: { type: "string", description: "算法版本（取值以 propose 模板回显为准，勿自造）" },
            granularity: { type: "string", description: "粒度（取值以 propose 模板回显为准）" },
            metric: { type: "string", description: "度量（取值以 propose 模板回显为准）" },
            linkage: { type: "string", description: "合并方式（取值以 propose 模板回显为准）" },
            threshold: { type: "string", description: "阈值（取值以 propose 模板回显为准）" },
            min_cluster_size: { type: "string", description: "最小簇（取值以 propose 模板回显为准）" },
          },
          description:
            "聚类参数声明（六键逐项显式，无隐式缺省；键集须完全一致，多键少键皆拒）。各键合法取值以 atf_preparation_propose 回显的 cluster_params_template 为准（单源），由内核闭集校验（越出闭集 → invalid_params）",
        },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      required: ["ok", "run_id", "dataset_id", "pin", "fact_id", "assignment_ref", "cluster_digest", "cluster_count", "clusters", "no_feature_count", "page_count", "source", "human_summary"],
      properties: {
        ok: { const: true },
        run_id: { type: "string" },
        dataset_id: { type: "string" },
        pin: { type: "string" },
        fact_id: { type: "string" },
        assignment_ref: { type: "string" },
        cluster_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$", description: "内核实义含 sha256: 前缀（integrity_digest 可复算形态）" },
        cluster_count: { type: "integer" },
        clusters: {
          type: "array",
          items: {
            type: "object",
            required: ["cluster_id", "size", "representative_sample_ref"],
            properties: {
              cluster_id: { type: "string" },
              size: { type: "integer" },
              representative_sample_ref: { type: "string" },
            },
          },
        },
        no_feature_count: { type: "integer" },
        page_count: { type: "integer" },
        source: { const: "kernel" },
        human_summary: { type: "object", strict: false },
      },
    },
  },
  {
    name: "atf_label_qc_inspect",
    // R-3 接线批（2026-09-23）：方法面 12→14 之 S1。写动作须审批：不可变体检报告＋逐项证据
    // 切片落登记面，直接改变准入前置状态（pending>0 即整体阻断；K2 启用后无报告亦阻断）。
    // RPC 经 executor 显式映射到 atf_label_qc.inspect（内核 §13.13）。
    description:
      "标签体检（写动作，须审批）：对已登记数据集的成对 png/json 标注执行 Q1–Q4 确定性检测（同框同值同字段疑似重复／同框同值异字段需确认归属／值与框形态不匹配／框越界），写不可变体检报告与逐项证据切片到登记面。纯检测不改原始标注、幂等可重跑。qc_params 可省（缺省 iou_threshold=0.9、bounds_tolerance=0；自定义取值以本描述为准，无坐标制参数）。检出不待确认问题可直接请求数据准入；检出待确认项（counts.pending>0）→ 向用户呈现待确认清单逐项裁决（经确认卡或按报告项组装 atf_label_qc_resolve），全部确认前该数据集准入保持阻断。Q2 归属判断＝整图理解：内核永不下发 crop，证据切片以 image_workspace_ref 指向整图（仅来源在工作区内时给值，外部来源如实置空）。",
    parameters: {
      type: "object",
      required: ["dataset_id"],
      properties: {
        dataset_id: {
          type: "string",
          description: "注册标识符：取自 atf_admit_data 登记结果 fact_id 的 dataset_id 段；非文件路径、不含 @",
        },
        pin: {
          type: "string",
          optional: true,
          description: "显式 pin；同数据集多 pin 登记时必须显式给出",
        },
        qc_params: {
          type: "object",
          optional: true,
          required: [],
          properties: {
            iou_threshold: { type: "number", optional: true, description: "Q1/Q2 重叠判定阈值（0<θ≤1；缺省 0.9；显式给值即记录 overridden）" },
            bounds_tolerance: { type: "number", optional: true, description: "Q4 越界判定容差（≥0 像素；缺省 0）" },
          },
          description: "检测参数（键闭集 {iou_threshold, bounds_tolerance}，未知键拒绝；无坐标制参数——检测恒在原像素坐标下进行）",
        },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      required: ["ok", "dataset_id", "pin", "report_ref", "report_file_sha256", "report_digest", "counts", "human_summary"],
      properties: {
        ok: { const: true },
        dataset_id: { type: "string" },
        pin: { type: "string" },
        report_ref: { type: "string", description: "workspace 相对路径（datasets/<dataset_id>@<pin>/label-qc-report.json）" },
        report_file_sha256: { type: "string", pattern: HEX64 },
        report_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        counts: { type: "object", strict: false, required: ["total_items", "pending", "resolved", "by_check_class"] },
        human_summary: { type: "object", strict: false },
      },
    },
  },
  {
    name: "atf_label_qc_resolve",
    // R-3 接线批（2026-09-23）：方法面 12→14 之 S2。裁决落不可变累积产物＋journal 留痕＋
    // 锚挂点——写动作须审批（第二道人审）；item_id 只能来自体检报告（TUI 经确认卡确定性
    // 合成本调用，模型不转写用户裁决）。RPC 显式映射到 atf_label_qc.resolve（内核 §13.14）。
    description:
      "提交标签体检裁决（写动作，须审批）：把逐项确认的处置批次写入累积裁决产物并留痕；全部待确认项确认完毕前该数据集准入保持阻断。decisions 逐项给出：item_id（只能取自体检报告待确认清单，勿自造）、action（accept=按建议处置／modify=自定处置／reject=维持原状不处置——reject≠剔除）、disposition 九项闭集（keep_first/keep_second/keep_both/drop_both/set_value/dedupe/fix_field/clip_to_bounds/no_action；须落该检查类允许组合：Q1 dedupe；Q2 keep_first/keep_second/keep_both/drop_both/set_value；Q3 set_value/fix_field/drop_both；Q4 clip_to_bounds），并按处置齐备必填附加字段（dedupe→keep_ref；keep_first/keep_second→target_candidate_id；keep_both/drop_both→reason_text；set_value→modified_value；fix_field→target_field）。Q2 项须附判断依据（judgements:[{item_id, basis:user|multimodal, reason_text?}]）。未决项绝不默认处置——只提交用户逐项确认过的项（可分批增量提交，同一 report_digest）。幂等：同项同值重放成功、同项异值冲突（label_qc_decision_conflict，转请示勿重试覆盖）。TUI 下推荐走体检确认卡（harness 确定性合成参数，免转写）。",
    parameters: {
      type: "object",
      required: ["dataset_id", "actor", "report_digest", "decisions"],
      properties: {
        dataset_id: {
          type: "string",
          description: "注册标识符：取自登记结果或体检报告；非文件路径、不含 @",
        },
        pin: {
          type: "string",
          optional: true,
          description: "显式 pin；同数据集多 pin 登记时必须显式给出",
        },
        actor: {
          type: "string",
          description: "裁决人标签（审批人，仅审计留痕；TUI 确认卡合成时由 harness 填 tui-operator）",
        },
        decided_at: {
          type: "string",
          optional: true,
          description: "裁决时刻（携带时区的 ISO8601；缺省由内核记录接收时间）",
        },
        report_digest: {
          type: "string",
          description: "体检报告身份（取自 atf_label_qc_inspect 返回的 report_digest，sha256: 前缀形态；勿自造）",
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            required: ["item_id", "action"],
            properties: {
              item_id: { type: "string", description: "待确认项稳定幂等键（形态 qc-<q1..q4>-<digest12>；取自体检报告）" },
              action: { enum: ["accept", "reject", "modify"], description: "accept=按建议处置；modify=自定处置；reject=维持原状（不处置，≠剔除）" },
              disposition: {
                enum: ["keep_first", "keep_second", "keep_both", "drop_both", "set_value", "dedupe", "fix_field", "clip_to_bounds", "no_action"],
                optional: true,
                description: "处置（九项闭集；accept/modify 须落该检查类允许组合且≠no_action；reject 只可省略或 no_action）",
              },
              modified_value: { type: "string", optional: true, description: "set_value 必填：归一后的新值" },
              target_field: { type: "string", optional: true, description: "fix_field 必填：修正后的字段归属" },
              target_candidate_id: { type: "string", optional: true, description: "keep_first/keep_second 必填：保留候选（须引用该项 candidates）" },
              keep_ref: { type: "string", optional: true, description: "dedupe 必填：保留项（形态 marks[<下标>]）" },
              reason_text: { type: "string", optional: true, description: "keep_both/drop_both 必填：处置理由" },
              evidence_ref: { type: "string", optional: true, description: "判断依据证据引用（workspace 相对路径；与 judgements 至少其一，Q2 项必需）" },
              judgements: {
                type: "array",
                optional: true,
                items: {
                  type: "object",
                  required: ["item_id", "basis"],
                  properties: {
                    item_id: { type: "string" },
                    basis: { enum: ["multimodal", "user"], description: "判断主体：user=用户裁决；multimodal=多模态查看" },
                    evidence_ref: { type: "string", optional: true },
                    reason_text: { type: "string", optional: true },
                  },
                },
                description: "内联判断依据（与 evidence_ref 至少其一；Q2 项必需）",
              },
            },
          },
          description: "裁决批次（非空数组；只含用户逐项确认过的项——未决项绝不默认处置；可分批增量提交）",
        },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      required: ["ok", "dataset_id", "pin", "resolved_count", "pending_count", "decisions_ref", "decisions_sha256", "human_summary"],
      properties: {
        ok: { const: true },
        dataset_id: { type: "string" },
        pin: { type: "string" },
        resolved_count: { type: "integer" },
        pending_count: { type: "integer" },
        decisions_ref: { type: "string" },
        decisions_sha256: { type: "string", pattern: HEX64 },
        human_summary: { type: "object", strict: false },
      },
    },
  },
  {
    name: "atf_gate",
    description:
      "查询或推进闸门：gate 取值按命名分流（G1–G4 大小写不敏感 → 数据准入闸；其余须命中七组完整性 GateId；都不命中 unknown_gate）。blocked/warn 为合法业务产出（含原因码与证据引用）。query 免审批自主执行；advance 须账本审批预录。完整性 GateId 非序号顺延，勿猜测；未收录 id 返回 unknown_gate，先 query 合法清单。合法 GateId 清单：" +
      GATE_LEGAL_IDS.join("／") +
      "。",
    parameters: {
      type: "object",
      required: ["gate", "action"],
      properties: {
        gate: { type: "string" },
        action: { enum: ["query", "advance"] },
        evidence_refs: { ...STRING_ARRAY, optional: true },
      },
    },
    requires_approval: true,
    requiresApproval: gateRequiresApproval,
    canonical_output: {
      type: "object",
      required: ["ok", "gate", "status"],
      properties: {
        ok: { const: true },
        gate: { type: "string" },
        status: { enum: ["pass", "warn", "blocked"] },
        reason_codes: { ...STRING_ARRAY, optional: true },
        // re-pin v0.7.5b0 补登（K1 闸门指引，2026-09-23）：内核被拦时新增一行可行动文案
        // （补齐路径＋「G1–G4 同源勿逐个穷举」）——可选字段，缺省形态零回归。
        guidance: { type: "string", optional: true },
        requires_human_review: { type: "boolean", optional: true },
        evidence: { ...STRING_ARRAY, optional: true },
        reason: { type: "string", optional: true },
        missing: { ...STRING_ARRAY, optional: true },
      },
    },
  },
  {
    name: "atf_fact_scan",
    description: "事实索引枚举：列出本 run 可被引用的事实索引（journal_type / fact_id / sha256_digest 三元组）。只读。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "facts", "count"],
      properties: {
        ok: { const: true },
        count: { type: "integer" },
        facts: {
          type: "array",
          items: {
            type: "object",
            required: ["journal_type", "fact_id", "sha256_digest"],
            properties: {
              journal_type: { type: "string" },
              fact_id: { type: "string" },
              sha256_digest: { type: "string", pattern: HEX64 },
            },
          },
        },
      },
    },
  },
  {
    name: "atf_workspace_status",
    description:
      "工作区状态查询：返回当前 run 标识、已准入事实计数与作用域引用 scope_ref（供账本定位）。只读。" +
      "状态面返回的信息供你直接使用与决策——向用户报告时只讲结论与下一步，无需向用户复述其枚举内容。" +
      "工作区结构与数据形态优先由状态面获取；不要遍历文件系统。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      // F6 harness 侧小批（2026-09-21）：状态面数据集概览透传——根 strict:false（内核多返回
      // 顶层字段不 fail-closed），概览深形态校验归内核（不引入第二权威）；既有必填面照校。
      type: "object",
      strict: false,
      required: ["ok", "run_id", "admitted_count", "scope_ref"],
      properties: {
        ok: { const: true },
        run_id: { type: "string" },
        admitted_count: { type: "integer" },
        scope_ref: {
          type: "object",
          required: ["project_id", "scope_type", "scope_id", "scope_mode"],
          properties: {
            project_id: { type: "string" },
            scope_type: { type: "string" },
            scope_id: { type: "string" },
            scope_mode: { type: "string" },
          },
        },
        datasets: {
          type: "array",
          optional: true,
          items: { type: "object", strict: false },
          description: "数据集概览（F6，形态归内核）：已登记 dataset_id＋pin（可多个）＋来源根相对形态摘要＋最近登记时间",
        },
        human_summary: { type: "object", optional: true, strict: false, description: "状态面人读双层报告（若内核给，harness 直渲染）" },
      },
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((definition) => definition.name);
