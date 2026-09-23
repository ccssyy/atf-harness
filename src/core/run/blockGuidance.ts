/**
 * 业务阻断错误码 guidance 回填（D-f 批 D-f-3 / D-f-6，2026-09-21）。
 *
 * 纯回填层：不改结构、不改 schema——对已登记业务阻断码在回流处附一行可行动文案
 * （含义／缺什么／正常谁产／无料应请示停止），并在 turn 收口时按 is_material_gap
 * 自动组装「缺口卡」四段（卡在哪／缺什么／为什么需要／可选项 ≤3 标推荐）。
 * 纪律：harness 不代产料、不静默补齐——可选项不含任何「代派生料」承诺（D-f-5 取乙）。
 * 内核事实依据：《ATF-Harness_冒烟2三跑核验记录_20260921.md》§四（data_admission.py
 * _read_assignments 的强制清单形态）。
 */
import { INTEGRITY_GATE_IDS } from "../tools/index.js";

export interface GapCardOption {
  text: string;
  recommended?: boolean;
}

/** 缺口卡四段（TurnFailureSummary.gap_card 的构造形态）。 */
export interface GapCard {
  /** 卡在哪（一句话，具体到环节与对象） */
  stuck: string;
  /** 缺什么（所需输入或材料，具体到文件名/形态） */
  missing: string;
  /** 为什么需要（缺了会导致什么后果） */
  why: string;
  /** 可选项 ≤3 条并标推荐；空数组 = 无自然选项，以「如实停止并等待指示」为出口 */
  options: GapCardOption[];
}

export interface BlockGuidanceEntry {
  /** 业务阻断码（内核稳定原因码，经 executor 结构化回流） */
  code: string;
  /** 含义（一句话） */
  meaning: string;
  /** 缺什么（具体到文件名/形态） */
  missing: string;
  /** 正常情况下谁产 */
  producedBy: string;
  /** 为什么需要（缺了导致什么后果；缺口卡第 ③ 段） */
  why: string;
  /** 回流附注的一行可行动文案 */
  actionLine: string;
  /** 缺料类 → turn 收口时自动出缺口卡（请示式）；否则仅 guidance 行 + nudge */
  isMaterialGap: boolean;
  /** 缺口卡可选项（≤3，首条标推荐） */
  options: GapCardOption[];
}

const STOP_OPTION: GapCardOption = { text: "如实停止并等待用户指示" };

/** 首批登记（v4 定稿 §三 D-f-3）；K-Gap-2 接线批（2026-09-21）增 split_policy_missing／
 *  split_recompute_cluster_required 两键（增键不新造机制；policy 取值优先级＝确认态 >
 *  登记面 skills 建议 > 拒绝执行，裁决权在内核，harness 只透传与呈现，禁静默补齐/换策略）。 */
export const BLOCK_CODE_GUIDANCE: readonly BlockGuidanceEntry[] = [
  {
    code: "split_policy_missing",
    meaning: "缺「经确认的划分策略」：既无确认态 split_policy 也无登记面 skills 建议（内核不透传不猜）",
    missing: "经用户确认的划分策略 payload（默认建议 训练:测试 = 8:2，可改），或 skills 侧 split-policy.json 建议料",
    producedBy: "用户确认（Agent 译为 schema 化 payload）或 skills 侧产料",
    why: "无策略则划分无依据，准入按 fail-closed 诚实拒绝，不会自作主张",
    actionLine: "向用户呈现划分模板并请示（说明策略语义与默认比例），勿重复探查、勿代用户默认拿主意",
    isMaterialGap: true,
    options: [
      { text: "确认划分策略（采用默认 训练:测试 = 8:2 或给出修改比例）后重新执行准入", recommended: true },
      { text: "先落 skills 建议策略料（split-policy.json 进登记面）再重试" },
      STOP_OPTION,
    ],
  },
  {
    code: "split_recompute_cluster_required",
    meaning: "用户既不提供聚类料也不选免聚类策略——聚类确认点被跳过（内核诚实停止）",
    missing: "版式聚类产物（atf_style_cluster.execute 落料）或免聚类策略声明（auto_style_cluster 语义）",
    producedBy: "内核确定性聚类（经用户确认参数后执行）或 skills 侧语义聚类",
    why: "无聚类归属时按策略重分会破坏版式分层防护，内核拒绝静默放行",
    actionLine: "向用户确认聚类参数（propose 模板回显）后执行聚类落料，或改选免聚类策略；勿静默补齐",
    isMaterialGap: true,
    options: [
      { text: "确认聚类参数后调用 atf_style_cluster_execute 落料，再重新执行准入", recommended: true },
      { text: "改用免聚类的划分策略 payload 后重试" },
      STOP_OPTION,
    ],
  },
  // 走查修复小批 §二.3（2026-09-23）：补 G1 缺抽取契约包条目——直接治走查 A4（缺料后
  // 全盘扫描）；与 split_policy_missing 同构（material gap：请示式收口＋缺口卡）。
  {
    code: "extraction_contract_bundle_missing",
    meaning: "准入上下文缺已发布的抽取契约包（ExtractionContractBundle/v1）——G1 抽取契约闸无证据可验",
    missing: "已发布的抽取契约包（ExtractionContractBundle/v1，冻结双 Prompt/Parser/Metric 组件引用；发布经用户强制确认）",
    producedBy: "atf-validate-extraction-contract 技能的 publish 路径（仅 G1 判 pass 时发布）",
    why: "无契约包则字段抽取无冻结依据，G1 按 fail-closed 阻断；目录存在、历史训练成功或「最新配置」都不算已发布合同",
    actionLine: "如实说明缺什么并给出补齐路径（走 atf-validate-extraction-contract 技能发布后重试准入），勿遍历文件系统找料",
    isMaterialGap: true,
    options: [
      { text: "走 atf-validate-extraction-contract 技能生成候选并发布契约包（发布经用户强制确认）后重试准入", recommended: true },
      { text: "请用户指认既有已发布契约包（bundle_ref）后重试" },
      STOP_OPTION,
    ],
  },
  // R-3 接线批（2026-09-23）：标签体检引导两条——label_qc_pending 为 pin 现语义（报告存在
  // 且 pending>0 整体阻断）；label_qc_required 为 K2「体检必经」前瞻登记（内核启用后命中，
  // 现 pin 不触发零行为影响）。均治走查 A4 类全盘扫描：指路一键体检入口，勿遍历文件系统。
  {
    code: "label_qc_required",
    meaning: "该数据集尚未做标签体检（无体检报告）——数据准入按「体检必经」前置阻断",
    missing: "该 dataset@pin 的标签体检报告（经 atf_label_qc.inspect 生成，报告落登记面）",
    producedBy: "atf_label_qc.inspect（或 atf-inspect-annotations 技能流程）一次性生成",
    why: "标签质量是训练数据的前提——未体检的标注不得流入训练（owner 裁定：体检是流程必经步）",
    actionLine: "直接调用 atf_label_qc.inspect 执行体检（一键入口，幂等可重跑）；出待确认项后经体检确认卡或 atf_label_qc.resolve 逐项裁决；勿遍历文件系统找报告、勿重复探查",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "label_qc_pending",
    meaning: "体检报告存在且有未决待确认项——该 dataset@pin 的数据准入整体阻断（不逐类解锁）",
    missing: "全部待确认项的逐项裁决（经确认卡或 atf_label_qc.resolve 提交，直至 pending=0）",
    producedBy: "用户逐项确认（harness 体检确认卡裁决，或经 atf_label_qc.resolve 分批提交）",
    why: "未决项绝不默认处置——裁决齐全前准入保持阻断（坏标注不得流入训练）",
    actionLine: "向用户呈现待确认清单逐项请示（报告项含 human_label／出处／证据引用；Q2 项按整图理解展示 image_workspace_ref），经确认卡或 atf_label_qc.resolve 分批提交已确认项；未决项勿默认处置、勿重复探查、勿遍历文件系统",
    isMaterialGap: true,
    options: [
      { text: "经体检确认卡逐项裁决全部待确认项后重新请求准入", recommended: true },
      { text: "先提交已确认项（atf_label_qc.resolve 分批 partial），剩余项继续请示" },
      STOP_OPTION,
    ],
  },
  {
    code: "split_manifest_missing",
    meaning: "split_root 下缺 global_assignment.csv（9 列）或 global_plan.json（内核准入强制清单）",
    missing: "split_root 指向的目录中同时存在 global_assignment.csv 与 global_plan.json",
    producedBy: "上游拆分管线（wave skills 产料）",
    why: "缺清单则准入无法建立样本→分区的指派，真实数据校验不能执行",
    actionLine: "若本批确无该料：请如实向用户说明并停止，勿重复探查（指引见回流 guidance 字段）",
    isMaterialGap: true,
    options: [
      { text: "提供/指认含 global_assignment.csv 与 global_plan.json 的 split_root 后重新登记准入", recommended: true },
      { text: "先由上游拆分管线产出该批 split 料，再重试" },
      STOP_OPTION,
    ],
  },
  {
    code: "source_split_assignment_missing",
    meaning: "来源样本未命中拆分指派（image_relpath 无对应行，或 json_relpath/哈希不一致）",
    missing: "覆盖全部来源样本且与成对标注零漂移的拆分清单",
    producedBy: "上游拆分管线（清单与成对标注一致性保证）",
    why: "指派不全则部分样本无法归入分区，准入按零漂移要求拒绝",
    actionLine: "若本批确无该料：请如实向用户说明并停止，勿重复探查（指引见回流 guidance 字段）",
    isMaterialGap: true,
    options: [
      { text: "核对/补全拆分清单使全部样本命中后重试", recommended: true },
      { text: "更换指派完整的来源批" },
      STOP_OPTION,
    ],
  },
  {
    code: "invalid_params",
    meaning: "参数形态或互斥约束不合法（如登记面双形态字段混用；亦可能是路径不存在或不可达）",
    missing: "符合工具 schema 的参数（见各工具 parameters 描述）",
    producedBy: "调用方（修正参数即可，无需新材料）",
    why: "形态非法的调用被内核 fail-closed 拒绝，不会部分生效",
    actionLine: "按 detail 中的字段说明修正参数后重试；亦可能是路径不存在或不可达——请先探测实际形态，再决定来源根与整备方式（可经工作区状态 atf_workspace_status 确认）；同类修参两次仍拒则如实请示，勿继续盲试",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "unknown_gate",
    meaning: "GateId 未收录（合法清单见 atf_gate 工具描述与 GATE_LEGAL_IDS）",
    missing: "命中合法清单的 GateId（G1–G4 命名分流或七组完整性 GateId）",
    producedBy: "工具描述单源清单（GATE_LEGAL_IDS）",
    why: "未收录 id 一律 fail-closed 拒绝，防闸门名幻觉",
    actionLine: "先以 atf_gate query 核对合法清单；勿猜测新 id",
    isMaterialGap: false,
    options: [],
  },
  // 批 3「创作执行面」（2026-09-22）：工作区工具本地拒绝码 guidance——可行动一行回填，
  // 模型可自纠换路径（非 material gap：均系参数/用法问题，无需请示用户产料）。
  {
    code: "argv0_not_allowed",
    meaning: "scratch 执行的 argv[0] 不在白名单（只允许 python3 或 .py 脚本：pin 内 skills scripts 或 scratch 内脚本）",
    missing: "以 python3 开头的 argv，或指向内核 skills scripts／scratch 内 .py 的脚本路径",
    producedBy: "调用方（改写 argv 即可）",
    why: "白名单外二进制（含 shell）一律拒绝——受控执行面无 shell 入口",
    actionLine: "把命令改写为 python3 执行 .py 脚本的形式（内核 skills scripts 直接给绝对路径）；launch.sh/train.sh 不可经本工具执行（由 harness 在用户确认后执行）",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "path_escape",
    meaning: "路径越界（拒绝绝对路径、.. 逃逸与 scratch 外落点）",
    missing: "scratch 内相对路径",
    producedBy: "调用方（改写 path 即可）",
    why: "T0 写入与执行落点恒在 scratch 内（沙箱最小权限）",
    actionLine: "改用 scratch 内相对路径（如 prep/iteration-config.json）；需要绝对路径输入时先确认 pin/内核目录形态",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "content_too_large",
    meaning: "写入内容超过体量上限（1 MiB）",
    missing: "更小的内容（拆分文件或精简）",
    producedBy: "调用方",
    why: "T0 写入体量守卫；超大内容应拆分或改由脚本生成",
    actionLine: "拆分为多个文件或精简内容后重试；大文件建议由脚本在 scratch 内生成",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "skills_root_missing",
    meaning: "技能根不可用（本环境未找到内核 skills 目录）",
    missing: "pin 内核 checkout（<内核>/skills）",
    producedBy: "环境（ATF_CLI_PATH 或 .atf-pinned）",
    why: "技能唯一事实源＝pin 内核；缺失时装载降级、读全文不可用",
    actionLine: "如实向用户说明本环境无技能目录，按用户指示改走显式命令路径",
    isMaterialGap: false,
    options: [],
  },
  {
    code: "launch_config_mismatch",
    meaning: "IterationConfig 与 launch_manifest 的 iteration_config_sha256 不一致（放行对拍 fail-closed）",
    missing: "与 launch_manifest 同源的 IterationConfig 文件",
    producedBy: "环节① generate_train_launch.py 消费的同一份配置",
    why: "放行记录按配置 sha256 入账；对不上即放行了另一份计划",
    actionLine: "核对配置文件是否为生成 train.sh 的同一份（可重新生成后重试）；勿强行放行不一致的计划",
    isMaterialGap: false,
    options: [],
  },
];

export const guidanceFor = (code: string): BlockGuidanceEntry | undefined =>
  BLOCK_CODE_GUIDANCE.find((entry) => entry.code === code);

export const isMaterialGapCode = (code: string): boolean => guidanceFor(code)?.isMaterialGap === true;

/** 回流附注的一行可行动文案（未登记码返回 undefined——零加工透传既有行为）。 */
export const guidanceLineFor = (code: string): string | undefined => {
  const entry = guidanceFor(code);
  if (entry === undefined) return undefined;
  return `【${entry.code}】${entry.meaning}。缺：${entry.missing}；正常由${entry.producedBy}产出。${entry.actionLine}`;
};

/** 缺口卡四段组装（turn 收口时由 runner 以最后一个 material-gap 回流调用）。 */
export const gapCardFor = (tool: string, code: string): GapCard => {
  const entry = guidanceFor(code);
  if (entry === undefined) {
    return { stuck: `${tool} 调用被内核以 ${code} 拒绝`, missing: "（未知缺口——见回流明细）", why: "业务阻断，未放行", options: [STOP_OPTION] };
  }
  return {
    stuck: `${tool} 调用被内核以 ${entry.code} 拒绝（业务阻断，非链路错误）`,
    missing: entry.missing,
    why: entry.why,
    options: entry.options.length > 0 ? entry.options : [STOP_OPTION],
  };
};

/**
 * length 截断收口缺口卡（pi-ai 换库批 R1，2026-09-23）：finish_reason=length 的 turn 收口
 * 引导——截断响应不作完整决策执行（fail-closed），出口＝降思考等级重试或以既有历史续跑。
 * contentEmpty=true（思考吞预算且重试已耗）时首选项为降档；非空截断时首选项为续跑。
 */
export const lengthTruncatedGapCard = (contentEmpty: boolean, retriesUsed: number): GapCard => {
  const retryNote = retriesUsed > 0 ? `（已自动重试 ${String(retriesUsed)} 次仍截断）` : "";
  return {
    stuck: contentEmpty
      ? `模型响应被 max_tokens 截断且无可见内容——思考耗尽输出预算${retryNote}`
      : `模型响应被 max_tokens 截断，携带的部分产出未执行${retryNote}`,
    missing: "本 turn 未收束的完整决策（截断响应不作为完整决策执行）",
    why: "以既有历史续跑不会丢失已确认的事实与结果；截断尾巴丢弃可避免执行不完整动作",
    options: contentEmpty
      ? [
          { text: "降低思考等级后重试（reasoning_effort 调低，如 max→low）", recommended: true },
          { text: "输入新指令继续本会话（历史保留）" },
        ]
      : [
          { text: "输入新指令继续本会话（历史保留，续跑即重建）", recommended: true },
          { text: "降低思考等级后重试（reasoning_effort 调低）" },
        ],
  };
};

// ---------------------------------------------------------------------------
// B3：完整性闸门 blocked 三段式指引（走查修复批 2026-09-23，指令 7158bf43；仅 harness
// 措辞层，不改内核闸门语义）。走查 run-full-v0762 实录（#2254）：atf_gate advance 对完整
// 性闸门返回 executed(ok=true)+status=blocked，内核 guidance 只有一句泛化文案——模型缺
// 「产出路径」与「登记动作示例」，被迫考古（走查报告 8628d036 §三 B3 ①②）。
// 回流固定三段：缺什么（缺失证据清单，从闸门结果 missing 透传，不新增猜测）＋产出路径
// （对应技能链名）＋登记动作（atf_gate action=advance 携证据引用示例）；内核原始 guidance
// 若已有内容保留拼接于段后、不覆盖。
// ---------------------------------------------------------------------------

/** 闸门 → 技能链产出路径映射。依据＝pin 内核 skills/ 清单（v0.6.0b0）各技能 description 的
 *  领域锚定；extraction-contract-valid 一行为指令 7158bf43 原文锚定。B4（技能互引）归内核侧
 *  批次执行，经 re-pin 生效后本表无需变更——本表只指路技能面，不承载技能内容（禁造第二权威）。 */
const INTEGRITY_GATE_OUTPUT_PATHS: Readonly<Record<string, string>> = {
  "extraction-contract-valid": "atf-validate-extraction-contract 技能（候选生成与校验；契约包发布见 atf-build-family-split 技能 publish 节）",
  "source-identity-valid": "atf-admit-training-data 技能（数据准入与来源证据闭合链）",
  "split-integrity-valid": "atf-build-family-split 技能（切分产物链）",
  "training-data-valid": "atf-admit-training-data 技能（TrainingDataArtifact/v1 编译与 G4 闭合）",
  "training-preflight-valid": "atf-prepare-training 技能（训练计划与前置证据）",
  "evaluation-preflight-valid": "atf-evaluate-checkpoints 技能（评估服务编排与前置证据）",
  "evaluation-evidence-valid": "atf-evaluate-checkpoints 技能（评估指标与 badcase 证据报告）",
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 完整性闸门 blocked 结果的三段式回流文案（executed 径专用——闸门 blocked 是合法业务产出
 * 而非 rejected，既有 guidanceLineFor 回填点不覆盖；runner 在 tool/result 落盘处调用）。
 * gate 接受 unknown（从 executed result 的 gate 回显字段透传，helper 内收窄——调用面零假设）。
 * 非完整性闸门（G1–G4 命名分流等）/ 非 blocked 状态 → undefined（零加工透传既有行为）。
 */
export const integrityGateBlockedGuidance = (gate: unknown, result: unknown): string | undefined => {
  if (typeof gate !== "string" || !INTEGRITY_GATE_IDS.includes(gate)) return undefined;
  if (!isPlainRecord(result) || result["status"] !== "blocked") return undefined;
  const reason =
    typeof result["reason"] === "string" && result["reason"] !== ""
      ? result["reason"]
      : Array.isArray(result["reason_codes"]) && typeof result["reason_codes"][0] === "string"
        ? (result["reason_codes"][0] as string)
        : "blocked";
  // 第一段［缺什么］：缺失证据清单从闸门结果 missing 透传；结果未列明则指向 query 回显
  //（不新增猜测——走查 B3 ③「不列缺哪些证据」的 harness 侧兜底）
  const missingList = Array.isArray(result["missing"])
    ? (result["missing"].filter((item): item is string => typeof item === "string" && item !== ""))
    : [];
  const missingPart =
    missingList.length > 0
      ? `缺什么：${missingList.join("、")}`
      : `缺什么：闸门结果未列明缺失清单——先以 atf_gate(gate="${gate}", action="query") 回显核对`;
  // 第二段［产出路径］：技能链名（映射表锚定；未收录映射的新 GateId 走通用指路）
  const outputPath = INTEGRITY_GATE_OUTPUT_PATHS[gate] ?? "技能面对应技能链（按闸门名检索常驻技能清单）";
  // 第三段［登记动作］：advance 携证据引用示例
  const advanceExample = `登记动作：按产出路径补齐证据产物后，以 atf_gate(gate="${gate}", action="advance", evidence_refs=[…证据引用…]) 重新推进`;
  const threeParts = `【完整性闸门 ${gate} 推进被拦（${reason}）】${missingPart}；产出路径：${outputPath}；${advanceExample}`;
  // 内核原始 guidance 保留拼接、不覆盖（走查 B3 修法第 3 条）
  const kernelGuidance = typeof result["guidance"] === "string" && result["guidance"] !== "" ? result["guidance"] : undefined;
  return kernelGuidance !== undefined ? `${threeParts}｜内核指引：${kernelGuidance}` : threeParts;
};
