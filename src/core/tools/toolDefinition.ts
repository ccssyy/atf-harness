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

/** 工具面 5 个（R1 修订 2026-09-20：原「严格 4 个」owner 口径 #5 经 R1 立项扩为 5——owner 决议
 *  sha 8b5458c0…；新增 atf_data_admission_request 经 executor 显式映射到 atf_data_admission.request。
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
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
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
    description: "工作区状态查询：返回当前 run 标识、已准入事实计数与作用域引用 scope_ref（供账本定位）。只读。",
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
