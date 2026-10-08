/**
 * 批㊶-E-H 项 2.1——桥对端装配单源（env 注入从口头变机制）。
 *
 * ATF_DSH_BRIDGE_COMMAND 在场＝真内核对端（argv 自命令串解析；前导 KEY=VALUE 词法
 * 作为**桥子进程私有 env**——PYTHONPATH 即此注入，不污 web 进程面）；缺席＝mock 对端
 * （开发态零扰）。显式 PYTHONPATH 缺席时从内核目录派生（内核仓 src 布局：<kernelDir>/src，
 * 探测 agentic_training_flow 包在位才注入——派生不出不猜，握手期错误如实回流）。
 * 消费方：packages/extensions/atf-tools（装配）与 atf-ui（徽标注入）——两插件同进程同
 * env，共用本单源防分叉。内核版本面＝内核目录 `git describe --tags`（pin 工作树为
 * tagged 提交即精确 tag），fail-soft null（徽标如实降级为无版本）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface BridgeDeployment {
  /** mock＝缺省开发对端；real＝env/配置显式指真内核。 */
  mode: "mock" | "real";
  /** 桥子进程 argv（前导 KEY=VALUE 词法已剥入 childEnv）。 */
  argv: readonly string[];
  /** 桥子进程私有 env 增量（仅合并于 spawn，不进 process.env）。 */
  childEnv: Readonly<Record<string, string>>;
  /** 内核源根（PYTHONPATH 推导／kernelDir——git describe 与徽标版本的数据源；mock 为 null）。 */
  kernelRoot: string | null;
}

/** 引号感知分词：成对单/双引号内空白不切分、引号本身剥除（env 值可含空格路径）。 */
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
    } else {
      current += ch;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

/** 前导 KEY=VALUE 词法解析：环境前缀剥入 env（值可引号包空白），余词为 argv。 */
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
  return basename(first) === "src" ? dirnameOf(first) : first;
};

const dirnameOf = (p: string): string => {
  const at = p.lastIndexOf("/");
  return at <= 0 ? p : p.slice(0, at);
};

/**
 * 桥对端装配解析（纯函数——fs 探测可注入）。
 * mode 判定事实源＝最终将 spawn 的命令串：指向 mock 夹具（mock_atf.mjs）即 mock；
 * env 在场或显式配置真内核命令即 real——两条注入路径（env 覆写／profile Config）同判。
 * @param inputs.commandValue - atf-tools Config.bridgeCommand 解析值（env 缺省已由 Config 兜底）。
 * @param inputs.kernelDir - 内核目录（atf-tools Config.kernelDir 同源值）。
 * @param inputs.env - 进程 env（ATF_DSH_BRIDGE_COMMAND 在场＝真内核注入路径一）。
 * @param inputs.probe - 目录在位探测（缺省 existsSync；测试注入桩）。
 */
export const resolveBridgeDeployment = (
  inputs: {
    commandValue: string;
    kernelDir: string;
    env: Readonly<Record<string, string | undefined>>;
    probe?: (path: string) => boolean;
  },
): BridgeDeployment => {
  const probe = inputs.probe ?? ((path: string) => existsSync(path));
  const { argv, env: prefixEnv } = parseCommandWithEnvPrefix(inputs.commandValue);
  const mockMode = (inputs.env["ATF_DSH_BRIDGE_COMMAND"] === undefined || inputs.env["ATF_DSH_BRIDGE_COMMAND"]!.trim() === "") && inputs.commandValue.includes("mock_atf.mjs");
  if (mockMode || argv.length === 0) {
    return { mode: "mock", argv, childEnv: prefixEnv, kernelRoot: null };
  }
  let pythonpath = prefixEnv["PYTHONPATH"];
  let kernelRoot = pythonpath !== undefined ? kernelRootFromPythonpath(pythonpath) : null;
  if (pythonpath === undefined) {
    // 派生：内核仓 src 布局优先（<kernelDir>/src），包直挂 kernelDir 兜底——探测在位才注入
    if (probe(join(inputs.kernelDir, "src", "agentic_training_flow"))) {
      pythonpath = join(inputs.kernelDir, "src");
      kernelRoot = inputs.kernelDir;
    } else if (probe(join(inputs.kernelDir, "agentic_training_flow"))) {
      pythonpath = inputs.kernelDir;
      kernelRoot = inputs.kernelDir;
    }
  }
  if (kernelRoot === null) kernelRoot = inputs.kernelDir;
  return {
    mode: "real",
    argv,
    childEnv: pythonpath !== undefined ? { ...prefixEnv, PYTHONPATH: pythonpath } : prefixEnv,
    kernelRoot,
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
