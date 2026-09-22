/**
 * 工具注册表（任务书 S3-1 / owner 口径 #5）：严格内置工具面，不暴露任意注册入口——
 * 工具面收敛由类型与构造共同强制，注册表外工具 = unknown_tool。
 * 批 3：工作区工具面（4 个，workspaceTools.ts 分册）经 createWithWorkspaceTools() 装配，
 * 仅 TUI/resume 使用；default 注册表（桥接方法面）不变。
 */
import { type Result } from "../../bridge/index.js";
import { toolError, type ToolError } from "./errors.js";
import { TOOL_DEFINITIONS, toModelVisible, type ModelVisibleTool, type ToolDefinition } from "./toolDefinition.js";
import { WORKSPACE_TOOL_DEFINITIONS } from "./workspaceTools.js";

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  private constructor(definitions: readonly ToolDefinition[]) {
    for (const definition of definitions) this.byName.set(definition.name, definition);
  }

  /** 内置注册表：恰为契约登记的桥接方法面工具（批 3 前全部工具）。 */
  public static createDefault(): ToolRegistry {
    return new ToolRegistry(TOOL_DEFINITIONS);
  }

  /** 批 3 工作区扩面：default ＋ 4 个本地工作区工具（不经桥接、契约零 diff）。 */
  public static createWithWorkspaceTools(): ToolRegistry {
    return new ToolRegistry([...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS]);
  }

  public get(name: string): Result<ToolDefinition, ToolError> {
    const definition = this.byName.get(name);
    if (definition === undefined) {
      return { ok: false, error: toolError("unknown_tool", `未注册工具: ${name}（工具面收敛：仅登记的工具）`, { registered: this.names() }) };
    }
    return { ok: true, value: definition };
  }

  public names(): string[] {
    return [...this.byName.keys()];
  }

  /** 全部工具的模型可见形态（白名单投影，内部字段一律不发）。 */
  public modelVisible(): ModelVisibleTool[] {
    return [...this.byName.values()].map(toModelVisible);
  }
}
