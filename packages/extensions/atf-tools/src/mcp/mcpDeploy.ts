/**
 * G5 MCP 切换——MCP 对端装配单源（阶段 1 落位 atf-tools；阶段 3 删 src/bridge 时
 * 承接 resolveBridgeDeployment 的 webui/atf-ui 消费面并迁移）。
 *
 * ATF_DSH_BRIDGE_COMMAND 语义随批变更（任务书路标）：MCP 后＝启动内核 MCP server
 * 的命令串（缺省派生 `python3 -m agentic_training_flow.mcp`，PYTHONPATH 从 kernelDir
 * 探测派生）；前导 KEY=VALUE 词法仍作子进程私有 env。mock 判定沿旧口径：显式 env
 * 缺席且命令指向 mock 夹具＝mock。mock 夹具自 G5 起双协议（首帧 initialize → MCP）。
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface McpDeployment {
  /** mock＝夹具对端；real＝内核 MCP server。 */
  mode: "mock" | "real";
  /** 子进程 argv（前导 KEY=VALUE 词法已剥入 childEnv）。 */
  argv: readonly string[];
  /** 子进程私有 env 增量（仅合并于 spawn，不进 process.env）。 */
  childEnv: Readonly<Record<string, string>>;
}

/** 引号感知分词（与旧 bridgeCommand 同款：env 值可含空格路径）。 */
const tokenizeRespectingQuotes = (value: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of value) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") tokens.push(current);
      current = "";
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

/** 前导 KEY=VALUE 词法解析：环境前缀剥入 env，余词为 argv。 */
export const parseCommandWithEnvPrefix = (value: string): { argv: string[]; env: Record<string, string> } => {
  const env: Record<string, string> = {};
  const argv: string[] = [];
  for (const token of tokenizeRespectingQuotes(value)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (match !== null && argv.length === 0) {
      env[match[1] as string] = match[2] ?? "";
      continue;
    }
    argv.push(token);
  }
  return { argv, env };
};

/** PYTHONPATH 候选内核根：首个路径段；basename=src 取上级（内核仓 src 布局）。 */
const kernelRootFromPythonpath = (pythonpath: string): string | null => {
  const first = pythonpath.split(":").map((p) => p.trim()).find((p) => p !== "");
  if (first === undefined) return null;
  return basename(first) === "src" ? first.slice(0, first.lastIndexOf("/")) || first : first;
};

/**
 * MCP 对端装配解析（纯函数）。
 * @param inputs.commandValue - atf-tools Config.bridgeCommand 解析值（env 缺省已兜底）。
 * @param inputs.kernelDir - 内核目录（PYTHONPATH 派生源）。
 * @param inputs.env - 进程 env（ATF_DSH_BRIDGE_COMMAND 在场＝真内核注入路径）。
 * @param inputs.mockCommand - mock 夹具 argv（缺省 node tests/fixtures/mock_atf.mjs）。
 * @param inputs.probe - 目录在位探测（缺省 existsSync；测试注桩）。
 */
export const resolveMcpDeployment = (
  inputs: {
    commandValue: string;
    kernelDir: string;
    env: Readonly<Record<string, string | undefined>>;
    mockCommand?: readonly string[];
    probe?: (path: string) => boolean;
  },
): McpDeployment => {
  const probe = inputs.probe ?? ((path: string) => existsSync(path));
  const mockMode =
    (inputs.env["ATF_DSH_BRIDGE_COMMAND"] === undefined || inputs.env["ATF_DSH_BRIDGE_COMMAND"]!.trim() === "") &&
    inputs.commandValue.includes("mock_atf.mjs");
  if (mockMode) {
    const mock = inputs.mockCommand ?? ["node", join(process.cwd(), "tests", "fixtures", "mock_atf.mjs")];
    const parsed = parseCommandWithEnvPrefix(inputs.commandValue);
    // mock 形态沿用命令串原样（夹具 argv 语义不变）
    return { mode: "mock", argv: parsed.argv.length > 0 ? parsed.argv : mock, childEnv: parsed.env };
  }
  const { argv, env: prefixEnv } = parseCommandWithEnvPrefix(inputs.commandValue);
  if (argv.length === 0) {
    const mock = inputs.mockCommand ?? ["node", join(process.cwd(), "tests", "fixtures", "mock_atf.mjs")];
    return { mode: "mock", argv: mock, childEnv: {} };
  }
  let pythonpath = prefixEnv["PYTHONPATH"];
  if (pythonpath === undefined) {
    if (probe(join(inputs.kernelDir, "src", "agentic_training_flow"))) {
      pythonpath = join(inputs.kernelDir, "src");
    } else if (probe(join(inputs.kernelDir, "agentic_training_flow"))) {
      pythonpath = inputs.kernelDir;
    }
  }
  return {
    mode: "real",
    argv,
    childEnv: pythonpath !== undefined ? { ...prefixEnv, PYTHONPATH: pythonpath } : prefixEnv,
  };
};

/** 内核 MCP server 启动命令派生（CLI 直调形态：cwd=kernelDir）。 */
export const kernelMcpArgv = (kernelDir: string): string[] => ["-m", "agentic_training_flow.mcp"];

/** kernelRootFromPythonpath 对外（boot 日志用）。 */
export const kernelRootOf = (deployment: McpDeployment, kernelDir: string): string | null => {
  const pythonpath = deployment.childEnv["PYTHONPATH"];
  return pythonpath !== undefined ? kernelRootFromPythonpath(pythonpath) : kernelDir;
};
