/**
 * D76 卡位入卡——harness 侧两锚（指令《ATF_指令_D76_卡位入卡_20261023》§三 harness T4/T5）。
 *
 * T4 卡面渲染该字段；留空提交 → config snapshot 无该键（不覆盖 deploy）。
 * T5 填 4,5,6,7 而 nproc=8 → 卡前红字拒绝（业务语言，零内部码），不进授权链。
 *
 * 键名/校验语义与内核侧 generate_iteration_config 的 visible_devices 逐字一致
 * （逗号分隔整数或 a-b 段、元素 0–7、不重复、个数须等于 nproc_per_node）；
 * 红线：缺省保持「回退 deploy」，校验失败为卡前红字＋业务语言（不出码原文）。
 */
import { describe, expect, it } from "vitest";
import { CONFIG_CONFIRM_KEYS, buildConfigConfirmFields, configFieldPlaceholderOf } from "../../src/webui/configConfirm.js";
import {
  confirmedSnapshotOf,
  configFormFieldsOf,
  visibleDevicesViolationsOf,
  type ConfigConfirmField,
} from "../../packages/extensions/atf-tools/src/confirmFace.js";

const fieldOf = (key: string, value: string): ConfigConfirmField => ({ key, value, tag: "need_confirm" });

describe("D76 卡位入卡：卡面渲染与快照空值纪律（T4）", () => {
  it("CONFIG_CONFIRM_KEYS 含 visible_devices（label 与指令件逐字一致；缺省空＝回退 deploy）", () => {
    const entry = CONFIG_CONFIRM_KEYS.find((k) => k.key === "visible_devices");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("卡位 visible_devices（留空＝全部可见卡）");
    expect(entry?.default).toBe("");
  });

  it("卡面渲染该字段（configFormFieldsOf 单源——键行在场＋域提示逐键）", () => {
    const fields = buildConfigConfirmFields({ visible_devices: "4,5,6,7", nproc_per_node: "4" });
    const rows = configFormFieldsOf(fields, 8);
    const row = rows.find((r) => r.key === "visible_devices");
    expect(row).toBeDefined();
    expect(row?.value).toBe("4,5,6,7");
    expect(row?.hint).toContain("0–7");
    expect(row?.hint).toContain("留空＝全部可见卡");
  });

  it("留空提交 → 快照无该键（禁空串覆盖 deploy 缺省）；有值 → 原样落键", () => {
    const blank = confirmedSnapshotOf([
      fieldOf("nproc_per_node", "4"),
      fieldOf("visible_devices", ""),
      fieldOf("learning_rate", "1e-4"),
    ]);
    expect("visible_devices" in blank).toBe(false);
    expect(blank["nproc_per_node"]).toBe("4");
    expect(blank["learning_rate"]).toBe("1e-4");
    const filled = confirmedSnapshotOf([
      fieldOf("nproc_per_node", "4"),
      fieldOf("visible_devices", " 4,5,6,7 "),
    ]);
    expect(filled["visible_devices"]).toBe(" 4,5,6,7 ");
  });

  // H7c：留空看着像没填 → 输入框占位提示（呈现层）。三跳同验：①字段载荷带提示
  // ②提示文案单源（机器事实卡数−1，未探测到不编造区间）③提示不入值、不落快照。
  it("空值输入框占位提示＝自动全部可见卡（卡数−1）；提示不入值、不落快照", () => {
    const rows = configFormFieldsOf(buildConfigConfirmFields({}), 8);
    const row = rows.find((r) => r.key === "visible_devices");
    expect(row?.placeholder).toBe("自动（全部可见卡 0-7）");
    expect(row?.value).toBe("");
    // 未探测到卡数＝不编造区间
    const unknown = configFormFieldsOf(buildConfigConfirmFields({}), null).find((r) => r.key === "visible_devices");
    expect(unknown?.placeholder).toBe("自动（全部可见卡）");
    // 已填值：值原样、提示不参与落盘（占位只在空值显示，值永不被提示污染）
    const filledRows = configFormFieldsOf(buildConfigConfirmFields({ visible_devices: "4-7" }), 8);
    const filledRow = filledRows.find((r) => r.key === "visible_devices");
    expect(filledRow?.value).toBe("4-7");
    const snapshot = confirmedSnapshotOf(buildConfigConfirmFields({ visible_devices: "4-7" }));
    expect(snapshot["visible_devices"]).toBe("4-7");
    // 空值落盘面复核：占位在场但值仍空 → 快照无该键
    expect(confirmedSnapshotOf(buildConfigConfirmFields({}))["visible_devices"]).toBeUndefined();
    // 提示文案与「留空＝全部可见卡」标签语义同源，且不写内部键名叙事
    expect(configFieldPlaceholderOf("visible_devices", 8)).toContain("全部可见卡");
    expect(configFieldPlaceholderOf("nproc_per_node", 8)).toBeUndefined();
  });
});

describe("D76 卡位入卡：卡前校验（T5——红字业务语言，零内部码）", () => {
  it("填 4,5,6,7 而 nproc=8 → 红字拒绝（个数不符）；红字不含内部码原文", () => {
    const violations = visibleDevicesViolationsOf([
      fieldOf("visible_devices", "4,5,6,7"),
      fieldOf("nproc_per_node", "8"),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("不一致");
    expect(violations[0]).toContain("4,5,6,7");
    expect(violations.join("\n")).not.toContain("visible_devices_nproc_mismatch");
    expect(violations.join("\n")).not.toContain("ValueError");
  });

  it("形态拒：越界（4,5,9）/重复（4,4）/非法 token → 业务红字（0–7 闭集、不重复）", () => {
    const outOfRange = visibleDevicesViolationsOf([fieldOf("visible_devices", "4,5,9"), fieldOf("nproc_per_node", "3")]);
    expect(outOfRange.join("")).toContain("0–7");
    const duplicated = visibleDevicesViolationsOf([fieldOf("visible_devices", "4,4"), fieldOf("nproc_per_node", "2")]);
    expect(duplicated.join("")).toContain("重复");
    const malformed = visibleDevicesViolationsOf([fieldOf("visible_devices", "4;5"), fieldOf("nproc_per_node", "2")]);
    expect(malformed.join("")).toContain("形态不对");
  });

  it("a-b 区间等价逗号形态（4-7＝4 张）；个数相等/留空均放行（空数组＝通过）", () => {
    expect(visibleDevicesViolationsOf([fieldOf("visible_devices", "4-7"), fieldOf("nproc_per_node", "4")])).toEqual([]);
    expect(visibleDevicesViolationsOf([fieldOf("visible_devices", "4,5,6,7"), fieldOf("nproc_per_node", "4")])).toEqual([]);
    expect(visibleDevicesViolationsOf([fieldOf("visible_devices", ""), fieldOf("nproc_per_node", "8")])).toEqual([]);
    expect(visibleDevicesViolationsOf([fieldOf("visible_devices", "0-3,6"), fieldOf("nproc_per_node", "5")])).toEqual([]);
  });
});
