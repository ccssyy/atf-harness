/**
 * atf_joint_train 单 run 槽位联合训练测试锚（E8 第二批重写；内核 pin v0.7.25b12）。
 *
 * 覆盖面（H5：argv 快照／N=1 单槽位／槽位缺失拒绝／双类倍率）：
 * - schema 面：新六参数（run_id/workspace_path/oversample/seed/base_model_family/
 *   prelaunch_report）在位；旧键（datasets/field_specs/target_run_id/train_sh）零残留；
 * - 卡前快败（零审批零段调用）：run_id 缺／workspace 非绝对／run 解析不到／槽位缺失／
 *   某类槽位数据为空／倍率值或键集非法／seed 非法；
 * - assemble argv 快照：--stage training_prep＋--assemble 下传、--doc-type 恒不出现
 *   （互斥压制）、base_model_family 缺省不透传/显式才透传（mock_pipeline_params 回显面）；
 * - N=1 单槽位全链：装配 ok＋倍率全 1 直通（合并件逐字节不变）＋训练直调被证
 *   （atf_run_training 执行函数回传 run_id/train_sh）＋整链恰一张审批卡；
 * - 双类倍率：行级账驱动确定性复制（行数＝Σ类行数×倍率、行序确定）＋倍率账
 *   harness-oversample.json 落盘（无时间戳可复现）；assemble 失败（mock exit 2）→
 *   joint_assemble_failed＋零倍率账零训练直调；
 * - 纯函数 applyJointOversample 三态锚（E4-乙先例保留）＋jointTrainState 单 run
 *   消息锚（E8 第一批——与 jointTrainUi.test.ts 双钉同源）。
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（argv 回显恒 exit 0——pipelineFace
 * 摘要回读面）；装配盘面产物（合并件/启动件）由夹具按内核 b12 assemble 落点预置。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJointTrainTool, applyJointOversample, JOINT_OVERSAMPLE_NOTE_FILENAME } from "../../packages/extensions/atf-tools/src/jointTrainFace.js";
import { buildJointTrainMessage, jointSpecIssues, normalizeJointFieldSpec } from "../../packages/extensions/atf-ui/src/jointTrainState.js";
import { listDocSlots } from "../../packages/extensions/atf-ui/src/docSlots.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e8-joint-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { callId: "t", agent: { session: { id: "sess-e8-joint" } } };
type Tool = { name: string; parameters: Record<string, unknown>; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const MOCK_PIPELINE = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");

const makeCtx = () => {
  let calls = 0;
  let card = "";
  const ctx = {
    get: (service: string) => service === "approval"
      ? { request: async (req: { reason: string }) => { calls += 1; card = req.reason; return "allowed-once"; } }
      : undefined,
  };
  return { ctx, calls: (): number => calls, card: (): string => card };
};

const buildTool = (root: string, ctx: ReturnType<typeof makeCtx>["ctx"], opts: { pipelineCommand?: string } = {}): Tool =>
  buildJointTrainTool(ctx, {
    runsRoot: root, logDir: root,
    pipelineCommand: opts.pipelineCommand ?? `node ${MOCK_PIPELINE}`, pipelineTimeoutMs: 30_000,
    registryWorkspaces: [],
  }) as unknown as Tool;

/** 槽位夹具：每类 prep/variants/<doc>/train.jsonl（行＝{"row":"<doc>-<i>"}）＋登记清单
 *  run.json docs[]（E8b·内核 b13 形态——已登记与已备槽位一致，卡前校验通过）。 */
const seedSlots = (root: string, runId: string, classes: ReadonlyArray<{ doc: string; rows: number }>): string => {
  const runDir = join(root, "runs", runId);
  for (const c of classes) {
    mkdirSync(join(runDir, "prep", "variants", c.doc), { recursive: true });
    writeFileSync(join(runDir, "prep", "variants", c.doc, "train.jsonl"), Array.from({ length: c.rows }, (_, i) => JSON.stringify({ row: `${c.doc}-${i}` })).join("\n") + "\n");
  }
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    run_id: runId,
    layout_version: "RunLayout/v1",
    docs: [...classes]
      .sort((a, b) => (a.doc < b.doc ? -1 : 1))
      .map((c) => ({ doc_type: c.doc, lane_suffix: c.doc, registered_at: "2026-10-25T00:00:00+00:00" })),
  }, null, 1)}\n`);
  return runDir;
};

/** 装配产物预置（内核 b12 assemble 落点——mock assemble 成功后的盘面形态）：
 *  合并件 train.jsonl（字典序逐类拼接）＋行级账 merge_manifest.json＋启动件 train.sh
 *  （DRY_RUN 必败形态——训练直调被证被调且零 tmux 零端口）。 */
const seedAssembleArtifacts = (runDir: string, classes: ReadonlyArray<{ doc: string; rows: number }>): void => {
  const variantsRoot = join(runDir, "prep", "variants");
  mkdirSync(variantsRoot, { recursive: true });
  const lines: string[] = [];
  const rows: Array<{ row_index: number; doc_type: string }> = [];
  let cursor = 0;
  for (const c of [...classes].sort((a, b) => (a.doc < b.doc ? -1 : 1))) {
    for (let i = 0; i < c.rows; i += 1) {
      rows.push({ row_index: cursor, doc_type: c.doc });
      lines.push(JSON.stringify({ row: `${c.doc}-${i}` }));
      cursor += 1;
    }
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(variantsRoot, "train.jsonl"), text);
  writeFileSync(join(variantsRoot, "merge_manifest.json"), `${JSON.stringify({
    schema_version: "JointDatasetMergeManifest/v1",
    merged: { path: "train.jsonl", row_count: cursor, sha256: createHash("sha256").update(text).digest("hex") },
    rows,
  }, null, 1)}\n`);
  mkdirSync(join(runDir, "launch"), { recursive: true });
  // DRY_RUN 过关形态＋prelaunch 在场——训练段推进到 base_model 复核（无 iteration-config
  // 即 model_path_missing 结构化拒——该载荷带 run_id/train_sh，训练直调被证面）
  writeFileSync(join(runDir, "launch", "train.sh"), "#!/bin/bash\necho 'SHA=pass ADMISSION=pass'\n");
  writeFileSync(join(runDir, "launch", "prelaunch.md"), "# prelaunch\n");
};

describe("E8——atf_joint_train 单 run 槽位联合训练（schema 面＋卡前快败＋assemble 链＋倍率＋训练直调）", () => {
  it("schema 面：新六参数在位（业务语言描述）；旧参数键零残留（datasets/field_specs/target_run_id/train_sh 整链退役）", async () => {
    const root = tempRoot();
    const tool = buildTool(root, makeCtx().ctx);
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? tool.parameters;
    for (const key of ["run_id", "workspace_path", "oversample", "seed", "base_model_family", "prelaunch_report"]) {
      expect(props[key], key).toBeDefined();
    }
    for (const gone of ["datasets", "field_specs", "target_run_id", "train_sh"]) {
      expect(props[gone], gone).toBeUndefined();
    }
    expect((props["oversample"] as { type?: string }).type).toBe("object"); // vendor json 键作者侧专用先例
    const desc = JSON.stringify(props);
    expect(desc).toContain("单据槽位");
    expect(desc).not.toContain("target_run_id");
  });

  it("卡前快败——七态全覆盖（run 缺／workspace 非绝对／run 解析不到／槽位缺失／某类空数据／倍率非法／seed 非法）：零审批零段调用", async () => {
    const root = tempRoot();
    const ctx = makeCtx();
    const tool = buildTool(root, ctx.ctx);
    // run_id 缺
    expect((await tool.execute({}, fakeExec))["error"]).toBe("joint_run_missing");
    // workspace_path 缺（必填——与 atf_pipeline_stage 同裁）／非绝对
    expect((await tool.execute({ run_id: "r" }, fakeExec))["error"]).toBe("workspace_path_missing");
    expect((await tool.execute({ run_id: "r", workspace_path: "rel/ws" }, fakeExec))["error"]).toBe("workspace_path_not_absolute");
    // run 解析不到（落点 <wp>/runs/<run_id> 不存在）
    expect((await tool.execute({ run_id: "absent", workspace_path: root }, fakeExec))["error"]).toBe("joint_run_unresolved");
    // 槽位缺失（run 在场但无 prep/variants/<doc>/train.jsonl）
    mkdirSync(join(root, "runs", "bare-run"), { recursive: true });
    const missing = await tool.execute({ run_id: "bare-run", workspace_path: root }, fakeExec);
    expect(missing["error"]).toBe("joint_slots_missing");
    expect(String(missing["note"])).toContain("单据槽位");
    expect(String(missing["note"])).not.toContain("prep/");
    // 某类槽位数据为空（0 行）
    seedSlots(root, "empty-slot", [{ doc: "pl", rows: 2 }, { doc: "swb", rows: 0 }]);
    const empty = await tool.execute({ run_id: "empty-slot", workspace_path: root }, fakeExec);
    expect(empty["error"]).toBe("joint_slot_empty");
    expect(empty["empty"]).toEqual(["swb"]);
    // 倍率值非法＋键集不齐
    seedSlots(root, "bad-ratio", [{ doc: "pl", rows: 1 }]);
    expect((await tool.execute({ run_id: "bad-ratio", workspace_path: root, oversample: { pl: 0 } }, fakeExec))["error"]).toBe("joint_oversample_invalid");
    expect((await tool.execute({ run_id: "bad-ratio", workspace_path: root, oversample: { swb: 2 } }, fakeExec))["error"]).toBe("joint_oversample_keyset_mismatch");
    // seed 非法
    expect((await tool.execute({ run_id: "bad-ratio", workspace_path: root, seed: -1 }, fakeExec))["error"]).toBe("joint_seed_invalid");
    expect(ctx.calls()).toBe(0); // 全部零审批零段调用
  });

  it("N=1 单槽位全链：assemble argv 下传快照（--assemble 在／--doc-type 恒不在）＋倍率全 1 直通＋训练直调被证＋恰一张审批卡", async () => {
    const root = tempRoot();
    const ctx = makeCtx();
    const tool = buildTool(root, ctx.ctx);
    const runDir = seedSlots(root, "n1-run", [{ doc: "pl", rows: 3 }]);
    seedAssembleArtifacts(runDir, [{ doc: "pl", rows: 3 }]);
    const result = await tool.execute({ run_id: "n1-run", workspace_path: root }, fakeExec);
    expect(result["ok"]).toBe(true);
    expect(result["doc_types"]).toEqual(["pl"]);
    expect(result["oversample_passthrough"]).toBe(true); // 全 1 直通——合并件逐字节不变
    const trainText = readFileSync(join(runDir, "prep", "variants", "train.jsonl"), "utf8");
    expect(result["merged_sha256"]).toBe(createHash("sha256").update(trainText).digest("hex"));
    // assemble argv 快照（mock_pipeline_params 回显面）：--stage training_prep＋--assemble；
    // --doc-type 恒不出现（互斥压制）；base_model_family 缺省（qwen3_vl）不透传
    const assemble = result["assemble"] as Record<string, unknown>;
    expect(assemble["ok"]).toBe(true);
    const argv = ((assemble["summary"] as Record<string, unknown>)["argv"]) as string[];
    expect(argv).toContain("--assemble");
    expect(argv[argv.indexOf("--stage") + 1]).toBe("training_prep");
    expect(argv).not.toContain("--doc-type");
    expect(argv).not.toContain("--base-model-family");
    // 训练直调被证（推进到 base_model 复核：无 iteration-config → model_path_missing
    // 结构化拒——载荷带 run_id/train_sh 双键，证明内部调用收到了联合参数）
    expect(result["started"]).toBe(false);
    const training = result["training"] as Record<string, unknown>;
    expect(training["error"]).toBe("model_path_missing");
    expect(training["run_id"]).toBe("n1-run");
    expect(String(training["train_sh"])).toBe(join(runDir, "launch", "train.sh"));
    // 整链恰一张审批卡（内部段审批与训练 danger 卡由本卡承接——不另出卡）
    expect(ctx.calls()).toBe(1);
    expect(ctx.card()).toContain("1 类：pl");
    expect(ctx.card()).not.toContain("target");
    expect(ctx.card()).not.toContain("落点");
  });

  it("双类倍率：行级账驱动确定性复制（pl×1＋swb×2 → 行数翻倍且行序确定）＋倍率账落盘＋非缺省家族透传", async () => {
    const root = tempRoot();
    const ctx = makeCtx();
    const tool = buildTool(root, ctx.ctx);
    const classes = [{ doc: "pl", rows: 3 }, { doc: "swb", rows: 2 }];
    const runDir = seedSlots(root, "n2-run", classes);
    seedAssembleArtifacts(runDir, classes);
    const result = await tool.execute({ run_id: "n2-run", workspace_path: root, oversample: { pl: 1, swb: 2 }, seed: 42, base_model_family: "internvl" }, fakeExec);
    expect(result["ok"]).toBe(true);
    expect(result["merged_rows"]).toBe(7); // 3×1＋2×2
    expect(result["oversample_passthrough"]).toBe(false);
    const merged = readFileSync(join(runDir, "prep", "variants", "train.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { row: string }).row);
    // 行序确定性：pl 原序 3 行 → swb 每行原序重复 2 次（字典序类序与行内序均确定）
    expect(merged).toEqual(["pl-0", "pl-1", "pl-2", "swb-0", "swb-0", "swb-1", "swb-1"]);
    // 倍率账落盘（无时间戳——同 seed/倍率重跑逐字节稳定）
    const note = JSON.parse(readFileSync(join(runDir, "prep", "variants", JOINT_OVERSAMPLE_NOTE_FILENAME), "utf8")) as Record<string, unknown>;
    expect(note["seed"]).toBe(42);
    expect(note["ratios"]).toEqual({ pl: 1, swb: 2 });
    expect((note["merged"] as Record<string, unknown>)["passthrough"]).toBe(false);
    // 非缺省家族透传（assemble argv 快照）
    const argv = (((result["assemble"] as Record<string, unknown>)["summary"] as Record<string, unknown>)["argv"]) as string[];
    expect(argv[argv.indexOf("--base-model-family") + 1]).toBe("internvl");
    // 卡面行数实测（3×1＋2×2 上卡）
    expect(ctx.card()).toContain("swb 2×2");
    expect(ctx.card()).toContain("seed：42");
  });

  it("assemble 失败（mock exit 2）：joint_assemble_failed＋stage_result 回流＋零倍率账零训练直调（放行已消耗如实注记）", async () => {
    const root = tempRoot();
    const ctx = makeCtx();
    const failMock = join(root, "fail_pipeline.mjs");
    writeFileSync(failMock, "process.exit(2);\n");
    const tool = buildTool(root, ctx.ctx, { pipelineCommand: `node ${failMock}` });
    const runDir = seedSlots(root, "fail-run", [{ doc: "pl", rows: 2 }]);
    seedAssembleArtifacts(runDir, [{ doc: "pl", rows: 2 }]);
    const result = await tool.execute({ run_id: "fail-run", workspace_path: root }, fakeExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("joint_assemble_failed");
    expect((result["stage_result"] as Record<string, unknown>)["exit_code"]).toBe(2);
    expect(existsSync(join(runDir, "prep", "variants", JOINT_OVERSAMPLE_NOTE_FILENAME))).toBe(false); // 零倍率账
    expect(result["training"]).toBeUndefined(); // 零训练直调
    expect(ctx.calls()).toBe(1); // 本卡一次（放行已消耗）——内部段未出卡
  });

  it("纯函数 applyJointOversample 三态锚：行数不一致拒／坏行拒／×2 复制行序确定＋全 1 直通逐字节不变", () => {
    const rows = [
      { row_index: 0, doc_type: "pl" },
      { row_index: 1, doc_type: "swb" },
    ];
    expect(applyJointOversample('{"a":1}\n', rows, { pl: 1 })["ok"]).toBe(false); // 账 2 行 vs 文件 1 行
    expect(applyJointOversample('{"a":1}\n{"b":2}\n', [{ row_index: 0 }, { row_index: 1, doc_type: "swb" }], { swb: 2 })["ok"]).toBe(false); // 坏行（缺 doc_type）
    const text = '{"a":1}\n{"b":2}\n';
    const pass = applyJointOversample(text, rows, { pl: 1, swb: 1 });
    expect(pass).toMatchObject({ ok: true, changed: false, text, final_rows: 2 }); // 全 1 直通
    const doubled = applyJointOversample(text, rows, { pl: 1, swb: 2 });
    expect(doubled["ok"]).toBe(true);
    expect(doubled["text"]).toBe('{"a":1}\n{"b":2}\n{"b":2}\n');
    expect(doubled["final_rows"]).toBe(3);
  });

  it("槽位枚举单源：工具卡前与 listDocSlots 同一读侧（E8 H2 红线——禁第二套实现）", () => {
    const root = tempRoot();
    const runDir = seedSlots(root, "mono", [{ doc: "aa", rows: 1 }, { doc: "zz", rows: 1 }]);
    mkdirSync(join(runDir, "prep", "variants", "notype"), { recursive: true }); // 无 train.jsonl 不构成类
    expect(listDocSlots(runDir).map((s) => s.doc_type)).toEqual(["aa", "zz"]);
  });

  it("E8b·H2 卡前校验——已登记 docs[] 与已备槽位不一致即快败（防「登记两类只装配一类」的静默）：登记多备少／备多登少／docs 形态非法三态；legacy 目录探测来源直通并在卡面与返回体标注", async () => {
    const root = tempRoot();
    const ctx = makeCtx();
    const tool = buildTool(root, ctx.ctx);
    // ① 登记两类（run.json docs[]＝do+swb）只备一类（槽位 do）→ joint_docs_slots_mismatch
    const partial = seedSlots(root, "partial-prep", [{ doc: "do", rows: 2 }]);
    // seedSlots 已写 docs[]=[do]——补登 swb（append-only 形态：手工重写 run.json）
    writeFileSync(join(partial, "run.json"), `${JSON.stringify({
      run_id: "partial-prep", layout_version: "RunLayout/v1",
      docs: [
        { doc_type: "do", lane_suffix: "do", registered_at: "2026-10-25T00:00:00+00:00" },
        { doc_type: "swb", lane_suffix: "swb", registered_at: "2026-10-25T01:00:00+00:00" },
      ],
    }, null, 1)}\n`);
    const mismatch = await tool.execute({ run_id: "partial-prep", workspace_path: root }, fakeExec);
    expect(mismatch["error"]).toBe("joint_docs_slots_mismatch");
    expect(mismatch["missing_slots"]).toEqual(["swb"]);
    expect(mismatch["registered"]).toEqual(["do", "swb"]);
    expect(String(mismatch["note"])).toContain("不会静默只装配其余类");
    expect(String(mismatch["note"])).toContain("先对缺的类逐类跑数据准备段");
    // ② 槽位有、登记无（docs[] 只登 do，槽位 do+swb）→ 同码 unregistered_slots 方向
    const unregistered = seedSlots(root, "unreg-slot", [{ doc: "do", rows: 1 }, { doc: "swb", rows: 1 }]);
    writeFileSync(join(unregistered, "run.json"), `${JSON.stringify({
      run_id: "unreg-slot", layout_version: "RunLayout/v1",
      docs: [{ doc_type: "do", lane_suffix: "do", registered_at: "2026-10-25T00:00:00+00:00" }],
    }, null, 1)}\n`);
    const mismatch2 = await tool.execute({ run_id: "unreg-slot", workspace_path: root }, fakeExec);
    expect(mismatch2["error"]).toBe("joint_docs_slots_mismatch");
    expect(mismatch2["unregistered_slots"]).toEqual(["swb"]);
    expect(String(mismatch2["note"])).toContain("来历与登记记录不一致");
    // ③ run.json docs 键形态非法 → joint_docs_registry_invalid（清单不可信即拒）
    const broken = seedSlots(root, "broken-docs", [{ doc: "do", rows: 1 }]);
    writeFileSync(join(broken, "run.json"), `${JSON.stringify({ run_id: "broken-docs", docs: "not-a-list" }, null, 1)}\n`);
    const invalid = await tool.execute({ run_id: "broken-docs", workspace_path: root }, fakeExec);
    expect(invalid["error"]).toBe("joint_docs_registry_invalid");
    expect(String(invalid["note"])).toContain("形态非法");
    // 三态全部零审批零段调用（卡前快败）
    expect(ctx.calls()).toBe(0);
    // ④ legacy 目录探测（无 run.json、有 stage-register 摘要）→ 校验直通，卡面与返回体标 legacy
    const legacyRun = join(root, "runs", "legacy-run");
    for (const doc of ["pl", "swb"]) {
      mkdirSync(join(legacyRun, "prep", "variants", doc), { recursive: true });
      writeFileSync(join(legacyRun, "prep", "variants", doc, "train.jsonl"), '{"row":"x"}\n');
      writeFileSync(join(legacyRun, `stage-register.${doc}.summary.json`), "{}\n");
    }
    seedAssembleArtifacts(legacyRun, [{ doc: "pl", rows: 1 }, { doc: "swb", rows: 1 }]);
    const legacyResult = await tool.execute({ run_id: "legacy-run", workspace_path: root }, fakeExec);
    expect(legacyResult["ok"]).toBe(true);
    expect(legacyResult["docs_registry"]).toEqual({ source: "legacy_dir_probe", doc_types: ["pl", "swb"] });
    expect(ctx.card()).toContain("目录探测（legacy run）");
    expect(ctx.card()).toContain("已登记单据");
  });
});

describe("E8——状态面单 run（jointTrainState 收敛：{run_id, classes 来自槽位, oversample, seed, base_model_family}）", () => {
  it("buildJointTrainMessage：文案＝「本次训练（N 类）」——run 单值；不出现 target run／落点与 prep/joint；字段规格槽位登记句在位", () => {
    const message = buildJointTrainMessage({
      run_id: "run-x",
      classes: [
        { doc_type: "pl", rows: 3410, field_count: 12 },
        { doc_type: "swb", rows: 1205 },
      ],
      oversample: { pl: 1, swb: 2 },
      seed: 42,
      base_model_family: "qwen3_vl",
      estimated_rows: 5820,
    });
    expect(message).toContain("本次训练（2 类：pl、swb → run run-x）：");
    expect(message).toContain("run_id：run-x");
    expect(message).toContain('oversample：{"pl":1,"swb":2}');
    expect(message).toContain("seed：42");
    expect(message).toContain("base_model_family：qwen3_vl");
    expect(message).toContain("pl 3,410 行 · 12 字段");
    expect(message).toContain("swb 1,205 行");
    expect(message).toContain("已按类登记在 experiment-setup（field-config.json）");
    expect(message).toContain("预计 5,820 行");
    // 禁词（E8：不出现 target run／落点实验概念与 prep/joint 落点指引；无 datasets 语义
    // ——atf_joint_train 工具名本身含 joint，禁的是路径指引非工具名）
    expect(message).not.toContain("target");
    expect(message).not.toContain("落点");
    expect(message).not.toContain("prep");
    expect(message).not.toContain("datasets：");
  });

  it("倍率/seed/基座族缺省形态：oversample 省略行在位；seed/base_model_family/预计行缺省不打行（不造数）", () => {
    const message = buildJointTrainMessage({ run_id: "run-y", classes: [{ doc_type: "only" }] });
    expect(message).toContain("本次训练（1 类：only → run run-y）：");
    expect(message).toContain("oversample：省略（全部类型 1 倍）");
    expect(message).not.toContain("seed：");
    expect(message).not.toContain("base_model_family：");
    expect(message).not.toContain("预计");
    expect(message).toContain("类型与数据：only");
    expect(message).not.toContain("行 · ");
  });

  it("共享判定单源：jointSpecIssues（UI 同锚——E8 类草稿无 run_id）与 normalizeJointFieldSpec 形态（locators 归一/group 闭集/选中过滤）", () => {
    expect(jointSpecIssues([{ doc_type: "pl", document_zh: "单据甲", fields: [{ field_id: "f", zh: "中", group: "goods", definition: "d", selected: true }] }])).toEqual([]);
    const issues = jointSpecIssues([
      { doc_type: "pl", document_zh: "", fields: [] },
      { doc_type: "pl", document_zh: "单据甲", fields: [{ field_id: "", zh: "x", group: "goods", definition: "" }] },
    ]);
    expect(issues.map((i) => i.code)).toEqual(["joint_document_zh_missing", "joint_field_missing", "joint_doc_type_duplicate"]);
    const spec = normalizeJointFieldSpec("pl", "单据甲", [
      { field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locator_keywords: ["K1"] },
      { field_id: "b", zh: "乙", definition: "d2", selected: false },
      { field_id: "c", zh: "丙", definition: "d3" },
    ]);
    expect(spec).toEqual({
      schema_version: "FieldSpec/v1", doc_type: "pl", document_zh: "单据甲",
      fields: [
        { field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locators: ["K1"] },
        { field_id: "c", zh: "丙", group: "goods", definition: "d3", locators: [] },
      ],
    });
  });
});
