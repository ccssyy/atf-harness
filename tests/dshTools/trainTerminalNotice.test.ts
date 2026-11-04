import { describe, expect, it } from "vitest";
import { trainTerminalNoticeOf } from "../../packages/extensions/atf-tools/src/trainingFace.js";

/**
 * B3（D5 修复）终态回流判定锚——训练完成不再等用户询问。
 * 判据面＝纯函数返回的用户面三句话（黑盒：不引内部状态）。
 */
describe("训练终态回流（D5/ADR-0019 B3）", () => {
  it("终态形态（进程不活+段已推进）→ 返回终态通知三句话", () => {
    const notice = trainTerminalNoticeOf({
      action: "status", run_id: "r1", running: false,
      segments: [{ key: "train", label: "训练", status: "done" }],
    });
    expect(notice).not.toBeNull();
    expect(notice!.conclusion).toContain("训练进程已结束");
    expect(notice!.next).toContain("atf_evaluate");
  });

  it("运行中（running=true）→ null（不投）", () => {
    expect(trainTerminalNoticeOf({
      action: "status", run_id: "r1", running: true,
      segments: [{ key: "train", label: "训练", status: "done" }],
    })).toBeNull();
  });

  it("未推进（全 pending/无 segments）→ null（未启动不算终态）", () => {
    expect(trainTerminalNoticeOf({ action: "status", run_id: "r1", running: false, segments: [] })).toBeNull();
    expect(trainTerminalNoticeOf({
      action: "status", run_id: "r1", running: false,
      segments: [{ key: "s", label: "s", status: "pending" as const }],
    })).toBeNull();
  });
});
