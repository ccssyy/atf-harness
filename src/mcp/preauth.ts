/**
 * 前端三（MCP server 外壳）——写类工具预授权白名单（L1b B1，L1b-D1=A；
 * 《ATF-Harness_B1设计diff_MCP预授权白名单_20260916.md》owner 已确认）。
 *
 * 形态：缺省 `~/.atf-harness/mcp-preauth.json`（0600，与 llm.json 同范式；环境变量
 * `ATF_MCP_PREAUTH` 显式路径）；`{"schema_version":"McpPreauth/v1","hosts":[{"host_id,"tools":[…]}]}`。
 *
 * fail-closed 基线（任务书 §5）：文件缺失＝空白名单（缺省最严，非错误）；宽权限/坏
 * schema_version/解析失败/结构非法→一律视同空白名单（全部写动作拒绝）并留因。
 * host_id 取自 MCP clientInfo.name＝客户端自报身份（非强身份鉴别，仅约束宿主自动化
 * 行为——本地 stdio/D3 场景边界，docs 已注记）。
 */
import { stat, readFile } from "node:fs/promises";
export const MCP_PREAUTH_SCHEMA_VERSION = "McpPreauth/v1";

/** 预授权白名单（解析成功形态；空 hosts＝全拒绝）。 */
export interface McpPreauthConfig {
  hosts: ReadonlyArray<{ host_id: string; tools: readonly string[] }>;
}

/** 加载结果：config 恒可用（失败即空白名单）；failure 非空＝fail-closed 留因（stderr/审计用）。 */
export interface McpPreauthLoad {
  config: McpPreauthConfig;
  path: string;
  failure?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 加载并校验（缺省最严；任何异常折算空白名单，不抛出）。 */
export const loadMcpPreauth = async (path: string): Promise<McpPreauthLoad> => {
  const empty: McpPreauthConfig = { hosts: [] };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // 文件缺失＝空白名单（合法且最严，非 failure）；其余读取异常同样视同空白名单
    return { config: empty, path };
  }
  try {
    const statInfo = await stat(path);
    // 0600：组/其他位任何可读位存在即拒绝（umask 语义下 owner 位之外须为 0）
    if ((statInfo.mode & 0o077) !== 0) {
      return { config: empty, path, failure: `预授权配置权限过宽（须 0600，实得 ${String((statInfo.mode & 0o777).toString(8).padStart(3, "0"))}）——视同空白名单` };
    }
  } catch {
    return { config: empty, path, failure: "预授权配置 stat 失败——视同空白名单" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { config: empty, path, failure: `预授权配置解析失败: ${String(cause)}——视同空白名单` };
  }
  if (!isPlainObject(parsed)) return { config: empty, path, failure: "预授权配置不是 JSON 对象——视同空白名单" };
  if (parsed["schema_version"] !== MCP_PREAUTH_SCHEMA_VERSION) {
    return { config: empty, path, failure: `预授权配置 schema_version 非法（须 "${MCP_PREAUTH_SCHEMA_VERSION}"）——视同空白名单` };
  }
  const hostsRaw = parsed["hosts"];
  if (!Array.isArray(hostsRaw)) return { config: empty, path, failure: "预授权配置缺 hosts 数组——视同空白名单" };
  const hosts: Array<{ host_id: string; tools: readonly string[] }> = [];
  for (const entry of hostsRaw) {
    if (!isPlainObject(entry)) return { config: empty, path, failure: "hosts 项不是对象——视同空白名单" };
    const hostId = entry["host_id"];
    const tools = entry["tools"];
    if (typeof hostId !== "string" || hostId === "") return { config: empty, path, failure: "hosts 项 host_id 非法——视同空白名单" };
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool === "")) {
      return { config: empty, path, failure: "hosts 项 tools 非法——视同空白名单" };
    }
    hosts.push({ host_id: hostId, tools: tools as readonly string[] });
  }
  return { config: { hosts }, path };
};

/**
 * 写类工具判定（L1b-D1=A 确认版）：`atf_admit_data` ＋ `atf_gate(action=="advance")`。
 * 其余工具（只读查询/账本双方法/bind）不入预授权管辖。
 */
export const isWriteClassTool = (tool: string, params: unknown): boolean => {
  if (tool === "atf_admit_data") return true;
  if (tool === "atf_gate") {
    const action = isPlainObject(params) ? params["action"] : undefined;
    return action === "advance";
  }
  return false;
};

/** 白名单匹配：host_id 精确匹配 ∧ 工具名在 tools 列表（gate(advance) 以工具名 atf_gate 匹配）。 */
export const isPreauthorized = (config: McpPreauthConfig, hostId: string, tool: string): boolean => {
  const host = config.hosts.find((entry) => entry.host_id === hostId);
  return host !== undefined && host.tools.includes(tool);
};
