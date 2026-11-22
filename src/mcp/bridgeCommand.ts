/**
 * G5 MCP 对端装配单源（src/mcp/bridgeCommand.ts——承接旧 src/bridge/bridgeCommand.ts
 * 的部署解析与版本交叉核对消费面；旧 JSONL 桥与 atf.version 握手已退役）。
 *
 * ATF_DSH_BRIDGE_COMMAND 语义（G5 起）＝启动内核 MCP server 的命令串：argv 自命令串
 * 解析，前导 KEY=VALUE 词法作子进程私有 env（PYTHONPATH 即此注入）；缺席＝mock 对端
 * （tests/fixtures/mock_atf.mjs，G5 起双协议——首帧 initialize 探测进 MCP 面）。
 * 消费方：packages/extensions/atf-tools（装配）、src/webui/server.ts（会话装配）、
 * atf-ui（徽标注入）——三插件同进程同 env，共用本单源防分叉。
 */
import { execFileSync } from "node:child_process";
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

/** 旧消费面（webui/atf-ui）的形态名——与 McpDeployment 同构（G5 承接位）。 */
export type BridgeDeployment = McpDeployment;

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

/** 内核版本（`git -C <root> describe --tags`；fail-soft null——非 git 目录/超时/无 tag 如实降级）。 */
export const kernelVersionSync = (kernelRoot: string | null, timeoutMs = 3_000): string | null => {
  if (kernelRoot === null) return null;
  try {
    const out = execFileSync("git", ["-C", kernelRoot, "describe", "--tags"], { timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
    const tag = out.toString("utf8").trim();
    return tag !== "" ? tag : null;
  } catch {
    return null;
  }
};

/** kernelRootFromPythonpath 对外（boot 日志用）。 */
export const kernelRootOf = (deployment: McpDeployment, kernelDir: string): string | null => {
  const pythonpath = deployment.childEnv["PYTHONPATH"];
  return pythonpath !== undefined ? kernelRootFromPythonpath(pythonpath) : kernelDir;
};
