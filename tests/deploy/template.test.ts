/**
 * 批㊶-I 测试锚——部署模板产品级单源（审批映射双旋钮解耦／goal 三行齐关／单轨工具面
 * ／overlay 覆写语义／生成-漂移回路）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.url.replace("file://", ""), "..", "..", "..");
const TEMPLATE = join(repo, "deploy", "profiles", "web", "cordis.patch.template.yml");
const GENERATE = join(repo, "deploy", "profiles", "web", "generate.py");

/** 模板行经 python3.10+PyYAML 归一为 JSON（本仓零 YAML 依赖——低依赖纪律）。 */
const templateRows = (): Array<Record<string, unknown>> =>
  JSON.parse(execFileSync("python3.10", ["-c", "import json,yaml,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1],encoding='utf8'))))", TEMPLATE], { cwd: repo }).toString("utf8")) as Array<Record<string, unknown>>;
const rowById = (rows: Array<Record<string, unknown>>, id: string): Record<string, unknown> | undefined =>
  rows.find((row) => row["id"] === id);
const presetPlugins = (): Array<Record<string, unknown>> => {
  const preset = rowById(templateRows(), "preset-standard") as { config?: { plugins?: Array<Record<string, unknown>> } };
  return preset?.config?.plugins ?? [];
};

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "deploy-tpl-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-I 部署模板（产品级单源——审批映射／goal 收敛／工具单轨）", () => {
  it("审批映射双旋钮解耦：四档 approval 恒 ask（never 不得出现）＋defaultPreset=danger-full-access（OS 沙箱关＋白名单恒开语义）", () => {
    const permission = rowById(templateRows(), "permission") as { config?: { presets?: Record<string, { approval?: string; sandbox?: string; name?: string }>; defaultPreset?: string } };
    expect(permission).toBeDefined();
    const presets = permission?.config?.presets ?? {};
    // 批㊶Q增补一裁定 2：auto_training 入模板单源（两环境同款）——四档闭集
    expect(Object.keys(presets).sort()).toEqual(["auto_training", "danger-full-access", "read-only", "workspace-write"]);
    for (const [name, preset] of Object.entries(presets)) {
      expect(preset.approval, name).toBe("ask");
    }
    // auto_training 档形态与 dev 实例同款（sandbox 关＋应用层审批 ask＋中文名）
    expect(presets["auto_training"]).toMatchObject({ sandbox: "danger-full-access", approval: "ask", name: "全自动训练" });
    expect(JSON.stringify(templateRows())).not.toContain("approval: never");
    expect(permission?.config?.defaultPreset).toBe("danger-full-access");
  });

  it("goal 产品收敛三行齐关（tool-goal/command-goal preset 行＋goal-round-driver host 行）；vendor bash 行 disabled", () => {
    const plugins = presetPlugins();
    const byId = new Map(plugins.map((plugin) => [plugin["id"] as string, plugin]));
    for (const id of ["tool-goal", "command-goal", "tool-bash"]) {
      expect(byId.get(id)?.["disabled"], id).toBe(true);
    }
    const driver = rowById(templateRows(), "goal-round-driver");
    expect(driver?.["disabled"]).toBe(true);
  });

  it("单轨保留面：tool-fs/tool-fs-search 保持挂载（glob/grep/read_image 走 pre-execute 守卫；read/edit/write 恒 deny 改道）", () => {
    const byId = new Map(presetPlugins().map((plugin) => [plugin["id"] as string, plugin]));
    expect(byId.get("tool-fs")?.["disabled"]).toBeUndefined();
    expect(byId.get("tool-fs-search")?.["disabled"]).toBeUndefined();
    expect(byId.get("tool-fs-search")?.["config"]).toMatchObject({ sampleOverCapGlobResults: false });
  });

  it("批默认flash＋档位max（owner 2026-10-19 裁）：模板 agent-default-model＝glm-atf/glm-5.3-flash＋reasoningEffort max——防回潮锚", () => {
    const rows = templateRows();
    const model = rowById(rows, "agent-default-model") as { config?: Record<string, unknown> };
    expect(model?.config).toEqual({ provider: "glm-atf", model: "glm-5.3-flash", reasoningEffort: "max" });
  });

  it("generate.py：模板＋overlay 覆写语义（同 id 整行覆盖）＋输出即 drift check 通过物", () => {
    const overlay = join(tempRoot(), "uat.overlay.yml");
    execFileSync("python3.10", ["-c", "import yaml,sys; yaml.safe_dump([{'id':'agent-default-model','config':{'provider':'zai-coding-cn','model':'glm-5.3-flash'}}], open(sys.argv[1],'w',encoding='utf8'), allow_unicode=True)", overlay]);
    const out = join(tempRoot(), "cordis.patch.yml");
    execFileSync("python3.10", [GENERATE, "--overlay", overlay, "--out", out], { cwd: repo });
    const rows = JSON.parse(execFileSync("python3.10", ["-c", "import json,yaml,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1],encoding='utf8'))))", out], { cwd: repo }).toString("utf8")) as Array<Record<string, unknown>>;
    const model = rowById(rows, "agent-default-model") as { config?: Record<string, unknown> };
    expect(model?.config).toEqual({ provider: "zai-coding-cn", model: "glm-5.3-flash" });
    // 覆写不丢模板其余行（insert 无 id 行原样保留）
    expect(rows.filter((row) => row["id"] === undefined).length).toBeGreaterThan(0);
    expect(rows.length).toBe(9); // 模板 9 行（批㊶-K 增 jobs 兜底行）
  });
});

describe("批甲-FIX T1——模型目录 per-model 思考档位闭集（智谱端点能力对账）", () => {
  /** 模板 glm-atf 路由的 models 配置（PyYAML 归一——本仓零 YAML 依赖纪律沿旧例）。 */
  const glmModels = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const llm = rowById(rows, "llm-pi-ai") as { config?: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> } };
    return llm?.config?.providers?.["glm-atf"]?.models ?? [];
  };
  const effortsOf = (model: Record<string, unknown> | undefined): string[] =>
    Object.keys(((model?.["reasoningEfforts"] as Record<string, unknown>) ?? {}));

  it("两模型闭集对账（批移除flashx 2026-10-19 owner 裁：coding plan 不提供 FlashX，下架必然 429 的入口）：glm-5.3＝off/low/high/max（thinking 可关）；flash＝low/high/max（无 off——智谱开放文档 2026-10-15：GLM-5.3 与 GLM-5.3-FLASH 仅支持 low/high/max，thinking 不可关）", () => {
    const rows = templateRows();
    const models = new Map(glmModels(rows).map((model) => [model["id"] as string, model]));
    expect(models.size).toBe(2);
    expect(effortsOf(models.get("glm-5.3"))).toEqual(["off", "low", "high", "max"]);
    expect(effortsOf(models.get("glm-5.3-flash"))).toEqual(["low", "high", "max"]);
    // 批移除flashx 防回潮锚：模板与 poc 交付副本零 flashx 声明
    expect(readFileSync(TEMPLATE, "utf8").toLowerCase()).not.toContain("flashx");
    expect(readFileSync(join(repo, "poc", "web-profile-cordis-patch.yml"), "utf8").toLowerCase()).not.toContain("flashx");
    // 出处注释在场（声明出处写进配置——「不造档位」审计面）
    const text = readFileSync(TEMPLATE, "utf8");
    expect(text).toContain("docs.bigmodel.cn");
    expect(text).toContain("thinking 不可关");
  });

  it("poc 交付副本与 uat overlay 示例同步：flash 系闭集随行（实例覆写整行时漏声明即无档位控件）", () => {
    const pocText = readFileSync(join(repo, "poc", "web-profile-cordis-patch.yml"), "utf8");
    expect(pocText).toContain("GLM-5.3-Flash");
    expect(pocText).toContain("thinking 不可关，无 off 档");
    const overlayText = readFileSync(join(repo, "deploy", "profiles", "web", "overlays", "uat.overlay.example.yml"), "utf8");
    expect(overlayText).toContain("reasoningEfforts 闭集");
  });
});
