/**
 * 批㊶-E-H 项 2.1——桥对端装配单源（env 注入从口头变机制）。
 *
 * ATF_DSH_BRIDGE_COMMAND 在场＝真内核对端（argv 自命令串解析；前导 KEY=VALUE 词法
 * 作为**桥子进程私有 env**——PYTHONPATH 即此注入，不污 web 进程面）；缺席＝mock 对端
 * （开发态零扰）。显式 PYTHONPATH 缺席时从内核目录派生（内核仓 src 布局：<kernelDir>/src，
 * 探测 agentic_training_flow 包在位才注入——派生不出不猜，握手期错误如实回流）。
 * 消费方：packages/extensions/atf-tools（装配）与 atf-ui（徽标注入）——两插件同进程同
 * env，共用本单源防分叉。内核版本面（批㊶-ISO-2 S2）＝boot 行以 bridge 握手实载版本为准
 * （probeBridgeHandshakeVersionSync）；`git describe --tags`（kernelVersionSync）降交叉核对
 * 项——fail-soft null（徽标面沿 describe，如实降级为无版本）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { encodeRequestFrame } from "./frames.js";

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

// 批㊶-ISO-2 S2——boot 桥版本行实载化（先实锚：现行版本行＝kernelVersionSync 读 pin worktree
// 的 git describe，疑非 serve 进程实载——门1件 §一.S2 审计：live 进程 env 无 PYTHONPATH 指
// pin，实测解析系统 site-packages＝0.4.2b1 与 pin 脱钩）。修复＝版本显示以 bridge 握手
// （atf.version 的 version 字段——serve 进程实载版本，契约面现成）为准；describe 降交叉
// 核对项，不一致双显＋warning。

/** 桥版本面（boot 版本行输入——握手实载为准＋describe 交叉核对）。 */
export interface BridgeBootVersionSurface {
  /** 握手实载版本（atf.version→version）；握手不可达＝null。 */
  handshake: string | null;
  /** 握手失败摘要（code: message 摘要——版本行如实标注「未证实实载」）。 */
  handshakeError: string | null;
  /** git describe 交叉核对值（pin 工作树标签；不可用＝null）。 */
  describe: string | null;
  /** 握手 vs describe 不一致告警（一致/不可比＝null——双显＋warning 文案）。 */
  mismatchWarning: string | null;
}

/**
 * 桥握手版本探针（同步——boot 装配面 apply() 为同步函数；spawnSync 一次性喂 atf.version
 * 帧、读首行响应、对端读 EOF 自退）。探针为只读诊断：不写任何状态、不触碰在途进程。
 * 失败 fail-soft（handshakeError 留因）——boot 版本行降级为 describe 未核对显示。
 */
export const probeBridgeHandshakeVersionSync = (deployment: BridgeDeployment, timeoutMs = 8_000): BridgeBootVersionSurface => {
  const describe = kernelVersionSync(deployment.kernelRoot);
  let handshake: string | null = null;
  let handshakeError: string | null = null;
  if (deployment.argv.length > 0) {
    const encoded = encodeRequestFrame({ type: "request", id: 1, method: "atf.version" });
    if (encoded.ok) {
      try {
        const run = spawnSync(deployment.argv[0] as string, deployment.argv.slice(1), {
          input: encoded.value,
          timeout: timeoutMs,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          ...(Object.keys(deployment.childEnv).length > 0 ? { env: { ...process.env, ...deployment.childEnv } } : {}),
        });
        const firstLine = (run.stdout ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
        try {
          const frame = JSON.parse(firstLine) as { type?: string; ok?: boolean; result?: { version?: unknown } };
          const version = frame.result?.["version"];
          if (frame.type === "response" && frame.ok === true && typeof version === "string" && version !== "") {
            handshake = version;
          } else {
            handshakeError = `handshake_failed:响应帧非 atf.version 结果（${firstLine.slice(0, 120)}）`;
          }
        } catch {
          handshakeError = `handshake_failed:首行非合法帧（${firstLine.slice(0, 120) || "空"}；stderr 头：${(run.stderr ?? "").slice(0, 120)}）`;
        }
      } catch (cause) {
        handshakeError = `spawn_failed:${String(cause).slice(0, 160)}`;
      }
    } else {
      handshakeError = `protocol_error:${encoded.error.message}`;
    }
  }
  // v 前缀双侧归一（内核 __version__ 无 v、describe tag 带 v；mock 对端自带 v 前缀亦归一）
  const norm = (s: string): string => s.replace(/^v/, "");
  const mismatchWarning =
    handshake !== null && describe !== null && norm(handshake) !== norm(describe)
      ? `⚠ 版本源不一致（以握手实载为准）：describe=${describe} vs 实载=${handshake}——serve 进程载荷与 pin 工作树标签脱钩（查桥命令 PYTHONPATH 注入链／re-pin 残留）`
      : null;
  return { handshake, handshakeError, describe, mismatchWarning };
};

/** boot 版本行文本（握手实载为准；握手不可达如实降级为 describe 未核对——不假报实载）。 */
export const formatBridgeBootVersionText = (surface: BridgeBootVersionSurface | null): string => {
  if (surface === null) return "版本未知（非 real 对端）";
  if (surface.handshake !== null) {
    if (surface.describe === null) return `${surface.handshake}（握手实载）`;
    return surface.mismatchWarning !== null
      ? `${surface.handshake}（握手实载；describe=${surface.describe} 不一致——以实载为准）`
      : `${surface.handshake}（握手实载；describe 交叉核对一致）`;
  }
  const why = surface.handshakeError !== null ? surface.handshakeError.slice(0, 80) : "探针不可用";
  return surface.describe !== null
    ? `describe=${surface.describe}（握手不可达——${why}；实载未证实）`
    : `版本未知（握手不可达——${why}；describe 亦不可用）`;
};
