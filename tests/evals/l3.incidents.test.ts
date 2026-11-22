/**
 * G6 分层 evals · L3 对抗用例（历史事故固化，收口/发版批跑；本批全量跑）。
 *
 * 元规则 2「围栏唯一合法来源是真实事故」：每条用例带事故出处注释（编号 + 原症状 +
 * 文档锚），且必须能**复现原事故形态**——不是复述实现的当前行为，是把事故的坏形态
 * 造出来，断言系统不再放过它。
 *
 * 与 L1 的分工：L1 断言「正路轨迹上必须出现的调用/回传」；L3 断言「事故形态出现时
 * 系统必须拦/必须如实回传」——同一事故在两层各有断言，L3 是复现式对抗。
 * 载体同 L1：段级 headless 驱动 + faux provider（零真实 LLM 调用）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dropWorkspace, readJsonIfPresent, runSegment } from "./_pipelineHarness.js";

const FIELDS = ["doc_identifier", "page_summary", "goods_name"] as const;

/** 字段确认账本预置（experiment_setup 的字段闸前置）。 */
const seedFieldChoice = (runDir: string, docType: string, fields: readonly string[]): void => {
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

/** 字段清单预置（register 段字段卡数据源）。 */
const seedFieldLabels = (runDir: string, labels: readonly string[]): void => {
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

/** 常规卡应答：分组卡选首候选，构造卡三问手打，其余空选。 */
const answerCards = (question: { id: string; options?: Array<{ label: string }> }) => {
  if (question.id.startsWith("grouping-")) {
    const label = question.options?.[0]?.label ?? "";
    return { selected: label === "" ? [] : [label] };
  }
  if (question.id.includes("construction-augment")) return { selected: [], custom: "两倍就行" };
  if (question.id.includes("construction-targeted")) return { selected: [], custom: "智能推导那个" };
  if (question.id.includes("construction-cutoff")) return { selected: [], custom: "9000 吧" };
  return { selected: [], custom: "" };
};

/** 卡 id 全表（用于「某张卡该不该弹」的断言）。 */
const cardIdsOf = (cards: readonly Record<string, unknown>[]): string[] =>
  cards.flatMap((card) => ((card["questions"] ?? []) as Array<{ id: string }>).map((question) => question.id));

// ================================================================ 事故 4

describe("L3 · 事故4 B3c 断链：构造卡作答原文必须进工具回执", () => {
  /**
   * 事故编号 4 · B3c 断链。
   * 原症状：`decideConstructionParams` 已返回 `card_answers`，但 pipelineFace 消费时丢弃、
   * 只落 construction-choice.json 账本——**任何工具返回体都看不到**，agent 无从知道
   * 用户在卡上说了什么，B3c（答案原样回 agent）在该链路断裂。
   * 文档锚：docs/audit/ATF_工具面自描述盘点_20261121.md §批次中发现的新缺口 ①
   *         （原文：「修它要动 return 组装，立独立小批」）；A2 透传批修复。
   *
   * 对抗形态：制造「用户作答了但回执无原话」的现场（构造卡三问全手打），断言回执必须带原文。
   */
  it("用户三问全手打 → 回执 construction_card_answers 逐条在场（断链形态不可复现）", async () => {
    const run = await runSegment(
      { seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS), answer: answerCards },
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
      expect(Array.isArray(card), "回执缺 construction_card_answers——B3c 断链形态复现").toBe(true);
      expect((card ?? []).length, "三问应有三条作答留痕").toBe(3);
      const said = (card ?? []).map((item) => item.said).join("|");
      expect(said).toContain("两倍就行");
      expect(said).toContain("智能推导那个");
      expect(said).toContain("9000 吧");
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("账本落盘 ≠ 回执在场：同时断言两处，防「只落账本」假绿", async () => {
    const run = await runSegment(
      { seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS), answer: answerCards },
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
      const ledgerPath = join(run.runDir, "runtime", "webui", "construction-choice.json");
      expect(existsSync(ledgerPath), "账本应落盘（审计面）").toBe(true);
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { answers?: Record<string, string> };
      expect(ledger.answers?.["augment"], "账本丢原文").toBe("两倍就行");

      // 断链事故的本质是「账本有、回执无」——两处任一缺失都必须红
      const result = run.steps[0]?.result ?? {};
      expect(result["construction_card_answers"], "账本有原文而回执没有＝事故4 原形").toBeDefined();
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});

// ================================================================ 事故 3

describe("L3 · 事故3 ci-bl-1103 组数指令：候选不符时必须拒绝出卡", () => {
  /**
   * 事故编号 3 · ci-bl-1103（循环确认）。
   * 原症状：用户说「改成 3 组」，agent 无视该意愿、带原方案重出分组卡 → 用户被迫在聊天里
   * 反复裁决「ci可以，bl也要3组」；卡弹了又问、问了又弹。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md（G1-G4 验收结论相邻批的裁定面）；
   *         施工卡 G6 事故表第 3 行。
   *
   * 对抗形态：marker 已在场（用户要 3 组）而 agent 仍带 2 组/1 组候选 → 工具必须
   * 拒绝出卡（regroup_required），不得再弹一张违背用户意愿的卡。
   */
  it("marker=3 组而候选全不是 3 组 → regroup_required 且零分组卡（循环确认不可复现）", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => {
          seedFieldChoice(runDir, "ci", FIELDS);
          mkdirSync(join(runDir, "runtime", "webui"), { recursive: true });
          writeFileSync(
            join(runDir, "runtime", "webui", "grouping-request.json"),
            JSON.stringify({ requested_group_count: 3, raw_text: "分3组", at: new Date().toISOString() }),
            "utf8",
          );
        },
        answer: answerCards,
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
      expect(result["grouping_decision"], "候选组数不符却未拒绝——循环确认事故原形").toBe("regroup_required");
      expect(run.steps[0]?.resultText).toContain("拒绝出卡");
      // 真因必须可读（agent 知道要按几组重设计）
      expect(run.steps[0]?.resultText).toContain("3组");
      expect(cardIdsOf(run.cards).filter((id) => id.startsWith("grouping-")), "不该再弹分组卡").toHaveLength(0);
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("marker 缺席时工具绝不自造组数（工具不猜——B3c 前提）", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        // 用户手打「分3组」但 agent 未带 requested_group_count（尚未理解/尚未重调）
        answer: (question) => {
          if (question.id.startsWith("grouping-")) return { selected: [], custom: "分3组" };
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
      // 工具不得从自由文本猜出组数落 marker（那是被 B3 明令退役的行为）
      expect(
        readJsonIfPresent(join(run.runDir, "runtime", "webui", "grouping-request.json")),
        "工具从自由文本猜了组数并落 marker——B3 退役的正则解析行为回潮",
      ).toBeNull();
      // 原话必须如实回传 agent（不许静默丢）
      expect(run.steps[0]?.resultText).toContain("分3组");
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("agent 带 requested_group_count 重调 → marker 落盘且回执声明 regroup_request", async () => {
    const run = await runSegment(
      { seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS), answer: answerCards },
      {
        stage: "experiment_setup",
        run_id: "run-evals",
        experiment: "exp-evals",
        doc_type: "ci",
        visual_readings: { fields: {} },
        grouping_proposal: PROPOSAL,
        requested_group_count: 3,
      },
    );
    try {
      const result = run.steps[0]?.result ?? {};
      expect(result["grouping_decision"]).toBe("regroup_request");
      const marker = readJsonIfPresent(join(run.runDir, "runtime", "webui", "grouping-request.json"));
      expect(marker?.["requested_group_count"], "marker 未落组数——下一轮无硬约束").toBe(3);
      // 回执必须明说「不得再带原组数方案重出」（防循环的指令面）
      expect(run.steps[0]?.resultText).toContain("不得再带原组数方案重出");
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});

// ================================================================ 事故 1

describe("L3 · 事故1 复验#24：「除 X 外的 N 个都要」不得被静默吞", () => {
  /**
   * 事故编号 1 · 复验#24。
   * 原症状：用户写「除 awb_title 外的 16 个都要」→ 旧正则没认出 → **静默吞掉**，
   * 卡消失、凭据不落，agent 完全不知道用户说过话（也就不会追问）。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md §四「未清偿项 ③ B3 删提问卡正则解析」
   *         （原文：「11-08（复验#24）：『除 X 外的 N 个都要』被正则静默吞，卡消失凭据不落」）；
   *         解法演进：把正则写强 → 不猜，原话留底（`parseFieldChoiceInput` 已退役）。
   *
   * 对抗形态：合成该原话输入，断言原话必然出现在回执（含渲染文本），且不得被伪造成
   * 「用户已确认全部字段」——两种静默（丢话 / 假确认）都不许。
   */
  it("合成「除了 awb_title 外的 16 个都要」→ 原话进回执且不伪造成已确认", async () => {
    const typed = "除了 awb_title 外的 16 个都要";
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldLabels(runDir, FIELDS),
        answer: (question) => {
          if (question.id.startsWith("field-choice-")) return { selected: [], custom: typed };
          return { selected: [], custom: "" };
        },
      },
      { stage: "register", run_id: "run-evals", experiment: "exp-evals", doc_type: "ci" },
    );
    try {
      const result = run.steps[0]?.result ?? {};
      const fieldChoice = result["field_choice"] as Record<string, unknown> | undefined;
      expect(fieldChoice, "register 回执缺 field_choice").toBeDefined();
      expect(fieldChoice?.["user_words"], "用户原话被静默吞（复验#24 原形）").toBe(typed);
      // 渲染文本（模型实际读到的）也必须含原话
      expect(run.steps[0]?.resultText).toContain(typed);
      // 两种静默形态：① 丢话 ② 假确认——后者表现为 all_fields=true / confirmed_fields 非空
      expect(fieldChoice?.["all_fields"], "手打文字被伪造成「全部字段都训练」").toBe(false);
      expect(fieldChoice?.["confirmed_fields"], "手打文字被伪造成已确认清单").toEqual([]);
      // 不许落账（手打文字不构成用户确认，凭据不得凭空成立）
      expect(existsSync(join(run.runDir, "webui", "field-choice.ci.json")), "手打文字落了确认账本——凭据造假").toBe(false);
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("无法理解的表述（「分两拨」「一半一半」）同样必须留底——覆盖不到也不能丢", async () => {
    for (const typed of ["分两拨", "一半一半"]) {
      const run = await runSegment(
        {
          seedRunDir: (runDir) => seedFieldLabels(runDir, FIELDS),
          answer: (question) => {
            if (question.id.startsWith("field-choice-")) return { selected: [], custom: typed };
            return { selected: [], custom: "" };
          },
        },
        { stage: "register", run_id: "run-evals", experiment: "exp-evals", doc_type: "ci" },
      );
      try {
        const fieldChoice = (run.steps[0]?.result ?? {})["field_choice"] as Record<string, unknown> | undefined;
        expect(fieldChoice?.["user_words"], `「${typed}」被静默吞——正则覆盖不到就丢话`).toBe(typed);
      } finally {
        dropWorkspace(run.workspace);
      }
    }
  });
});

// ================================================================ 事故 2

describe("L3 · 事故2 N5：「2 倍」不得被吞成「不增强」", () => {
  /**
   * 事故编号 2 · N5。
   * 原症状：WebUI 把 selected 回传成整行文字时，「2 倍」被解析层吞成「不增强」——
   * 用户说了加强，系统按不加强跑；且这种改写对 agent 不可见。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md §四（B3/B3c 两解法更替）；
   *         修复＝删除 label→value 查表（`augmentFromText`/`spellingIndexOf` 全族退役），
   *         答案原样照录。
   *
   * 对抗形态：卡上答「2 倍」→ 断言回执原话是「2 倍」而非被改写的「不增强」。
   */
  it("答「2 倍」→ 回执原话照录，不得出现「不增强」改写", async () => {
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
      const card = (run.steps[0]?.result ?? {})["construction_card_answers"] as
        | Array<{ field: string; said: string }>
        | undefined;
      const augment = (card ?? []).find((item) => item.field.includes("增强"));
      expect(augment?.said, "「2 倍」被解析层吞改（N5 原形）").toBe("2 倍");
      expect(run.steps[0]?.resultText).not.toContain("不增强");
    } finally {
      dropWorkspace(run.workspace);
    }
  });

  it("用户点选项（非手打）同样原样照录，工具不做 label→数值翻译", async () => {
    const run = await runSegment(
      {
        seedRunDir: (runDir) => seedFieldChoice(runDir, "ci", FIELDS),
        answer: (question) => {
          if (question.id.includes("construction-augment")) {
            // 点选一个选项（不是手打）——旧 N5 缺陷正是「把整行 label 当值再翻译」
            const label = question.options?.[1]?.label ?? question.options?.[0]?.label ?? "";
            return { selected: label === "" ? [] : [label] };
          }
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
      const card = (run.steps[0]?.result ?? {})["construction_card_answers"] as
        | Array<{ field: string; said: string }>
        | undefined;
      const augment = (card ?? []).find((item) => item.field.includes("增强"));
      expect(augment, "点选的作答也必须回传原文").toBeDefined();
      // 原样＝用户看到的那个选项文案，不是被翻成的数字
      expect(augment?.said, "选项文案被翻译成了别的值（N5 的 label→value 查表回潮）").not.toBe("");
      expect(/^\d+$/.test(augment?.said ?? ""), "选项文案被翻成了裸数字——工具做了语义翻译（已退役行为）").toBe(false);
    } finally {
      dropWorkspace(run.workspace);
    }
  });
});

// ================================================================ 事故 5

describe("L3 · 事故5 worktree 深度：4 级 import 在主仓形态下必红", () => {
  /**
   * 事故编号 5 · worktree 深度。
   * 原症状：G5 执行批在 worktree（多两层目录）写 4 级 import，worktree 内全绿；
   * 主仓 tests/dshTools 距仓根仅 2 级 → tsc TS2307×4 + vitest 加载失败，
   * 合入后才暴露。教训：import 深度必须锚 repo 布局，不能锚验证环境布局。
   * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md（未清偿项处置）；提交 68e9629f message。
   *
   * L3 对抗形态：模拟主仓形态（文件深度=2）喂一段 4 级 import，断言结构判定逻辑
   * 判它越界——即「4 级在 worktree 能过」的现象不再等价于合规。
   * 结构断言的完整全量扫描在 l0.structure.test.ts；此处只锁「判据对事故原形敏感」。
   */
  it("主仓形态（深度 2）+ 4 级 import → 判越界；同串在 worktree 形态（深度 4）才「恰好合法」", async () => {
    const { relative } = await import("node:path");
    const repoRoot = join(import.meta.dirname, "..", "..");
    // 判据与 L0 同源：层数 > 到仓根深度 即越界
    const upLevels = (specifier: string): number => {
      let count = 0;
      let rest = specifier;
      while (rest.startsWith("../")) {
        count += 1;
        rest = rest.slice(3);
      }
      return count;
    };
    const fourUp = ["..", "..", "..", ".."].join("/") + "/src/core/tools/index.js";
    const depthInMainRepo = relative(repoRoot, join(repoRoot, "tests", "dshTools", "x.test.ts")).split("/").length - 1;
    const depthInWorktree = depthInMainRepo + 2; // .worktrees/<name>/ 多两层
    expect(depthInMainRepo).toBe(2);
    expect(upLevels(fourUp), "4 级在主仓深度 2 下越界（事故原形）").toBeGreaterThan(depthInMainRepo);
    expect(upLevels(fourUp), "4 级在 worktree 深度 4 下恰好合法——这就是掩盖机制").toBe(depthInWorktree);
  });
});

// ================================================================ 事故 6

describe("L3 · 事故6 schema 黑盒：新增工具漏 properties 必被入口枚举拦下", () => {
  /**
   * 事故编号 6 · schema 黑盒。
   * 原症状：18 个工具里前 11 位的 output.schema 是裸开放形态（无 properties），
   * agent 拿到回执却不知道结构，只能靠试错；且既有守卫靠 DECLARED_TOOLS 白名单，
   * 新增工具不登记就漏检。
   * 文档锚：docs/audit/ATF_工具面自描述盘点_20261121.md（looseObjectOutput 11 位清退）；
   *         A1 清退批（2026-11-22）逐位结构化。
   *
   * L3 对抗形态：把一段「新增工具 + 裸开放 schema」的合成定义喂给入口枚举判据，
   * 断言它判红——即白名单式漏检不再成立。
   */
  it("合成「新增工具无 properties」定义 → 入口枚举判据判红", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    // 判据与 L0 同源（同一段切分逻辑的纯函数化表达）
    const hasPropertiesInOutput = (segment: string): boolean => {
      const outputAt = segment.indexOf("output: {");
      if (outputAt < 0) return false;
      const schemaAt = segment.indexOf("schema:", outputAt);
      if (schemaAt < 0) return false;
      const renderAt = segment.indexOf("render:", schemaAt);
      const slice = segment.slice(schemaAt, renderAt > schemaAt ? renderAt : segment.length);
      return slice.includes("properties:");
    };
    const bare = ['defineTool({', '  name: "atf_new_tool",', '  output: {', '    schema: { type: "object", additionalProperties: true },', '    render: () => [],', '  },', '});'].join("\n");
    expect(hasPropertiesInOutput(bare.slice(bare.indexOf("defineTool({"))), "裸开放形态被误判为合规").toBe(false);

    const declared = bare.replace(
      'schema: { type: "object", additionalProperties: true },',
      'schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean" } } },',
    );
    expect(hasPropertiesInOutput(declared.slice(declared.indexOf("defineTool({")))).toBe(true);

    // 真实现场：当前每个 defineTool 定义点都判合规（否则 L0 那条已红）
    const repoRoot = join(import.meta.dirname, "..", "..");
    const srcDir = join(repoRoot, "packages", "extensions", "atf-tools", "src");
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    let sites = 0;
    for (const file of files) {
      const full = join(srcDir, file);
      if (statSync(full).isDirectory()) continue;
      const text = readFileSync(full, "utf8");
      const starts: number[] = [];
      for (let at = text.indexOf("defineTool({"); at >= 0; at = text.indexOf("defineTool({", at + 1)) starts.push(at);
      for (let k = 0; k < starts.length; k += 1) {
        const segment = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length);
        expect(hasPropertiesInOutput(segment), `${file} 第 ${k + 1} 个 defineTool 定义点无 properties（事故6 原形）`).toBe(true);
        sites += 1;
      }
    }
    expect(sites, "defineTool 定义点枚举数异常（扫描面失效即判据失效）").toBeGreaterThanOrEqual(15);
  });
});
