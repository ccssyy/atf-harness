import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection, type AtfBridgeEventData } from "../../src/bridge/connection.js";
import type { Result } from "../../src/bridge/result.js";

/**
 * 契约 v2 方法面补登（2026-09-13）mock 路径用例——《ATF-Harness_Owner指令_推送授权与bind_run补登_20260913.md》
 * 验收 §2.3：绑定后无参调用 / 显式 run_id 覆盖 / 未绑定报错（no_run_bound）/ unknown_run，
 * 另含 B4 绑定留痕（session/run-bound event）与 B3 连接保持断言。
 * mock 口径：默认启动即绑定 mock-run-1（批次一兼容承载）；--no-auto-bind 严格启动；
 * --unknown-run=ID 注定不可解析值（auto-registry 差异面见 mock 头部注记）。
 */

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

/** 线缆错误码提取：对端 error response 在 TS 侧折算为 err(request_rejected)，detail.code 承载原码。 */
const wireCode = (rejected: { ok: false; error: { code: string; detail?: unknown } }): string => {
  expect(rejected.error.code).toBe("request_rejected");
  return ((rejected.error.detail ?? {}) as { code?: string }).code ?? "";
};

const request = async (connection: AtfBridgeConnection, method: string, params?: unknown): Promise<Result<unknown, { code: string; detail?: unknown }>> => {
  const response = await connection.request(method, params);
  return response.ok ? response : { ok: false, error: { code: wireCode(response), detail: response.error.detail } };
};

describe("契约补登 B1——atf.bind_run 绑定后无参调用（--no-auto-bind 严格启动）", () => {
  it("绑定 → result {ok, run_id, scope_ref}；随后无参 fact_scan / workspace_status 落在绑定 run", async () => {
    const spawned = await spawnMock("--no-auto-bind");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const bound = await request(connection, "atf.bind_run", { run_id: "run-A" });
    expect(bound).toEqual({
      ok: true,
      value: {
        ok: true,
        run_id: "run-A",
        scope_ref: { project_id: "mock-project", scope_type: "run", scope_id: "run-A", scope_mode: "headless" },
      },
    });

    const scan = await request(connection, "atf_fact_scan", {});
    expect(scan.ok).toBe(true);

    const status = await request(connection, "atf_workspace_status", {});
    expect(status).toEqual({
      ok: true,
      value: {
        ok: true,
        run_id: "run-A",
        admitted_count: 0,
        scope_ref: { project_id: "mock-project", scope_type: "run", scope_id: "run-A", scope_mode: "headless" },
      },
    });
  });
});

describe("契约补登 B2/B4——显式 run_id 优先于会话绑定；覆盖绑定发留痕 event", () => {
  it("显式 run_id 覆盖默认绑定（mock-run-1）→ 结果落在显式 run", async () => {
    const spawned = await spawnMock();
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const status = await request(connection, "atf_workspace_status", { run_id: "run-B" });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect((status.value as { run_id: string }).run_id).toBe("run-B");
    }
  });

  it("覆盖绑定：先收 event session/run-bound（payload from/to），后续无参调用落新 run；重复绑定同 run 不发 event", async () => {
    const spawned = await spawnMock();
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);
    const events: AtfBridgeEventData[] = [];
    connection.onEvent((event) => events.push(event));

    const rebound = await request(connection, "atf.bind_run", { run_id: "run-B" });
    expect(rebound.ok).toBe(true);
    // event 先于 response 到达（mock 经 writeChain 串行写出），request resolve 时监听器已收到
    expect(events).toEqual([{ name: "session/run-bound", payload: { from: "mock-run-1", to: "run-B" } }]);

    const status = await request(connection, "atf_workspace_status", {});
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect((status.value as { run_id: string }).run_id).toBe("run-B");
    }

    // 同 run 重复绑定 = 无覆盖语义，不发留痕 event
    const same = await request(connection, "atf.bind_run", { run_id: "run-B" });
    expect(same.ok).toBe(true);
    expect(events).toHaveLength(1);
  });
});

describe("契约补登 B3——未绑定且未显式给 run_id → no_run_bound（fail-closed，连接保持）", () => {
  it("严格启动下无参调用两个只读方法 → no_run_bound；绑定后恢复可用", async () => {
    const spawned = await spawnMock("--no-auto-bind");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const scan = await request(connection, "atf_fact_scan", {});
    expect(scan).toEqual({ ok: false, error: { code: "no_run_bound", detail: { code: "no_run_bound" } } });

    const status = await request(connection, "atf_workspace_status", {});
    expect(status).toEqual({ ok: false, error: { code: "no_run_bound", detail: { code: "no_run_bound" } } });

    // 连接保持：no_run_bound 后同一连接可继续绑定并成功调用
    const bound = await request(connection, "atf.bind_run", { run_id: "run-C" });
    expect(bound.ok).toBe(true);
    const recovered = await request(connection, "atf_workspace_status", {});
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect((recovered.value as { run_id: string }).run_id).toBe("run-C");
    }
  });
});

describe("契约补登 B3——run_id 不可解析 → unknown_run（连接保持）", () => {
  it("显式 run_id / bind_run 命中不可解析值 → unknown_run；同一连接后续请求不受影响", async () => {
    const spawned = await spawnMock("--unknown-run=ghost-run");
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const connection = track(spawned.value);

    const scan = await request(connection, "atf_fact_scan", { run_id: "ghost-run" });
    expect(scan).toEqual({ ok: false, error: { code: "unknown_run", detail: { code: "unknown_run" } } });

    const bind = await request(connection, "atf.bind_run", { run_id: "ghost-run" });
    expect(bind).toEqual({ ok: false, error: { code: "unknown_run", detail: { code: "unknown_run" } } });

    // 连接保持：unknown_run 后同一连接可继续服务其他请求
    const status = await request(connection, "atf_workspace_status", {});
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect((status.value as { run_id: string }).run_id).toBe("mock-run-1");
    }
  });
});
