/**
 * JSON-RPC 2.0 消息面单测（T03）：严格校验矩阵——请求/通知/响应三形态、标准错误码、
 * 批处理数组拒收、result/error 恰一、编解码往返与单行保证。
 */
import { describe, expect, it } from "vitest";
import {
  buildErrorResponse,
  buildNotification,
  buildRequest,
  buildResultResponse,
  encodeJsonRpcLine,
  JSON_RPC_ERROR_CODES,
  jsonRpcError,
  parseJsonRpcLine,
} from "../../src/rpc/index.js";

const okLine = (text: string) => {
  const parsed = parseJsonRpcLine(text);
  return { ok: parsed.ok, value: parsed.ok ? parsed.value : null, failure: parsed.ok ? null : parsed.error };
};

describe("parseJsonRpcLine：合法形态", () => {
  it("请求（number/string/null id；params 对象或数组或缺省）", () => {
    expect(okLine('{"jsonrpc":"2.0","method":"initialize","params":{"a":1},"id":1}')).toMatchObject({
      ok: true,
      value: { jsonrpc: "2.0", method: "initialize", id: 1 },
    });
    expect(okLine('{"jsonrpc":"2.0","method":"m","id":"abc"}')).toMatchObject({ ok: true });
    expect(okLine('{"jsonrpc":"2.0","method":"m","id":null}')).toMatchObject({ ok: true });
    expect(okLine('{"jsonrpc":"2.0","method":"m","params":[1,2],"id":2}')).toMatchObject({ ok: true });
    expect(okLine('{"jsonrpc":"2.0","method":"m","id":3}')).toMatchObject({ ok: true });
  });

  it("通知（无 id 字段）与响应（result/error 恰一）", () => {
    expect(okLine('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}')).toMatchObject({
      ok: true,
      value: { method: "session/update" },
    });
    expect(okLine('{"jsonrpc":"2.0","method":"m"}')).toMatchObject({ ok: true });
    const okResp = okLine('{"jsonrpc":"2.0","result":{"v":7},"id":9}');
    expect(okResp).toMatchObject({ ok: true });
    const errResp = okLine('{"jsonrpc":"2.0","error":{"code":-32601,"message":"no"},"id":9}');
    expect(errResp).toMatchObject({ ok: true });
    if (errResp.value !== null && "error" in errResp.value) {
      expect(errResp.value.error).toEqual({ code: -32601, message: "no" });
    } else {
      throw new Error("error 响应解析形态不符");
    }
  });
});

describe("parseJsonRpcLine：非法形态（fail-closed 矩阵）", () => {
  it("JSON 解析失败 → -32700 / id null", () => {
    const failure = okLine("{oops");
    expect(failure.ok).toBe(false);
    expect(failure.failure).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("非对象/批处理数组/jsonrpc 版本错 → -32600", () => {
    expect(okLine('"text"').failure?.error.code).toBe(-32600);
    expect(okLine("[]").failure?.error.code).toBe(-32600);
    expect(okLine('[{"jsonrpc":"2.0","method":"m","id":1}]').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"1.0","method":"m","id":1}').failure?.error.code).toBe(-32600);
  });

  it("method/id/params 非法 → -32600；可提取 id 回显", () => {
    expect(okLine('{"jsonrpc":"2.0","method":"","id":1}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","method":5,"id":1}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","method":"m","id":true}').failure).toMatchObject({ id: null });
    expect(okLine('{"jsonrpc":"2.0","method":"m","params":"x","id":"keep"}').failure).toMatchObject({ id: "keep" });
    expect(okLine('{"jsonrpc":"2.0","method":"m","params":"primitive","id":1}').failure?.error.code).toBe(-32600);
  });

  it("响应缺 id / result 与 error 并存或全缺 / error 体非法 → -32600", () => {
    expect(okLine('{"jsonrpc":"2.0","result":1}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","result":1,"error":{"code":1,"message":"m"},"id":2}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","id":2}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","error":"oops","id":2}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","error":{"code":"x","message":"m"},"id":2}').failure?.error.code).toBe(-32600);
    expect(okLine('{"jsonrpc":"2.0","error":{"code":1},"id":2}').failure?.error.code).toBe(-32600);
  });
});

describe("编码面", () => {
  it("构造器 + 编解码往返；单行保证（无裸 LF）", () => {
    const request = buildRequest(1, "session/new", { cwd: "/tmp" });
    expect(request).toEqual({ jsonrpc: "2.0", method: "session/new", params: { cwd: "/tmp" }, id: 1 });
    const bare = buildRequest(2, "m");
    expect(bare).not.toHaveProperty("params");
    const line = encodeJsonRpcLine(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(okLine(line)).toMatchObject({ ok: true });

    const notif = buildNotification("n");
    expect(notif).not.toHaveProperty("params");
    expect(okLine(encodeJsonRpcLine(notif))).toMatchObject({ ok: true, value: { method: "n" } });
    expect(okLine(encodeJsonRpcLine(buildResultResponse(5, { a: 1 })))).toMatchObject({ ok: true });
    expect(okLine(encodeJsonRpcLine(buildErrorResponse(5, jsonRpcError(-32000, "t"))))).toMatchObject({ ok: true });
  });

  it("params 内含换行的字符串被 JSON 转义（线缆恒单行）", () => {
    const line = encodeJsonRpcLine(buildRequest(1, "m", { text: "a\nb" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n"); // 裸 LF 恒被转义——线缆恒单行
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", method: "m", params: { text: "a\nb" }, id: 1 });
  });

  it("标准错误码常量", () => {
    expect(JSON_RPC_ERROR_CODES).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
      transportFailure: -32000,
    });
  });
});
