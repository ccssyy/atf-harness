/**
 * 文件面工具（4 个只读：run_list / report_read / metrics_compare / gpu_status）——
 * 逻辑零重写：直接复用 src/webui/readOnlyTools.ts 的纯函数（listRuns/queryNvidiaSmi），
 * DSH defineTool 包装＋结果 JSON 文本化。
 *
 * D81-B 会话作用域隔离（指令《ATF_指令_D81B_会话作用域隔离_20261023》§二）：
 * run 面三读具（run_list/report_read/metrics_compare）缺省只解析当前会话归属工作区的
 * runs 子目录（作用域解析单源 scopeFace.ts）；跨任务查看走 scope 显式参数＋既有
 * approvalFace 审批（不另造通道），拒绝即零返回；归属缺失 fail-closed 空＋指引，
 * 禁回落全局扫描。atf_gpu_status 与 run 面无关（GPU 状态本就全局），零作用域语义。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRuns, queryNvidiaSmiProbed, gpuOfflinePayload, queryNvidiaSmiAll, queryGpuComputeApps } from "../../../../src/webui/readOnlyTools.js";
import { buildCardOccupancyTable, formatCardTable } from "./gpuQueueFace.js";
import { resolveRunDir } from "../../../../src/core/workspace/runLayout.js";
import { registeredWorkspaceRoots } from "../../../../src/core/workspace/workspaceRegistry.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import {
  SCOPE_PARAM_DESCRIPTION,
  SCOPE_UNRESOLVED_NOTE,
  collectAllRunGroups,
  listTrueRuns,
  resolveExplicitWorkspace,
  resolveSessionWorkspace,
  scopeOutOfWorkspaceNote,
  sessionCwdOfExec,
  workspaceRunsDir,
  workspaceRunsDirMissingNote,
  type WorkspaceScope,
} from "./scopeFace.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";

/** 作用域装配依赖（index.ts apply 注入审批 ctx；测试注入 dshHome）。ctx 缺席＝跨任务
 *  通道审批服务不可达（fail-closed 拒绝），缺省作用域（current）不受影响。 */
export interface FileToolScopeDeps {
  /** DSH 插件 ctx（approval seam 消费）——scope 跨任务审批唯一通道。 */
  ctx?: { get(service: string): unknown };
  /** DSH 家覆盖（测试注入注册表根；缺省 env DSH_HOME → ~/.dsh 解析链）。 */
  dshHome?: string;
}

/** metrics_summary 读取（readOnlyTools 内部逻辑的同款复用——读文件 JSON，缺/坏 → null）。
 *  runsBase 传 runs 目录基准（本区＝归属工作区 runs 子目录；跨任务＝runs 根）。 */
const readMetrics = (runsBase: string, runId: string, canonicalRoots?: readonly string[]): Record<string, unknown> | null => {
  // 批㊶Q增补三 段3：run 目录双形态解析（平铺存量＋分桶新形态兼容）
  const path = join(resolveRunDir(runsBase, runId, { canonicalRoots }), "report", "metrics_summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** 注册工作区根清单（resolveRunDir canonical 档——跨任务全局面解析用；单源在 registry）。 */
const canonicalRootsOf = (dshHome: string | undefined): string[] => registeredWorkspaceRoots(dshHome);

/** 跨任务 scope 审批（既有 approvalFace 单通道——E5 四行模板；ctx 缺席＝unavailable fail-closed）。 */
const approveScopeOrDeny = async (
  deps: FileToolScopeDeps | undefined,
  exec: { agent?: unknown; callId?: string; signal?: unknown },
  toolName: string,
  scopeLabel: string,
): Promise<{ ok: true } | { ok: false; result: Record<string, unknown> }> => {
  if (deps?.ctx === undefined) {
    return { ok: false, result: approvalDeniedResult(toolName, "unavailable") };
  }
  const verdict = await requestApproval(
    deps.ctx,
    exec,
    toolName,
    buildApprovalReason({
      action: "跨任务读取 run 面",
      target: `（scope=${scopeLabel}）`,
      effect: "只读枚举/读取其他任务工作区的 run 清单、报告与 metrics（不写盘；本次放行仅一次，再次跨任务需重新确认）",
      reversible: "只读操作（零写盘、零删除）",
    }),
  );
  if (!verdict.ok) return { ok: false, result: approvalDeniedResult(toolName, verdict.outcome) };
  return { ok: true };
};

/** 跨任务 scope 参数解析（"all" 或显式工作区路径/id；解析失败＝null→指路回执）。 */
const resolveCrossScope = (scopeRaw: unknown, deps: FileToolScopeDeps | undefined): { label: string; workspace: WorkspaceScope | null } => {
  if (typeof scopeRaw === "string" && scopeRaw !== "" && scopeRaw !== "all" && scopeRaw !== "current") {
    return { label: scopeRaw, workspace: resolveExplicitWorkspace(scopeRaw, { dshHome: deps?.dshHome }) };
  }
  return { label: "all", workspace: null }; // all＝runs 根全量（不锚定单一工作区）
};

export const buildFileTools = (runsRoot: string, scopeDeps?: FileToolScopeDeps): unknown[] => [
  defineTool({
    name: "atf_run_list",
    description:
      "枚举当前会话归属工作区内的 run（只读，缺省作用域）：返回各 run 的 run_id/状态/最近产物清单，用于『查看历史 run/总结训练/继续某个训练』等请求。" +
      "缺省只列本工作区 runs 子目录（workspace/runs/ 与 runs/ 双布局）中的真实 run，其他任务的历史 run 与杂项不出现在缺省结果中。" +
      "跨任务查看需显式传 scope（代价：触发用户审批；\"all\" 全量分组或给目标工作区绝对路径/注册 id）。" +
      "会话未归属工作区时返回空并给指引（不回落全局扫描）。",
    parameters: {
      scope: { type: "string", description: SCOPE_PARAM_DESCRIPTION },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { scope?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const scopeRaw = args?.scope;
      const cwd = sessionCwdOfExec(exec);
      // 跨任务显式通道（scope=all / 显式工作区）：审批 → 全量分组（本任务/历史任务）
      if (typeof scopeRaw === "string" && scopeRaw !== "" && scopeRaw !== "current") {
        const cross = resolveCrossScope(scopeRaw, scopeDeps);
        if (cross.workspace === null && cross.label !== "all") {
          return asToolValue({
            scope: scopeRaw,
            runs: [],
            count: 0,
            error: "workspace_not_found",
            note: `显式 scope 未解析到工作区（${scopeRaw}）——请给工作区根的绝对路径，或 DSH 注册表中的工作区 id`,
          });
        }
        const gate = await approveScopeOrDeny(scopeDeps, exec, "atf_run_list", cross.label);
        if (!gate.ok) return asToolValue(gate.result);
        const current = resolveSessionWorkspace(cwd, { dshHome: scopeDeps?.dshHome });
        // 分组视角锚点：显式工作区＝该工作区（scope 透传生效）；all＝当前归属工作区
        const perspective = cross.workspace ?? current;
        const groups = collectAllRunGroups(runsRoot, perspective);
        const runs = groups.flatMap((group) => group.runs);
        return asToolValue({
          scope: cross.label,
          workspace: perspective !== null ? { workspace_id: perspective.workspaceId, path: perspective.root } : null,
          groups,
          runs,
          count: runs.length,
          approval: "allowed-once",
          note:
            cross.workspace !== null
              ? "跨任务视图（经用户审批）：以 scope 指定工作区为「本任务」视角，runs 按「本任务／历史任务」分组标注"
              : "跨任务视图（经用户审批）：runs 按「本任务／历史任务」分组标注",
        });
      }
      // 缺省作用域（current）：只看本区——归属缺失 fail-closed 空＋指引，禁回落全局扫描
      const current = resolveSessionWorkspace(cwd, { dshHome: scopeDeps?.dshHome });
      if (current === null) {
        return asToolValue({ scope: "current", workspace: null, runs: [], count: 0, note: SCOPE_UNRESOLVED_NOTE });
      }
      const runsDir = workspaceRunsDir(current.root);
      if (runsDir === null) {
        return asToolValue({
          scope: "current",
          workspace: { workspace_id: current.workspaceId, path: current.root },
          runs: [],
          count: 0,
          note: workspaceRunsDirMissingNote,
        });
      }
      const runs = listTrueRuns(runsDir, current.root);
      return asToolValue({
        scope: "current",
        workspace: { workspace_id: current.workspaceId, path: current.root },
        runs,
        count: runs.length,
      });
    },
  }),
  defineTool({
    name: "atf_report_read",
    description:
      "读 run 报告（只读）：runs/<run_id>/report/report.md 或指定段 segment-<n>.md。入参 run_id 必填、segment 可选（缺省读 report.md 全文）。" +
      "缺省只在本会话归属工作区的 runs 子目录内解析 run_id；run 属于其他任务时给出跨任务指引——需显式传 scope（触发用户审批）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（runs 目录名）" },
      segment: { type: "number", description: "段号（缺省读 report.md 全文）" },
      scope: { type: "string", description: SCOPE_PARAM_DESCRIPTION },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { run_id: string; segment?: number; scope?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const rel = args.segment === undefined ? "report/report.md" : `report/segment-${String(args.segment)}.md`;
      const scopeRaw = args?.scope;
      // 跨任务显式通道：审批 → 全局面解析（canonical 注册根 ∪ runs 根平铺）
      if (typeof scopeRaw === "string" && scopeRaw !== "" && scopeRaw !== "current") {
        const cross = resolveCrossScope(scopeRaw, scopeDeps);
        if (cross.workspace === null && cross.label !== "all") {
          return asToolValue({
            run_id: args.run_id,
            exists: false,
            error: "workspace_not_found",
            note: `显式 scope 未解析到工作区（${scopeRaw}）——请给工作区根的绝对路径，或 DSH 注册表中的工作区 id`,
          });
        }
        const gate = await approveScopeOrDeny(scopeDeps, exec, "atf_report_read", cross.label);
        if (!gate.ok) return asToolValue(gate.result);
        const path = join(resolveRunDir(runsRoot, args.run_id, { canonicalRoots: canonicalRootsOf(scopeDeps?.dshHome) }), rel);
        if (!existsSync(path)) return asToolValue({ run_id: args.run_id, path: rel, exists: false, note: "报告不存在（该 run 无此段记录）" });
        return asToolValue({ run_id: args.run_id, path: rel, exists: true, scope: cross.label, text: readFileSync(path, "utf8").slice(0, 8000) });
      }
      // 缺省作用域（current）：本区解析；越界给跨任务指引（不静默回落）
      const current = resolveSessionWorkspace(sessionCwdOfExec(exec), { dshHome: scopeDeps?.dshHome });
      if (current === null) {
        return asToolValue({ run_id: args.run_id, exists: false, error: "scope_unresolved", note: SCOPE_UNRESOLVED_NOTE });
      }
      const runsDir = workspaceRunsDir(current.root);
      // 本区解析：canonical 档只给当前工作区根（RunLayout/v3 实验树
      // `<ws>/experiments/<exp>/<run_id>`）——不塞全量注册根，否则跨区 run 会不经审批被读到。
      const inScopeDir = resolveRunDir(runsDir ?? runsRoot, args.run_id, { canonicalRoots: [current.root] });
      if (runsDir !== null && existsSync(inScopeDir)) {
        const path = join(inScopeDir, rel);
        if (!existsSync(path)) return asToolValue({ run_id: args.run_id, path: rel, exists: false, note: "报告不存在（该 run 无此段记录）" });
        return asToolValue({ run_id: args.run_id, path: rel, exists: true, text: readFileSync(path, "utf8").slice(0, 8000) });
      }
      // 不在本区：区分「越界（全局面在）」与「确实不存在」——越界回流带显式跨任务指引
      const globalDir = resolveRunDir(runsRoot, args.run_id, { canonicalRoots: canonicalRootsOf(scopeDeps?.dshHome) });
      if (existsSync(join(globalDir, "report"))) {
        return asToolValue({ run_id: args.run_id, exists: false, error: "scope_out_of_workspace", note: scopeOutOfWorkspaceNote });
      }
      return asToolValue({ run_id: args.run_id, path: rel, exists: false, note: "报告不存在（该 run 无此段记录）" });
    },
  }),
  defineTool({
    name: "atf_metrics_compare",
    description:
      "两轮 metrics_summary 对比（只读）：run_a/run_b 必填。任一轮缺 metrics_summary.json 时如实报『无可比轮次』（不造数）。" +
      "缺省只在本会话归属工作区的 runs 子目录内解析两个 run；run 属于其他任务时给出跨任务指引——需显式传 scope（触发用户审批）。",
    parameters: {
      run_a: { type: "string", required: true, description: "对比左侧 run 标识" },
      run_b: { type: "string", required: true, description: "对比右侧 run 标识" },
      scope: { type: "string", description: SCOPE_PARAM_DESCRIPTION },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { run_a: string; run_b: string; scope?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const scopeRaw = args?.scope;
      // 跨任务显式通道：审批 → 全局面读取
      if (typeof scopeRaw === "string" && scopeRaw !== "" && scopeRaw !== "current") {
        const cross = resolveCrossScope(scopeRaw, scopeDeps);
        if (cross.workspace === null && cross.label !== "all") {
          return asToolValue({
            comparable: false,
            error: "workspace_not_found",
            note: `显式 scope 未解析到工作区（${scopeRaw}）——请给工作区根的绝对路径，或 DSH 注册表中的工作区 id`,
          });
        }
        const gate = await approveScopeOrDeny(scopeDeps, exec, "atf_metrics_compare", cross.label);
        if (!gate.ok) return asToolValue(gate.result);
        const roots = canonicalRootsOf(scopeDeps?.dshHome);
        const a = readMetrics(runsRoot, args.run_a, roots);
        const b = readMetrics(runsRoot, args.run_b, roots);
        return asToolValue(buildMetricsCompareResult(a, b, [args.run_a, args.run_b], cross.label));
      }
      // 缺省作用域（current）：本区解析；越界与不存在分流回流（不静默回落）
      const current = resolveSessionWorkspace(sessionCwdOfExec(exec), { dshHome: scopeDeps?.dshHome });
      if (current === null) {
        return asToolValue({ comparable: false, error: "scope_unresolved", note: SCOPE_UNRESOLVED_NOTE });
      }
      const runsDir = workspaceRunsDir(current.root);
      const inScope = (runId: string): boolean => runsDir !== null && existsSync(join(runsDir, runId));
      const outOfScope = [args.run_a, args.run_b].filter((runId) => !inScope(runId));
      if (outOfScope.length > 0) {
        // 全局面也不存在的 run 按「无可比轮次」如实回流（不误导为跨任务越界）
        const globalExist = (runId: string): boolean =>
          existsSync(resolveRunDir(runsRoot, runId, { canonicalRoots: canonicalRootsOf(scopeDeps?.dshHome) }));
        if (outOfScope.every((runId) => !globalExist(runId))) {
          const a = inScope(args.run_a) ? readMetrics(runsDir as string, args.run_a) : null;
          const b = inScope(args.run_b) ? readMetrics(runsDir as string, args.run_b) : null;
          return asToolValue(buildMetricsCompareResult(a, b, [args.run_a, args.run_b], "current"));
        }
        return asToolValue({ comparable: false, error: "scope_out_of_workspace", missing: outOfScope, note: scopeOutOfWorkspaceNote });
      }
      const a = readMetrics(runsDir as string, args.run_a);
      const b = readMetrics(runsDir as string, args.run_b);
      return asToolValue(buildMetricsCompareResult(a, b, [args.run_a, args.run_b], "current"));
    },
  }),
  defineTool({
    name: "atf_gpu_status",
    description: "GPU 状态（只读，nvidia-smi 包装）：全卡利用率/显存/进程归属（空闲/常驻/训练三态逐卡表＋占用进程摘要；归属判定＝compute-apps 进程，非显存阈值）。nvidia-smi 不可用时报 gpu_offline（不猜测）。",
    parameters: {},
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute() {
      const view = await queryNvidiaSmiProbed();
      // D88-A：展示面不判致命性——只用探针状态选文案（「探测超时」≠「不可达」）。
      if (view.gpu === null) return asToolValue(gpuOfflinePayload(view.probe));
      // 批㊶-W F6 ⑤：全卡状态表＋归属（compute-apps 不可得＝归属面如实 unavailable，不猜测）
      const [cards, apps] = await Promise.all([queryNvidiaSmiAll(), queryGpuComputeApps()]);
      const table = cards !== null ? buildCardOccupancyTable(cards, apps ?? []) : [];
      const tableText = cards !== null ? formatCardTable(table) : null;
      return asToolValue({ gpu_offline: false, ...view.gpu, card_table: table, card_table_text: tableText, ownership_available: apps !== null });
    },
  }),
];

/** metrics 对比结果组装（缺料如实报『无可比轮次』——不造数；D81-B 增 scope 标注）。 */
const buildMetricsCompareResult = (
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
  runIds: [string, string],
  scope: string,
): Record<string, unknown> => {
  if (a === null || b === null) {
    return {
      comparable: false,
      scope,
      note: "无可比轮次",
      missing: [a === null ? runIds[0] : null, b === null ? runIds[1] : null].filter(Boolean),
    };
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const diff: Record<string, { a: unknown; b: unknown }> = {};
  for (const key of keys) diff[key] = { a: a[key], b: b[key] };
  return { comparable: true, scope, diff };
};
