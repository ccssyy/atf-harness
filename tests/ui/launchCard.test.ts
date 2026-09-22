/**
 * 批 3 §三：训练启动确认卡（UI 件单测）——卡面人读摘要／harness 译码确认文本／
 * A2.5 同构确定性合成（无 LLM 参与；同输入同输出）。
 */
import { describe, expect, it } from "vitest";
import { launchCardKey, launchCardLines, launchConfirmationText, synthesizeLaunchAction } from "../../src/ui/launchCard.js";
import type { LaunchReady } from "../../src/core/workspace/index.js";

const READY: LaunchReady = {
  launch_sh: "out/launch.sh",
  run_id: "run-ddl1",
  iteration_config_sha256: "a".repeat(64),
  global_batch: 16,
  nnodes: 1,
  config: "prep/iteration-config.json",
};

describe("批 3 §三：训练启动确认卡", () => {
  it("卡面人读中文＋计划摘要＋放行动作两步说明；不含裸参数名式工程语头", () => {
    const lines = launchCardLines(READY);
    expect(lines.join("\n")).toContain("训练启动");
    expect(lines.join("\n")).toContain("launch_ready_but_not_executed");
    expect(lines.join("\n")).toContain("run-ddl1");
    expect(lines.join("\n")).toContain("aaaaaaaaaaaa…");
    expect(lines.join("\n")).toContain("out/launch.sh");
    expect(lines.join("\n")).toContain("prep/iteration-config.json");
    expect(lines.join("\n")).toContain("1=确认放行并启动");
  });

  it("确认文本与合成动作：确定性、无 LLM；config 缺省时不携带", () => {
    expect(launchConfirmationText(READY)).toContain("launch.sh=out/launch.sh");
    expect(launchConfirmationText(READY)).toContain("配置=prep/iteration-config.json");
    const action = synthesizeLaunchAction(READY);
    expect(action).toEqual({
      tool: "atf_launch_execute",
      params: { launch_sh: "out/launch.sh", config: "prep/iteration-config.json" },
      origin: "confirm_card",
    });
    expect(synthesizeLaunchAction(READY)).toEqual(action);

    const bare: LaunchReady = { launch_sh: "x/launch.sh" };
    const bareAction = synthesizeLaunchAction(bare);
    expect(bareAction.params).toEqual({ launch_sh: "x/launch.sh" });
    expect(launchCardKey(READY)).toBe(`out/launch.sh|${"a".repeat(64)}`);
    expect(launchCardKey(bare)).toBe("x/launch.sh|-");
  });
});
