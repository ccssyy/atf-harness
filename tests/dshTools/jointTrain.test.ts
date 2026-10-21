/**
 * H5——atf_joint_train 多类联合训练测试锚（指令 H5＋D25 设计 §四/§五；内核 pin v0.7.23b0）。
 *
 * 覆盖面：
 * - schema 面（datasets/field_specs/oversample 参数在位、业务语言描述、单一入口无 A/B）；
 * - 卡前快败六态（字段空/说明缺/doc_type 重/键集不齐/prep 缺/倍率非法）＋扩展态
 *   （run 解析不到/目标缺/train.sh 缺/--out 落点越声明/规格文件不可读/seed 非法）——
 *   全部零产物零审批零 spawn（out 目录不建、builder 不被调）；
 * - builder argv 快照（--run/--field-spec 逐值、--base-model-family、--seed、--out 落点
 *   ＝<目标run>/prep/joint）；规格文件入 run 树（file 导入字节保留、inline 归一
 *   locator_keywords→locators）；
 * - oversample 确定性倍率复制（×2 行数翻倍且行序确定；全 1 直通 sha 逐字节不变）＋
 *   倍率账注记（无时间戳——可复现）；
 * - 卡面四要素（类型/各类字段数/预计行数——实测 dry plan/倍率）＋seed＋权属行＋E5 模板；
 * - 训练直调（atf_run_training 执行函数——整链仅一张审批卡；训练段经 DRY_RUN 面证明
 *   被调且参数回传）；返回体 lossless（JSON round-trip 深等）。
 * mock pin 形态沿 evalInherit/trainingFace 测试（真 python3 子进程面；builder mock 逐字
 * 镜像内核 merge 语义：类序＝doc_type 字典序、行级账 rows[].row_index/doc_type）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildJointTrainTool,
  JOINT_OUT_REL,
  applyJointOversample,
  jointBuilderArgv,
  jointOutLayoutVerdict,
  parseJointBuilderStderr,
} from "../../packages/extensions/atf-tools/src/jointTrainFace.js";
import { jointSpecIssues, normalizeJointFieldSpec } from "../../packages/extensions/atf-ui/src/jointTrainState.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "h5-joint-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { callId: "t", agent: { session: { id: "sess-h5" } } };
type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

/** mock 内核 pin：builder 逐字镜像内核 merge 语义（类序字典序/行级账/三产物/stdout 摘要）；
 *  argv 快照落 pin 根（argv-capture.json）。opts.fail＝exit 2 内核校验拒绝形态（无条件拒绝
 *  ——dry 首调即拒，验「卡前实测拒绝零审批消耗」）。 */
const writeMockBuilder = (pin: string, opts: { fail?: string } = {}): void => {
  mkdirSync(join(pin, "tools"), { recursive: true });
  const failBlock = opts.fail === undefined
    ? ""
    : `sys.stderr.write(json.dumps({"error": ${JSON.stringify(opts.fail)}, "detail": "mock 拒绝明细"}))
raise SystemExit(2)
`;
  writeFileSync(join(pin, "tools", "build_joint_dataset.py"), `#!/usr/bin/env python3
import hashlib, json, os, sys
args = sys.argv[1:]
pin = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
open(os.path.join(pin, "argv-capture.json"), "w").write(json.dumps(args))
${failBlock}out = args[args.index("--out") + 1]
runs = {}
for i, a in enumerate(args):
    if a == "--run":
        key, _, value = args[i + 1].partition("=")
        runs[key] = value
os.makedirs(out, exist_ok=True)
lines = []
rows = []
classes = []
cursor = 0
for dt in sorted(runs):
    src = os.path.join(runs[dt], "prep", "variants", "train.jsonl")
    with open(src, "r", encoding="utf-8") as fh:
        dt_lines = [line.rstrip("\\n") for line in fh if line.strip()]
    classes.append({"doc_type": dt, "source_row_count": len(dt_lines)})
    for line in dt_lines:
        rows.append({"row_index": cursor, "doc_type": dt})
        lines.append(line)
        cursor += 1
merged = ("\\n".join(lines) + "\\n") if lines else ""
with open(os.path.join(out, "train.jsonl"), "w", encoding="utf-8") as fh:
    fh.write(merged)
plan = {"schema_version": "JointDatasetPlan/v1", "doc_types": sorted(runs), "seed": 0, "classes": classes}
with open(os.path.join(out, "joint-dataset-plan.json"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(plan, ensure_ascii=False, indent=1) + "\\n")
manifest = {"schema_version": "JointDatasetMergeManifest/v1", "doc_types": sorted(runs), "classes": classes,
            "merged": {"path": "train.jsonl", "row_count": cursor, "sha256": hashlib.sha256(merged.encode("utf-8")).hexdigest()},
            "rows": rows}
with open(os.path.join(out, "merge_manifest.json"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(manifest, ensure_ascii=False, indent=1) + "\\n")
print(json.dumps({"status": "ok", "out_dir": out, "doc_types": sorted(runs), "row_count": cursor}))
`);
};

/** 源 run 夹具（prep 产物闭集：prep/variants/train.jsonl＋contract-candidate.json）。 */
const seedSourceRun = (runsRoot: string, runId: string, rowKeys: string[], fields: string[], opts: { dropPrep?: boolean; dropCandidate?: boolean } = {}): string => {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  if (!opts.dropPrep) {
    mkdirSync(join(dir, "prep", "variants"), { recursive: true });
    writeFileSync(join(dir, "prep", "variants", "train.jsonl"), rowKeys.map((k) => JSON.stringify({ row: k })).join("\n") + "\n");
  } else {
    mkdirSync(join(dir, "prep"), { recursive: true }); // prep 标记在位（run 可见）——缺的是产物 train.jsonl
  }
  if (!opts.dropCandidate) {
    writeFileSync(join(dir, "contract-candidate.json"), JSON.stringify({ field_schema: { fields: fields.map((f) => ({ field_id: f })) } }));
  }
  return dir;
};

const RUN_LAYOUT_DIRS = ["webui", "prep", "prep/iteration-config", "prep/variants", "launch", "training", "eval", "analysis", "publish"];

/** 目标 run 夹具（canonical RunLayout/v1 形态——run.json.dirs 声明闭集含 prep）。 */
const seedTargetRun = (runsRoot: string, runId: string, opts: { dirs?: string[]; legacy?: boolean } = {}): string => {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  if (opts.legacy !== true) {
    const dirs = opts.dirs ?? RUN_LAYOUT_DIRS;
    writeFileSync(join(dir, "run.json"), JSON.stringify({
      layout_version: "RunLayout/v1", workspace_id: "ws-h5", run_id: runId,
      created_at: "2026-10-21T00:00:00Z", dirs,
    }, null, 1) + "\n");
    for (const top of new Set(dirs.map((d) => d.split("/")[0] ?? ""))) mkdirSync(join(dir, top), { recursive: true });
  }
  return dir;
};

/** DRY_RUN 必败 train.sh（exit 0 且无 ADMISSION=pass——训练直调被证被调且零 tmux 零端口）。 */
const seedFailingTrainSh = (root: string): string => {
  const path = join(root, "train.sh");
  writeFileSync(path, "#!/bin/bash\necho 'dry-check-ok'\n");
  return path;
};

/** DRY_RUN 过关 train.sh（stdout 含 ADMISSION=pass——训练直调推进到 prelaunch/模型复核段）。 */
const seedPassingTrainSh = (root: string): string => {
  const path = join(root, "train-pass.sh");
  writeFileSync(path, "#!/bin/bash\necho 'SHA=pass ADMISSION=pass'\n");
  return path;
};

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

const buildTool = (runsRoot: string, pin: string, ctx: ReturnType<typeof makeCtx>["ctx"]): Tool =>
  buildJointTrainTool(ctx, { runsRoot, kernelDir: pin, logDir: runsRoot, registryWorkspaces: [] }) as unknown as Tool;

const PL_FIELDS = [
  { field_id: "goods_description", zh: "货描", group: "goods", definition: "货物描述", locator_keywords: ["DESCRIPTION", "品名"] },
  { field_id: "container_no", zh: "箱号", group: "non_goods", definition: "集装箱号" },
  { field_id: "seal_no", zh: "铅封号", group: "non_goods", definition: "铅封号码" },
];
const SWB_FIELDS = [
  { field_id: "shipper", zh: "发货人", group: "goods", definition: "发货人名称" },
  { field_id: "voyage_no", zh: "航次号", group: "non_goods", definition: "航次编号" },
];

const seedStandardWorld = (opts: { oversample?: Record<string, number> } = {}): { root: string; pin: string; tool: Tool; ctx: ReturnType<typeof makeCtx>; args: Record<string, unknown>; targetDir: string; trainSh: string } => {
  const root = tempRoot();
  const pin = tempRoot();
  writeMockBuilder(pin);
  seedSourceRun(root, "run-pl", ["pl-1", "pl-2", "pl-3"], ["goods_description", "container_no", "seal_no"]);
  seedSourceRun(root, "run-swb", ["swb-1", "swb-2"], ["shipper", "voyage_no"]);
  const targetDir = seedTargetRun(root, "run-target");
  const trainSh = seedFailingTrainSh(root);
  const ctx = makeCtx();
  const tool = buildTool(root, pin, ctx.ctx);
  const args: Record<string, unknown> = {
    datasets: [{ run_id: "run-pl", doc_type: "pl" }, { run_id: "run-swb", doc_type: "swb" }],
    field_specs: {
      pl: { schema_version: "FieldSpec/v1", doc_type: "pl", document_zh: "装箱单", fields: PL_FIELDS },
      swb: { schema_version: "FieldSpec/v1", doc_type: "swb", document_zh: "海运单", fields: SWB_FIELDS },
    },
    seed: 42,
    target_run_id: "run-target",
    train_sh: trainSh,
    ...(opts.oversample !== undefined ? { oversample: opts.oversample } : {}),
  };
  return { root, pin, tool, ctx, args, targetDir, trainSh };
};

const noUndefinedDeep = (value: unknown, path = "$"): string[] => {
  if (value === undefined) return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => noUndefinedDeep(v, `${path}[${String(i)}]`));
  if (value !== null && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => noUndefinedDeep(v, `${path}.${k}`));
  return [];
};

describe("H5——atf_joint_train（schema 面＋卡前快败＋builder 链＋oversample＋卡面＋训练直调）", () => {
  it("schema 面：参数在位且全业务语言描述；单一入口（描述带『不要拆成单类』；无 A/B 引导）", () => {
    const { tool } = seedStandardWorld();
    expect(tool.name).toBe("atf_joint_train");
    // defineTool 产物的 parameters 是 JSON Schema（properties 键面——DSH 协议面）
    const raw = tool as unknown as { parameters?: { properties?: Record<string, { description?: string }> } };
    const props = raw.parameters?.properties ?? {};
    for (const key of ["datasets", "field_specs", "oversample", "seed", "target_run_id", "train_sh"]) {
      expect(props[key], `参数 ${key} 应在 schema 面`).toBeTruthy();
      expect(props[key]?.description, `参数 ${key} 描述应业务语言`).toBeTruthy();
    }
    expect(props["datasets"]?.description).toContain("doc_type");
    expect(props["field_specs"]?.description).toContain("FieldSpec/v1");
    expect(props["oversample"]?.description).toContain("1 倍");
  });

  it("卡前快败——字段缺失（某类 fields 空）：joint_field_missing＋零产物零审批零 spawn", async () => {
    const w = seedStandardWorld();
    const spec = w.args.field_specs as Record<string, Record<string, unknown>>;
    spec["swb"] = { document_zh: "海运单", fields: [] };
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("joint_field_missing");
    expect(result.doc_type).toBe("swb");
    expect(w.ctx.calls()).toBe(0); // 零审批
    expect(existsSync(join(w.targetDir, "prep", "joint"))).toBe(false); // 零产物
    expect(existsSync(join(w.pin, "argv-capture.json"))).toBe(false); // 零 spawn
  });

  it("卡前快败——字段说明缺失（zh/definition 空）：joint_field_desc_missing 指明类与字段", async () => {
    const w = seedStandardWorld();
    const spec = w.args.field_specs as Record<string, Record<string, unknown>>;
    spec["pl"] = { document_zh: "装箱单", fields: [{ field_id: "goods_description", zh: "", group: "goods", definition: "x" }] };
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.error).toBe("joint_field_desc_missing");
    expect(result.doc_type).toBe("pl");
    expect(result.field_id).toBe("goods_description");
    expect(w.ctx.calls()).toBe(0);
    expect(existsSync(join(w.targetDir, "prep", "joint"))).toBe(false);
  });

  it("卡前快败——doc_type 重复：joint_doc_type_duplicate", async () => {
    const w = seedStandardWorld();
    w.args.datasets = [{ run_id: "run-pl", doc_type: "pl" }, { run_id: "run-swb", doc_type: "pl" }];
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.error).toBe("joint_doc_type_duplicate");
    expect(result.doc_type).toBe("pl");
    expect(w.ctx.calls()).toBe(0);
    expect(existsSync(join(w.pin, "argv-capture.json"))).toBe(false);
  });

  it("卡前快败——键集不一致（field_specs 缺类/多类）：joint_field_spec_keyset_mismatch", async () => {
    const w = seedStandardWorld();
    const spec = w.args.field_specs as Record<string, unknown>;
    delete spec["swb"];
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.error).toBe("joint_field_spec_keyset_mismatch");
    expect(result.missing_keys).toEqual(["swb"]);
    expect(w.ctx.calls()).toBe(0);
    // 多类形态
    spec["do"] = { document_zh: "提单", fields: [{ field_id: "f1", zh: "一", group: "goods", definition: "d" }] };
    const result2 = await w.tool.execute(w.args, fakeExec);
    expect(result2.error).toBe("joint_field_spec_keyset_mismatch");
    expect(result2.extra_keys).toEqual(["do"]);
  });

  it("卡前快败——prep 产物缺失：joint_prep_missing（缺 train.jsonl／缺 contract-candidate 两态）", async () => {
    const w = seedStandardWorld();
    w.args.datasets = [{ run_id: "run-bare", doc_type: "pl" }];
    w.args.field_specs = { pl: { document_zh: "装箱单", fields: PL_FIELDS } };
    seedSourceRun(w.root, "run-bare", ["x"], ["goods_description", "container_no", "seal_no"], { dropPrep: true });
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.error).toBe("joint_prep_missing");
    expect(result.missing).toEqual(["prep/variants/train.jsonl"]);
    expect(w.ctx.calls()).toBe(0);
    seedSourceRun(w.root, "run-bare2", ["x"], ["goods_description", "container_no", "seal_no"], { dropCandidate: true });
    w.args.datasets = [{ run_id: "run-bare2", doc_type: "pl" }];
    const result2 = await w.tool.execute(w.args, fakeExec);
    expect(result2.error).toBe("joint_prep_missing");
    expect(result2.missing).toEqual(["contract-candidate.json"]);
  });

  it("卡前快败——倍率非法：非整数/＜1 → joint_oversample_invalid；键集不齐 → joint_oversample_keyset_mismatch", async () => {
    const w = seedStandardWorld();
    w.args.oversample = { pl: 1, swb: 0 };
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.error).toBe("joint_oversample_invalid");
    expect(result.doc_type).toBe("swb");
    w.args.oversample = { pl: 1.5, swb: 1 };
    const result2 = await w.tool.execute(w.args, fakeExec);
    expect(result2.error).toBe("joint_oversample_invalid");
    w.args.oversample = { pl: 1 };
    const result3 = await w.tool.execute(w.args, fakeExec);
    expect(result3.error).toBe("joint_oversample_keyset_mismatch");
    expect(result3.missing_keys).toEqual(["swb"]);
    expect(w.ctx.calls()).toBe(0);
    expect(existsSync(join(w.pin, "argv-capture.json"))).toBe(false);
  });

  it("卡前快败——扩展态：run 解析不到／目标 run 缺／train.sh 缺／--out 越声明闭集／spec 文件不可读／seed 非法（全部零审批）", async () => {
    const w = seedStandardWorld();
    // run 解析不到
    w.args.datasets = [{ run_id: "run-ghost", doc_type: "pl" }];
    w.args.field_specs = { pl: { document_zh: "装箱单", fields: PL_FIELDS } };
    const r1 = await w.tool.execute(w.args, fakeExec);
    expect(r1.error).toBe("joint_run_unresolved");
    expect(r1.run_id).toBe("run-ghost");
    // 目标 run 缺
    const w2 = seedStandardWorld();
    w2.args.target_run_id = "run-ghost";
    const r2 = await w2.tool.execute(w2.args, fakeExec);
    expect(r2.error).toBe("joint_run_unresolved");
    expect(r2.target).toBe(true);
    // train.sh 缺
    const w3 = seedStandardWorld();
    w3.args.train_sh = "";
    const r3 = await w3.tool.execute(w3.args, fakeExec);
    expect(r3.error).toBe("joint_train_sh_missing");
    // --out 越声明闭集（目标 run.json.dirs 无 prep）
    const w4 = seedStandardWorld();
    seedTargetRun(w4.root, "run-odd-target", { dirs: ["webui", "launch"] });
    w4.args.target_run_id = "run-odd-target";
    const r4 = await w4.tool.execute(w4.args, fakeExec);
    expect(r4.error).toBe("joint_out_outside_layout");
    expect(Array.isArray(r4.declared)).toBe(true);
    expect(w4.ctx.calls()).toBe(0);
    // spec 文件不可读
    const w5 = seedStandardWorld();
    w5.args.field_specs = { pl: join(w5.root, "no-such-spec.json"), swb: { document_zh: "海运单", fields: SWB_FIELDS } };
    const r5 = await w5.tool.execute(w5.args, fakeExec);
    expect(r5.error).toBe("joint_field_spec_unreadable");
    // seed 非法
    const w6 = seedStandardWorld();
    w6.args.seed = -1;
    const r6 = await w6.tool.execute(w6.args, fakeExec);
    expect(r6.error).toBe("joint_seed_invalid");
    for (const c of [w, w2, w3, w5, w6]) expect(c.ctx.calls()).toBe(0);
  });

  it("全链：builder argv 快照（--run/--field-spec 逐值＋--out 落点 prep/joint）＋倍率 ×2 行数翻倍且行序确定", async () => {
    const w = seedStandardWorld({ oversample: { pl: 1, swb: 2 } });
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    // argv 快照（真跑那一次——dry 同构仅 --out 不同）
    const argv = JSON.parse(readFileSync(join(w.pin, "argv-capture.json"), "utf8")) as string[];
    const plDir = join(w.root, "run-pl");
    const swbDir = join(w.root, "run-swb");
    expect(argv).toContain(`pl=${plDir}`);
    expect(argv).toContain(`swb=${swbDir}`);
    const specCopied = join(w.targetDir, "prep", "joint", "field-specs", "pl.json");
    const specCopiedSwb = join(w.targetDir, "prep", "joint", "field-specs", "swb.json");
    expect(argv).toContain(`pl=${specCopied}`);
    expect(argv).toContain(`swb=${specCopiedSwb}`);
    expect(argv).toContain("--base-model-family");
    expect(argv[argv.indexOf("--base-model-family") + 1]).toBe("qwen3_vl");
    expect(argv).toContain("--seed");
    expect(argv[argv.indexOf("--seed") + 1]).toBe("42");
    expect(argv).toContain("--out");
    expect(argv[argv.indexOf("--out") + 1]).toBe(join(w.targetDir, "prep", "joint"));
    // inline spec 归一落盘：locator_keywords→locators、group 保持
    const specJson = JSON.parse(readFileSync(specCopied, "utf8")) as { fields: Array<Record<string, unknown>> };
    expect(specJson.fields[0]).toMatchObject({ field_id: "goods_description", group: "goods", locators: ["DESCRIPTION", "品名"] });
    expect(specJson.fields[1]).toMatchObject({ field_id: "container_no", group: "non_goods" });
    // 倍率数学：3×1＋2×2＝7 行；行序确定（pl1..pl3,swb1,swb1,swb2,swb2）
    expect(result.merged_rows).toBe(7);
    const rows = readFileSync(join(w.targetDir, "prep", "joint", "train.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { row: string }).row);
    expect(rows).toEqual(["pl-1", "pl-2", "pl-3", "swb-1", "swb-1", "swb-2", "swb-2"]);
    // 返回体类事实＋倍率账注记（无时间戳——可复现）
    expect(result.classes).toEqual([
      { doc_type: "pl", run_id: "run-pl", field_count: 3, source_rows: 3, ratio: 1, final_rows: 3 },
      { doc_type: "swb", run_id: "run-swb", field_count: 2, source_rows: 2, ratio: 2, final_rows: 4 },
    ]);
    expect(result.oversample_passthrough).toBe(false);
    const note = JSON.parse(readFileSync(join(w.targetDir, "prep", "joint", "harness-oversample.json"), "utf8")) as Record<string, unknown>;
    expect(note.schema_version).toBe("JointOversampleNote/v1");
    expect(note.ratios).toEqual({ pl: 1, swb: 2 });
    expect((note.merged as Record<string, unknown>).row_count).toBe(7);
    expect((note.merged as Record<string, unknown>).passthrough).toBe(false);
    expect(String((note.merged as Record<string, unknown>).sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(note)).not.toContain("updated_at");
  });

  it("全 1 直通：oversample 省略 → train.jsonl 逐字节不变（sha＝builder merged sha）＋oversample_passthrough true", async () => {
    const w = seedStandardWorld();
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    expect(result.merged_rows).toBe(5);
    expect(result.oversample_passthrough).toBe(true);
    const mergedText = ["pl-1", "pl-2", "pl-3", "swb-1", "swb-2"].map((k) => JSON.stringify({ row: k })).join("\n") + "\n";
    const expectedSha = createHash("sha256").update(mergedText).digest("hex");
    expect(result.merged_sha256).toBe(expectedSha);
    const note = JSON.parse(readFileSync(join(w.targetDir, "prep", "joint", "harness-oversample.json"), "utf8")) as { merged: Record<string, unknown>; ratios: Record<string, number> };
    expect(note.merged.passthrough).toBe(true);
    expect(note.merged.builder_sha256).toBe(expectedSha);
    expect(note.merged.sha256).toBe(expectedSha);
    expect(note.ratios).toEqual({ pl: 1, swb: 1 }); // 缺省全 1 显式化
  });

  it("卡面四要素＋seed＋权属行（E5 模板四行——类型/各类字段数/预计行数实测/倍率）＋整链恰一张审批卡", async () => {
    const w = seedStandardWorld({ oversample: { pl: 1, swb: 2 } });
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    const card = w.ctx.card();
    expect(card).toContain("将要执行：");
    expect(card).toContain("影响范围：");
    expect(card).toContain("可逆性：");
    expect(card).toContain("预计代价：");
    expect(card).toContain("类型：pl、swb（2 类）");
    expect(card).toContain("各类字段数：pl 3 · swb 2");
    expect(card).toContain("预计行数：7"); // 实测 dry plan：3×1＋2×2
    expect(card).toContain("合并倍率：pl ×1 · swb ×2");
    expect(card).toContain("seed：42");
    expect(card).toContain("仅 owner 可点；执行方不得代点");
    // 整链恰一张卡（训练直调段不再弹卡——设计 §五.3 一张确认卡一个联合任务）
    expect(w.ctx.calls()).toBe(1);
  });

  it("训练直调：atf_run_training 执行函数被调（模型复核面证明——run_id/train_sh 回传）＋返回体 lossless", async () => {
    const w = seedStandardWorld();
    // 训练段推进到 base_model 复核（DRY_RUN 过＋prelaunch 在场＋无 iteration-config）——
    // 该结构化拒绝载荷带 run_id 与 train_sh 双键，证明内部调用收到了联合参数。
    const passingSh = seedPassingTrainSh(w.root);
    const prelaunch = join(w.root, "prelaunch.md");
    writeFileSync(prelaunch, "# prelaunch\n");
    w.args.train_sh = passingSh;
    w.args.prelaunch_report = prelaunch;
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    expect(result.started).toBe(false); // 无 iteration-config——模型复核如实拒绝（零猜测）
    const training = result.training as Record<string, unknown>;
    expect(training.started).toBe(false);
    expect(training.error).toBe("model_path_missing");
    expect(training.run_id).toBe("run-target");
    expect(training.train_sh).toBe(passingSh);
    // 联合产物在位（训练失败不抹数据——重推只补训练）
    expect(existsSync(join(w.targetDir, "prep", "joint", "train.jsonl"))).toBe(true);
    expect(String(result.note)).toContain("训练未启动");
    // typert lossless：JSON round-trip 深等（无 undefined 键——条件 spread 纪律）
    expect(noUndefinedDeep(result)).toEqual([]);
    const round = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(round).toEqual(result);
  });

  it("file 导入：spec 文件路径 → 字节保留拷贝入 run 树＋argv 指向 run 树内副本", async () => {
    const w = seedStandardWorld();
    const specFile = join(w.root, "imported-pl-spec.json");
    const imported = { schema_version: "FieldSpec/v1", doc_type: "pl", document_zh: "装箱单", fields: PL_FIELDS };
    writeFileSync(specFile, JSON.stringify(imported, null, 1) + "\n");
    (w.args.field_specs as Record<string, unknown>)["pl"] = specFile;
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    const copied = join(w.targetDir, "prep", "joint", "field-specs", "pl.json");
    expect(readFileSync(copied, "utf8")).toBe(readFileSync(specFile, "utf8")); // 字节保留
    const argv = JSON.parse(readFileSync(join(w.pin, "argv-capture.json"), "utf8")) as string[];
    expect(argv).toContain(`pl=${copied}`);
  });

  it("run 解析单源（分桶形态）：桶内 run 可解析进联合；纯函数面（argv/out 守卫/oversample/stderr 账）单测", async () => {
    const w = seedStandardWorld();
    seedSourceRun(join(w.root, "bucket-x"), "run-bucket", ["b-1"], ["goods_description", "container_no", "seal_no"]);
    // bucketedRunEntries 需要 bucket-x 不是 run 本身（无标记）且 run-bucket 有 prep 标记——上面 seed 已给
    w.args.datasets = [{ run_id: "run-bucket", doc_type: "pl" }];
    w.args.field_specs = { pl: { document_zh: "装箱单", fields: PL_FIELDS } };
    delete w.args.oversample; // 缺省全 1（lossless 校验拒 undefined 键——工具面同样拒）
    const result = await w.tool.execute(w.args, fakeExec);
    expect(result.ok).toBe(true);
    expect(result.doc_types).toEqual(["pl"]);
    // 纯函数面：argv 构造（doc_type 字典序）
    const argv = jointBuilderArgv({
      classes: [
        { doc_type: "swb", run_dir: "/r/s", specPath: "/s/s.json" },
        { doc_type: "pl", run_dir: "/r/p", specPath: "/s/p.json" },
      ],
      baseModelFamily: "qwen3_vl", seed: 7, out: "/o",
    });
    expect(argv).toEqual(["--run", "pl=/r/p", "--run", "swb=/r/s", "--field-spec", "pl=/s/p.json", "--field-spec", "swb=/s/s.json", "--base-model-family", "qwen3_vl", "--seed", "7", "--out", "/o"]);
    // --out 落点守卫：声明命中（prep 前缀）／未声明拒绝／无 run.json 放行
    const root2 = tempRoot();
    const okRun = seedTargetRun(root2, "run-ok");
    expect(jointOutLayoutVerdict(okRun, JOINT_OUT_REL).ok).toBe(true);
    const oddRun = seedTargetRun(root2, "run-odd", { dirs: ["webui"] });
    const verdict = jointOutLayoutVerdict(oddRun, JOINT_OUT_REL);
    expect(verdict.ok).toBe(false);
    expect((verdict as { error: string }).error).toBe("joint_out_outside_layout");
    const legacyDir = join(root2, "run-legacy");
    mkdirSync(legacyDir, { recursive: true });
    expect(jointOutLayoutVerdict(legacyDir, JOINT_OUT_REL).ok).toBe(true);
    // oversample 纯函数：坏账 fail-closed／倍率重复行序
    const bad = applyJointOversample("a\n", [{ row_index: 0, doc_type: "x" }, { row_index: 1, doc_type: "x" }], { x: 2 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("joint_oversample_failed");
    const doubled = applyJointOversample("l1\nl2\n", [{ row_index: 0, doc_type: "x" }, { row_index: 1, doc_type: "y" }], { x: 3, y: 1 });
    expect(doubled.text).toBe("l1\nl1\nl1\nl2\n");
    expect(doubled.final_rows).toBe(4);
    // stderr 账解析（内核 {"error","detail"} 协议）
    expect(parseJointBuilderStderr('noise\n{"error": "field_spec_invalid", "detail": "d"}\n')).toEqual({ error: "field_spec_invalid", detail: "d" });
    expect(parseJointBuilderStderr("no json here").error).toBeNull();
  });

  it("dry 阶段内核拒绝（跨类 field_id 共享命名空间等）：joint_builder_failed stage=dry＋零审批消耗", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockBuilder(pin, { fail: "field_spec_invalid" });
    seedSourceRun(root, "run-pl", ["x"], ["goods_description"]);
    seedTargetRun(root, "run-target");
    const trainSh = seedFailingTrainSh(root);
    const ctx = makeCtx();
    const tool = buildTool(root, pin, ctx.ctx);
    const result = await tool.execute({
      datasets: [{ run_id: "run-pl", doc_type: "pl" }],
      field_specs: { pl: { document_zh: "装箱单", fields: [{ field_id: "goods_description", zh: "货描", group: "goods", definition: "货物描述" }] } },
      target_run_id: "run-target",
      train_sh: trainSh,
    }, fakeExec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("joint_builder_failed");
    expect(result.stage).toBe("dry");
    expect(result.kernel_error).toBe("field_spec_invalid");
    expect(ctx.calls()).toBe(0); // 卡前实测拒绝——零审批消耗
    expect(existsSync(join(root, "run-target", "prep", "joint"))).toBe(false);
  });

  it("共享判定单源：jointSpecIssues（UI 同锚）与 normalizeJointFieldSpec 形态（locators 归一/group 闭集/选中过滤）", () => {
    expect(jointSpecIssues([{ doc_type: "pl", run_id: "r", document_zh: "装箱单", fields: [{ field_id: "f", zh: "中", group: "goods", definition: "d", selected: true }] }])).toEqual([]);
    const issues = jointSpecIssues([
      { doc_type: "pl", run_id: "", document_zh: "", fields: [] },
      { doc_type: "pl", run_id: "r2", document_zh: "装箱单", fields: [{ field_id: "", zh: "x", group: "goods", definition: "" }] },
    ]);
    expect(issues.map((i) => i.code)).toEqual(["joint_run_id_missing", "joint_document_zh_missing", "joint_field_missing", "joint_doc_type_duplicate"]);
    const spec = normalizeJointFieldSpec("pl", "装箱单", [
      { field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locator_keywords: ["K1"] },
      { field_id: "b", zh: "乙", definition: "d2", selected: false },
      { field_id: "c", zh: "丙", definition: "d3" },
    ]);
    expect(spec).toEqual({
      schema_version: "FieldSpec/v1", doc_type: "pl", document_zh: "装箱单",
      fields: [
        { field_id: "a", zh: "甲", group: "non_goods", definition: "d1", locators: ["K1"] },
        { field_id: "c", zh: "丙", group: "goods", definition: "d3", locators: [] },
      ],
    });
  });
});
