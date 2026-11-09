import { describe, expect, it } from "vitest";
import {
  findDeadAtfExtensions,
  ATF_REQUIRED_EXTENSION_IDS,
  type LoaderCtxLike,
} from "../../../src/core/workspace/atfBootHealth.js";

/**
 * D246/D247 boot 健康门判定（无机检不立规；事故=1109 工具面静默降级整轮假链路）：
 * 治理面扩展 loader fiber 未建（undefined=vendor inactiveEntries 同款未装配判据）
 * 即报死——调用方 fail-fast 拒绝服务。判定纯函数四态即契约。
 */

const entry = (id: string, alive: boolean) => ({
  options: { id },
  ...(alive ? { fiber: { state: 2 } } : {}),
});

const ctxWith = (...entries: ReturnType<typeof entry>[]): LoaderCtxLike => ({
  loader: { entries: () => entries, await: async () => undefined },
});

describe("D246/D247 boot 健康门判定", () => {
  it("治理面清单含 atf-tools 与 atf-continuation（缺一即裸奔）", () => {
    expect(ATF_REQUIRED_EXTENSION_IDS).toContain("atf-tools");
    expect(ATF_REQUIRED_EXTENSION_IDS).toContain("atf-continuation");
  });

  it("全部存活 → 空（放行）", () => {
    const ctx = ctxWith(entry("atf-tools", true), entry("atf-continuation", true), entry("llm", true));
    expect(findDeadAtfExtensions(ctx)).toEqual([]);
  });

  it("atf-tools fiber 未建（D246 事故形态）→ 报死", () => {
    const ctx = ctxWith(entry("atf-tools", false), entry("atf-continuation", true));
    expect(findDeadAtfExtensions(ctx)).toEqual(["atf-tools"]);
  });

  it("非治理面扩展死亡不报（只盯治理面清单）", () => {
    const ctx = ctxWith(entry("atf-tools", true), entry("llm", false));
    expect(findDeadAtfExtensions(ctx)).toEqual([]);
  });

  it("loader 缺席 → 空（调用方兜底不误杀）", () => {
    expect(findDeadAtfExtensions(undefined)).toEqual([]);
    expect(findDeadAtfExtensions({})).toEqual([]);
  });
});
