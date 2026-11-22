/**
 * G6 分层 evals · L1 行为 eval（轨迹断言，秒级，全跑）。
 *
 * 判据形态（eval-spec §2 L1 + §8「轨迹断言：验收含『轨迹必须出现指定工具调用』」）：
 * 断言 agent loop **实际调用了哪些工具、传了什么参数、收到什么结果**——不是断言最终文本。
 * 载体：段级 headless 驱动（`_pipelineHarness.ts`）＝夹具 + agent loop + 工具注入，不走 WebUI
 * （eval-spec §4.5 判据载体三分：行为判据走 headless/API 段级驱动）。
 * 模型面＝faux（零真实 LLM 调用，本批红线）。
 *
 * 覆盖本批 6 个历史事故中的 1/2/3/4（5/6 是结构面，在 l0.structure.test.ts）。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dropWorkspace, readJsonIfPresent, runSegment } from "./_pipelineHarness.js";

/** 字段清单预置（内核 register 段产出形态；字段卡的数据源）。 */
const seedFieldLabels = (runDir: string, labels: readonly string[]): void => {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(runDir, "prep"), { recursive: true });
  writeFileSync(
    join(runDir, "prep", "field-labels.json"),
    JSON.stringify({
      schema_version: "FieldLabels/v1",
      page_count: 3,
      label_count: labels.length,
      box_count: labels.length * 3,
      labels: labels.map((label) => ({ label, box_count: 3, page_count: 3, absent_pages: 0 })),
    }),
    "utf8",
  );
};

/** 字段确认账本预置（放行 experiment_setup 的字段闸；experiment_setup 用例前置）。 */
const seedFieldChoice = (runDir: string, docType: string, fields: readonly string[]): void => {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(runDir, "webui"), { recursive: true });
  writeFileSync(
    join(runDir, "webui", `field-choice.${docType}.json`),
    JSON.stringify({
      schema_version: "FieldChoice/v1",
      run_id: "run-evals",
      confirmed_fields: [...fields],
      all_fields: true,
      total_fields: fields.length,
      decided_at: new Date().toISOString(),
      source: "user_confirmed",
    }),
    "utf8",
  );
};

/** 两候选分组提案（每候选 ≥2 组、组内字段并集＝登记字段全集——出卡硬规则）。 */
const PROPOSAL = {
  schema_version: "GroupingProposal/v1",
  candidates: [
    {
      name: "按单据/明细两层",
      recommended: true,
      reason: "单据头和明细分开",
      groups: [
        { name: "单据级", fields: ["doc_identifier", "page_summary"] },
        { name: "明细级", fields: ["goods_name"] },
      ],
    },
    {
      name: "全部平铺成一组",
      recommended: false,
      reason: "不分层",
      groups: [{ name: "平铺", fields: ["doc_identifier", "page_summary", "goods_name"] }],
    },
  ],
};

const FIELDS = ["doc_identifier", "page_summary", "goods_name"] as const;

/** 构造卡三问的手打原文（N5/复验#24 的共同形态：用户说了话，工具不许替它懂）。 */
const CONSTRUCTION_CUSTOMS: ReadonlyArray<[string, string]> = [
  ["augment", "两倍就行"],
  ["targeted", "智能推导那个"],
  ["cutoff", "9000 吧"],
];

const answerConstructionCard = (question: { id: string; options?: Array<{ label: string }> }) => {
  if (question.id.startsWith("construction-")) {
    const custom = CONSTRUCTION_CUSTOMS.find(([key]) => question.id.includes(key))?.[1] ?? "";
    return { selected: [], custom };
  }
  if (question.id.startsWith("grouping-")) {
    const label = question.options?.[0]?.label ?? "";
    return { selected: label === "" ? [] : [label] };
  }
  return { selected: [], custom: "" };
};

describe("L1 · 事故4 B3c 断链：experiment_setup 轨迹回执必须含 construction_card_answers", () => {
  /**
   * 事故 4 · B3c 断链（原症状）：B3c 已把用户作答原文放进 `decideConstructionParams`
   * 返回的 `card_answers`，但 pipelineFace 消费时丢弃、只落 construction-choice.json 账本
   * ——**不在任何工具返回体**里，agent 看不到用户说了什么，B3c 目标在该链路断裂。
   * 文档锚：docs/audit/ATF_工具面自描述盘点_20261121.md §批次中发现的新缺口 ①。
   *
   * L1 判据：轨迹里 experiment_setup 这一步的**回执原文**必须含三问原话；
   * 只落账本（磁盘在场而回执缺席）＝断链形态，必须红。
   */
  it("三问手打原文逐条出现在工具回执（不只落账本）", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        answer: answerConstructionCard,
      },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
      },
    );
    try {
      expect(run.steps, "轨迹应含一次 atf_pipeline_stage 调用").toHaveLength(1);
      const step = run.steps[0];
      expect(step?.toolName).toBe("atf_pipeline_stage");
      // 轨迹参数面：调用确实带 experiment_setup（must_use 断言的对偶）
      expect(step?.args["stage"]).toBe("experiment_setup");

      const result = step?.result ?? {};
      const card = result["construction_card_answers"];
      expect(
        Array.isArray(card),
        "轨迹回执缺 construction_card_answers——用户作答只在账本里，agent 看不到（事故4 断链原形）",
      ).toBe(true);

      const said = (card as Array<{ field: string; said: string }>).map((item) => item.said).join("|");
      for (const [, custom] of CONSTRUCTION_CUSTOMS) {
        expect(said, `回执丢了用户原话「${custom}」——B3c 断链`).toContain(custom);
      }
      // 决定者凭据同在（不得为了透传而丢凭据）
      expect(result["construction_decided_by"]).toBe("user");
      // 回执原文（模型实际读到的文本）也必须含原话——防止只有 details 有、渲染文本没有
      expect(step?.resultText).toContain("两倍就行");
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("构造卡确实弹给用户（前提断言：卡不在场则上面的透传断言无意义）", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        answer: answerConstructionCard,
      },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
      },
    );
    try {
      const ids = run.cards.flatMap((card) =>
        ((card["questions"] ?? []) as Array<{ id: string }>).map((question) => question.id),
      );
      expect(
        ids.some((id) => id.startsWith("construction-")),
        "构造参数卡未弹——透传断言的前提不在场（前提不在=结构缺陷，不计行为失败）",
      ).toBe(true);
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});

describe("L1 · 事故3 ci-bl-1103：requested_group_count 必须进 marker（防循环确认）", () => {
  /**
   * 事故 3 · ci-bl-1103（原症状）：用户说「改成 3 组」，agent 无视该意愿、带原方案重出
   * 分组卡 → 循环确认（用户被迫在聊天里反复裁决）。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md §四「口径修订」/施工卡 G6 事故表；
   * 修复形态＝agent 理解原话后带 `requested_group_count` 显式参数重调，工具落 run 级
   * marker 并以它为硬约束。
   *
   * L1 判据（must_use）：轨迹里 agent 的**调用参数**携带 requested_group_count，
   * 且回执声明 regroup_request，且 marker 落盘含同一个数。
   * must_not_use：工具不得自己从自由文本猜组数（即卡上原话只回传、不落 marker——
   * 下一步由 agent 带参重调时才有 marker）。
   */
  it("agent 带 requested_group_count=3 重调 → 轨迹参数在场 + 回执 regroup_request + marker 落盘", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        answer: () => ({ selected: [], custom: "分3组" }),
      },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
        // agent 读懂用户「分3组」后显式带上（B3c 规定的重调形态）
        requested_group_count: 3,
        grouping_quote: "分3组",
      },
    );
    try {
      const step = run.steps[0];
      expect(step?.args["requested_group_count"], "轨迹调用参数未携带 requested_group_count——agent 的组数意愿未进接口").toBe(3);

      const result = step?.result ?? {};
      expect(result["grouping_decision"]).toBe("regroup_request");
      expect(step?.resultText).toContain("用户明确要求3组");

      const marker = readJsonIfPresent(join(run.runDir, "runtime", "webui", "grouping-request.json"));
      expect(marker, "marker 未落盘——下一轮出卡无硬约束，循环确认事故原形").not.toBeNull();
      expect(marker?.["requested_group_count"]).toBe(3);
      // 注：marker 的 raw_text（原话留痕）本轮实测恒为空串——`grouping_quote` 已声明为
      // 入参且 resolveGroupingFace 有读侧（pipelineFace.ts:841），但调用点
      // （pipelineFace.ts:3315-3327）未把它传下去，留痕链路断开。属**本批发现的实现缺陷**，
      // 按任务书「只加测试，不动实现」不在此顺手修、也不把现状锁成断言；
      // 缺陷已登记在交付报告 §7。核心判据（组数进 marker）由上面的断言覆盖。
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("marker 在场而候选组数不符 → 拒绝出卡（regroup_required），不再循环确认", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => {
          seedFieldChoice(runDir, "ci", FIELDS);
          const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
          mkdirSync(join(runDir, "runtime", "webui"), { recursive: true });
          writeFileSync(
            join(runDir, "runtime", "webui", "grouping-request.json"),
            JSON.stringify({ requested_group_count: 3, raw_text: "分3组", at: new Date().toISOString() }),
            "utf8",
          );
        },
        answer: answerConstructionCard,
      },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
      },
    );
    try {
      const result = run.steps[0]?.result ?? {};
      expect(result["grouping_decision"]).toBe("regroup_required");
      expect(run.steps[0]?.resultText).toContain("拒绝出卡");
      // must_not_use：此形态下不得再弹分组卡（弹=又一轮违背意愿的确认循环）
      const groupingCards = run.cards.filter((card) =>
        ((card["questions"] ?? []) as Array<{ id: string }>).some((question) => question.id.startsWith("grouping-")),
      );
      expect(groupingCards, "候选组数不符仍弹了分组卡——循环确认事故原形").toHaveLength(0);
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});

describe("L1 · 事故1 复验#24 / 事故2 N5：用户自述原话必须回传（静默吞路径不可达）", () => {
  /**
   * 事故 1 · 复验#24（原症状）：用户写「除 awb_title 外的 16 个都要」→ 旧正则没认出
   * → **静默吞掉**，卡消失、凭据不落，agent 完全不知道用户说过话。
   * 事故 2 · N5（原症状）：WebUI 把 selected 回传成整行文字时，「2 倍」被吞成「不增强」
   * ——解析层改写/丢弃用户值。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md §四「未清偿项 ③ B3 删提问卡正则解析」
   * （两事故同源；解法从「把正则写强」改为「不猜，原话留底」）。
   *
   * L1 判据（must_use）：register 段字段卡回执必须含 `user_words` ＝用户原话原文；
   * must_not_use：不得出现「静默吞」形态——即回执里既无 user_words 也无 confirmed_fields，
   * 或 user_words 被改写成结构化猜测值（原话不在回执里）。
   */
  it("字段卡手打「除了 X 外的 N 个都要」→ 原话原样进回执 user_words（不被吞）", async () => {
    const typed = "除了 awb_title 外的 16 个都要";
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldLabels(runDir, FIELDS),
        answer: (question) => {
          if (question.id.startsWith("field-choice-")) return { selected: [], custom: typed };
          return { selected: [], custom: "" };
        },
      },
      {
        stage: "register",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
      },
    );
    try {
      const step = run.steps[0];
      expect(step?.toolName).toBe("atf_pipeline_stage");
      const fieldChoice = (step?.result ?? {})["field_choice"] as Record<string, unknown> | undefined;
      expect(fieldChoice, "register 回执缺 field_choice——字段卡结果未回传").toBeDefined();
      expect(
        fieldChoice?.["user_words"],
        "用户原话被静默吞（revalidation#24 原形）——回执里必须原样带上用户说的话",
      ).toBe(typed);
      // 原话必须在模型读到的渲染文本里（不只在 details）
      expect(step?.resultText).toContain(typed);
      // 不得伪造成「用户确认了」——手打文字不等于卡上确认
      expect(fieldChoice?.["all_fields"]).toBe(false);
      expect(fieldChoice?.["confirmed_fields"]).toEqual([]);
      // 回执必须带重调指引（agent 知道下一步）
      expect(fieldChoice?.["retry_hint"]).toBeTruthy();
      expect(Array.isArray(fieldChoice?.["all_field_names"]), "缺全量字段名——agent 无法把口语对上字段").toBe(true);
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("事故2 N5：构造卡「2 倍」不被改写成「不增强」——原话照录进回执", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        answer: (question) => {
          if (question.id.includes("construction-augment")) return { selected: [], custom: "2 倍" };
          if (question.id.startsWith("grouping-")) {
            const label = question.options?.[0]?.label ?? "";
            return { selected: label === "" ? [] : [label] };
          }
          return { selected: [], custom: "" };
        },
      },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
      },
    );
    try {
      const result = run.steps[0]?.result ?? {};
      const card = result["construction_card_answers"] as Array<{ field: string; said: string }> | undefined;
      expect(Array.isArray(card), "构造卡回执缺 card_answers").toBe(true);
      const augment = (card ?? []).find((item) => item.field.includes("增强"));
      expect(augment, "回执丢掉了增强倍率这一问的作答").toBeDefined();
      expect(augment?.said, "「2 倍」被改写/吞掉了（N5 原形）").toBe("2 倍");
      // must_not_use：不得出现「不增强」这种静默改成默认值的形态
      const decisions = JSON.stringify(result["construction_card_answers"] ?? []);
      expect(decisions).not.toContain("不增强");
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("must_not_use：卡上什么都没说时不得伪造 user_words（防假绿——空应答≠用户确认）", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldLabels(runDir, FIELDS),
        answer: () => ({ selected: [], custom: "" }),
      },
      {
        stage: "register",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
      },
    );
    try {
      const fieldChoice = (run.steps[0]?.result ?? {})["field_choice"] as Record<string, unknown> | undefined;
      expect(fieldChoice, "register 回执缺 field_choice").toBeDefined();
      // 空应答：user_words 应为空串（或 null），绝不能编造出原话
      const said = fieldChoice?.["user_words"];
      expect(said === "" || said === null || said === undefined, `空应答被编造成了「${String(said)}」——静默造数`).toBe(true);
      expect(fieldChoice?.["all_fields"]).toBe(false);
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});
