/**
 * F14：label_qc「看得到冲突、交不了裁决」缺口的防回退锚。
 *
 * 现场症状（UAT 1027-1）：体检段因待确认项阻断后，会话里没路可走，agent 把任务当新的重开，
 * 同一实验下不断新增 run 目录（`workspace/runs/run-awb-01/03/04`）。根因不是内核缺功能——
 * 内核注册了 `atf_label_qc.inspect` 与 `atf_label_qc.resolve`（`session/tools.py:3657-3658`），
 * 也不是缺定义——harness 有 `atf_label_qc_resolve` 定义与方法映射；而是 DSH 面按
 * `BRIDGE_TOOL_NAMES` 过滤（`bridgeFace.ts:262`），名单里只有 inspect。
 */
import { describe, expect, it } from "vitest";

import { BRIDGE_TOOL_NAMES } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { labelQcResumeHintOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { TOOL_DEFINITIONS } from "../../src/core/tools/index.js";

describe("F14 裁决入口在 DSH 面可达", () => {
  it("BRIDGE_TOOL_NAMES 同时含 inspect 与 resolve（只给 inspect＝只能看不能裁）", () => {
    expect(BRIDGE_TOOL_NAMES).toContain("atf_label_qc_inspect");
    expect(BRIDGE_TOOL_NAMES).toContain("atf_label_qc_resolve");
  });

  it("resolve 的定义与参数面真实存在（不是只加了名单）", () => {
    const definition = TOOL_DEFINITIONS.find(entry => entry.name === "atf_label_qc_resolve");
    expect(definition).toBeDefined();
    const params = definition?.parameters as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(params?.properties ?? {})).toContain("decisions");
  });
});

describe("F14 阻断回执自带续跑指路", () => {
  it("label_qc + exit 2 → next 指明 inspect→resolve→同一 run 重跑，且标 same_run_required", () => {
    const hint = labelQcResumeHintOf("label_qc", 2);
    expect(hint["next_action"]).toBe("label_adjudication");
    expect(hint["same_run_required"]).toBe(true);
    expect(String(hint["next"])).toContain("atf_label_qc_inspect");
    expect(String(hint["next"])).toContain("atf_label_qc_resolve");
    expect(String(hint["next"])).toContain("同一个 run_id");
  });

  it("其它段或成功态不加键（不污染回执）", () => {
    expect(labelQcResumeHintOf("register", 2)).toEqual({});
    expect(labelQcResumeHintOf("label_qc", 0)).toEqual({});
    expect(labelQcResumeHintOf("label_qc", null)).toEqual({});
  });
});
