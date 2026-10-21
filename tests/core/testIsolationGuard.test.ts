/**
 * D51（门 2 收口）——测试隔离 guard 测试锚。
 *
 * 覆盖：① CJS 写族补丁（require 面——live 目标即抛 test_isolation_violation 且零落盘）；
 * ② mtime tripwire 权威层（快照→写→复检＝违规点名；快照→只读→复检＝干净）——对任意
 * 写路径（含 ESM 具名 import 面——node:fs ESM 命名空间 sealed 无法函数级拦截，由本层
 * 兜底）零漏报；③ /tmp 面 guard 零误伤。
 * 注：qc-02 回填 run.json 已由 owner 备份移走（sha 07325d9a）不得重建——本组对
 * /data/atf 零触碰（live 断言只走 guard 拦截面与 tmp 仿真树，无实际写）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_WRITE_FORBIDDEN_ROOTS, snapshotLiveTreeForTest, verifyTreeUntouched } from "../fixtures/testIsolationGuard.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "zz-d51-isolation-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D51——测试隔离 guard", () => {
  it("CJS 写族补丁：live 根目标即抛 test_isolation_violation（写之前——零落盘）＋/tmp 畅通", () => {
    const fsCjs = createRequire(import.meta.url)("node:fs") as Record<string, (...args: unknown[]) => unknown>;
    const target = "/data/atf/prodtest/zz-d51-guard-probe/guard-probe.json";
    expect(() => fsCjs.writeFileSync(target, "x", "utf8")).toThrow(/test_isolation_violation: .*writeFileSync/);
    expect(() => fsCjs.mkdirSync("/data/atf/dev/runs/zz-d51-guard-probe", { recursive: true })).toThrow(/test_isolation_violation: .*mkdirSync/);
    expect(() => fsCjs.rmSync("/data/atf/dev/runs/zz-d51-guard-probe", { recursive: true, force: true })).toThrow(/test_isolation_violation: .*rmSync/);
    expect(() => fsCjs.renameSync("/tmp/zz-no-src", "/data/atf/uat/zz-d51-probe")).toThrow(/test_isolation_violation: .*renameSync/);
    const tmpA = join(tempRoot(), "a.txt");
    expect(() => fsCjs.writeFileSync(tmpA, "ok", "utf8")).not.toThrow(); // /tmp 零误伤
    expect(readFileSync(tmpA, "utf8")).toBe("ok");
  });
  it("mtime tripwire 权威层：快照后写入/改动/删除 → 复检逐项点名（tmp 仿真树——ESM 具名 import 面由本层兜底）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ws", "workspace", "runs", "r1"), { recursive: true });
    writeFileSync(join(root, "ws", "workspace", "runs", "r1", "run.json"), "{}", "utf8");
    const before = snapshotLiveTreeForTest(root);
    // 写入后三类违规各造一个：新增／改动／删除
    writeFileSync(join(root, "ws", "workspace", "runs", "r1", "extra.json"), "x", "utf8"); // 新增＋父目录 mtime 变
    writeFileSync(join(root, "ws", "workspace", "runs", "r1", "run.json"), '{"v":2}', "utf8"); // 改动
    rmSync(join(root, "ws", "workspace", "runs", "r1", "run.json")); // 删除（改动与删除取后态——至少一项命中）
    const violations = verifyTreeUntouched(root, before);
    expect(violations.some((v) => v.includes("新增写入"))).toBe(true);
    expect(violations.length).toBeGreaterThan(0);
  });
  it("mtime tripwire：快照后只读 → 复检干净（零误报——读不受限）", () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.json"), "{}", "utf8");
    const before = snapshotLiveTreeForTest(root);
    expect(readFileSync(join(root, "a.json"), "utf8")).toBe("{}"); // 读面
    expect(verifyTreeUntouched(root, before)).toEqual([]);
  });
  it("live 清单闭集锚（/data/atf 运行面＋内核仓＋uat＋pin＋/root/.atf——qc-02 所在 prodtest 在列）", () => {
    expect(LIVE_WRITE_FORBIDDEN_ROOTS).toContain("/data/atf/prodtest");
    expect(LIVE_WRITE_FORBIDDEN_ROOTS).toContain("/data/sam/AgenticTrainingFlow");
    expect(LIVE_WRITE_FORBIDDEN_ROOTS).toContain("/root/.atf");
  });
});
