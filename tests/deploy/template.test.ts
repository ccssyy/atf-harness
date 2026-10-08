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
  it("审批映射双旋钮解耦：三档 approval 恒 ask（never 不得出现）＋defaultPreset=danger-full-access（OS 沙箱关＋白名单恒开语义）", () => {
    const permission = rowById(templateRows(), "permission") as { config?: { presets?: Record<string, { approval?: string }>; defaultPreset?: string } };
    expect(permission).toBeDefined();
    const presets = permission?.config?.presets ?? {};
    expect(Object.keys(presets).sort()).toEqual(["danger-full-access", "read-only", "workspace-write"]);
    for (const [name, preset] of Object.entries(presets)) {
      expect(preset.approval, name).toBe("ask");
    }
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
