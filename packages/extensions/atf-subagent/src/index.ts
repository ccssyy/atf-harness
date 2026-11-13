/**
 * @atf/dsh-atf-subagent —— ATF 训练子任务派发三件套的会话级 plugin（C1，1113 验证轮）。
 *
 * B 批教训锁（1112-2/1113 实锚）：dispatch 三件此前装在 harness WebUiSessionManager
 * （eval 驱动器专用入口），真机 web 进程从不加载它——本包把三件装进 vendor 原生
 * preset plugin 体系（atf-training 预设 plugins 清单挂载），验收锚真机路径。
 *
 * 形态适配：subagent.ts 工厂产物是 pi-agent-core AgentTool（harness loop 内部约定，
 * execute(toolCallId, params)）；vendor 工具面是 dsh-tools ToolDefinition（execute(args, exec)
 * 返回 canonical 值）。本包只做签名/结果包装——派发、fan-out、GateLock 串行、结果聚合
 * 全部复用工厂 execute（逻辑零复制，测真实实现）；schema 由 JSON Schema 方言直译为
 * DSH 参数表（照 atf-tools schemaTranslate 同款直译子集）。
 *
 * 治理面接线（残留三题收敛，1113-2 会话定位批）：
 * - 账本域锚（原 scopeRefBox 空 box 残留）：dispatch 执行时惰性解析会话工作区
 *   （sessionCwdOfExec→resolveSessionWorkspace，身份文件单源）→ 经 workspace 域桥接
 *   连接调 atf_workspace_status 取 scope_ref 填 box（与 harness 线同一回填机制
 *   atfAgentTools.ts）——子任务经 runChildSubtask 的 Object.assign 继承同域；解析失败
 *   降级留痕，子任务首写被 approvalHook 指路自愈（atf_workspace_status 填子任务自己的
 *   box，既有 fail-closed 语义不变）。桥接代理路由到同一域连接（atf.bind_workspace 绑定，
 *   与主线 atf_* 工具同池）。
 * - 审批卡单源（原 hand-rolled 适配残留）：surface 经 atf-tools requestApproval
 *   （approvalFace）走 vendor approval 服务——与主线 atf_* 工具同一通路同一词汇
 *   （callId/signal/displayReason 全量）；outcome→verdict 映射 fail-保守。
 * - 锁域（定性收窄）：子任务间 GateLock 串行 ✓（approvalHook gateLock.run 包裹审批段）；
 *   主线↔子任务仅 deferred spawn（fire-and-forget）场景可交叠——两路账本异流且内核
 *   Approval Ledger append-only，无配对损坏；残留＝可能同时弹卡（UX 面，记录不修）。
 * - 主线 scopeRefBox 无 harness 装配对应物 → 不再依赖主线：本包自持 box 并在派发时
 *   主动填充（结构性残留的替代解，非等待主线接线）。
 * @module @atf/dsh-atf-subagent
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createChildInstructionRunner,
  createDispatchParallelTrainingSubtaskTool,
  createDispatchTrainingSubtaskTool,
  type SubagentDeps,
} from "../../../../src/agent/subagent.js";
import { createGateLock } from "../../../../src/agent/approvalHook.js";
import { createDeferredToolSet } from "../../../../src/agent/deferredTools.js";
import type { ApprovalSurface, ApprovalSurfaceVerdict } from "../../../../src/agent/approvalSurface.js";
import type { ScopeRef } from "../../../../src/core/tools/approvalKey.js";
import { createProviderStreamFn } from "../../../../src/agent/providerStreamFn.js";
import { loadLlmProviderConfig } from "../../../../src/llm/providerConfig.js";
import { createFauxStreamFn, fauxAssistantMessage } from "../../../../src/agent/fauxStream.js";
import type { SpikeBridgeTransport } from "../../../../src/agent/atfAgentTools.js";
import type { BridgeError } from "../../../../src/bridge/index.js";
import { requestApproval } from "../../atf-tools/src/approvalFace.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeManagerSlot } from "../../atf-tools/src/index.js";
import { resolveSessionWorkspace, sessionCwdOfExec } from "../../atf-tools/src/scopeFace.js";

export const name = "atf-subagent";
export const inject = ["tools"];

/** workspace 域桥接连接（atf.bind_workspace 绑定形态；与主线 atf_* 工具同池）。 */
interface ScopedConnection {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

/** atf-tools 暴露的实例级桥接管理器（ctx.atfBridgeManager——index.ts 挂载）。 */
interface BridgeManagerLike {
  transport(): Promise<ScopedConnection>;
  transportForWorkspace(workspacePath: string): Promise<ScopedConnection>;
}

/** DSH 属性 spec 直译子集（对齐 atf-tools schemaTranslate 的 DshPropertySpec 同款）。 */
type DshPropertySpec =
  | { type: "string"; description?: string; required?: true }
  | { type: "json"; description?: string; required?: true }
  | { type: "integer"; description?: string; required?: true }
  | { type: "number"; description?: string; required?: true }
  | { type: "boolean"; description?: string; required?: true };

/** JSON Schema 方言 → DSH 参数表（直译；未知类型如实抛错不猜——契约漂移宁可加载失败）。 */
const translateParams = (schema: unknown): Record<string, DshPropertySpec> => {
  const node = (schema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: unknown };
  const requiredList = Array.isArray(node.required) ? (node.required as unknown[]) : [];
  const out: Record<string, DshPropertySpec> = {};
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const description = typeof prop["description"] === "string" ? prop["description"] : undefined;
    const base = { ...(description !== undefined ? { description } : {}), ...(requiredList.includes(key) ? { required: true as const } : {}) };
    switch (prop["type"]) {
      case "string":
        out[key] = { type: "string", ...base };
        break;
      case "integer":
        out[key] = { type: "integer", ...base };
        break;
      case "number":
        out[key] = { type: "number", ...base };
        break;
      case "boolean":
        out[key] = { type: "boolean", ...base };
        break;
      case "object":
      case "array":
        out[key] = { type: "json", ...base };
        break;
      default:
        throw new Error(`[atf-subagent] 参数 ${key} 类型 ${JSON.stringify(prop["type"])} 不在直译闭集（fail-closed）`);
    }
  }
  return out;
};

/** 通用输出（与 atf-tools 桥接工具同款：loose object＋JSON 文本渲染——几行通用件自带）。 */
const looseObjectOutput = { type: "object", additionalProperties: true } as const;
const renderAsJsonText = (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
  { type: "text", text: JSON.stringify(value, null, 1) },
];

/** content text → JSON 解析（失败回执 error 面提取；非 JSON 返回 null）。 */
const safeParseObj = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const safeParseJson = safeParseObj;

/** execute 返回收口：递归清洗为无损 JSON（DSH output 校验拒收 undefined 等非 lossless
 *  值——与 atf-tools asToolValue 同口径，几行通用件自带）。 */
const asToolValue = (value: unknown): Record<string, never> => {
  const clean = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (item !== undefined) out[k] = clean(item);
      }
      return out;
    }
    return v;
  };
  return clean(value) as Record<string, never>;
};

/** vendor approval outcome → harness surface verdict（requestApproval verdict 映射；
 *  fail-保守：未知 outcome 落 suspended 非否决——未决不猜授权）。 */
export const surfaceVerdictFromApproval = (
  verdict: { ok: true } | { ok: false; outcome?: string },
): ApprovalSurfaceVerdict => {
  if (verdict.ok) return { kind: "granted" };
  switch (verdict.outcome) {
    case "rejected":
      return { kind: "denied" };
    case "cancelled":
      return { kind: "aborted" };
    default:
      return { kind: "suspended" };
  }
};

/**
 * 账本域锚惰性填充（C1-① 收敛）：从执行上下文解析会话工作区（身份文件单源），经
 * workspace 域桥接连接调 atf_workspace_status 取 scope_ref 填 box——与 harness 线
 * 同一回填机制（atf_workspace_status 响应 .scope_ref → box，atfAgentTools.ts 同款）。
 * 已填/已建连接则幂等跳过；解析失败返回 false 并由调用方 warn（子任务首写被
 * approvalHook 指路自愈——既有 fail-closed 语义不变）。
 *
 * :param box: plugin 自持的 scopeRefBox（子任务派发时经 runChildSubtask 继承）。
 * :param manager: atf-tools 实例级桥接管理器（workspace 域连接池单源）。
 * :param exec: dsh 工具执行上下文（agent.session.header.cwd 为会话工作区）。
 * :return: 是否成功取得 scope_ref（连接已建但本次未取到也算 false——不重复尝试）。
 */
export const ensureScopeRef = async (
  box: { current: ScopeRef | undefined },
  manager: BridgeManagerLike,
  exec: unknown,
): Promise<boolean> => {
  if (box.current !== undefined) return true;
  const workspace = resolveSessionWorkspace(sessionCwdOfExec(exec));
  if (workspace === null) return false;
  const conn = await manager.transportForWorkspace(workspace.root);
  const response = await conn.request("atf_workspace_status", {});
  if (!response.ok) return false;
  const scopeRef = (response.value as { scope_ref?: ScopeRef } | null)?.scope_ref;
  if (scopeRef === undefined || scopeRef === null) return false;
  box.current = scopeRef;
  return true;
};

export async function apply(ctx: unknown, _config: unknown): Promise<void> {
  const c = ctx as {
    tools: { register(tool: unknown): void };
    get(service: string): unknown;
  };
  // —— 前置依赖 fail-loud（可观测降级＝不注册三件，boot 日志留痕；不静默）——
  // manager 经 atf-tools 模块级槽共享（cordis ctx 拒绝裸 set——真机 boot 实锚）。
  const manager = bridgeManagerSlot.current as BridgeManagerLike | null;
  if (manager === null) {
    console.warn("[atf-subagent] ⚠ bridgeManagerSlot 缺席（atf-tools 未挂载或未填充）——dispatch 三件不注册（fail-closed）");
    return;
  }
  const sessionsRoot = process.env.ATF_WEBUI_SESSIONS_ROOT;
  if (sessionsRoot === undefined || sessionsRoot === "") {
    console.warn("[atf-subagent] ⚠ ATF_WEBUI_SESSIONS_ROOT 未设置——dispatch 三件不注册（本环境非 WebUI 实例形态）");
    return;
  }
  // —— 账本域锚：plugin 自持 box + 会话级域连接（惰性解析，dispatch 执行时填充）——
  const scopeRefBox: { current: ScopeRef | undefined } = { current: undefined };
  let scopedConn: Promise<ScopedConnection> | null = null;
  let scopedRoot: string | null = null;
  let scopeWarned = false;
  const ensureScope = async (exec: unknown): Promise<void> => {
    if (scopeRefBox.current !== undefined) return;
    try {
      const workspace = resolveSessionWorkspace(sessionCwdOfExec(exec));
      if (workspace === null) {
        if (!scopeWarned) {
          console.warn("[atf-subagent] ⚠ 会话工作区解析失败（cwd 缺席或非注册工作区）——子任务账本域锚缺席，子任务首写将按既有 fail-closed 指路自愈");
          scopeWarned = true;
        }
        return;
      }
      if (scopedRoot === null) scopedRoot = workspace.root;
      if (scopedConn === null) scopedConn = manager.transportForWorkspace(workspace.root);
      const conn = await scopedConn;
      const response = await conn.request("atf_workspace_status", {});
      if (response.ok) {
        const scopeRef = (response.value as { scope_ref?: ScopeRef } | null)?.scope_ref;
        if (scopeRef !== undefined && scopeRef !== null) scopeRefBox.current = scopeRef;
      }
    } catch (cause) {
      // 域锚失败不阻断派发（子任务首写按既有 fail-closed 指路自愈）——warn 一次可观测
      scopedConn = null;
      if (!scopeWarned) {
        console.warn(`[atf-subagent] ⚠ 账本域锚解析失败（${cause instanceof Error ? cause.message : String(cause)}）——降级为子任务自愈路径`);
        scopeWarned = true;
      }
    }
  };
  // 桥接代理：域连接已建则路由之（子任务账本调用与主线 atf_* 工具同池同域）；
  // 未建走默认连接（eval 线等价形态——子任务自己的 atf_workspace_status 可再锚）。
  const bridge: SpikeBridgeTransport = {
    request: async (method, params) => {
      const conn = scopedConn !== null ? await scopedConn : await manager.transport();
      return conn.request(method, params);
    },
  };
  // —— 子任务模型面（ATF_LLM_CONFIG 独立装配；缺席 faux 降级留痕）——
  let childStreamFn: () => unknown;
  let childModel: unknown;
  let modelTag: string;
  const resolved = await loadLlmProviderConfig(process.env);
  if (resolved.ok) {
    const cfg = resolved.value;
    const assembled = createProviderStreamFn({
      provider_id: cfg.provider_id,
      model: cfg.model,
      base_url: cfg.base_url,
      api_key: cfg.api_key,
    });
    childStreamFn = () => assembled.streamFn;
    childModel = assembled.model;
    modelTag = cfg.model;
  } else {
    console.warn(`[atf-subagent] ⚠ LLM 配置解析失败（${resolved.error.message}）——子任务模型面降级 faux（主线模型不受影响）`);
    childStreamFn = () =>
      createFauxStreamFn([
        fauxAssistantMessage(
          [{ type: "text", text: "子任务模型宿主未配置（ATF_LLM_CONFIG）——请配置 Provider 后重试。" }],
          "stop",
        ),
      ]);
    modelTag = "webui";
  }
  // —— 审批继承（C1-③ 收敛）：经 atf-tools requestApproval 走 vendor approval 服务——
  // 与主线 atf_* 工具同一通路同一词汇（callId/signal/displayReason 全量；outcome
  // "allowed-once" 语义单源）。主线 agent 从 dsh exec.agent 绑定：vendor UI answerer
  // 只应答自己拥有的 agent，工具 execute 的 exec.agent 是唯一可靠绑定点——wrapper 先
  // 赋值再放行工厂 execute，子任务内 ask 时序必然晚于赋值。
  const executionBox: { agent: unknown } = { agent: undefined };
  const surface: ApprovalSurface = {
    ask: async (info) => {
      const verdict = await requestApproval(
        c,
        { agent: executionBox.agent },
        info.tool,
        `子任务内写动作确认（dispatch 派发链——继承同一操作员面）：${info.tool}`,
      );
      return surfaceVerdictFromApproval(verdict);
    },
  };
  // —— D293：工单装载器（workorders_path 形态）——工单文件解析+页图定位+白名单
  // 校验+base64 组装全部工具内单源；agent 只传 workorders_path+source_root 两个
  // 路径，切片与看图注入零自由度。图路径白名单=会话工作区根（scopedConn 解析锚）。
  const workordersLoader = async (
    workordersPath: string,
    sourceRoot: string,
  ): Promise<Array<{ instruction: string; label?: string; images?: unknown[] }>> => {
    if (scopedRoot === null) {
      throw new Error("会话工作区未解析（cwd 非注册工作区？）——workorders_path 形态需工作区锚，先重试或给绝对路径");
    }
    const wsRoot: string = scopedRoot;
    const resolveInWorkspace = (given: string): string => {
      if (given.startsWith("/")) {
        if (!given.startsWith(wsRoot)) {
          throw new Error(`路径越出会话工作区（${given} 不在 ${wsRoot} 内）——工单/页图必须在工作区内`);
        }
        return given;
      }
      return join(wsRoot, given);
    };
    const doc = JSON.parse(readFileSync(resolveInWorkspace(workordersPath), "utf8")) as {
      doc_type?: unknown;
      // 字段名实锚=内核 _parallel_doc 的 workorders（首实现凭想当然写 waves=真机全 0 失败，
      // mock/自造形状教训第 5 次）。D294 共用工单装载（双形态，按字段存在识别不绑业务段）：
      //   A workorders 型——LabelQcParallelWorkorders/v1 等（每片自带 instruction/pages，
      //     页名=标注 JSON 名→stem 定位同名图+同名标注内容随片文本注入）
      //   B VisualSamplePlan/v1——版式聚类抽样计划（pages[].{page,path,wave}+source，
      //     按 wave 分组切片；看图作用=验证聚类簇语义+采集 FieldVisualSignals/v1 视觉信号）
      workorders?: Array<{ label?: unknown; pages?: unknown; instruction?: unknown; images?: unknown[] }>;
      pages?: Array<{ page?: unknown; path?: unknown; wave?: unknown }>;
      source?: unknown;
      how_to_use?: unknown;
    };
    let workorders: Array<{ instruction: string; label?: string; pages?: string[]; images?: unknown[] }>;
    const isVisualSamplePlan = Array.isArray(doc.pages) && doc.pages.length > 0 && !Array.isArray(doc.workorders);
    if (isVisualSamplePlan) {
      // 形态 B：pages 按 wave 分组切片，页图读 pages[].path（内核已给确定性真名路径），
      // 产出合同=FieldVisualSignals/v1（信号闭集+coverage——style_split 视觉闸与倍数建议共用输入）
      const planSource = typeof doc.source === "string" ? doc.source : "";
      if (planSource === "") throw new Error("VisualSamplePlan/v1 缺 source 字段——页图定位需要标注源根");
      const planRoot = resolveInWorkspace(planSource);
      const byWave = new Map<number, Array<{ page: string; path: string }>>();
      for (const entry of doc.pages as Array<{ page?: unknown; path?: unknown; wave?: unknown }>) {
        const pageName = typeof entry.page === "string" ? entry.page : "";
        const pagePath = typeof entry.path === "string" ? entry.path : "";
        if (pageName === "" || pagePath === "") continue;
        const waveNo = typeof entry.wave === "number" ? entry.wave : 1;
        const bucket = byWave.get(waveNo) ?? [];
        bucket.push({ page: pageName, path: pagePath });
        byWave.set(waveNo, bucket);
      }
      if (byWave.size === 0) throw new Error("VisualSamplePlan/v1 无可用页（pages 全部缺 page/path）");
      const signalsContract =
        "输出 JSON：{pages:[{page,signals:[页级闭集:layout_style_mixed|table_irregular|wireframe_misaligned|dense_table|scan_skew|print_blur|noise_heavy|watermark_overlay]}],"
        + "fields:[{field_id,signals:[字段闭集:multi_line|multi_value|stamp|handwriting|tiny_text|overlap_obscured],evidence:[{page,note:该页观察}]}],"
        + "coverage:{pages_reviewed:[已实际看过的页文件名数组],pages_remaining:未看页数,incomplete_reason:可选}}——"
        + "闭集权威=scripts/visual_signals.py;coverage 必报,未看完如实报 pages_remaining";
      workorders = [...byWave.entries()].map(([waveNo, pages], index) => ({
        instruction:
          `版式判读任务(版式聚类并行片 ${String(index + 1)}/${String(byWave.size)},来源根 ${planSource}):`
          + "逐页查看所附页面图片——这些页已被版式聚类算法按视觉签名分为同类,你的任务是确认簇语义并采集视觉信号:"
          + "每页记录页级信号(版式混杂/表格不规则/线框错位/密表/扫描倾斜/打印模糊/噪点重/水印遮挡,无则空数组);"
          + "登记字段在页上的视觉表现记录字段级信号(多行/多值/印章/手写/小字/遮挡)与图面观察;"
          + "若发现某页与其他页明显不同类,在 note 里指明——聚类语义错误的页单独标记。"
          + signalsContract,
        label: `style-wave-${String(waveNo)}`,
        pages: pages.map((p) => p.page),
        images: pages.map((p) => {
          const imagePath = resolveInWorkspace(p.path);
          const ext = imagePath.slice(imagePath.lastIndexOf(".") + 1).toLowerCase();
          const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
          return { type: "image", data: readFileSync(imagePath).toString("base64"), mimeType };
        }),
      }));
    } else {
      workorders = (doc.workorders ?? []).map((entry) => ({
        instruction: typeof entry.instruction === "string" ? entry.instruction : "",
        label: typeof entry.label === "string" && entry.label !== "" ? entry.label : undefined,
        pages: Array.isArray(entry.pages) ? (entry.pages as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
      }));
    }
    if (!Array.isArray(workorders) || workorders.length === 0) {
      throw new Error("工单文件无 workorders（共用工单形态:workorders 数组,每片 label/pages/instruction——确认产出段已导出并行工单）");
    }
    const docType = typeof doc.doc_type === "string" && doc.doc_type !== "" ? doc.doc_type : "";
    const batchRoot = resolveInWorkspace(sourceRoot);
    return workorders.map((wave, index) => {
      // 双形态：形态 B 元素已带 images（loader 前段组装）——直接通过；形态 A 走下方组装
      if (Array.isArray(wave.images) && wave.images.length > 0) {
        return {
          instruction: typeof wave.instruction === "string" ? wave.instruction : "",
          label: typeof wave.label === "string" && wave.label !== "" ? wave.label : `wave-${String(index + 1)}`,
          images: wave.images,
        };
      }
      const instruction = typeof wave.instruction === "string" ? wave.instruction : "";
      if (instruction === "") throw new Error(`工单片 ${String(index)} 缺 instruction`);
      const label = typeof wave.label === "string" && wave.label !== "" ? wave.label : `wave-${String(index + 1)}`;
      const pages = Array.isArray(wave.pages) ? (wave.pages as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const images: unknown[] = [];
      const annotationSections: string[] = [];
      for (const page of pages) {
        // 工单页名=标注 JSON 文件名（1113-4 真机实锚 page 以 .json 结尾）——页图=去
        // .json 后缀的同名图片文件；命中结果必须落在图片后缀闭集（同名 .json 标注跳过）
        const stem = page.endsWith(".json") ? page.slice(0, -".json".length) : page;
        const dir = docType !== "" ? join(batchRoot, docType) : batchRoot;
        let imageFile: string | null = null;
        try {
          const hit = readdirSync(dir).find((name) => {
            const candidate = name === stem ? name : name.startsWith(stem + ".") ? name : null;
            if (candidate === null) return false;
            const ext = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
            return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp";
          });
          if (hit !== undefined) imageFile = join(dir, hit);
        } catch {
          /* 目录不存在→保持 null 走统一缺图报错 */
        }
        if (imageFile === null) {
          throw new Error(`工单片 ${label} 页 ${page} 的图片文件定位失败（找 ${dir}/${page}.*）——确认 source_root 与工单页名一致`);
        }
        const ext = imageFile.slice(imageFile.lastIndexOf(".") + 1).toLowerCase();
        const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
        images.push({ type: "image", data: readFileSync(imageFile).toString("base64"), mimeType });
        // D293b：标注内容随片注入（看图核查=标注值 vs 图面值比对——子 agent 无文件读取
        // 工具，同名 .json 8-12KB/页文本注入，比对依赖不缺、零工具依赖）
        const annotationFile = join(dir, stem + ".json");
        try {
          annotationSections.push(`== 标注文件 ${page} ==\n` + readFileSync(annotationFile, "utf8"));
        } catch {
          // 同名标注缺席=工单 page 名与盘上形态不一致——图已注入，标注缺席可观测
          annotationSections.push(`== 标注文件 ${page} ==（缺席——值比对项无法完成，按缺料如实记）`);
        }
      }
      const fullInstruction =
        (annotationSections.length > 0
          ? "【该片各页标注内容（box 坐标与抄录值——与所附页图逐项比对）】\n"
            + annotationSections.join("\n\n") + "\n\n【派发指令】\n"
          : "") + instruction;
      return { instruction: fullInstruction, label, ...(images.length > 0 ? { images } : {}) };
    });
  };
  const deps: SubagentDeps = {
    bridge,
    sessionsRoot,
    scopeRefBox,
    surface,
    workordersLoader,
    childStreamFn: childStreamFn as () => never,
    ...(childModel !== undefined ? { childModel: childModel as SubagentDeps["childModel"] } : {}),
    modelTag,
    // GateLock 显式自挂（verdict 首轮 FAIL 实锚：「工厂自挂」系误记——自动创建点只在
    // headless 线 cli.ts，plugin 不传即无锁，并行子任务审批临界段不串行）。本锁覆盖
    // plugin 派发的全部子任务执行体；主线 vendor agent 审批段不在锁域（deferred spawn
    // 场景可交叠——两路账本异流且内核 Approval Ledger append-only，无配对损坏；残留＝
    // 可能同时弹卡，UX 面记录不修）。
    gateLock: createGateLock(),
  };
  // —— dsh-tools 包装：签名/结果转换零逻辑复制（工厂 execute 内的参数校验、fan-out、
  // GateLock 串行、聚合全量复用）；AgentTool 返回 {content, details}，canonical 值取
  // details（SubtaskResult / 并行聚合形态）。执行前惰性填充账本域锚（子任务继承）。——
  const dshToolOf = (agentTool: AgentTool): unknown =>
    defineTool({
      name: agentTool.name,
      description: agentTool.description,
      parameters: translateParams(agentTool.parameters),
      output: { schema: looseObjectOutput, render: renderAsJsonText },
      async execute(args: unknown, exec: { agent?: unknown }) {
        const agent = (exec as { agent?: unknown } | undefined)?.agent;
        if (agent !== undefined) executionBox.agent = agent;
        await ensureScope(exec);
        const outcome = (await (agentTool.execute as (id: string, p: unknown) => Promise<unknown>)("atf-subagent", args)) as {
          content?: Array<{ type?: string; text?: string }>;
          details?: unknown;
        };
        // 失败 detail 保留：工厂失败形态 error 在 content[0].text、details 只有 {ok:false}
        // （1113-2 真机「Failed without detail」根因——wrapper 此前只透传 details，error 全丢）。
        // details 缺失或无 error 字段时从 content text 解析合并，canonical 值对 agent 完整。
        const text = outcome.content?.find((block) => block.type === "text")?.text;
        const details = outcome.details ?? (text !== undefined ? safeParseJson(text) : undefined);
        const merged =
          details !== null && typeof details === "object" && (details as { error?: unknown }).error === undefined && text !== undefined
            ? { ...(details as Record<string, unknown>), ...(safeParseObj(text) ?? {}) }
            : details;
        return asToolValue(merged ?? outcome);
      },
    });
  const { tools: deferredTools } = createDeferredToolSet(createChildInstructionRunner(deps));
  const registered: string[] = [];
  for (const agentTool of [
    createDispatchTrainingSubtaskTool(deps),
    createDispatchParallelTrainingSubtaskTool(deps),
    ...deferredTools,
  ]) {
    c.tools.register(dshToolOf(agentTool));
    registered.push(agentTool.name);
  }
  console.log(`[atf-subagent] 已装配 dispatch 三件套（${registered.join(" / ")}；会话级 plugin——真机 WebUI 工具面；sessionsRoot=${sessionsRoot}）`);
}
