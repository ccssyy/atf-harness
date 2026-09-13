import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection, REQUEST_TIMEOUT_MS, type AtfBridgeEventData } from "../../src/bridge/connection.js";
import type { BridgeError } from "../../src/bridge/errors.js";
import type { Result } from "../../src/bridge/result.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));
const spawnMock = (...flags: string[]) => AtfBridgeConnection.spawn({ command: ["node", mockAtf, ...flags] });

const openConnections: AtfBridgeConnection[] = [];
const track = (connection: AtfBridgeConnection): AtfBridgeConnection => {
  openConnections.push(connection);
  return connection;
};

afterEach(async () => {
  // 兜底回收：任何用例遗留的连接统一关闭，避免挂起句柄影响 vitest 进程
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

describe("S1 验收用例 1——握手（spawn → 版本 response → 优雅退出，退出码 0）", () => {
  it("握手拿到版本 response，close 后对端退出码 0", async () => {
    const spawned = await spawnMock();
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    // 握手承载会话协议版本轴（双轴修正 2026-09-13）：mock 默认回 1，与内核 SESSION_CONTRACT_VERSION 同源
    expect(connection.version).toEqual({ name: "atf", version: "v0.2.0b7-mock", contract_version: 1 });

    const closed = await connection.close();
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.value.exitCode).toBe(0);
      expect(closed.value.signal).toBeNull();
    }
  });

  it("close 幂等：重复 close 返回同一结果", async () => {
    const spawned = await spawnMock();
    if (!spawned.ok) throw new Error("spawn 失败");
    const connection = track(spawned.value);
    const first = await connection.close();
    const second = await connection.close();
    expect(second).toEqual(first);
  });

  it("会话协议版本不一致（注入 2 = 桥接契约版本误用反例）→ err(handshake_failed)，文案指向会话协议版本轴", async () => {
    const spawned = await spawnMock("--contract-version=2");
    expect(spawned.ok).toBe(false);
    if (spawned.ok) {
      await track(spawned.value).close();
      return;
    }
    expect(spawned.error.code).toBe("handshake_failed");
    // 双轴修正 2026-09-13：文案指向会话协议版本（不再误导为"核对 bridge.contract.yaml/pin"）
    expect(spawned.error.message).toContain("会话协议版本不一致");
    expect(spawned.error.message).toContain("harness 期望 1");
    expect(spawned.error.message).toContain("对端报告 2");
    expect(spawned.error.message).toContain("线缆协议不兼容");
    expect(spawned.error.message).toContain("请查契约文件版本而非本值");
  });
});

describe("S1 验收用例 2——错误（不存在的 atf 可执行路径 → err，主进程不崩）", () => {
  it("可执行文件不存在（ENOENT）→ err(spawn_failed)，异常不穿越边界", async () => {
    const spawned = await AtfBridgeConnection.spawn({
      command: ["/nonexistent/atf-bridge-probe-binary"],
    });
    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    expect(spawned.error.code).toBe("spawn_failed");
    expect(spawned.error.message).toContain("/nonexistent/atf-bridge-probe-binary");
    // 走到这里 = 主进程未崩、promise 未 reject
  });

  it("对端启动即崩溃（脚本缺失，node 正常存在）→ err 且附带 stderr 摘要", async () => {
    const spawned = await AtfBridgeConnection.spawn({
      command: ["node", "/nonexistent/atf-bridge-missing.mjs"],
    });
    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    expect(spawned.error.code).toBe("handshake_failed");
    expect(spawned.error.stderrTail ?? "").toContain("Cannot find module");
  });
});

describe("S1 验收用例 3——分帧粘包（连续 10 个 request 的 response 无串扰，id 全部正确配对）", () => {
  it("对端按字节分片输出（--chunk=3）：10 请求全部按 id 正确配对", async () => {
    const spawned = await spawnMock("--chunk=3");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const results = await Promise.all(Array.from({ length: 10 }, () => connection.request("atf.version")));
    expect(results).toHaveLength(10);
    for (const result of results) expect(result.ok).toBe(true);

    const closed = await connection.close();
    expect(closed.ok).toBe(true);
  });

  it("对端延迟合包输出（--flush-delay）：多响应合包仍无串扰，且错误响应与成功响应各归其主", async () => {
    const spawned = await spawnMock("--flush-delay=25", "--emit-ready-event");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const events: AtfBridgeEventData[] = [];
    connection.onEvent((event) => events.push(event));

    // 成功与错误请求交错：任一串扰都会让调用方拿到别人的结果而被捕获。
    // 按构造顺序逐任务记录期望，不依赖位置规律。
    const jobs: Array<{ promise: Promise<Result<unknown, BridgeError>>; expectRejected: boolean }> = [];
    for (let i = 0; i < 10; i += 1) {
      jobs.push({ promise: connection.request("atf.version"), expectRejected: false });
      if (i % 2 === 0) jobs.push({ promise: connection.request("no.such.method"), expectRejected: true });
    }
    const results = await Promise.all(jobs.map((job) => job.promise));

    expect(results).toHaveLength(jobs.length);
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const job = jobs[i];
      if (job?.expectRejected) {
        expect(result?.ok, `任务 ${String(i)} 意外成功（串扰嫌疑）`).toBe(false);
        if (result !== undefined && !result.ok) {
          expect(result.error.code).toBe("request_rejected");
          expect((result.error.detail as { code?: string } | undefined)?.code).toBe("method_not_found");
        }
      } else {
        expect(result?.ok, `任务 ${String(i)} 意外失败（串扰嫌疑）`).toBe(true);
      }
    }
    expect(events).toEqual([{ name: "atf.ready", payload: { peer: "mock" } }]);

    const closed = await connection.close();
    expect(closed.ok).toBe(true);
  });
});

describe("S1 补充语义——超时 / 意外退出 / 协议违规（fail-closed）", () => {
  it("请求超时 → err(timeout)；连接随即回收，后续请求 → err(closed)", async () => {
    const spawned = await spawnMock("--delay-response=1000");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const timedOut = await connection.request("atf.version", undefined, { timeoutMs: 60 });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error.code).toBe("timeout");

    const afterFailure = await connection.request("atf.version");
    expect(afterFailure.ok).toBe(false);
    if (!afterFailure.ok) expect(afterFailure.error.code).toBe("closed");
  });

  it("对端意外退出 → 挂起请求 err(peer_exit) 并附 stderr 摘要；不重试、不猜测成功", async () => {
    const spawned = await spawnMock("--crash-on-second-request");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const crashed = await connection.request("atf.version");
    expect(crashed.ok).toBe(false);
    if (!crashed.ok) {
      expect(crashed.error.code).toBe("peer_exit");
      expect(crashed.error.stderrTail ?? "").toContain("crash-on-second-request");
    }

    const afterCrash = await connection.request("atf.version");
    expect(afterCrash.ok).toBe(false);
    if (!afterCrash.ok) expect(afterCrash.error.code).toBe("closed");
  });

  it("对端发协议违规行 → 连接 fail-closed，后续请求 err(closed)", async () => {
    const spawned = await spawnMock("--bad-line-after-handshake");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    // 给对端留出写出违规行的时间
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterViolation = await connection.request("atf.version");
    expect(afterViolation.ok).toBe(false);
    if (!afterViolation.ok) expect(afterViolation.error.code).toBe("closed");
  });
});

describe("S1 协议常量（任务书：超时常量定义）", () => {
  it("REQUEST_TIMEOUT_MS 初值 = 30s", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
