// 批C2 E5——审批卡面结构化模板（buildApprovalReason 单源）＋调用点全量走模板的源面钉。
//
// - 模板四行固定形状（将要执行/影响范围/可逆性/预计代价；cost 缺省「按任务卡」）；
// - 源面扫描：全部 requestApproval 调用点的 reason 一律经 buildApprovalReason 构造
//   （禁自由文案形态）；
// - 文案纪律：零「手搓版」「同款」自拟黑话（O7 根因字面）。
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
] as const;

describe("批C2 E5 模板形状（buildApprovalReason）", () => {
  it("四行固定前缀＋action/target 合行＋cost 缺省「按任务卡」", () => {
    const reason = buildApprovalReason({
      action: "启动真实 GPU 训练",
      target: "（train.sh=x）",
      effect: "占用 GPU 与写训练产物",
      reversible: "不可自动回滚（产物可人工清理）",
    });
    const lines = reason.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("将要执行：启动真实 GPU 训练（train.sh=x）");
    expect(lines[1]).toBe("影响范围：占用 GPU 与写训练产物");
    expect(lines[2]).toBe("可逆性：不可自动回滚（产物可人工清理）");
    expect(lines[3]).toBe("预计代价：按任务卡");
  });
  it("cost 显式值生效；空 target 容忍（action 单独成义）", () => {
    const reason = buildApprovalReason({ action: "执行工具", target: "", effect: "只读", reversible: "可逆", cost: "无额外代价（本地读取）" });
    expect(reason.split("\n")[0]).toBe("将要执行：执行工具");
    expect(reason.split("\n")[3]).toBe("预计代价：无额外代价（本地读取）");
  });
});

describe("批C2 E5 调用点全量走模板（源面钉——禁自由文案）", () => {
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
});
