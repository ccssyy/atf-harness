/** D223 锚:lossless 回执吞单——装饰链在 asToolValue 清洗之后改写回执,
 * decisions 夹带 undefined 键(target_candidate_id/custom)使 vendor
 * snapshotToolValue 拒收整张段回执(ToolOutputError),agent 盲重跑。
 * 真机实锚 11-06 ci-bl-test1106-1:bl 裁决卡确认(15:52:25.150 落账)与
 * ToolOutputError(15:52:25)同毫秒——裁决结果对 agent 不可见。
 *
 * 修复=出口统一清洗:所有装饰链改写后的 return 出口必须过 asToolValue;
 * decisions 构造源头即剔除 undefined 键。本文件双锚:
 *   1) 行为锚:含嵌套 undefined 的装饰产物经 asToolValue 后可无损序列化;
 *   2) 源码锚:pipelineFace/trainingFace 不存在裸 `return decorated;` 出口
 *      (防止后续新增装饰链出口时退回旧形态)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asToolValue } from "../../packages/extensions/atf-tools/src/schemaTranslate.js";

describe("D223——装饰链回执 lossless 出口", () => {
  it("行为锚:label_qc 装饰链形态(嵌套 undefined)清洗后可无损序列化且有效键保留", () => {
    // 真机故障形态复现:target_candidate_id/custom 为 undefined
    const receipt = {
      ok: true,
      stage: "label_qc",
      label_qc_decisions: {
        decided_by: "user_confirmed",
        decisions: [
          { item_id: "qc-1", action: "accept", disposition: "", target_candidate_id: undefined, custom: undefined, decided_by: "user_confirmed" },
          { item_id: "qc-2", action: "reject", disposition: "keep_both_untouched", decided_by: "user_confirmed" },
        ],
      },
      escalate_block: { note: undefined, count: 2 },
    };
    const cleaned = asToolValue(receipt);
    // 无损序列化不抛、不含 "undefined" 文本(vendor walkJsonValue 等价判定面)
    const text = JSON.stringify(cleaned);
    expect(text).not.toContain("undefined");
    // undefined 键被剔除而非置 null;有效键全保留
    const first = (cleaned as unknown as {
      label_qc_decisions: { decisions: Array<Record<string, unknown>> };
    }).label_qc_decisions.decisions[0];
    expect(first).not.toHaveProperty("target_candidate_id");
    expect(first).not.toHaveProperty("custom");
    expect(first["item_id"]).toBe("qc-1");
    expect(first["decided_by"]).toBe("user_confirmed");
  });

  it("源码锚:atf-tools 各 face 不存在裸 return decorated 出口(装饰链出口必须 asToolValue 包裹)", () => {
    const faces = ["pipelineFace.ts", "trainingFace.ts", "bridgeFace.ts", "constructionGate.ts"] as const;
    for (const face of faces) {
      const src = readFileSync(join(process.cwd(), "packages/extensions/atf-tools/src", face), "utf8");
      const bare = src.match(/^\s*return decorated;\s*$/m);
      expect(bare, `${face} 存在裸 return decorated 出口——装饰链改写后的出口必须 return asToolValue(decorated)`).toBeNull();
    }
  });
});
