/**
 * D94-harness 六类护栏（指令《ATF_指令_窗口B6_20261024》sha b24fa77d9c68 L-H3）：
 * 消费内核 argparse surface 清单（tools/argparse_surface.json 的 harness 侧快照＝
 * tests/fixtures/kernel/argparse_surface.json；内核生成器 docstring 即定义清单为
 * 「harness 侧消费的接口契约快照」）对 harness 事实面做六类对账——参数面／段清单／
 * 九要素键↔消费点／闭集／文档实现／形态假设。
 *
 * 形态：纯函数（快照＋harness 事实面 → 违例清单），零 IO 零 env——快照与事实的采集
 * 归消费方（guard.test.ts）；阴性对照（guard.negative.test.ts）以变异快照/事实直接
 * 驱动本模块断言必红。清单与内核真源的对账（ATF_KERNEL_DIR 在场时）也归消费方。
 *
 * 护栏纪律（授权件）：红＝能小修当场修，修不了登记豁免；禁 skip／禁放宽断言。
 */

// ── 快照形态（与内核 generate_argparse_surface.py 输出逐键对应）──

export interface SurfaceArg {
  option: string;
  dest: string;
  action: string | null;
  type: unknown;
  choices: unknown;
  default: unknown;
  required: unknown;
}

export interface SurfaceScript {
  script: string;
  args: SurfaceArg[];
}

export type SurfaceSnapshot = readonly SurfaceScript[];

/** 快照内脚本条目检索（按相对路径精确匹配；缺条目＝null 由护栏报违例）。 */
export const scriptOf = (snapshot: SurfaceSnapshot, script: string): SurfaceScript | null =>
  snapshot.find((entry) => entry.script === script) ?? null;

/** 旗标选项集（--option 字符串集合）。 */
export const optionSetOf = (entry: SurfaceScript): ReadonlySet<string> =>
  new Set(entry.args.map((arg) => arg.option));

// ── harness 事实面（消费方采集后注入；字段语义见各护栏注释）──

export interface HarnessSurfaceFacts {
  /** 行为面全 token 序列（mock 对端回显的 argv，多段拼接——store_true 形态判定用）。 */
  argvTokens: readonly string[];
  /** atf_pipeline_stage 参数 schema 键集（运行时 properties）。 */
  toolParamKeys: readonly string[];
  /** 工具参数键 → 内核旗标单源映射（映射完整性＝参数面护栏断言对象之一）。 */
  flagByParam: Readonly<Record<string, string>>;
  /** 参数面前瞻豁免集（E4-乙 b9 未发窗——豁免键跳过「旗标落声明面」单项对账；
   *  映射完整性与必填/choices 对账不变；re-pin b9 时随快照更新退役）。 */
  paramFaceWaivers: ReadonlySet<string>;
  /** harness 八段序（runFacts SEGMENT_ORDER）。 */
  pipelineStages: readonly string[];
  /** 段事实映射键集（segmentFacts SEGMENT_FACT_BY_KERNEL_STAGE 键）。 */
  segmentFactKeys: readonly string[];
  /** 词汇闭集（pipelineFace 常量）。G2 退役：grouping_preset 取值集合归内核，harness 不再声明，
   *  故不在册（choices 同源对账随之取消——内核 argparse 仍是唯一权威）。 */
  autoStyleClusterValues: readonly string[];
  /** 行为面下传的 approval-mode 值。 */
  approvalModeValue: string;
  /** 九要素确认卡键集（configConfirm CONFIG_CONFIRM_KEYS 的 key 列）。 */
  configConfirmKeys: readonly string[];
  /** 九要素只读键（READONLY_CONFIG_KEYS）。 */
  readonlyConfigKeys: readonly string[];
  /** 九要素键 → 消费点登记表（键 → [清单脚本相对路径, 旗标]；「可编辑不消费」禁的
   *  正向登记——可编辑键必须在册且消费点在清单内真实在位）。 */
  keyConsumption: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>>;
  /** 错误码闭集（kernelErrorFace KERNEL_ERROR_FACE_CODES）。 */
  kernelErrorFaceCodes: readonly string[];
  /** humanizeKernelError 的 switch case 键集（源码扫描）。 */
  errorFaceCaseKeys: readonly string[];
  /** harness 引用的内核脚本相对路径闭集（清单 script 键精确匹配）。 */
  kernelScriptRefs: readonly string[];
  /** pipelineFace 头注释「命令面（段模式）」接口契约段文本（文档实现类对账面）。 */
  docContractText: string;
  /** kernelErrorFace 头注释闭集记载段文本。 */
  docKernelErrorText: string;
  /** bridge.contract.yaml 全文（pin 段形态自洽）。 */
  bridgeContractText: string;
  /** 摘要落盘模板源码字面（pipelineFace 落盘回读路径模板）。 */
  summaryPathTemplateLiteral: string;
}

export type GuardKind = "参数面" | "段清单" | "九要素键" | "闭集" | "文档实现" | "形态假设";

export interface GuardViolation {
  kind: GuardKind;
  detail: string;
}

const WALKTHROUGH = "tools/walkthrough_pipeline.py";

// ── 一 参数面：harness 下传面 ⊆ 内核声明面；映射表完整；必填参在传；choices 同源 ──

export const guardParamsFace = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFacts): GuardViolation[] => {
  const out: GuardViolation[] = [];
  const entry = scriptOf(snapshot, WALKTHROUGH);
  if (entry === null) {
    out.push({ kind: "参数面", detail: `快照缺 ${WALKTHROUGH} 条目——harness 管线段模式对账失去内核声明面` });
    return out;
  }
  const options = optionSetOf(entry);
  const byOption = new Map(entry.args.map((arg) => [arg.option, arg]));
  // 豁免键旗标集（前瞻豁免面——E5·H1 D139 豁免已随 re-pin b10 退役，集恒空；
  // waivedFlags 派生逻辑保留供将来前瞻豁免复用，空集＝行为面/映射面全对账）
  const waivedFlags = new Set(
    [...facts.paramFaceWaivers].map((key) => facts.flagByParam[key]).filter((flag) => flag !== undefined),
  );
  // 行为面旗标全部在内核声明面（禁传内核未声明参数；豁免旗标除外——集空即全查）
  for (const token of facts.argvTokens) {
    if (token.startsWith("--") && !options.has(token) && !waivedFlags.has(token)) {
      out.push({ kind: "参数面", detail: `行为面下传旗标 ${token} 不在内核 argparse 声明面（禁传内核未声明参数）` });
    }
  }
  // 工具参数键 ↔ 旗标映射完整且落清单（前瞻豁免键免「旗标落声明面」单项——集空即全查）
  for (const key of facts.toolParamKeys) {
    const flag = facts.flagByParam[key];
    if (flag === undefined) {
      out.push({ kind: "参数面", detail: `工具参数键 ${key} 无旗标映射（flagByParam 缺登记——参数面对账断链）` });
      continue;
    }
    if (!options.has(flag) && !facts.paramFaceWaivers.has(key)) {
      out.push({ kind: "参数面", detail: `工具参数键 ${key} 映射旗标 ${flag} 不在内核声明面` });
    }
  }
  // 必填参必传（清单 required=true 的旗标须在行为面出现）
  for (const arg of entry.args) {
    if (arg.required === true && !facts.argvTokens.includes(arg.option)) {
      out.push({ kind: "参数面", detail: `内核必填参 ${arg.option} 未出现在行为面（harness 必传面缺口）` });
    }
  }
  // choices 字面量同源（快照字面量 ↔ harness 常量逐键相等）
  const choicesOf = (flag: string): unknown => byOption.get(flag)?.choices;
  const sameSet = (a: unknown, b: readonly string[]): boolean =>
    Array.isArray(a) && a.length === b.length && [...b].sort().join("\u0000") === [...(a as string[])].sort().join("\u0000");
  // G2（owner 2026-10-26）：--grouping-preset 的 choices 归内核，harness 不再持有词表——
  // 本项「choices 同源」对账随枚举退役，改由「形状校验＋内核拒绝回流」保证（见 pipelineFace）。
  if (!sameSet(choicesOf("--auto-style-cluster"), facts.autoStyleClusterValues)) {
    out.push({ kind: "参数面", detail: `--auto-style-cluster choices 与 harness AUTO_STYLE_CLUSTER_VALUES 不同源（快照=${JSON.stringify(choicesOf("--auto-style-cluster"))}）` });
  }
  return out;
};

// ── 二 段清单：段序单源名对账＋映射恒等＋mock 形态一致 ──

export const guardStageList = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => {
  const out: GuardViolation[] = [];
  const entry = scriptOf(snapshot, WALKTHROUGH);
  const stageArg = entry?.args.find((arg) => arg.option === "--stage");
  if (stageArg === undefined) {
    out.push({ kind: "段清单", detail: "快照缺 --stage 参数——内核段清单失去对账锚" });
  } else if (stageArg.choices !== "<expr:list(STAGE_ORDER)>") {
    out.push({ kind: "段清单", detail: `--stage choices 表达式漂移（期望 <expr:list(STAGE_ORDER)>，得 ${JSON.stringify(stageArg.choices)}）——内核段序单源名变更须随 re-pin 重对账` });
  }
  const sameSeq = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((item, index) => item === b[index]);
  if (!sameSeq(facts.pipelineStages, facts.segmentFactKeys)) {
    out.push({ kind: "段清单", detail: `SEGMENT_ORDER 与 SEGMENT_FACT_BY_KERNEL_STAGE 键序不恒等（D96 映射恒等化破坏）：${JSON.stringify(facts.pipelineStages)} vs ${JSON.stringify(facts.segmentFactKeys)}` });
  }
  if (!sameSeq(facts.pipelineStages, facts.mockKnownStages)) {
    out.push({ kind: "段清单", detail: "mock 对端 KNOWN 段闭集与 harness 八段序不一致（mock 漂移）" });
  }
  return out;
};

export interface HarnessSurfaceFactsWithMock extends HarnessSurfaceFacts {
  /** mock 对端 KNOWN 段闭集（fixtures 源码扫描）。 */
  mockKnownStages: readonly string[];
}

// ── 三 九要素键↔消费点：只读键自洽；可编辑键消费点在册且清单在位 ──

export const guardNineFactorKeys = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => {
  void snapshot;
  const out: GuardViolation[] = [];
  for (const key of facts.readonlyConfigKeys) {
    if (!facts.configConfirmKeys.includes(key)) {
      out.push({ kind: "九要素键", detail: `只读键 ${key} 不在确认卡键集（READONLY_CONFIG_KEYS 与 CONFIG_CONFIRM_KEYS 脱钩）` });
    }
  }
  const editable = facts.configConfirmKeys.filter((key) => !facts.readonlyConfigKeys.includes(key));
  for (const key of editable) {
    const consumption = facts.keyConsumption[key];
    if (consumption === undefined || consumption.length === 0) {
      out.push({ kind: "九要素键", detail: `可编辑键 ${key} 无消费点登记（可编辑不消费禁——卡上可改值必须走到内核消费点）` });
      continue;
    }
    for (const [script, flag] of consumption) {
      const entry = scriptOf(snapshot, script);
      if (entry === null) {
        out.push({ kind: "九要素键", detail: `键 ${key} 消费点脚本 ${script} 不在内核清单（改名/移位未随 re-pin 对账）` });
        continue;
      }
      // 旗标空串＝脚本级组装消费（值经脚本组装进产物文件，非 CLI 参数直收）——
      // 只断言脚本在册；非空旗标须在内核声明面（消费断路即红）。
      if (flag !== "" && !optionSetOf(entry).has(flag)) {
        out.push({ kind: "九要素键", detail: `键 ${key} 消费点 ${script} ${flag} 不在内核声明面（消费断路）` });
      }
    }
  }
  return out;
};

// ── 四 闭集：错误码↔文案 case 恒等；approval-mode/lane 产品闭集冻结 ──

export const guardClosedSets = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => {
  const out: GuardViolation[] = [];
  const codes = [...facts.kernelErrorFaceCodes].sort();
  const cases = [...facts.errorFaceCaseKeys].sort();
  if (codes.join("\u0000") !== cases.join("\u0000")) {
    out.push({ kind: "闭集", detail: `KERNEL_ERROR_FACE_CODES 与 humanizeKernelError case 集不恒等：${JSON.stringify(codes)} vs ${JSON.stringify(cases)}` });
  }
  const entry = scriptOf(snapshot, WALKTHROUGH);
  const approvalArg = entry?.args.find((arg) => arg.option === "--approval-mode");
  if (approvalArg === undefined) {
    out.push({ kind: "闭集", detail: "快照缺 --approval-mode——审批模式闭集失去内核锚" });
  } else {
    const choices = Array.isArray(approvalArg.choices) ? approvalArg.choices : [];
    if (!choices.includes(facts.approvalModeValue)) {
      out.push({ kind: "闭集", detail: `行为面 approval-mode ${facts.approvalModeValue} 不在内核 choices ${JSON.stringify(choices)}` });
    }
  }
  const laneArg = entry?.args.find((arg) => arg.option === "--lane-suffix");
  if (laneArg === undefined) {
    out.push({ kind: "闭集", detail: "快照缺 --lane-suffix——lane 产品闭集失去内核锚" });
  } else if (JSON.stringify(laneArg.choices) !== JSON.stringify(["goods", "non_goods", "mixed"])) {
    out.push({ kind: "闭集", detail: `--lane-suffix choices 漂移（产品闭集 goods/non_goods/mixed）：${JSON.stringify(laneArg.choices)}` });
  }
  return out;
};

// ── 五 文档实现：接口契约文档段 ↔ 实现旗标一一在册；pin 段形态自洽 ──

export const guardDocImplementation = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => {
  void snapshot;
  const out: GuardViolation[] = [];
  // 前瞻豁免键（含 harness 自用参数：T4 像素下限例外的理由位——从不进 argv）不参与
  // 「契约文档段在册」对账：它们不是下传旗标，写进契约段反而制造反向漂移。
  const waivedFlags = new Set(
    [...facts.paramFaceWaivers].map((key) => facts.flagByParam[key]).filter((flag) => flag !== undefined),
  );
  for (const flag of Object.values(facts.flagByParam)) {
    if (waivedFlags.has(flag)) continue;
    if (!facts.docContractText.includes(flag)) {
      out.push({ kind: "文档实现", detail: `实现下传旗标 ${flag} 未记载于 pipelineFace 接口契约文档段（文档漂移）` });
    }
  }
  for (const code of facts.kernelErrorFaceCodes) {
    if (!facts.docKernelErrorText.includes(code)) {
      out.push({ kind: "文档实现", detail: `错误码 ${code} 未记载于 kernelErrorFace 头注释闭集段（文档漂移）` });
    }
  }
  if (!/atf_upstream:\n {2}tag: v/.test(facts.bridgeContractText) || !/^ {2}commit_sha: [0-9a-f]{40}$/m.test(facts.bridgeContractText)) {
    out.push({ kind: "文档实现", detail: "bridge.contract.yaml pin 段形态不自洽（atf_upstream tag/commit_sha 缺失或形态漂移）" });
  }
  return out;
};

// ── 六 形态假设：内核脚本引用在清单；store_true 裸开关；摘要落盘模板在位 ──

export const guardShapeAssumptions = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => {
  const out: GuardViolation[] = [];
  const scriptBasenames = new Set(snapshot.map((entry) => entry.script.split("/").pop() ?? entry.script));
  for (const ref of facts.kernelScriptRefs) {
    if (!scriptBasenames.has(ref)) {
      out.push({ kind: "形态假设", detail: `harness 引用的内核脚本 ${ref} 不在清单脚本闭集（内核改名/移位未随 re-pin 对账）` });
    }
  }
  const entry = scriptOf(snapshot, WALKTHROUGH);
  const storeTrueFlags = new Set((entry?.args ?? []).filter((arg) => arg.action === "store_true").map((arg) => arg.option));
  for (let index = 0; index < facts.argvTokens.length; index += 1) {
    const token = facts.argvTokens[index] ?? "";
    if (storeTrueFlags.has(token)) {
      const next = facts.argvTokens[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.push({ kind: "形态假设", detail: `store_true 旗标 ${token} 后跟随了值 token ${next}（内核开关形态假设破坏——harness 不得传值）` });
      }
    }
  }
  if (!facts.summaryPathTemplateLiteral.includes("stage-") || !facts.summaryPathTemplateLiteral.includes(".summary.json")) {
    out.push({ kind: "形态假设", detail: "落盘摘要路径模板字面缺失（stage-<段>.summary.json 形态假设失去实现锚）" });
  }
  return out;
};

/** 六类串跑（每类独立收集——一类红不遮蔽其余类）。 */
export const runAllGuards = (snapshot: SurfaceSnapshot, facts: HarnessSurfaceFactsWithMock): GuardViolation[] => [
  ...guardParamsFace(snapshot, facts),
  ...guardStageList(snapshot, facts),
  ...guardNineFactorKeys(snapshot, facts),
  ...guardClosedSets(snapshot, facts),
  ...guardDocImplementation(snapshot, facts),
  ...guardShapeAssumptions(snapshot, facts),
];
