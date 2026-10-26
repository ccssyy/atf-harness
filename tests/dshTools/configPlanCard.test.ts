/**
 * 「本次训练方案」卡面回归锚（owner 2026-10-26 改名 + 六区块重排 + 选项形态）。
 *
 * 锚点：
 *  ① 六区块：标题是业务话，键序＝区块序（CONFIG_CONFIRM_KEYS 单源，防两份排序漂移）；
 *  ② 决策类走 options（不设 intent）／录入类保留 form／自由输入走选项组末尾 custom；
 *  ③ deepspeed 是闭集 → 必须下拉（options），不再让用户在输入框手打；
 *  ④ multiSelect 用量非零（卡位多选）；
 *  ⑤ 答案解析单源：form 的 key=value、options 的 label→value、custom 自由输入，同一函数。
 */
import { describe, expect, it } from "vitest";
import {
  buildConfigConfirmFields,
  CONFIG_CONFIRM_BLOCKS,
  CONFIG_CONFIRM_KEYS,
  CONFIG_BLOCK_ORDER,
  configBlockOf,
  configChoiceValuesOf,
  DEEPSPEED_CHOICES,
} from "../../src/webui/configConfirm.js";
import { configFormFieldsOf, buildConfigChoiceQuestions, editsFromFormAnswers } from "../../packages/extensions/atf-tools/src/confirmFace.js";

describe("六区块（标题业务话＋键序单源）", () => {
  it("区块标题恰为六个业务话，且不含内部键名", () => {
    expect(CONFIG_CONFIRM_BLOCKS.map((block) => block.title)).toEqual([
      "运行环境",
      "训练规模",
      "长度与预算",
      "优化设置",
      "数据构造",
      "只读信息",
    ]);
    for (const block of CONFIG_CONFIRM_BLOCKS) expect(block.title).not.toMatch(/[a-z_]{3,}/);
  });
  it("CONFIG_CONFIRM_KEYS 顺序＝区块展平序（17 键一一对应，无遗漏无重复）", () => {
    expect(CONFIG_CONFIRM_KEYS.map((entry) => entry.key)).toEqual([...CONFIG_BLOCK_ORDER]);
    expect(CONFIG_BLOCK_ORDER).toHaveLength(17);
    expect(new Set(CONFIG_BLOCK_ORDER).size).toBe(17);
  });
  it("区块内相邻键满足排序理由：A 卡数/卡位同区相邻；B bs 在 accum 前；C 像素对相邻", () => {
    const environment = CONFIG_CONFIRM_BLOCKS.find((block) => block.id === "environment")?.keys ?? [];
    expect(environment.indexOf("visible_devices") - environment.indexOf("nproc_per_node")).toBe(1);
    const scale = CONFIG_CONFIRM_BLOCKS.find((block) => block.id === "scale")?.keys ?? [];
    expect(scale.indexOf("per_device_train_batch_size")).toBeLessThan(scale.indexOf("gradient_accumulation_steps"));
    const budget = CONFIG_CONFIRM_BLOCKS.find((block) => block.id === "budget")?.keys ?? [];
    expect(budget.indexOf("image_max_pixels") - budget.indexOf("image_min_pixels")).toBe(1);
  });
  it("只读信息区块只装只读键；configBlockOf 反查单源", () => {
    expect(CONFIG_CONFIRM_BLOCKS.find((block) => block.id === "readonly")?.keys).toEqual(["dataset_keys"]);
    expect(configBlockOf("dataset_keys")?.title).toBe("只读信息");
    expect(configBlockOf("learning_rate")?.title).toBe("优化设置");
    expect(configBlockOf("not_a_key")).toBeUndefined();
  });
});

describe("决策卡（options 形态；自由输入留在选项组末尾）", () => {
  const fields = buildConfigConfirmFields({});
  const { questions, picks } = buildConfigChoiceQuestions(fields, 8);

  it("决策卡问题一律不设 intent（原生选项卡），且每题都有 options", () => {
    expect(questions.length).toBeGreaterThan(1);
    for (const question of questions) {
      expect((question as { intent?: unknown }).intent).toBeUndefined();
      expect((question.options ?? []).length).toBeGreaterThan(0);
    }
  });
  it("multiSelect 用量非零：卡位多选（卡 0…卡 7），选两张＝回传 0,1", () => {
    const devices = questions.find((question) => question.id === "config-choice-visible-devices");
    expect(devices?.multiSelect).toBe(true);
    expect(devices?.options.map((option) => option.label)).toEqual(["卡 0", "卡 1", "卡 2", "卡 3", "卡 4", "卡 5", "卡 6", "卡 7"]);
    const edits = editsFromFormAnswers(
      { answers: [{ id: "config-choice-visible-devices", selected: ["卡 0", "卡 1"] }] },
      picks,
    );
    expect(edits["visible_devices"]).toBe("0,1");
  });
  it("deepspeed 必须下拉：7 档闭集选项，值全部落在内核闭集内，label 是业务话", () => {
    const deepspeed = questions.find((question) => question.id === "config-choice-deepspeed");
    expect(deepspeed?.options).toHaveLength(7);
    expect(deepspeed?.options.map((option) => option.label)).toEqual(DEEPSPEED_CHOICES.map((choice) => choice.label));
    const edits = editsFromFormAnswers({ answers: [{ id: "config-choice-deepspeed", selected: ["Z3 + 全卸载（默认）"] }] }, picks);
    expect(edits["deepspeed"]).toBe("ds_z3_offload_config.json");
    // 立选项里不出现内部文件名（零内部码字样）
    for (const option of deepspeed?.options ?? []) expect(option.label).not.toMatch(/\.json$/);
  });
  it("未探测到卡数＝不编造卡位域（该题不生成，其余决策题照办）", () => {
    const gpuUnknown = buildConfigChoiceQuestions(fields, null);
    expect(gpuUnknown.questions.find((question) => question.id === "config-choice-visible-devices")).toBeUndefined();
    expect(gpuUnknown.questions.length).toBeGreaterThan(0);
  });
  it("自由输入（选项组末尾 custom）：裸值＝本问取值；key=value 形态＝逐键取值", () => {
    const bare = editsFromFormAnswers({ answers: [{ id: "config-choice-deepspeed", selected: [], custom: "ds_z3_offload" }] }, picks);
    expect(bare["deepspeed"]).toBe("ds_z3_offload");
    const pair = editsFromFormAnswers({ answers: [{ id: "config-choice-lora-rank", selected: [], custom: "lora_alpha=96" }] }, picks);
    expect(pair["lora_alpha"]).toBe("96");
  });
  it("选选项与自由输入同答在：选项优先落映射值，custom 另键并入", () => {
    const edits = editsFromFormAnswers(
      { answers: [{ id: "config-choice-lora-rank", selected: ["rank 64"], custom: "learning_rate=2e-4" }] },
      picks,
    );
    expect(edits["lora_rank"]).toBe("64");
    expect(edits["learning_rate"]).toBe("2e-4");
  });
  it("闭集取值单源：rank 取 CLAMP 档位、像素取惯例闭集", () => {
    expect(configChoiceValuesOf("lora_rank").map((option) => option.value)).toEqual(["16", "32", "64", "128"]);
    expect(configChoiceValuesOf("image_max_pixels").map((option) => option.value)).toEqual(["802816", "1605632"]);
    expect(configChoiceValuesOf("nproc_per_node")).toEqual([]);
  });
});

describe("录入卡（form 保留）：区块前缀＋闭集键不重复收", () => {
  const fields = buildConfigConfirmFields({});
  it("录入类字段标签带区块业务标题；闭集三键（present）不在表单", () => {
    const rows = configFormFieldsOf(fields, 8, { collectedByChoices: true });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // 区块标题作前缀（区块内相邻、顺序＝区块序）；呈现名沿用既有键名形态
    expect(byKey.get("learning_rate")?.label).toBe("优化设置｜learning_rate");
    expect(byKey.get("nproc_per_node")?.label).toBe("运行环境｜nproc_per_node");
    // 像素对仍是中文呈现名（b5 既有锚不回归）
    expect(byKey.get("image_min_pixels")?.label).toBe("长度与预算｜最小像素");
    for (const key of ["deepspeed", "lora_rank", "image_max_pixels"]) expect(byKey.has(key)).toBe(false);
    // 卡位保留（自由输入 a-b 区间通道）
    expect(byKey.has("visible_devices")).toBe(true);
  });
  it("amend 形态（无决策卡）照旧保留闭集输入框——改参数值不丢能力", () => {
    const rows = configFormFieldsOf(fields, 8, { collectedByChoices: false });
    const keys = rows.map((row) => row.key);
    expect(keys).toContain("deepspeed");
    expect(keys).toContain("lora_rank");
    expect(keys).toContain("image_max_pixels");
  });
  it("只读键永不出输入框（max_model_len／dataset_keys）", () => {
    for (const collectedByChoices of [true, false]) {
      const keys = configFormFieldsOf(fields, 8, { collectedByChoices }).map((row) => row.key);
      expect(keys).not.toContain("max_model_len");
      expect(keys).not.toContain("dataset_keys");
    }
  });
});
