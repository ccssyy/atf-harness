#!/usr/bin/env node
/**
 * 前端三（MCP server 外壳）——stdio 入口（L1 门 2 T05）。
 *
 * 形态：本进程 = MCP server，MCP 客户端（WorkBuddy / 编码 Agent / 冒烟 client）经
 * JSON-RPC 2.0 over stdio 挂载（本地 stdio 唯一，D3；跨机走 SSH stdio 桥时客户端侧
 * 仍是本机 stdio）。会话以 atf_bind_run 为界；授权按 D4 口径留痕（不放宽闸门）；
 * 终局退出码编码进 tool result。
 *
 * 运行：
 *   node dist/mcp/main.js [--runs-root <dir>] [--mock <桥接 serve 脚本>]
 *        [--scope-mode canonical|simulation] [--project-id <id>]
 *
 * 红线：stdout 是协议通道——非协议输出一律 stderr；本壳不发起任何 LLM 调用
 * （模型/额度归客户端自管），无 provider 配置依赖。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPeer } from "../rpc/index.js";
import { McpShell } from "./shell.js";
import { MCP_LATEST_VERSION } from "./protocol.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultMockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const defaultRunsRoot = join(repoRoot, "tmp", "mcp-runs");

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const runsRoot = argValue("--runs-root") ?? defaultRunsRoot;
const mockPath = argValue("--mock") ?? defaultMockPath;
const scopeModeArg = argValue("--scope-mode");
const projectId = argValue("--project-id");

if (scopeModeArg !== undefined && scopeModeArg !== "canonical" && scopeModeArg !== "simulation") {
  console.error(`[atf-mcp] --scope-mode 非法: ${scopeModeArg}（允许 canonical|simulation）`);
  process.exit(1);
}
mkdirSync(runsRoot, { recursive: true });

const shell = new McpShell({
  runsRoot,
  mockCommand: ["node", mockPath],
  ...(scopeModeArg !== undefined ? { scopeMode: scopeModeArg as "canonical" | "simulation" } : {}),
  ...(projectId !== undefined ? { projectId } : {}),
});

const peer = RpcPeer.create({
  input: process.stdin,
  output: process.stdout,
  onRequest: shell.handleRequest,
  onNotification: (method) => shell.handleNotification(method),
});
peer.start();
console.error(`[atf-mcp] server 就绪（MCP ${MCP_LATEST_VERSION}；runs-root=${runsRoot}）`);

