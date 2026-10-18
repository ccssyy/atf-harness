/**
 * 批㊶-S5 测试锚——设置面数据层（B1/B3：五字段校验·实例派生·生效值投影）／§九基模型锚
 * （卡键基线注入·agentRecommend 本地目录校验·iteration-config base_model.path 嵌套写回）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  instanceSettingsPath,
  deriveAtfRoot,
  validateDirWritable,
  validateVenvPath,
  validateGpuBaseline,
  ensureConventionSubdirs,
  effectiveStorageValues,
} from "../../src/webui/storageSettings.js";
import { openSettingsStore, EMPTY_STORAGE_SETTINGS } from "../../src/webui/settings.js";
import { DEFAULT_BASE_MODEL_NAME, defaultBaseModelPath, applyConfirmedToIterationConfig } from "../../src/core/workspace/smartDefaults.js";
import { CONFIG_CONFIRM_KEYS, buildConfigConfirmFields } from "../../src/webui/configConfirm.js";
import { evalAgentRecommend, RECOMMENDABLE_KEYS } from "../../src/core/workspace/agentRecommend.js";
import { buildSettingsReadonlyBlock } from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "s5-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-S5 B1——实例派生与设置 store", () => {
  it("store 路径实例隔离：HOME 派生＋env 覆写（§三.2 零跨实例共享）", () => {
    expect(instanceSettingsPath({ HOME: "/home/uat" })).toBe("/home/uat/.atf/webui-settings.json");
    expect(instanceSettingsPath({ HOME: "/home/uat", ATF_DSH_SETTINGS: "/x/s.json" })).toBe("/x/s.json");
    expect(instanceSettingsPath({})).toBe(join(".", ".atf", "webui-settings.json"));
  });
  it("根目录缺省派生：ATF_ATF_ROOT ＞ runsRoot 父目录（…/runs 形态）＞ null", () => {
    expect(deriveAtfRoot({ ATF_ATF_ROOT: "/data/atf" })).toBe("/data/atf");
    expect(deriveAtfRoot({ ATF_DSH_RUNS_ROOT: "/data/atf/uat/runs" })).toBe("/data/atf/uat");
    expect(deriveAtfRoot({ ATF_DSH_RUNS_ROOT: "/x/y/tasks" })).toBeNull();
    expect(deriveAtfRoot({})).toBeNull();
  });
  it("store storage 块读写回环（缺席视为全未配置）", () => {
    const path = join(tempRoot(), "webui-settings.json");
    const store = openSettingsStore(path);
    expect(store.get().storage).toEqual(EMPTY_STORAGE_SETTINGS);
    store.put({ storage: { ...EMPTY_STORAGE_SETTINGS, atf_root: "/data/atf", train_gpu_baseline: "8" } });
    const reread = openSettingsStore(path).get();
    expect(reread.storage.atf_root).toBe("/data/atf");
    expect(reread.storage.train_gpu_baseline).toBe("8");
    expect(reread.storage.model_root).toBe("");
  });
});

describe("批㊶-S5 B3——fail-fast 校验集", () => {
  it("validateDirWritable：不存在/是文件/不可写各拒；可写目录过", () => {
    const root = tempRoot();
    expect(validateDirWritable(join(root, "nope")).ok).toBe(false);
    const file = join(root, "f");
    writeFileSync(file, "x");
    expect(validateDirWritable(file).ok).toBe(false);
    expect(validateDirWritable(root).ok).toBe(true);
    expect(validateDirWritable("").ok).toBe(false);
  });
  it("validateVenvPath：非 venv 拒（缺 bin/python 与 pyvenv.cfg）；pyvenv.cfg 在位过；空＝合法（未配置停下问）", () => {
    const root = tempRoot();
    const notVenv = join(root, "plain");
    mkdirSync(notVenv, { recursive: true });
    expect(validateVenvPath(notVenv).ok).toBe(false);
    const venv = join(root, "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), "version = 3.10\n");
    expect(validateVenvPath(venv).ok).toBe(true);
    expect(validateVenvPath(join(root, "nope")).ok).toBe(false);
    expect(validateVenvPath("").ok).toBe(true);
  });
  it("validateGpuBaseline：正整数过；非正整数/超可用卡数拒；空＝跟随探测拉满", () => {
    expect(validateGpuBaseline("8", 8).ok).toBe(true);
    expect(validateGpuBaseline("4", 8).ok).toBe(true);
    expect(validateGpuBaseline("9", 8).ok).toBe(false);
    expect(validateGpuBaseline("abc", 8).ok).toBe(false);
    expect(validateGpuBaseline("", 8).ok).toBe(true);
  });
  it("约定子目录：根保存时缺失创建、已有不动（§三.3 仅新建生效）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "runs"), { recursive: true });
    const created = ensureConventionSubdirs(root);
    expect(created).toEqual([join(root, "datasets"), join(root, "logs")]);
    expect(ensureConventionSubdirs(root)).toEqual([]);
    expect(existsSync(join(root, "datasets"))).toBe(true);
    expect(existsSync(join(root, "runs"))).toBe(true);
    expect(existsSync(join(root, "logs"))).toBe(true);
  });
  it("生效值投影：instance env 优先于设置值（漂移显性呈现的数据源）", () => {
    const effective = effectiveStorageValues(
      { ATF_MODEL_ROOT: "/data/LLM_model", ATF_DSH_RUNS_ROOT: "/data/atf/uat/runs" },
      { atf_root: "", model_root: "/other", train_env: "", eval_env: "", train_gpu_baseline: "8" },
    );
    expect(effective.atf_root).toBe("/data/atf/uat");
    expect(effective.model_root).toBe("/data/LLM_model");
    expect(effective.sources.model_root).toBe("instance-env");
    expect(effective.sources.train_gpu_baseline).toBe("settings");
  });
});

describe("批㊶-S5 §九——默认基模型锚点（确认卡基线＋防线①同源校验）", () => {
  it("锚点路径派生：模型库 env 拼默认名；未配置＝null（零绝对路径硬编码）", () => {
    expect(defaultBaseModelPath({ ATF_MODEL_ROOT: "/data/LLM_model" })).toBe("/data/LLM_model/Qwen3-VL-32B-Instruct");
    expect(defaultBaseModelPath({})).toBeNull();
    expect(DEFAULT_BASE_MODEL_NAME).toBe("Qwen3-VL-32B-Instruct");
  });
  it("卡键入集（第 15 键）＋RECOMMENDABLE_KEYS 自动流入", () => {
    expect(CONFIG_CONFIRM_KEYS.some((e) => e.key === "base_model_path")).toBe(true);
    expect(RECOMMENDABLE_KEYS.has("base_model_path")).toBe(true);
  });
  it("agentRecommend base_model_path：本地目录在采纳；家族名拦截（防线①同源口径）", () => {
    const dir = tempRoot();
    const ok = evalAgentRecommend("base_model_path", dir, "", "owner 偏置锚点");
    expect(ok.accepted).toBe(true);
    const bad = evalAgentRecommend("base_model_path", "qwen3_vl", "", undefined);
    expect(bad.accepted).toBe(false);
    expect(bad.note).toContain("不是本地存在的目录");
  });
  it("iteration-config 嵌套写回：base_model_path 落 base_model.path（非 training 段）", () => {
    const root = tempRoot();
    const iterPath = join(root, "iteration-config.json");
    writeFileSync(iterPath, `${JSON.stringify({ base_model: { family: "qwen3_vl", path: "/old" }, training: { learning_rate: "1e-4" } }, null, 1)}\n`);
    const result = applyConfirmedToIterationConfig(iterPath, { base_model_path: "/data/LLM_model/Qwen3-VL-32B-Instruct" });
    expect("updated" in result && result.updated).toContain("base_model_path");
    const patched = JSON.parse(readFileSync(iterPath, "utf8")) as { base_model: { path: string; family?: string }; training: Record<string, unknown> };
    expect(patched.base_model.path).toBe("/data/LLM_model/Qwen3-VL-32B-Instruct");
    expect(patched.base_model.family).toBe("qwen3_vl"); // 其余 base_model 字段不动
  });
});

describe("批㊶-S5 B2——只读区块组装与卡面投影", () => {
  it("只读区：内核版本/账本位置/凭据状态/实例标识（不回凭据值）", () => {
    const block = buildSettingsReadonlyBlock(
      { HOME: "/home/uat", DSH_HOME: "/x/poc/dsh-home-tongshi", ATF_LLM_KEY_GLM: "sk-xxx" },
      { mode: "real", version: "v0.7.5b1" },
      "/repo",
    );
    expect(block.kernel_version).toBe("v0.7.5b1");
    expect(block.approval_ledger).toBe("/home/uat/.atf/approval-ledger/training-release.jsonl");
    expect(block.key_status).toBe("已配置");
    expect(block.instance_id).toBe("dsh-home-tongshi");
    const noKey = buildSettingsReadonlyBlock({ HOME: "/h", DSH_HOME: "/h/d1" }, { mode: "mock", version: null }, "/repo");
    expect(noKey.key_status).toBe("未配置");
    expect(JSON.stringify(block)).not.toContain("sk-xxx");
  });
  it("卡面投影：基模型路径行在卡（overrides 形态 need_confirm）", () => {
    const fields = buildConfigConfirmFields({ base_model_path: "/m/model" }, {});
    const row = fields.find((f) => f.key === "base_model_path");
    expect(row?.value).toBe("/m/model");
    expect(row?.tag).toBe("need_confirm");
  });
});

describe("批㊶-U §五范围升级——共用双段式 helper 四卡统一（批㊶-W F5 表单卡语义改版）", () => {
  it("dualStageNote：可改卡完整双段式文案（表单卡改值提交）；凭据卡退化形式不造参数", async () => {
    const { dualStageNote } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const full = dualStageNote("评估服务 EVAL_RELEASE 确认", { extra: "九必报项报告：…" });
    expect(full).toContain("双段式");
    expect(full).toContain("改参在表单卡改值提交");
    expect(full).toContain("Allow once");
    const cred = dualStageNote("契约凭据卡", { amendable: false });
    expect(cred).toContain("无可调参数");
    expect(cred).toContain("复核通道");
    expect(cred).not.toContain("改参在表单卡改值提交");
  });
  it("live 链三卡锚：问题卡 note/凭据卡 body 仍投 helper；审批卡 reason 一律走 E5 模板（禁每卡手搓）", async () => {
    const confirm = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/confirmFace.ts"), "utf8");
    const training = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/trainingFace.ts"), "utf8");
    expect((confirm.match(/dualStageNote\(/g) ?? []).length).toBeGreaterThanOrEqual(2); // 定义＋九要素表单卡 note（凭据卡走 body 拼接同 helper）
    // 批C2 E5：评估审批卡 reason 由 buildApprovalReason 模板构造（dualStageNote 退问题卡域）
    expect(training).toContain("buildApprovalReason({");
    expect(training).not.toContain("dualStageNote(\"评估服务 EVAL_RELEASE 确认");
  });
});
