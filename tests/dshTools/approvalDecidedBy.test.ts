// -*- coding: utf-8 -*-
// 切片 2·C2'/C3'：审批决定来源推导与文案分支测试（纯函数）。
// 判据（owner 确认）：账面如实记「策略自动」而非「谁点的」事实——推导依据=权限档位，
// 可判定、零时间启发式；guarded 档真提问保留 owner 值域。
import { describe, expect, it } from "vitest";
import {
  approvalDecidedByOf,
  approvalTailLineOf,
} from "../../packages/extensions/atf-tools/src/permissionTier.js";

describe("approvalDecidedByOf（C1' 值域推导）", () => {
  it("unattended → auto（无人值守自动）", () => {
    expect(approvalDecidedByOf("unattended")).toBe("auto");
  });
  it("full-access → policy（策略档自动放行——1112 会话 38 次场景的实际形态）", () => {
    expect(approvalDecidedByOf("full-access")).toBe("policy");
  });
  it("guarded → owner（真提问路径，卡真等待）", () => {
    expect(approvalDecidedByOf("guarded")).toBe("owner");
  });
});

describe("approvalTailLineOf（C3' 文案与行为一致）", () => {
  it("guarded 保留原措辞（真提问）", () => {
    expect(approvalTailLineOf("guarded")).toContain("仅 owner 可点");
  });
  it("full-access 不再出现假措辞，如实标注策略自动+审计词", () => {
    const line = approvalTailLineOf("full-access");
    expect(line).not.toContain("仅 owner 可点");
    expect(line).toContain("自动放行");
    expect(line).toContain("policy");
  });
  it("unattended 如实标注无人值守自动", () => {
    const line = approvalTailLineOf("unattended");
    expect(line).not.toContain("仅 owner 可点");
    expect(line).toContain("auto");
  });
});
