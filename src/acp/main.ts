#!/usr/bin/env node
/**
 * 前端二（ACP agent 外壳）——stdio 入口（L1 门 2 T04）。
 *
 * 形态：本进程 = ACP agent（server 端），宿主/客户端（acpx@0.15.1、编辑器、冒烟
 * client）经 JSON-RPC 2.0 over stdio 驱动（传输层 src/rpc/，手写 D8）。治理语义全在
 * core（同进程直连）；宿主应答按 D4 B＋C 留痕；授权仅 allow_once/reject_once（D5）。
 *
 * 运行：
 *   node dist/acp/main.js [--runs-root <dir>] [--mock <桥接 serve 脚本>] [--scope-mode <mode>]
 *
 * 红线：stdout 是协议通道——任何非协议输出一律走 stderr；provider 配置经
 * ATF_LLM_CONFIG 注入（沿用 L1a），加载失败 fail-closed 退出（stderr 报因）。
 * ADR-07：宿主"自动应答"对本壳授权请求只是宿主自己的设置（D4 C：显式预授权），
 * 我方闸门与账本一次性消费语义不受影响。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLlmProviderConfig } from "../llm/index.js";
import { formatThreePartLines, providerConfigThreePart } from "../core/index.js";
import { RpcPeer } from "../rpc/index.js";
import { AcpShell } from "./shell.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultMockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const defaultRunsRoot = join(repoRoot, "tmp", "acp-runs");

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const runsRoot = argValue("--runs-root") ?? defaultRunsRoot;
const mockPath = argValue("--mock") ?? defaultMockPath;
const scopeModeArg = argValue("--scope-mode");

// provider 配置 fail-closed 前置（沿用 L1a；stdout 恒净——错误走 stderr）
const config = await loadLlmProviderConfig(process.env);
if (!config.ok) {
  console.error(`[atf-acp] ${formatThreePartLines(providerConfigThreePart(config.error.message, "配置文件经 ATF_LLM_CONFIG 指定（两层清单，0600）"))}`);
  process.exit(1);
}
if (scopeModeArg !== undefined && scopeModeArg !== "headless" && scopeModeArg !== "canonical" && scopeModeArg !== "simulation") {
  console.error(`[atf-acp] --scope-mode 非法: ${scopeModeArg}（允许 headless|canonical|simulation）`);
  process.exit(1);
}
mkdirSync(runsRoot, { recursive: true });

let peerRef: RpcPeer | undefined;
const shell = new AcpShell({
  // 传输面间接层：peer 在 shell 之后创建（onRequest 指向 shell handler）
  peer: {
    request: async (method, params) => {
      const peer = peerRef;
      if (peer === undefined) return { ok: false, error: { code: -32000, message: "传输面未就绪" } };
      return await peer.request(method, params);
    },
    notify: (method, params) => {
      peerRef?.notify(method, params);
    },
  },
  runsRoot,
  mockCommand: ["node", mockPath],
  providerConfig: config.value,
  ...(scopeModeArg !== undefined ? { scopeMode: scopeModeArg as "canonical" | "simulation" | "headless" } : {}),
});
const peer = RpcPeer.create({
  input: process.stdin,
  output: process.stdout,
  onRequest: shell.handleRequest,
  onNotification: shell.handleNotification,
  // 客户端断开（stdin end/close）：退出（ACP 会话的桥接连接随各 prompt 收口，无常驻句柄）
  onPeerClose: () => {
    process.exit(0);
  },
});
peerRef = peer;
peer.start();
console.error(`[atf-acp] agent 就绪（ACP v1；runs-root=${runsRoot}）`);
