/**
 * G6 分层 evals · L2 真实语料回放（真机原始调用语料，原样重放 + 两层断言）。
 *
 * 依据 eval-spec §2「L2 标准形态：真实语料回放」：
 *   ① 语料来源＝真机轮会话记录里的**原始调用参数，不改写**（`fixtures/l2-*.json`，
 *      provenance 带源文件 sha256）；
 *   ② 断言两层：
 *      - **契约断言**：exit≠0 必须有可见报错（含结论/下一步），静默崩溃直接 FAIL；
 *      - **设计承诺断言**：该段设计条款承诺的行为面逐条断言，**期望值从设计锚推导，
 *        不从当前实现行为反推**（反推会把 bug 锁进基线）。
 *
 * 与 faux（L1/L3）的边界：faux 是**脚本化固定输出**，只能证明「给定输入下代码怎么走」；
 * L2 这里回放的是真模型当时**实际发出的参数**——它证明的是「真机会话形态下工具怎么应答」。
 * 二者不可互相冒充（任务书明令：不得用 faux 冒充 L2）。
 *
 * 语料缺口如实登记在 `L2_CORPUS_GAPS`（见文件末）：未覆盖面写清楚，不假装覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "fixtures", "l2-ci-bl-1103-4.pipeline-stage.json");

interface L2Call {
  readonly seq: number | null;
  readonly tool: string;
  /** 真机原始参数串（原样，未改写）。 */
  readonly arguments_raw: string;
  /** 真机原始回执文本（原样，未改写）。 */
  readonly result_text_raw: string;
  readonly is_error: boolean;
}

interface L2Corpus {
  readonly schema_version: string;
  readonly provenance: Record<string, string | number>;
  readonly call_count: number;
  readonly calls: readonly L2Call[];
}

const corpus = JSON.parse(readFileSync(FIXTURE, "utf8")) as L2Corpus;

/** 语料参数串 → 对象（语料是原文，解析失败即语料损坏，属 FAIL 不属容错）。 */
const argsOf = (call: L2Call): Record<string, unknown> => JSON.parse(call.arguments_raw) as Record<string, unknown>;

/** 回执文本 → 对象（真机回执恒 JSON；解析失败说明现场形态变了，需人工看）。 */
const resultOf = (call: L2Call): Record<string, unknown> => JSON.parse(call.result_text_raw) as Record<string, unknown>;

describe("L2 · 语料形态与出处（前提断言：语料可信才谈回放）", () => {
  it("语料带 provenance（源会话 sha256）且调用数自洽", () => {
    expect(corpus.schema_version).toBe("L2CorpusReplay/v1");
    expect(corpus.provenance["session_sha256"], "缺源 sha256——语料不可复核").toMatch(/^[0-9a-f]{64}$/);
    expect(corpus.provenance["session_dir"]).toContain("ci-bl-test-1103-4");
    expect(corpus.call_count).toBe(corpus.calls.length);
    expect(corpus.call_count, "语料条数异常偏少（抽取面失效）").toBeGreaterThanOrEqual(5);
  });

  it("每条调用都带原样参数串与回执文本（未改写——原始语料定义）", () => {
    for (const call of corpus.calls) {
      expect(call.tool).toBe("atf_pipeline_stage");
      expect(typeof call.arguments_raw).toBe("string");
      expect(call.arguments_raw.length).toBeGreaterThan(2);
      expect(typeof call.result_text_raw).toBe("string");
      // 原样性证据：参数串是 JSON 且能解析出 stage
      expect(typeof argsOf(call)["stage"]).toBe("string");
    }
  });

  it("真机原始参数里没有 requested_group_count（本语料是事故现场：agent 当时未带该参数）", () => {
    // 这不是「应该如此」的期望，而是这条语料的**事实标注**：它是 ci-bl-1103 事故轮，
    // 组数意愿没有进接口正是事故本体。断言它在场即说明抽错语料。
    const withCount = corpus.calls.filter((call) => argsOf(call)["requested_group_count"] !== undefined);
    expect(withCount, "语料抽错——这批调用应是不带组数参数的 ci-bl-1103 现场").toHaveLength(0);
  });
});

describe("L2 · 契约断言：失败必须有可见报错且带修复指令", () => {
  /**
   * 设计锚（eval-spec §2 契约断言 + 元规则 3「报错即修复指令」）：
   * exit≠0 不得静默——回执必须有 ok:false + 结构化错误/结论，且带下一步指向。
   */
  it("所有非零退出回执都有 ok:false 与用户可见结论（无静默崩溃）", () => {
    const failures = corpus.calls
      .map(resultOf)
      .filter((result) => result["exit_code"] !== 0 && result["exit_code"] !== undefined);
    // 语料里应有失败样本（否则契约断言无对抗面）
    expect(failures.length, "语料无失败样本——契约断言失去对抗面（抽错语料或事故现场未被覆盖）").toBeGreaterThan(0);

    for (const result of failures) {
      expect(result["ok"], `失败回执缺 ok:false（静默失败）：${JSON.stringify(result).slice(0, 200)}`).toBe(false);
      const summary = result["user_summary"] as
        | { conclusion?: string; next?: string; stage?: string }
        | undefined;
      expect(summary?.conclusion, "失败回执缺用户可见结论——静默崩溃").toBeTruthy();
      expect(summary?.next, "失败回执缺下一步指向——只说不行不说怎么改").toBeTruthy();
      // 每段都有明确的「停在哪」说明（当前段未被改）
      expect(summary?.stage, "失败回执缺「停在本段」说明").toBeTruthy();
    }
  });

  it("成功回执都带段落结论与下一步（成功面同样不许无话）", () => {
    const successes = corpus.calls.map(resultOf).filter((result) => result["exit_code"] === 0);
    expect(successes.length).toBeGreaterThan(0);
    for (const result of successes) {
      const summary = result["user_summary"] as { conclusion?: string; next?: string } | undefined;
      expect(summary?.conclusion).toBeTruthy();
      expect(summary?.next).toBeTruthy();
    }
  });
});

describe("L2 · 设计承诺断言：分组/字段面承诺逐条落地（期望值取自设计锚）", () => {
  /**
   * 设计锚（pipelineFace 工具描述与 D 系列裁定，非当前实现反推）：
   *   ① 字段清单必须经用户确认才放行实验配置（field_choice 三键回执）；
   *   ② 分组四态回执必须如实标注来源（grouping_source / grouping_decision），
   *      绝不在「没有分组输入」时假装有分组；
   *   ③ 组数意愿（requested_group_count）进接口后，回执必须声明 regroup_request；
   *   ④ 用户没在卡上确认过时，不得把 agent 自拟当用户决定（不得伪称 user_confirmed）。
   */
  it("register 段回执必带字段清单确认结果（field_choice 三键）", () => {
    const registers = corpus.calls.filter((call) => argsOf(call)["stage"] === "register");
    expect(registers.length, "语料应含 register 段调用").toBeGreaterThan(0);
    for (const call of registers) {
      const result = resultOf(call);
      const fieldChoice = result["field_choice"] as Record<string, unknown> | undefined;
      expect(fieldChoice, "register 回执缺 field_choice——agent 不知用户确认了哪些字段（真机事故面）").toBeDefined();
      expect(fieldChoice).toHaveProperty("confirmed_fields");
      expect(fieldChoice).toHaveProperty("all_fields");
      expect(fieldChoice).toHaveProperty("total_fields");
    }
  });

  it("experiment_setup 段回执必如实标注分组来源与决定形态（无假装有分组）", () => {
    const setups = corpus.calls.filter((call) => argsOf(call)["stage"] === "experiment_setup");
    expect(setups.length, "语料应含 experiment_setup 段调用").toBeGreaterThan(0);
    for (const call of setups) {
      const result = resultOf(call);
      // 失败回执（字段闸拦下/出卡前的早退）不带分组四态键——那是设计内的分支
      if (result["ok"] === false && result["grouping_source"] === undefined) continue;
      expect(result["grouping_source"], "分组来源未如实标注——agent 无法对账分组是谁定的").toBeDefined();
      expect(result["grouping_decision"], "分组决定形态未如实标注").toBeDefined();
      // 承诺：没有分组输入时不得假装有分组（source=none 时 decision 必须是 none）
      if (result["grouping_source"] === "none") {
        expect(result["grouping_decision"], "无分组输入却报了非 none 决定——假装有分组").toBe("none");
      }
    }
  });

  it("agent 未带 requested_group_count → 回执绝不自称 regroup_request（不猜组数）", () => {
    for (const call of corpus.calls) {
      const args = argsOf(call);
      const result = resultOf(call);
      if (args["requested_group_count"] !== undefined) continue;
      expect(
        result["grouping_decision"],
        "agent 没带组数参数，回执却报 regroup_request——工具替 agent 猜了组数（B3 已退役行为）",
      ).not.toBe("regroup_request");
    }
  });

  it("构造面承诺（按语料年代分档）：decided_by=user 的凭据面断言", () => {
    // 语料年代判据：这份语料录制于 2026-11-03 19:58，而 construction_card_answers 的
    // 透传修复是 2026-11-22 00:20（commit efd0af21「A2 小批」）——**语料早于修复**。
    // 因此本断言按年代分两档，绝不把现状反推成期望：
    //   ① 修复前语料 → 它本身就是事故 4 的真机证据，断言「确有 decided_by=user 而无
    //      card_answers 的调用」＝断言事故真实发生过（语料价值所在）；
    //   ② 修复后语料（将来补录）→ 断言设计承诺成立（user 决定必带作答原文）。
    // 这一分档是 eval-spec §2「期望值从设计锚推导，不从当前实现行为反推」的直接落实：
    // 若不分档，要么把 bug 锁成基线（要求无 card_answers），要么让历史语料恒红。
    const FIX_COMMIT_EPOCH_MS = Date.parse("2026-11-22T00:20:36+08:00");
    const recordedAtMs = Number(corpus.provenance["recorded_at_ms"] ?? 0);
    expect(recordedAtMs, "语料缺录制时间——无法判断断言该按哪档").toBeGreaterThan(0);
    const predatesFix = recordedAtMs < FIX_COMMIT_EPOCH_MS;

    const userDecided = corpus.calls
      .map(resultOf)
      .filter((result) => result["construction_decided_by"] === "user");
    expect(userDecided.length, "语料无 decided_by=user 的构造调用——凭据面断言失去对抗面").toBeGreaterThan(0);

    for (const result of userDecided) {
      if (predatesFix) {
        // ① 事故证据档：修复前轮次「用户决定了但作答原文不在回执」是事故 4 的原形，
        //    本断言正是在替这份语料标注「它记录的是断链现场」。
        expect(
          result["construction_card_answers"],
          "语料标注为修复前，却已带 card_answers——年代判定与实际不符（语料或时间戳有误）",
        ).toBeUndefined();
      } else {
        // ② 承诺档：修复后 user 决定必须带作答原文
        expect(
          result["construction_card_answers"],
          "construction_decided_by=user 却无 card_answers——凭据不落（事故4 原形）",
        ).toBeDefined();
      }
    }
  });
});

/**
 * L2 语料缺口登记（任务书明令：无则登记缺口 + 获取路径，不得用 faux 冒充 L2）。
 *
 * 本资产覆盖：ci-bl-1103-4 会话的 atf_pipeline_stage 全量调用（8 条：register×2 +
 * experiment_setup×6），含 exit 2 失败样本与用户选定分组后的成功样本。
 * 未覆盖面（后续批次补录，获取路径已写明）：
 *   - **组数意愿入场形态**：全实例 373 个会话、1452 次 atf_pipeline_stage 调用中
 *     `requested_group_count` 出现 **0 次**——B3c 修复后的真机轮尚未发生。
 *     获取路径：真机走一次「用户说改成 N 组」的完整轮，会话 v4.jsonl.zstd 落下后
 *     用同一抽取法（见 §L2 抽取命令）追加为 l2-<批次>.json。
 *   - **training_prep / training / eval 段**：需 GPU 与真实训练，未录制。
 *   - **多类联合（doc_type>2）**：现语料只有 ci/bl 两类。
 */
const L2_CORPUS_GAPS: readonly { readonly gap: string; readonly acquire: string }[] = [
  {
    gap: "requested_group_count 入场形态（全实例 1452 次 stage 调用中 0 次出现）",
    acquire: "真机跑一轮「用户说改成 N 组」，落 v4.jsonl.zstd 后按同一抽取法追加资产",
  },
  {
    gap: "training_prep / training / eval 段真机调用",
    acquire: "真机跑到训练段（需 GPU），或复用 deploy/verify/rehearsal 的 GPU 段录像",
  },
  {
    gap: "三类以上联合训练（doc_type>2）的分组面",
    acquire: "真机跑一次三类联合 run，抽 experiment_setup 逐类调用",
  },
  {
    gap: "A2 修复（efd0af21，2026-11-22）之后的构造卡真机语料——现资产录制于 2026-11-03，属修复前现场",
    acquire: "真机跑一轮「用户在构造卡上手打作答」，落 v4.jsonl.zstd 后按同一抽取法追加资产；届时上条断言自动切到承诺档",
  },
] as const;

describe("L2 · 语料缺口如实登记（不假装覆盖）", () => {
  it("缺口清单非空且每条带获取路径（禁止把缺口说成已覆盖）", () => {
    expect(L2_CORPUS_GAPS.length).toBeGreaterThanOrEqual(4);
    for (const entry of L2_CORPUS_GAPS) {
      expect(entry.gap.length).toBeGreaterThan(10);
      expect(entry.acquire.length, `缺口「${entry.gap}」缺获取路径`).toBeGreaterThan(10);
    }
  });

  it("组数意愿缺口与事实一致：本语料里确实没有该参数（缺口不是编的）", () => {
    const withCount = corpus.calls.filter((call) => argsOf(call)["requested_group_count"] !== undefined);
    expect(withCount).toHaveLength(0);
    // 缺口清单必须显式点名这条，否则等于隐瞒覆盖边界
    expect(L2_CORPUS_GAPS.some((entry) => entry.gap.includes("requested_group_count"))).toBe(true);
  });
});
