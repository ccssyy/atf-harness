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

/** 首批登记（v4 定稿 §三 D-f-3）；K-Gap-2 接线批将增 split_policy_missing／
 *  split_recompute_cluster_required 两键（增键不新造机制）。 */
export const BLOCK_CODE_GUIDANCE: readonly BlockGuidanceEntry[] = [
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
    actionLine: "按 detail 中的字段说明修正参数后重试；亦可能是路径不存在或不可达——请先按工作区状态确认来源根实际形态，勿按示例路径猜测；同类修参两次仍拒则如实请示，勿继续盲试",
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
