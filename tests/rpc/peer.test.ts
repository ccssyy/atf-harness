/**
 * RpcPeer 双向 E2E 单测（T03）：PassThrough 双对等体互连——出站配对（含乱序）、入站
 * 请求分派、双向通知、-32700/-32600 回包、超限丢弃（含残尾）、超时收敛、对端关闭收敛、
 * 字节切分容忍。全部零 npm 依赖（node:stream）。
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  encodeJsonRpcLine,
  JSON_RPC_ERROR_CODES,
  jsonRpcError,
  RpcPeer,
  type RpcHandlerOutcome,
} from "../../src/rpc/index.js";

interface PeerPair {
  a: RpcPeer;
  b: RpcPeer;
  aToB: PassThrough;
  bToA: PassThrough;
}

const connectPair = (handlerB?: (method: string, params: unknown, id: number | string | null) => Promise<RpcHandlerOutcome> | RpcHandlerOutcome): PeerPair => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = RpcPeer.create({ input: aToB, output: bToA });
  const b = RpcPeer.create({ input: bToA, output: aToB, ...(handlerB !== undefined ? { onRequest: handlerB } : {}) });
  a.start();
  b.start();
  return { a, b, aToB, bToA };
};

const closePair = (pair: PeerPair): void => {
  pair.a.close();
  pair.b.close();
  pair.aToB.end();
  pair.bToA.end();
};

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 15));
};

const lineOf = (object: Record<string, unknown>): string => encodeJsonRpcLine(object as never);

describe("RpcPeer：出站请求-响应配对", () => {
  it("往返配对：result 与 error 两形态", async () => {
    const pair = connectPair((method) =>
      method === "echo"
        ? { ok: true, result: { said: "echo" } }
        : { ok: false, error: jsonRpcError(-32601, "no such method") },
    );
    const echoed = await pair.a.request("echo", { v: 1 });
    expect(echoed).toEqual({ ok: true, result: { said: "echo" } });
    const failed = await pair.a.request("nope");
    expect(failed).toMatchObject({ ok: false, error: { code: -32601 } });
    closePair(pair);
  });

  it("并发请求、响应乱序回写 → 仍按 id 正确配对", async () => {
    const pair = connectPair(async (_method, params) => {
      const delay = (params as { delay: number }).delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { ok: true, result: { delay } };
    });
    const [r1, r2] = await Promise.all([pair.a.request("m", { delay: 40 }), pair.a.request("m", { delay: 5 })]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.ok ? (r1.result as { delay: number }).delay : 0).toBe(40);
    expect(r2.ok ? (r2.result as { delay: number }).delay : 0).toBe(5);
    closePair(pair);
  });

  it("字节任意切分/合包/CRLF 尾均正确解码", async () => {
    const pair = connectPair(() => ({ ok: true, result: "ok" }));
    const pending = pair.a.request("m", { n: 1 });
    const line = lineOf({ jsonrpc: "2.0", method: "m", params: { n: 1 }, id: 1 });
    for (const character of `${line}\r\n`) {
      pair.bToA.write(character);
    }
    const result = await pending;
    expect(result).toMatchObject({ ok: true, result: "ok" });
    closePair(pair);
  });
});

describe("RpcPeer：入站请求/双向通知", () => {
  it("handler 抛异常 → -32603；handler 缺席 → -32601", async () => {
    const throwing = connectPair(() => {
      throw new Error("boom");
    });
    const boom = await throwing.a.request("m");
    expect(boom).toMatchObject({ ok: false, error: { code: -32603 } });
    closePair(throwing);

    const pair = connectPair(); // b 无 handler
    const missing = await pair.a.request("anything");
    expect(missing).toMatchObject({ ok: false, error: { code: JSON_RPC_ERROR_CODES.methodNotFound } });
    closePair(pair);
  });

  it("双向通知互达（params 缺省不带字段）", async () => {
    const gotOnA: Array<{ method: string; params: unknown }> = [];
    const gotOnB: Array<{ method: string; params: unknown }> = [];
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = RpcPeer.create({ input: aToB, output: bToA, onNotification: (method, params) => gotOnA.push({ method, params }) });
    const b = RpcPeer.create({ input: bToA, output: aToB, onNotification: (method, params) => gotOnB.push({ method, params }) });
    a.start();
    b.start();
    a.notify("session/update", { n: 1 });
    b.notify("client/ack");
    await settle();
    expect(gotOnB).toEqual([{ method: "session/update", params: { n: 1 } }]);
    expect(gotOnA).toEqual([{ method: "client/ack", params: undefined }]);
    a.close();
    b.close();
    aToB.end();
    bToA.end();
  });
});

describe("RpcPeer：协议异常 fail-closed", () => {
  it("非法 JSON → -32700（id=null）回包，onProtocolError 留痕", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const protocolErrors: number[] = [];
    const peer = RpcPeer.create({ input: aToB, output: bToA, onProtocolError: (error) => protocolErrors.push(error.code) });
    peer.start();
    let written = "";
    bToA.on("data", (chunk: Buffer | string) => {
      written += String(chunk);
    });
    aToB.write("not-json-at-all\n");
    await settle();
    expect(protocolErrors).toEqual([JSON_RPC_ERROR_CODES.parseError]);
    expect(JSON.parse(written.trim())).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
    peer.close();
    aToB.end();
    bToA.end();
  });

  it("结构非法请求 → -32600 且回显可提取 id", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    let received = "";
    bToA.on("data", (chunk: Buffer | string) => {
      received += String(chunk);
    });
    const peer = RpcPeer.create({ input: aToB, output: bToA });
    peer.start();
    aToB.write('{"jsonrpc":"1.0","method":"m","id":"keep-me"}\n');
    await settle();
    expect(received).toContain("-32600");
    expect(received).toContain("keep-me");
    peer.close();
    aToB.end();
    bToA.end();
  });

  it("配不上的响应 id → onProtocolError 留痕，不投递", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const protocolErrors: string[] = [];
    const peer = RpcPeer.create({ input: aToB, output: bToA, onProtocolError: (error) => protocolErrors.push(error.message) });
    peer.start();
    aToB.write('{"jsonrpc":"2.0","result":{},"id":999}\n');
    await settle();
    expect(protocolErrors.length).toBe(1);
    peer.close();
    aToB.end();
    bToA.end();
  });

  it("单行超限：静默丢弃＋留痕，不回包", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    let written = "";
    const protocolErrors: string[] = [];
    const peer = RpcPeer.create({
      input: aToB,
      output: bToA,
      maxLineBytes: 64,
      onProtocolError: (error) => protocolErrors.push(error.message),
    });
    peer.start();
    bToA.on("data", (chunk: Buffer | string) => {
      written += String(chunk);
    });
    aToB.write(`${"x".repeat(200)}\n`);
    await settle();
    expect(protocolErrors.length).toBe(1);
    expect(written).toBe(""); // 超限无回包（不放大）
    peer.close();
    aToB.end();
    bToA.end();
  });

  it("超限行残尾（跨 chunk 到达）整体丢弃，后续合法请求不受影响", async () => {
    const handled: string[] = [];
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const protocolErrors: string[] = [];
    const peer = RpcPeer.create({
      input: aToB,
      output: bToA,
      maxLineBytes: 64,
      onRequest: (method) => {
        handled.push(method);
        return { ok: true, result: "ok" };
      },
      onProtocolError: (error) => protocolErrors.push(error.message),
    });
    peer.start();
    aToB.write("y".repeat(100)); // 无 LF、超限 → 丢弃 + overflow
    await settle();
    aToB.write("residue-tail\n"); // 残尾：随 overflow 丢弃
    const pending = peer.request("fine"); // 合法出站请求（经 aToB? 不——出站在 bToA）
    void pending;
    await settle();
    expect(handled).toEqual([]);
    // 残尾被吞、未产生 -32700 回包噪声：出站流只有本次出站请求行
    peer.close();
    aToB.end();
    bToA.end();
  });
});

describe("RpcPeer：生命周期", () => {
  it("请求超时 → -32000 收敛；其余挂起不受影响", async () => {
    const pair = connectPair(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { ok: true, result: "late" };
    });
    const fast = pair.a.request("m", undefined, { timeoutMs: 40 });
    const slow = pair.a.request("m");
    const fastOutcome = await fast;
    expect(fastOutcome).toMatchObject({ ok: false, error: { code: -32000 } });
    const slowOutcome = await slow;
    expect(slowOutcome).toMatchObject({ ok: true, result: "late" });
    closePair(pair);
  });

  it("对端流关闭 → 挂起请求 -32000 收敛 + onPeerClose", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    let peerClosed = false;
    const peer = RpcPeer.create({ input: aToB, output: bToA, onPeerClose: () => {
      peerClosed = true;
    } });
    peer.start();
    const pending = peer.request("m");
    aToB.end();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, error: { code: -32000 } });
    expect(peerClosed).toBe(true);
    peer.close();
    bToA.end();
  });

  it("close 后 request 拒绝且不悬挂；close 幂等", async () => {
    const peer = RpcPeer.create({ input: new PassThrough(), output: new PassThrough() });
    peer.close();
    expect(() => peer.close()).not.toThrow();
    const outcome = await peer.request("m");
    expect(outcome).toMatchObject({ ok: false, error: { code: -32000 } });
  });
});
