/**
 * #13（owner 裁定 2026-11-02）：选项类提问统一走原生提问卡——提问卡=产品统一
 * 问询通道，聊天框不承载选项问询。桥接返回体 pending_confirmations 的选项类
 * 收编为原生选项卡问题集；纯信息披露（无 options）不进卡；答案结构化回传
 * pending_answers（agent 据此组装重跑参数，不再聊天转述重复提问）。
 */
import { describe, expect, it } from "vitest";
import { pendingAnswersOf, pendingChoiceQuestionsOf } from "../../packages/extensions/atf-tools/src/bridgeFace.js";

describe("#13 桥接返回体选项类待确认收编原生卡", () => {
  it("选项类进卡：title/detail/options 逐项映射为原生选项卡问题", () => {
    const pending = [
      { title: "小簇过多，怎么处理？", detail: "62 个单页簇", options: ["合并相近小类", "全小簇单训", "放弃本轮"] },
    ];
    const { questions, meta } = pendingChoiceQuestionsOf(pending);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe("pending-0");
    expect(questions[0]?.question).toBe("小簇过多，怎么处理？");
    expect(questions[0]?.detail).toBe("62 个单页簇");
    expect(questions[0]?.options?.map((opt) => opt.label)).toEqual(["合并相近小类", "全小簇单训", "放弃本轮"]);
    expect(meta).toEqual([{ title: "小簇过多，怎么处理？" }]);
  });

  it("非选项类不收编：无 options/空 title/非对象项全部跳过", () => {
    const pending = [
      { title: "纯披露项", detail: "无选项" },
      { title: "", options: ["a"] },
      { title: "空选项", options: [] },
      null,
      "bad",
    ];
    const { questions, meta } = pendingChoiceQuestionsOf(pending);
    expect(questions).toHaveLength(0);
    expect(meta).toHaveLength(0);
  });

  it("多题次序稳定：id 按收编序递增（跳过项不占号）", () => {
    const pending = [
      { title: "披露", detail: "x" },
      { title: "第一问", options: ["a", "b"] },
      { title: "第二问", options: ["c"] },
    ];
    const { questions } = pendingChoiceQuestionsOf(pending);
    expect(questions.map((q) => q.id)).toEqual(["pending-0", "pending-1"]);
    expect(questions.map((q) => q.question)).toEqual(["第一问", "第二问"]);
  });

  it("答案映射：selected 逐题对位，custom 非空才带，缺席答案=空 selected", () => {
    const meta = [{ title: "第一问" }, { title: "第二问" }];
    const answers = [
      { id: "pending-0", selected: ["a"], custom: "  " },
      { id: "pending-1", selected: ["c"], custom: "其实我想按船公司分" },
    ];
    expect(pendingAnswersOf(meta, answers)).toEqual([
      { title: "第一问", selected: ["a"] },
      { title: "第二问", selected: ["c"], custom: "其实我想按船公司分" },
    ]);
    // 某题未答（答案缺席）——如实空 selected 不造默认
    expect(pendingAnswersOf(meta, [{ id: "pending-0", selected: ["a"] }])).toEqual([
      { title: "第一问", selected: ["a"] },
      { title: "第二问", selected: [] },
    ]);
  });
});
