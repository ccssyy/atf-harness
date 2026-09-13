import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_FRAME_BYTES, LineFrameDecoder, encodeRequestFrame } from "../../src/bridge/frames.js";

const versionResponse =
  '{"type":"response","id":1,"ok":true,"result":{"name":"atf","version":"v0.2.0b7-mock","contract_version":2}}\n';

const framesOf = (items: ReturnType<LineFrameDecoder["push"]>) =>
  items.filter((item) => item.kind === "frame").map((item) => (item.kind === "frame" ? item.frame : null));
const errorsOf = (items: ReturnType<LineFrameDecoder["push"]>) =>
  items.filter((item) => item.kind === "protocol_error");

describe("LineFrameDecoder——严格 LF 分帧（bridge.contract.yaml framing）", () => {
  it("单帧单块完整到达", () => {
    const decoder = new LineFrameDecoder();
    const frames = framesOf(decoder.push(versionResponse));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "response", id: 1, ok: true });
  });

  it("帧被字节级分片跨块到达（粘包/分帧还原）", () => {
    const decoder = new LineFrameDecoder();
    let frames: ReturnType<typeof framesOf> = [];
    for (let i = 0; i < versionResponse.length; i += 3) {
      frames = frames.concat(framesOf(decoder.push(versionResponse.slice(i, i + 3))));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "response", id: 1 });
    expect(frames[0]).toHaveProperty("result.contract_version", 2);
  });

  it("多帧合包于单块到达（粘包拆分）", () => {
    const decoder = new LineFrameDecoder();
    const chunk = versionResponse + versionResponse.replace('"id":1', '"id":2') + versionResponse.replace('"id":1', '"id":3');
    const frames = framesOf(decoder.push(chunk));
    expect(frames.map((frame) => (frame && frame.type === "response" ? frame.id : null))).toEqual([1, 2, 3]);
  });

  it("分片与合包混合的乱序块序列", () => {
    const decoder = new LineFrameDecoder();
    const line2 = '{"type":"response","id":2,"ok":false,"error":{"code":"method_not_found","message":"未知方法: x.y"}}\n';
    const blob = versionResponse + line2;
    const cut = 17;
    const items = [
      ...decoder.push(blob.slice(0, cut)),
      ...decoder.push(blob.slice(cut, cut + 5)),
      ...decoder.push(blob.slice(cut + 5)),
    ];
    const frames = framesOf(items);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "response", id: 1, ok: true });
    expect(frames[1]).toMatchObject({ type: "response", id: 2, ok: false, error: { code: "method_not_found" } });
    expect(errorsOf(items)).toHaveLength(0);
  });

  it("event 帧解析并保留 payload", () => {
    const decoder = new LineFrameDecoder();
    const frames = framesOf(decoder.push('{"type":"event","name":"atf.ready","payload":{"peer":"mock"}}\n'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "event", name: "atf.ready", payload: { peer: "mock" } });
  });

  it("非法 JSON 行 → protocol_error（不抛异常）", () => {
    const decoder = new LineFrameDecoder();
    const items = decoder.push("这不是合法JSON帧\n");
    expect(framesOf(items)).toHaveLength(0);
    const errors = errorsOf(items);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "protocol_error" });
    if (errors[0]?.kind === "protocol_error") {
      expect(errors[0].error.code).toBe("protocol_error");
      expect(errors[0].error.message).toContain("非法 JSON 行");
    }
  });

  it("空行 → protocol_error（严格 LF：每行必须是一帧）", () => {
    const decoder = new LineFrameDecoder();
    const items = decoder.push("\n");
    expect(errorsOf(items)).toHaveLength(1);
  });

  it("未知帧 type（含内核侧发 request 的方向违规）→ protocol_error", () => {
    const decoder = new LineFrameDecoder();
    const items = decoder.push('{"type":"request","id":9,"method":"x"}\n');
    expect(framesOf(items)).toHaveLength(0);
    if (errorsOf(items)[0]?.kind === "protocol_error") {
      expect(errorsOf(items)[0]!.error.message).toContain("未知帧 type");
    }
  });

  it("response 缺字段（ok=true 无 result）→ protocol_error", () => {
    const decoder = new LineFrameDecoder();
    const items = decoder.push('{"type":"response","id":1,"ok":true}\n');
    expect(errorsOf(items)).toHaveLength(1);
  });

  it("无 LF 的超限帧 → 立即 protocol_error 并复位缓冲", () => {
    const decoder = new LineFrameDecoder(32);
    const oversized = "x".repeat(40);
    const first = errorsOf(decoder.push(oversized));
    expect(first).toHaveLength(1);
    // 复位后仍可正常解码后续合法帧（连接层随后会 fail-closed 回收，解码器本身不残留垃圾）
    const next = decoder.push('{"type":"event","name":"ok"}\n');
    expect(framesOf(next)).toHaveLength(1);
  });

  it("默认帧上限与契约 max_frame_bytes 一致", () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(1_048_576);
  });
});

describe("encodeRequestFrame", () => {
  it("编码含结尾 LF；params 为 undefined 时不携带 params 字段", () => {
    const encoded = encodeRequestFrame({ type: "request", id: 1, method: "atf.version" });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(encoded.value.endsWith("\n")).toBe(true);
      expect(JSON.parse(encoded.value)).not.toHaveProperty("params");
    }
  });

  it("params 循环引用 → err（不抛异常）", () => {
    const params: Record<string, unknown> = {};
    params["self"] = params;
    const encoded = encodeRequestFrame({ type: "request", id: 1, method: "echo", params });
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) expect(encoded.error.code).toBe("protocol_error");
  });
});
