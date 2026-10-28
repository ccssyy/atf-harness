/**
 * F11-2 锚：atf_evaluate 的 env_profile 参数描述注入**实例**档案清单（启动时读磁盘，
 * 源码不写死档案名）；目录不可得＝保留原文案并标「目录不可得」且不抛错。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalTools, envProfileCatalogLineOf } from "../../packages/extensions/atf-tools/src/trainingFace.js";

type Tool = { name: string; description: string };

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "f112-profiles-"));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const seedProfile = (instanceRoot: string, name: string, evalEnv: string): void => {
  const dir = join(instanceRoot, ".atf", "env-profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ train: { eval_env: evalEnv } }), "utf8");
};

type ParamTool = Tool & { parameters?: { properties?: Record<string, { description?: string }> } };

/** env_profile 参数描述（清单注入面在参数描述里——工具描述本身不列档案名）。 */
const evalDescriptionOf = (env: Record<string, string | undefined>): string => {
  const root = tempRoot();
  const tools = buildEvalTools({ get: () => undefined }, { runsRoot: root, logDir: join(root, "logs"), kernelDir: join(root, "kernel"), env }) as unknown as ParamTool[];
  const tool = tools.find((entry) => entry.name === "atf_evaluate");
  if (tool === undefined) throw new Error("atf_evaluate 未挂载");
  const description = tool.parameters?.properties?.["env_profile"]?.description;
  if (description === undefined) throw new Error("env_profile 参数描述缺失");
  return description;
};

describe("F11-2 env_profile 动态档案清单", () => {
  it("目录内两档 → 描述列两档档案名与各自 eval_env 摘要", () => {
    const instance = tempRoot();
    seedProfile(instance, "a800-local", "/data/venv/a800/bin/python");
    seedProfile(instance, "h20-local", "/data/venv/h20/bin/python");
    const env = { ATF_INSTANCE_ROOT: instance };
    expect(envProfileCatalogLineOf(env)).toBe(
      "实例档案：a800-local(eval_env=/data/venv/a800/bin/python)、h20-local(eval_env=/data/venv/h20/bin/python)",
    );
    const description = evalDescriptionOf(env);
    expect(description).toContain("a800-local(eval_env=/data/venv/a800/bin/python)");
    expect(description).toContain("h20-local(eval_env=/data/venv/h20/bin/python)");
    expect(description).not.toContain("可选值见该目录内 .json 文件名");
  });

  it("档案缺 eval_env → 该档标「缺」（不造值）", () => {
    const instance = tempRoot();
    seedProfile(instance, "no-env", "");
    mkdirSync(join(instance, ".atf", "env-profiles"), { recursive: true });
    writeFileSync(join(instance, ".atf", "env-profiles", "empty.json"), JSON.stringify({ train: {} }), "utf8");
    expect(envProfileCatalogLineOf({ ATF_INSTANCE_ROOT: instance })).toContain("empty(eval_env=缺)");
  });

  it("实例根不可得 → 描述保留原文案并标「目录不可得」，构建不抛错", () => {
    expect(envProfileCatalogLineOf({})).toBeNull();
    const description = evalDescriptionOf({});
    expect(description).toContain("可选值见该目录内 .json 文件名（目录不可得）");
  });

  it("实例根在场但目录为空 → 同「目录不可得」档（不列空集）", () => {
    const instance = tempRoot();
    mkdirSync(join(instance, ".atf", "env-profiles"), { recursive: true });
    expect(envProfileCatalogLineOf({ ATF_INSTANCE_ROOT: instance })).toBeNull();
    expect(evalDescriptionOf({ ATF_INSTANCE_ROOT: instance })).toContain("（目录不可得）");
  });
});
