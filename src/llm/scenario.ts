/**
 * 场景脚本 schema v1（任务书 §5 / owner 口径 #2：draft-v0 校准定稿入库 scenarios/）。
 *
 * 六类步骤白名单（严格收口，未知 type / 未声明字段一律拒绝——与全仓 schema 同哲学）：
 * - assistant_message / final_answer：Faux 的会话输出（assistant/message 事件 + 收束）
 * - tool_call：严格 4 工具面调用（params 与账本预录严格绑定——审批键 = tool + params digest）
 * - scratch_write / promote / cite_t0：runner 内置步骤——harness 本地工作区动作与 T0 引用尝试，
 *   **不属于工具注册表**（owner 口径 #1：晋升走晋升闸 A，严格 4 工具与内核方法面不变）
 *
 * 本模块只做结构与语法校验；语义（步骤顺序、账本绑定一致性）由 runner 执行期承载。
 */
import { err, ok, type Result } from "../bridge/index.js";

export const SCENARIO_VERSION = 1;

/** 步骤类型白名单（v1，六类，无第七类）。 */
export const SCENARIO_STEP_TYPES = [
  "assistant_message",
  "tool_call",
  "scratch_write",
  "promote",
  "cite_t0",
  "final_answer",
] as const;

export type ScenarioStepType = (typeof SCENARIO_STEP_TYPES)[number];

/** 单个 Faux 决策步骤（判别联合）。 */
export type ScenarioStep =
  | { type: "assistant_message"; text: string }
  | {
      type: "tool_call";
      /** 工具名（严格 4 工具面，面外由注册表拒绝） */
      tool: string;
      /** 与账本预录严格绑定的参数对象（审批键 = tool + stable(params) digest） */
      params: Record<string, unknown>;
      /** true = 把最近一次成功准入的事实三元组作为本步骤 tool/result 事件的 domain_refs（证据链闭合） */
      cite_admitted_fact?: boolean;
    }
  | { type: "scratch_write"; path: string; content: string }
  | { type: "promote"; source: string; command: string[] }
  | { type: "cite_t0"; source: string; text: string }
  | { type: "final_answer"; text: string };

/** 账本预录条目（owner 口径：审批键与工具调用 params 严格一致，脚本内显式重复以可审计）。 */
export interface LedgerPreRecord {
  tool: string;
  params: Record<string, unknown>;
}

/** 分支期望（runner 执行后由 evaluateExpectations 逐项核验，违例列入报告）。 */
export interface ScenarioExpect {
  outcome: "completed" | "approval_missing" | "session_rejected";
  exit_code: 0 | 1 | 78;
  gate_status?: "pass" | "blocked";
  first_gate_status?: "pass" | "blocked";
  block_reason?: "approval_missing" | "t0_ref_forbidden";
  promoted?: boolean;
  replayable?: boolean;
  domain_refs_valid?: boolean;
}

export interface ScenarioBranch {
  branch_id: string;
  /** 本分支 run 工作区标识（注入 provenance——owner 口径 #6：S4 口径 #2 的兑现） */
  run_id: string;
  /** 注入 provenance 的触发指令（同上） */
  trigger_instruction: string;
  purpose: string;
  setup: { ledger: LedgerPreRecord[] };
  steps: ScenarioStep[];
  expect: ScenarioExpect;
}

export interface Scenario {
  scenario_id: string;
  version: 1;
  provider: "faux";
  description: string;
  /** 以 branch_id 为键（draft-v0 的数组形态校准为对象映射） */
  branches: Record<string, ScenarioBranch>;
}

export type ScenarioErrorCode = "schema_violation";

export interface ScenarioError {
  code: ScenarioErrorCode;
  message: string;
  detail?: unknown;
}

export const scenarioError = (message: string, detail?: unknown): ScenarioError => {
  const error: ScenarioError = { code: "schema_violation", message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 未声明字段检查（properties 即白名单——与 S3 canonical 方言同哲学）。 */
const rejectUndeclared = (value: Record<string, unknown>, declared: readonly string[], path: string): string | null => {
  for (const key of Object.keys(value)) {
    if (!declared.includes(key)) return `${path} 含未声明字段 "${key}"`;
  }
  return null;
};

const parseStep = (value: unknown, path: string): Result<ScenarioStep, ScenarioError> => {
  if (!isPlainObject(value)) return err(scenarioError(`${path} 不是 JSON 对象`));
  const type = value["type"];
  if (!isNonEmptyString(type) || !(SCENARIO_STEP_TYPES as readonly string[]).includes(type)) {
    return err(scenarioError(`${path} 未知步骤 type: ${String(type)}（v1 白名单外一律拒绝）`));
  }
  switch (type as ScenarioStepType) {
    case "assistant_message":
    case "final_answer": {
      const violation = rejectUndeclared(value, ["type", "text"], path);
      if (violation !== null) return err(scenarioError(violation));
      if (!isNonEmptyString(value["text"])) return err(scenarioError(`${path}.text 非法（须为非空字符串）`));
      return ok({ type: type as "assistant_message" | "final_answer", text: value["text"] });
    }
    case "tool_call": {
      const violation = rejectUndeclared(value, ["type", "tool", "params", "cite_admitted_fact"], path);
      if (violation !== null) return err(scenarioError(violation));
      if (!isNonEmptyString(value["tool"])) return err(scenarioError(`${path}.tool 非法（须为非空字符串）`));
      if (!isPlainObject(value["params"])) return err(scenarioError(`${path}.params 非法（须为 JSON 对象）`));
      if (value["cite_admitted_fact"] !== undefined && typeof value["cite_admitted_fact"] !== "boolean") {
        return err(scenarioError(`${path}.cite_admitted_fact 非法（须为 boolean）`));
      }
      const step: Extract<ScenarioStep, { type: "tool_call" }> = { type: "tool_call", tool: value["tool"], params: value["params"] };
      if (value["cite_admitted_fact"] === true) step.cite_admitted_fact = true;
      return ok(step);
    }
    case "scratch_write": {
      const violation = rejectUndeclared(value, ["type", "path", "content"], path);
      if (violation !== null) return err(scenarioError(violation));
      if (!isNonEmptyString(value["path"])) return err(scenarioError(`${path}.path 非法（须为非空字符串）`));
      if (typeof value["content"] !== "string") return err(scenarioError(`${path}.content 非法（须为字符串）`));
      return ok({ type: "scratch_write", path: value["path"], content: value["content"] });
    }
    case "promote": {
      const violation = rejectUndeclared(value, ["type", "source", "command"], path);
      if (violation !== null) return err(scenarioError(violation));
      if (!isNonEmptyString(value["source"])) return err(scenarioError(`${path}.source 非法（须为非空字符串）`));
      const command = value["command"];
      if (!Array.isArray(command) || command.length === 0 || command.some((part) => !isNonEmptyString(part))) {
        return err(scenarioError(`${path}.command 非法（须为非空 argv 数组）`));
      }
      return ok({ type: "promote", source: value["source"], command: [...command] });
    }
    case "cite_t0": {
      const violation = rejectUndeclared(value, ["type", "source", "text"], path);
      if (violation !== null) return err(scenarioError(violation));
      if (!isNonEmptyString(value["source"])) return err(scenarioError(`${path}.source 非法（须为非空字符串）`));
      if (!isNonEmptyString(value["text"])) return err(scenarioError(`${path}.text 非法（须为非空字符串）`));
      return ok({ type: "cite_t0", source: value["source"], text: value["text"] });
    }
  }
};

const parseExpect = (value: unknown, path: string): Result<ScenarioExpect, ScenarioError> => {
  if (!isPlainObject(value)) return err(scenarioError(`${path} 不是 JSON 对象`));
  const violation = rejectUndeclared(
    value,
    ["outcome", "exit_code", "gate_status", "first_gate_status", "block_reason", "promoted", "replayable", "domain_refs_valid"],
    path,
  );
  if (violation !== null) return err(scenarioError(violation));
  const outcome = value["outcome"];
  if (outcome !== "completed" && outcome !== "approval_missing" && outcome !== "session_rejected") {
    return err(scenarioError(`${path}.outcome 非法（须为 completed | approval_missing | session_rejected）`));
  }
  const exitCode = value["exit_code"];
  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 78) {
    return err(scenarioError(`${path}.exit_code 非法（须为 0 | 1 | 78）`));
  }
  const gateish = (key: string): string | null => {
    const v = value[key];
    if (v === undefined) return null;
    if (v !== "pass" && v !== "blocked") return `${path}.${key} 非法（须为 pass | blocked）`;
    return null;
  };
  for (const key of ["gate_status", "first_gate_status"]) {
    const bad = gateish(key);
    if (bad !== null) return err(scenarioError(bad));
  }
  const blockReason = value["block_reason"];
  if (blockReason !== undefined && blockReason !== "approval_missing" && blockReason !== "t0_ref_forbidden") {
    return err(scenarioError(`${path}.block_reason 非法（须为 approval_missing | t0_ref_forbidden）`));
  }
  for (const key of ["promoted", "replayable", "domain_refs_valid"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return err(scenarioError(`${path}.${key} 非法（须为 boolean）`));
    }
  }
  const asGateStatus = (key: string): "pass" | "blocked" | undefined =>
    value[key] === "pass" || value[key] === "blocked" ? value[key] : undefined;
  const asBlockReason = (): "approval_missing" | "t0_ref_forbidden" | undefined =>
    blockReason === "approval_missing" || blockReason === "t0_ref_forbidden" ? blockReason : undefined;
  const asBool = (key: string): boolean | undefined => (typeof value[key] === "boolean" ? (value[key] as boolean) : undefined);
  const expect: ScenarioExpect = { outcome, exit_code: exitCode };
  if (asGateStatus("gate_status") !== undefined) expect.gate_status = asGateStatus("gate_status");
  if (asGateStatus("first_gate_status") !== undefined) expect.first_gate_status = asGateStatus("first_gate_status");
  if (asBlockReason() !== undefined) expect.block_reason = asBlockReason();
  if (asBool("promoted") !== undefined) expect.promoted = asBool("promoted");
  if (asBool("replayable") !== undefined) expect.replayable = asBool("replayable");
  if (asBool("domain_refs_valid") !== undefined) expect.domain_refs_valid = asBool("domain_refs_valid");
  return ok(expect);
};

const parseBranch = (branchId: string, value: unknown): Result<ScenarioBranch, ScenarioError> => {
  if (!isPlainObject(value)) return err(scenarioError(`branch ${branchId} 不是 JSON 对象`));
  const violation = rejectUndeclared(
    value,
    ["branch_id", "run_id", "trigger_instruction", "purpose", "setup", "steps", "expect"],
    `branch ${branchId}`,
  );
  if (violation !== null) return err(scenarioError(violation));
  if (value["branch_id"] !== branchId) {
    return err(scenarioError(`branch 键 "${branchId}" 与 branch_id "${String(value["branch_id"])}" 不一致`));
  }
  if (!isNonEmptyString(value["run_id"])) return err(scenarioError(`branch ${branchId}.run_id 非法`));
  if (!RUN_ID_PATTERN.test(value["run_id"])) {
    return err(scenarioError(`branch ${branchId}.run_id 非法（须匹配 ${RUN_ID_PATTERN.source}，防路径逃逸）`));
  }
  if (!isNonEmptyString(value["trigger_instruction"])) return err(scenarioError(`branch ${branchId}.trigger_instruction 非法`));
  if (!isNonEmptyString(value["purpose"])) return err(scenarioError(`branch ${branchId}.purpose 非法`));
  const setup = value["setup"];
  if (!isPlainObject(setup)) return err(scenarioError(`branch ${branchId}.setup 非法`));
  const setupViolation = rejectUndeclared(setup, ["ledger"], `branch ${branchId}.setup`);
  if (setupViolation !== null) return err(scenarioError(setupViolation));
  const ledger: LedgerPreRecord[] = [];
  if (setup["ledger"] !== undefined) {
    if (!Array.isArray(setup["ledger"])) return err(scenarioError(`branch ${branchId}.setup.ledger 非法（须为数组）`));
    for (let i = 0; i < setup["ledger"].length; i += 1) {
      const entry = setup["ledger"][i];
      if (!isPlainObject(entry)) return err(scenarioError(`branch ${branchId}.setup.ledger[${String(i)}] 不是 JSON 对象`));
      const entryViolation = rejectUndeclared(entry, ["tool", "params"], `branch ${branchId}.setup.ledger[${String(i)}]`);
      if (entryViolation !== null) return err(scenarioError(entryViolation));
      if (!isNonEmptyString(entry["tool"])) return err(scenarioError(`branch ${branchId}.setup.ledger[${String(i)}].tool 非法`));
      if (!isPlainObject(entry["params"])) return err(scenarioError(`branch ${branchId}.setup.ledger[${String(i)}].params 非法`));
      ledger.push({ tool: entry["tool"], params: entry["params"] });
    }
  }
  if (!Array.isArray(value["steps"]) || value["steps"].length === 0) {
    return err(scenarioError(`branch ${branchId}.steps 非法（须为非空数组）`));
  }
  const steps: ScenarioStep[] = [];
  for (let i = 0; i < value["steps"].length; i += 1) {
    const parsed = parseStep(value["steps"][i], `branch ${branchId}.steps[${String(i)}]`);
    if (!parsed.ok) return parsed;
    steps.push(parsed.value);
  }
  const expectResult = parseExpect(value["expect"], `branch ${branchId}.expect`);
  if (!expectResult.ok) return expectResult;
  return ok({
    branch_id: branchId,
    run_id: value["run_id"],
    trigger_instruction: value["trigger_instruction"],
    purpose: value["purpose"],
    setup: { ledger },
    steps,
    expect: expectResult.value,
  });
};

/** 场景脚本解析与严格校验（v1；占位符纪律：含 "<" 占位符的值在 parse 层不拒——真实值由 v1 文件给出）。 */
export const parseScenario = (value: unknown): Result<Scenario, ScenarioError> => {
  if (!isPlainObject(value)) return err(scenarioError("场景脚本不是 JSON 对象"));
  const violation = rejectUndeclared(value, ["scenario_id", "version", "provider", "description", "notes", "branches"], "scenario");
  if (violation !== null) return err(scenarioError(violation));
  if (!isNonEmptyString(value["scenario_id"])) return err(scenarioError("scenario_id 非法"));
  if (value["version"] !== SCENARIO_VERSION) {
    return err(scenarioError(`version 非法（期望 ${String(SCENARIO_VERSION)}，实得 ${String(value["version"])}）`));
  }
  if (value["provider"] !== "faux") return err(scenarioError('provider 非法（Phase 1 仅 "faux"）'));
  if (!isNonEmptyString(value["description"])) return err(scenarioError("description 非法"));
  if (!isPlainObject(value["branches"])) return err(scenarioError("branches 非法（须为对象映射）"));
  const branches: Record<string, ScenarioBranch> = {};
  for (const [branchId, branchValue] of Object.entries(value["branches"])) {
    const parsed = parseBranch(branchId, branchValue);
    if (!parsed.ok) return parsed;
    branches[branchId] = parsed.value;
  }
  const scenario: Scenario = {
    scenario_id: value["scenario_id"],
    version: 1,
    provider: "faux",
    description: value["description"],
    branches,
  };
  if (value["notes"] !== undefined) {
    if (!Array.isArray(value["notes"]) || value["notes"].some((note) => !isNonEmptyString(note))) {
      return err(scenarioError("notes 非法（须为字符串数组）"));
    }
  }
  return ok(scenario);
};
