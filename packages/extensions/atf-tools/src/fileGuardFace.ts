/**
 * 批㊶-H/I——文件工具路径守卫＋A7 治理四件 DSH 挂载（案 甲：单轨收敛）。
 *
 * 三层防线（全部应用层，非 OS 边界——对用户与文档如实声明；OS 级沙箱本机结构性
 * 不可用＝批㊶E 项 4 定案不复话）：
 *   ① A7 治理四件（atf_read/atf_edit/atf_write/atf_bash）以 DSH defineTool 挂进
 *      atf-tools（toFileAgentTool 执行径零重写；白名单单源 resolveWhitelistedPath
 *      内建——read 免审直通，写类过守卫后免弹（F-H 分级：文件面边界由白名单恒开
 *      承担，档位只决定 OS 沙箱层有无））；
 *   ② vendor 无对应物三件（glob/grep/read_image）保留挂载，经宿主级
 *      `tools/pre-execute` waterfall（prepend）白名单守卫——越界返回一等
 *      `{kind:'deny'}` 决策（reason=file_path_outside_allowlist，附越界路径＋合法根
 *      ＋一行指引——可发现性三面之错误回流面）；
 *   ③ vendor read/edit/write 同经 pre-execute **恒 deny 带改道指引**（单轨收敛：
 *      能力由 A7 承接，vendor 通道保留挂载但封闭，防描述面继续暴露无边界读写）。
 *   atf_bash 另加命令串内绝对路径扫描（应用层策略，引号内不解析——如实声明非 OS 边界）。
 *
 * 白名单根＝派生集（fileRoots.ts 配置声明面镜像）＋env 附加集（ATF_V1_FILE_TOOL_ROOTS）；
 * 产品资产零具体目录（增补裁定——分层原则）。
 */
import { isAbsolute, join, resolve, sep } from "node:path";
import { toFileAgentTool, FILE_TOOL_DEFINITIONS, type FileToolHost } from "../../../../src/agent/fileTools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { translateParameters, asToolValue, looseObjectOutput } from "./schemaTranslate.js";

/** pre-execute 守卫的 vendor 工具名闭集。 */
export const PRE_EXECUTE_GUARDED_TOOLS: ReadonlySet<string> = new Set(["glob", "grep", "read_image"]);
/** 单轨封闭（恒 deny 带改道指引）的 vendor 工具名闭集——能力由 A7 四件承接。 */
export const VENDOR_REDIRECT_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);
/** A7 对应名（改道指引引用）。 */
const VENDOR_REDIRECT_TARGET: Readonly<Record<string, string>> = { read: "atf_read", edit: "atf_edit", write: "atf_write" };

/** 路径守卫拒绝码（H 段 1.3 结构化拒绝面）。 */
export const FILE_PATH_OUTSIDE_ALLOWLIST = "file_path_outside_allowlist";

/** pre-execute exec 的最小消费面（结构类型）。 */
interface GuardExec {
  name?: unknown;
  arguments?: unknown;
}

type PreExecuteListener = (exec: GuardExec, next: () => Promise<unknown>) => Promise<unknown>;

/** 守卫工具的路径参数提取（参数名闭集——read_image=file_path；glob/grep=path 可选）。 */
export const pathsFromPreExecuteArgs = (name: string, args: Record<string, unknown>): string[] => {
  const paths: string[] = [];
  const file_path = args["file_path"];
  const path = args["path"];
  if (name === "read_image" && typeof file_path === "string") paths.push(file_path);
  if ((name === "glob" || name === "grep") && typeof path === "string" && path.trim() !== "") paths.push(path);
  return paths;
};

/** 命令串内绝对路径记号提取（应用层 best-effort：`/` 开头连续非空白段；引号内不解析）。 */
export const absolutePathTokensFromCommand = (command: string): string[] => {
  const tokens: string[] = [];
  for (const token of command.split(/\s+/)) {
    if (token.length > 1 && token.startsWith("/")) tokens.push(token);
  }
  return tokens;
};

const insideRoot = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(root + sep);

/** 白名单成员判定（与 resolveWhitelistedPath 同根集；轻量路径版——不触 fs，供命令串扫描）。 */
export const pathOutsideRoots = (rawPath: string, roots: readonly string[]): boolean => {
  if (roots.length === 0) return true;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(roots[0] as string, rawPath));
  return !roots.some((root) => insideRoot(abs, root));
};

/**
 * pre-execute 路径守卫注册（prepend）：glob/grep/read_image 路径参数过白名单；
 * read/edit/write 恒 deny 带改道指引。越界拒绝码 file_path_outside_allowlist，
 * 消息含越界路径＋合法根清单＋一行指引（改用工作区相对路径或向用户申请）。
 * @returns 注册是否发生（ctx.on 缺席的裸装配面跳过）。
 */
export const registerPathGuard = (
  ctx: {
    on?: (event: string, listener: PreExecuteListener, options?: { prepend?: boolean }) => unknown;
  },
  host: FileToolHost,
): boolean => {
  if (typeof ctx.on !== "function") return false;
  const listener: PreExecuteListener = async (exec, next) => {
    const name = typeof exec?.name === "string" ? exec.name : "";
    const args = (exec?.arguments !== null && typeof exec?.arguments === "object" ? exec.arguments : {}) as Record<string, unknown>;
    if (VENDOR_REDIRECT_TOOLS.has(name)) {
      return {
        kind: "deny",
        reason: `${FILE_PATH_OUTSIDE_ALLOWLIST}: vendor ${name} 通道已单轨封闭——改用 ${VENDOR_REDIRECT_TARGET[name] ?? "atf_*"}（白名单治理面）`,
      };
    }
    if (PRE_EXECUTE_GUARDED_TOOLS.has(name)) {
      for (const rawPath of pathsFromPreExecuteArgs(name, args)) {
        if (pathOutsideRoots(rawPath, host.roots)) {
          return {
            kind: "deny",
            reason: `${FILE_PATH_OUTSIDE_ALLOWLIST}: ${rawPath} 越出白名单（合法根：${host.roots.join("；")}）——改用工作区相对路径，或将数据目录经 ${"ATF_V1_FILE_TOOL_ROOTS"} 声明后使用`,
          };
        }
      }
    }
    return next();
  };
  ctx.on("tools/pre-execute", listener, { prepend: true });
  return true;
};

/** atf_bash 命令串扫描（守卫面）：越界绝对路径记号 → 结构化拒绝。 */
export const bashCommandGuard = (command: unknown, roots: readonly string[]): { ok: true } | { ok: false; message: string } => {
  if (typeof command !== "string" || command === "") return { ok: true };
  for (const token of absolutePathTokensFromCommand(command)) {
    if (pathOutsideRoots(token, roots)) {
      return {
        ok: false,
        message: `${FILE_PATH_OUTSIDE_ALLOWLIST}: 命令引用白名单外绝对路径 ${token}（合法根：${roots.join("；")}）——改用工作区相对路径，或将数据目录经 ATF_V1_FILE_TOOL_ROOTS 声明后使用`,
      };
    }
  }
  return { ok: true };
};

/**
 * A7 四件 DSH 挂载（atf_read/atf_edit/atf_write/atf_bash）：toFileAgentTool 执行径
 * 零重写；atf_bash 先过命令串扫描。审批语义＝白名单守卫承担边界（无弹卡——F-H 分级
 * 「写=免弹」在白名单恒开前提下的产品化）。
 */
export const buildFileGuardTools = (host: FileToolHost): unknown[] =>
  FILE_TOOL_DEFINITIONS.map((definition) => {
    const agentTool = toFileAgentTool(definition, host);
    return defineTool({
      name: definition.name,
      description: definition.description,
      parameters: translateParameters(definition.parameters),
      output: {
        schema: looseObjectOutput,
        render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
      },
      async execute(args: Record<string, unknown>, exec: { callId?: string }) {
        if (definition.name === "atf_bash") {
          const scan = bashCommandGuard(args["command"], host.roots);
          if (!scan.ok) {
            return asToolValue({ ok: false, error: FILE_PATH_OUTSIDE_ALLOWLIST, tool: definition.name, message: scan.message });
          }
        }
        const result = await agentTool.execute(`dsh-${exec.callId ?? "call"}`, args);
        return asToolValue(result.details);
      },
    });
  });
