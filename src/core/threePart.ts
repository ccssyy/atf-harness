/**
 * 三段式错误文案统一模板（L1b B2，任务书 §2.2）：四个用户可见出口
 * （CLI／TUI／ACP result／MCP tool result）的错误与失败文案统一为
 * ①发生了什么（事实）→ ②原因（判据）→ ③用户可操作的修复方式。
 *
 * 纪律：文案只是展示层——不改变任何错误码/Result 语义/退出码；不得泄露凭据
 * （修复指引只引用配置路径与环境变量名，永不回显键值）。
 */

export interface ThreePartError {
  /** ①发生了什么（事实，含 fail-closed 标记等定性） */
  fact: string;
  /** ②原因（判据：缺什么/哪条规则命中） */
  cause: string;
  /** ③修复（用户可操作：补什么文件/环境变量/命令，含权限要求） */
  fix: string;
}

/** 单行压缩形态（ACP/MCP result 等单值字段用；段间以空格分隔）。 */
export const formatThreePartInline = (error: ThreePartError): string =>
  `①${error.fact} ②原因：${error.cause} ③修复：${error.fix}`;

/** 多行形态（CLI/TUI 终端输出用）。 */
export const formatThreePartLines = (error: ThreePartError): string =>
  `①${error.fact}\n②原因：${error.cause}\n③修复：${error.fix}`;

/** provider 配置加载失败的统一三段式（四出口同源；凭据零回显）。 */
export const providerConfigThreePart = (cause: string, configHint: string): ThreePartError => ({
  fact: "provider 配置加载失败（fail-closed），本次操作未执行",
  cause,
  fix: `检查 provider 配置：${configHint}；确认 api_key_env 指向的环境变量已设置且非空（凭据只经环境变量注入，不落文件）后重跑`,
});
