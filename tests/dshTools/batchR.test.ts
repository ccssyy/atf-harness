/**
 * 批㊶R前置 测试锚——start 面复核三态（防线③）／模型清单状态面／卡数机器事实与反模式
 * 拦截两态／agentRecommend nproc clamp 边界／扩键投影三态（白名单/摘要/卡面用例）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLocalModels, modelRootOf } from "../../src/core/workspace/modelInventory.js";
import {
  detectAvailableGpuCount,
  guardNprocAntiPatterns,
  parseVisibleDevicesCount,
  type NprocGuardField,
} from "../../src/core/workspace/smartDefaults.js";
import { checkStartModelPath } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { evalAgentRecommend, RECOMMENDABLE_KEYS } from "../../src/core/workspace/agentRecommend.js";
import { CONFIG_CONFIRM_KEYS, buildConfigConfirmFields, parseConfigEditText } from "../../src/webui/configConfirm.js";
import { buildIterationSummary } from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-r-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶R前置——模型清单状态面（modelInventory）", () => {
  it("一级目录扫描：子目录升序入列；root 缺席＝空清单＋error（不猜测）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "Qwen3-VL-32B-Instruct"), { recursive: true });
    mkdirSync(join(root, "b-model"), { recursive: true });
    writeFileSync(join(root, "a-file.txt"), "x");
    mkdirSync(join(root, ".hidden"), { recursive: true });
    const inv = scanLocalModels({ ATF_MODEL_ROOT: root });
    expect(inv.models).toEqual(["Qwen3-VL-32B-Instruct", "b-model"]);
    expect(inv.error).toBeUndefined();
    const missing = scanLocalModels({ ATF_MODEL_ROOT: join(root, "nope") });
    expect(missing.models).toEqual([]);
    expect(missing.error).toBe("model_root_missing");
  });
  it("env 解析：ATF_MODEL_ROOT 可配；未配置＝null（产品资产零绝对路径——env-only）", () => {
    expect(modelRootOf({})).toBeNull();
    expect(modelRootOf({ ATF_MODEL_ROOT: "/data/models " })).toBe("/data/models");
    const unset = scanLocalModels({});
    expect(unset.models).toEqual([]);
    expect(unset.error).toBe("model_root_unset");
  });
});

describe("批㊶R前置——防线③ start 面复核（checkStartModelPath 三态）", () => {
  const writeIterConfig = (runDir: string, basePath: string | undefined): void => {
    const dir = join(runDir, "prep");
    mkdirSync(dir, { recursive: true });
    const training = { learning_rate: "1e-4" };
    const base = basePath === undefined ? {} : { path: basePath };
    writeFileSync(join(dir, "iteration-config.json"), `${JSON.stringify({ base_model: base, training }, null, 1)}\n`);
  };
  it("① iteration-config 缺席 → 拒（iteration_config_missing＋清单回流）", () => {
    const runDir = tempRoot();
    const modelsRoot = tempRoot();
    mkdirSync(join(modelsRoot, "m-a"), { recursive: true });
    const result = checkStartModelPath(runDir, { ATF_MODEL_ROOT: modelsRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("iteration_config_missing");
      expect(result.models).toEqual(["m-a"]);
    }
  });
  it("② 路径非本地目录（qwen3_vl 家族名误填）→ 拒（not_local_dir＋清单回流）", () => {
    const runDir = tempRoot();
    writeIterConfig(runDir, "qwen3_vl");
    const modelsRoot = tempRoot();
    mkdirSync(join(modelsRoot, "Qwen3-VL-32B-Instruct"), { recursive: true });
    const result = checkStartModelPath(runDir, { ATF_MODEL_ROOT: modelsRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_local_dir");
      expect(result.path).toBe("qwen3_vl");
      expect(result.models).toEqual(["Qwen3-VL-32B-Instruct"]);
    }
  });
  it("③ 合法本地路径（含 config.json）→ 过；config.json 缺席 → 拒（不静默放行）", () => {
    const runDir = tempRoot();
    const modelsRoot = tempRoot();
    const modelDir = join(modelsRoot, "Qwen3-VL-32B-Instruct");
    mkdirSync(modelDir, { recursive: true });
    writeIterConfig(runDir, modelDir);
    const missingConfig = checkStartModelPath(runDir, { ATF_MODEL_ROOT: modelsRoot });
    expect(missingConfig.ok).toBe(false);
    if (!missingConfig.ok) expect(missingConfig.reason).toBe("config_json_missing");
    writeFileSync(join(modelDir, "config.json"), "{}\n");
    const ok = checkStartModelPath(runDir, { ATF_MODEL_ROOT: modelsRoot });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.path).toBe(modelDir);
  });
});

describe("批㊶R前置——卡数机器事实与反模式拦截", () => {
  it("detectAvailableGpuCount：CUDA_VISIBLE_DEVICES 列表/区间优先；皆缺＝null（不设默认）", () => {
    expect(detectAvailableGpuCount({ CUDA_VISIBLE_DEVICES: "2,3,4,5" }, () => 8)).toBe(4);
    expect(detectAvailableGpuCount({ CUDA_VISIBLE_DEVICES: "2-5" }, () => 8)).toBe(4);
    expect(detectAvailableGpuCount({ CUDA_VISIBLE_DEVICES: "bad" }, () => 8)).toBeNull();
    expect(detectAvailableGpuCount({}, () => null)).toBeNull();
    expect(detectAvailableGpuCount({}, () => 8)).toBe(8);
    expect(parseVisibleDevicesCount("0,1, 2")).toBe(3);
    expect(parseVisibleDevicesCount("0-7")).toBe(8);
    expect(parseVisibleDevicesCount("")).toBeNull();
  });
  const fields = (nproc: string, deepspeed: string, tag: NprocGuardField["tag"] = "default_used"): NprocGuardField[] => [
    { key: "nproc_per_node", value: nproc, tag },
    { key: "deepspeed", value: deepspeed, tag },
    { key: "gradient_accumulation_steps", value: "16", tag },
  ];
  it("拦截 A·非用户显式回退（A-C3b E11）：default_used/from_registry/agent_recommend 单卡×任意 deepspeed×QLoRA → 回退＋内核同规则 note；机器事实缺失 → error 停下问", () => {
    for (const tag of ["default_used", "from_registry", "agent_recommend"] as const) {
      const hit = guardNprocAntiPatterns(fields("1", "ds_z3_offload_config.json", tag), { gpuCount: 8 });
      expect("hits" in hit).toBe(true);
      if ("hits" in hit) {
        expect(hit.hits).toHaveLength(1);
        expect(hit.hits[0]?.revertedTo).toBe("8");
        expect(hit.hits[0]?.note).toContain("静默死亡"); // 文案单源：内核 runtime_linkage_conflict 因由
        expect(hit.hits[0]?.note).toContain("runtime_linkage_conflict");
        expect(hit.hits[0]?.note).toContain("已按可用卡数回退");
      }
    }
    // 判据对齐内核：任意 deepspeed（非 z3_offload 家族同样触发——z2 也拦）
    const z2 = guardNprocAntiPatterns(fields("1", "ds_z2_config.json", "default_used"), { gpuCount: 8 });
    expect("hits" in z2 && z2.hits.length === 1).toBe(true);
    const blocked = guardNprocAntiPatterns(fields("1", "ds_z3_offload_config.json"), { gpuCount: null });
    expect("error" in blocked).toBe(true);
  });
  it("拦截 A·用户显式不回退（A-C3b E11）：need_confirm 单卡×deepspeed×QLoRA → 不回退，只标注冲突原文交内核拒", () => {
    const explicit = guardNprocAntiPatterns(fields("1", "ds_z3_offload_config.json", "need_confirm"), { gpuCount: 8 });
    expect("hits" in explicit).toBe(true);
    if ("hits" in explicit) {
      expect(explicit.hits).toHaveLength(0); // 不回退——用户显式值原样保留
      expect(explicit.conflicts).toHaveLength(1);
      expect(explicit.conflicts[0]?.note).toContain("静默死亡");
      expect(explicit.conflicts[0]?.note).toContain("runtime_linkage_conflict");
      expect(explicit.conflicts[0]?.note).toContain("不改用户显式值");
      expect(explicit.conflicts[0]?.note).toContain("--deepspeed off");
    }
    // 机器事实缺失时用户显式态仍只标注（无需回退→不 error）
    const noFacts = guardNprocAntiPatterns(fields("1", "ds_z2_config.json", "need_confirm"), { gpuCount: null });
    expect("hits" in noFacts && noFacts.conflicts.length === 1).toBe(true);
  });
  it("判据不误报（A-C3b E11）：单卡×bf16（非 QLoRA）×deepspeed 不触发；deepspeed=off 不触发；多卡不触发", () => {
    // bf16 形态取用户显式（need_confirm）以隔离 A 支判据——非用户显式单卡低配另受 B 支回退（既有语义）
    const bf16 = guardNprocAntiPatterns(fields("1", "ds_z3_offload_config.json", "need_confirm"), { gpuCount: 8, qlora: false });
    expect("hits" in bf16 && bf16.hits.length === 0 && bf16.conflicts.length === 0).toBe(true);
    const off = guardNprocAntiPatterns(fields("1", "off", "need_confirm"), { gpuCount: 8 });
    expect("hits" in off && off.hits.length === 0 && off.conflicts.length === 0).toBe(true);
    const multi = guardNprocAntiPatterns(fields("8", "ds_z3_offload_config.json", "need_confirm"), { gpuCount: 8 });
    expect("hits" in multi && multi.hits.length === 0 && multi.conflicts.length === 0).toBe(true);
  });
  it("拦截 B：超上限任何来源回退；非用户显式低配回退拉满；need_confirm＝用户显式降档放行", () => {
    const overflow = guardNprocAntiPatterns(fields("16", "ds_z2_config.json", "need_confirm"), { gpuCount: 8 });
    if (!("hits" in overflow)) throw new Error("expect hits");
    expect(overflow.hits[0]?.revertedTo).toBe("8");
    const lazyDefault = guardNprocAntiPatterns(fields("4", "ds_z2_config.json", "default_used"), { gpuCount: 8 });
    if (!("hits" in lazyDefault)) throw new Error("expect hits");
    expect(lazyDefault.hits[0]?.revertedTo).toBe("8");
    expect(lazyDefault.hits[0]?.note).toContain("拉满");
    const userExplicit = guardNprocAntiPatterns(fields("4", "ds_z2_config.json", "need_confirm"), { gpuCount: 8 });
    expect("hits" in userExplicit && userExplicit.hits.length === 0).toBe(true);
    const fullOk = guardNprocAntiPatterns(fields("8", "ds_z2_config.json"), { gpuCount: 8 });
    expect("hits" in fullOk && fullOk.hits.length === 0).toBe(true);
  });
  it("非法 nproc 值 → error（不猜测）", () => {
    const bad = guardNprocAntiPatterns(fields("abc", "ds_z2_config.json"), { gpuCount: 8 });
    expect("error" in bad).toBe(true);
  });
});

describe("批㊶R前置——agentRecommend nproc clamp（扩键五同步③）", () => {
  it("RECOMMENDABLE_KEYS 自动含扩键（白名单同源单点）", () => {
    expect(RECOMMENDABLE_KEYS.has("nproc_per_node")).toBe(true);
  });
  it("clamp [1, 可用卡数]：域内采纳；0/负数/超上界拒；机器事实缺失拒", () => {
    const ok = evalAgentRecommend("nproc_per_node", 4, "8", "时长优先", { maxNproc: 8 });
    expect(ok.accepted).toBe(true);
    expect(ok.terminal).toBe("4");
    const zero = evalAgentRecommend("nproc_per_node", 0, "8", undefined, { maxNproc: 8 });
    expect(zero.accepted).toBe(false);
    const overflow = evalAgentRecommend("nproc_per_node", 9, "8", undefined, { maxNproc: 8 });
    expect(overflow.accepted).toBe(false);
    expect(overflow.note).toContain("[1, 可用卡数 8]");
    const noFacts = evalAgentRecommend("nproc_per_node", 4, "8", undefined, { maxNproc: null });
    expect(noFacts.accepted).toBe(false);
    expect(noFacts.note).toContain("机器事实缺失");
  });
});

describe("批㊶R前置——扩键投影三态（白名单/摘要/卡面用例）", () => {
  it("① 键表白名单：nproc_per_node 在位（label 训练卡数）且键数 16（批㊶-S5 §九 增 base_model_path；批次 R H1-1 增 max_model_len）", () => {
    const entry = CONFIG_CONFIRM_KEYS.find((e) => e.key === "nproc_per_node");
    expect(entry?.label).toContain("训练卡数");
    expect(CONFIG_CONFIRM_KEYS.length).toBe(16);
  });
  it("② 摘要化路径：buildIterationSummary 出 nproc 行（iteration_config 来源优先）", () => {
    const rows = buildIterationSummary({ nproc_per_node: 4 }, null);
    const row = rows.find((r) => r.key === "nproc_per_node");
    expect(row?.value).toBe("4");
    expect(row?.source).toBe("iteration_config");
    expect(row?.meaning).toContain("训练卡数");
    const fallback = buildIterationSummary(null, null).find((r) => r.key === "nproc_per_node");
    expect(fallback?.source).toBe("default");
  });
  it("③ 卡面用例：fields 含 nproc 行；纯文字别名「卡数改 4」可解析", () => {
    const fields = buildConfigConfirmFields({ nproc_per_node: "4" }, {});
    const row = fields.find((f) => f.key === "nproc_per_node");
    expect(row?.value).toBe("4");
    expect(row?.tag).toBe("need_confirm");
    expect(parseConfigEditText("卡数 改 4")?.edits).toEqual({ nproc_per_node: "4" });
    expect(parseConfigEditText("nproc 改 2")?.edits).toEqual({ nproc_per_node: "2" });
  });
});
