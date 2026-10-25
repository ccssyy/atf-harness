// 批C2 E5——审批卡面结构化模板（buildApprovalReason 单源）＋调用点全量走模板的源面钉。
//
// - 模板三行固定形状（将要执行/影响范围/可逆性；E8b·H3 D152 起「预计代价」行退役——
//   缺省文案「按任务卡」属工程措辞，实义代价〔GPU 卡数等〕并入 effect 呈现）；
// - 源面扫描：全部 requestApproval 调用点的 reason 一律经 buildApprovalReason 构造
//   （禁自由文案形态）；
// - 文案纪律：零「手搓版」「同款」自拟黑话（O7 根因字面）；卡面零内部工具名与
//   「按任务卡」（D152：atf_* 工具名只进日志与审计面）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApprovalReason } from "../../packages/extensions/atf-tools/src/approvalFace.js";

const SRC_DIR = join(import.meta.dirname, "../../packages/extensions/atf-tools/src");
const CALL_SITE_FILES = [
  "recordsFace.ts",
  "pipelineFace.ts",
  "bridgeFace.ts",
  "confirmFace.ts",
  "trainingFace.ts",
  "fileFace.ts",
  "fileGuardFace.ts",
  "jointTrainFace.ts",
  "quantizeFace.ts",
  "preflightFace.ts",
] as const;

describe("模板形状（buildApprovalReason——E8b·H3 三行）", () => {
  it("三行固定前缀＋action/target 合行；不再有「预计代价」行", () => {
    const reason = buildApprovalReason({
      action: "启动真实 GPU 训练",
      target: "（train.sh=x）",
      effect: "占用 GPU 与写训练产物",
      reversible: "不可自动回滚（产物可人工清理）",
    });
    const lines = reason.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("将要执行：启动真实 GPU 训练（train.sh=x）");
    expect(lines[1]).toBe("影响范围：占用 GPU 与写训练产物");
    expect(lines[2]).toBe("可逆性：不可自动回滚（产物可人工清理）");
    expect(reason).not.toContain("预计代价");
    expect(reason).not.toContain("按任务卡");
  });
  it("空 target 容忍（action 单独成义）", () => {
    const reason = buildApprovalReason({ action: "执行工具", target: "", effect: "只读", reversible: "可逆" });
    expect(reason.split("\n")[0]).toBe("将要执行：执行工具");
  });
});

describe("调用点全量走模板（源面钉——禁自由文案）", () => {
  it("每个 requestApproval 调用的 reason 一律含 buildApprovalReason（approvalFace 自身定义除外）", () => {
    for (const file of CALL_SITE_FILES) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      let cursor = 0;
      let calls = 0;
      while (true) {
        const at = source.indexOf("requestApproval(", cursor);
        if (at < 0) break;
        // 取调用点后 900 字符窗口（跨多行模板参数），reason 必须由 buildApprovalReason 构造
        const window = source.slice(at, at + 900);
        expect(
          window.includes("buildApprovalReason("),
          `${file}@${at}: requestApproval 调用未走 buildApprovalReason 模板`,
        ).toBe(true);
        cursor = at + 1;
        calls += 1;
      }
      expect(calls, `${file} 应含 requestApproval 调用`).toBeGreaterThan(0);
    }
  });
  it("文案纪律：atf-tools 源面零自拟黑话（手搓版/同款）", () => {
    for (const file of CALL_SITE_FILES) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      // 「手搓」在注释/文档性描述中的历史用法允许（仅卡面文案禁）；「手搓版同款」连用形态零容忍
      expect(source.includes("手搓版同款"), `${file} 含「手搓版同款」黑话`).toBe(false);
    }
  });
  it("E8b·H3 D152：审批卡源面零「按任务卡」与 cost 传参（模板三行化——实义代价并入 effect）", () => {
    for (const file of CALL_SITE_FILES) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source.includes("按任务卡"), `${file} 卡面源仍含「按任务卡」`).toBe(false);
      expect(/cost:\s/.test(source), `${file} 仍含 cost 传参`).toBe(false);
    }
  });
  it("E8b·H3 D152：桥接通用卡 action 走业务动作名映射（卡面零 atf_* 工具名）", () => {
    const source = readFileSync(join(SRC_DIR, "bridgeFace.ts"), "utf8");
    expect(source).toContain("BRIDGE_ACTION_LABELS");
    expect(source).toContain('action: BRIDGE_ACTION_LABELS[definition.name] ?? "执行训练流程操作"');
    // 卡面构造处不再出现 target 回填工具名形态
    expect(source).not.toContain("target: `（${definition.name}）`");
  });
});
