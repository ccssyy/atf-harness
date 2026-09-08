#!/usr/bin/env node
/**
 * 契约忠实 mock 对端（bridge.contract.yaml v1 的内核侧实现）——仅 harness 测试基建，非内核代码。
 * 行为：stdin 逐行读 request 帧 → 回 response 帧（id 回显）；atf.version 返回握手结果，
 * 其他方法一律 ok=false / method_not_found；stdin 关闭 → 退出码 0（配合优雅关闭语义）。
 *
 * 行为注入旗标（全部可选，供测试制造分帧/合包/反例）：
 *   --chunk=N                  每次仅异步写 N 字节，模拟输出被字节级分帧
 *   --flush-delay=MS           每个响应延迟 MS 再写，使多个响应合包到达
 *   --delay-response=MS        收到请求后延迟 MS 再响应（配合超时用例）
 *   --contract-version=N       握手返回的 contract_version（默认 1；用于版本不一致反例）
 *   --emit-ready-event         首个响应前先发一条 atf.ready event 帧
 *   --crash-on-second-request  第二个 request 到达时写 stderr 并以退出码 3 崩溃（模拟意外退出）
 *   --bad-line-after-handshake 首个响应后再发一行非法文本（协议违规反例）
 */
import readline from "node:readline";

const findOpt = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : Number(hit.slice(prefix.length));
};

const chunkBytes = findOpt("chunk") ?? 0;
const flushDelayMs = findOpt("flush-delay") ?? 0;
const delayResponseMs = findOpt("delay-response") ?? 0;
const contractVersion = findOpt("contract-version") ?? 1;
const flags = new Set(process.argv.slice(2));
const emitReadyEvent = flags.has("--emit-ready-event");
const crashOnSecond = flags.has("--crash-on-second-request");
const badLineAfterHandshake = flags.has("--bad-line-after-handshake");

// 响应写出经串行链，保证分片模式下不同响应的字节不交错（对端自身的帧完整性义务）
let writeChain = Promise.resolve();
const writeRaw = (text) => {
  writeChain = writeChain.then(async () => {
    if (chunkBytes > 0) {
      for (let i = 0; i < text.length; i += chunkBytes) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        process.stdout.write(text.slice(i, i + chunkBytes));
      }
    } else {
      if (flushDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, flushDelayMs));
      process.stdout.write(text);
    }
  });
  return writeChain;
};

const sendFrame = (frame) => writeRaw(`${JSON.stringify(frame)}\n`);

const respondTo = (req, servedCount) => {
  // atf.ready 语义 = 版本交换（第 1 个请求即握手）完成后对端就绪；此时 TS 侧监听器已可挂载
  if (emitReadyEvent && servedCount === 2) {
    sendFrame({ type: "event", name: "atf.ready", payload: { peer: "mock" } });
  }
  if (req.method === "atf.version") {
    sendFrame({
      type: "response",
      id: req.id,
      ok: true,
      result: { name: "atf", version: "v0.2.0b7-mock", contract_version: contractVersion },
    });
  } else {
    sendFrame({
      type: "response",
      id: req.id,
      ok: false,
      error: { code: "method_not_found", message: `未知方法: ${req.method}` },
    });
  }
};

let served = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write(`mock: 非法请求行: ${line.slice(0, 80)}\n`);
    process.exit(2);
  }
  if (request === null || typeof request !== "object" || request.type !== "request" || !Number.isInteger(request.id)) {
    process.stderr.write("mock: 请求帧不符合契约（缺 type=request 或 id）\n");
    process.exit(2);
  }
  served += 1;
  if (crashOnSecond && served >= 2) {
    process.stderr.write("mock: crash-on-second-request 触发，进程退出(3)\n");
    process.exit(3);
  }
  const respond = () => {
    respondTo(request, served);
    if (badLineAfterHandshake && served === 1) writeRaw("这不是合法JSON帧\n");
  };
  if (delayResponseMs > 0) setTimeout(respond, delayResponseMs);
  else respond();
});
rl.on("close", () => {
  process.exit(0);
});
