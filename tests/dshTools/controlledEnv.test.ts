/**
 * 受控执行 env 单源（`core/workspace/controlledEnv.ts`）的防回退测试。
 *
 * 锁的是「两通道不会再各自漂移」这件事本身：
 * `LD_LIBRARY_PATH` 曾在 scratch 侧带、bash 侧不带 —— 同一容器里 python3 一个能跑一个起不来。
 * 所以这里断言的不是某个键存在，而是**键归属只有一份来源**。
 */
import { describe, expect, it } from "vitest";
import {
  ATF_NAMED_ENV_KEYS,
  CONTROLLED_BASH_ENV_KEYS,
  ENV_DENY_PATTERN,
  RUNTIME_ENV_KEYS,
  SESSION_ENV_KEYS,
  bashEnvOf,
  runtimeEnvOf,
} from "../../src/core/workspace/controlledEnv.js";
import { buildScratchExecEnv } from "../../src/core/workspace/scratchExec.js";
import { FILE_TOOL_BASH_ENV_KEYS } from "../../src/agent/fileTools.js";

describe("受控执行 env 单源", () => {
  it("bash 白名单是三类键的并集（运行时键不得被漏掉）", () => {
    for (const key of [...SESSION_ENV_KEYS, ...ATF_NAMED_ENV_KEYS, ...RUNTIME_ENV_KEYS]) {
      expect(CONTROLLED_BASH_ENV_KEYS).toContain(key);
    }
    // 顺序＝会话键 → ATF 具名 → 运行时键（改顺序会改变取值行为，锁住）
    expect([...CONTROLLED_BASH_ENV_KEYS]).toEqual([
      ...SESSION_ENV_KEYS,
      ...ATF_NAMED_ENV_KEYS,
      ...RUNTIME_ENV_KEYS,
    ]);
  });

  it("fileTools 的白名单就是单源那份（同一引用，不是复制一份）", () => {
    expect(FILE_TOOL_BASH_ENV_KEYS).toBe(CONTROLLED_BASH_ENV_KEYS);
  });

  it("runtimeEnvOf 取到运行时键；命中凭据禁区者跳过", () => {
    const picked = runtimeEnvOf({
      LD_LIBRARY_PATH: "/usr/local/lib:/usr/local/lib64",
      ATF_LLM_KEY_GLM: "should-not-leak",
    } as NodeJS.ProcessEnv);
    expect(picked["LD_LIBRARY_PATH"]).toBe("/usr/local/lib:/usr/local/lib64");
    expect(picked["ATF_LLM_KEY_GLM"]).toBeUndefined();
  });

  it("runtimeEnvOf 空值跳过（不注入空字符串，免得覆盖解释器真实库路径）", () => {
    expect(runtimeEnvOf({ LD_LIBRARY_PATH: "" } as NodeJS.ProcessEnv)).toEqual({});
  });

  it("bashEnvOf 只取白名单内的键（用户其它 env 不外泄）", () => {
    const picked = bashEnvOf({
      PATH: "/usr/bin:/bin",
      LD_LIBRARY_PATH: "/usr/local/lib",
      ATF_LLM_KEY_GLM: "secret",
      MY_PRIVATE_VAR: "x",
    } as NodeJS.ProcessEnv);
    expect(picked).toEqual({ PATH: "/usr/bin:/bin", LD_LIBRARY_PATH: "/usr/local/lib" });
  });

  it("凭据禁区正则覆盖密钥类键名", () => {
    for (const key of ["ATF_LLM_KEY_GLM", "API_TOKEN", "DB_PASSWORD", "MY_SECRET_VALUE"]) {
      expect(ENV_DENY_PATTERN.test(key)).toBe(true);
    }
    expect(ENV_DENY_PATTERN.test("LD_LIBRARY_PATH")).toBe(false);
  });

  it("scratch 通道同样带运行时键（真调 buildScratchExecEnv，不读代码猜）", () => {
    const previous = process.env["LD_LIBRARY_PATH"];
    process.env["LD_LIBRARY_PATH"] = "/usr/local/lib:/usr/local/lib64";
    try {
      const env = buildScratchExecEnv({
        scratchDir: "/tmp/scratch",
        kernelDir: "/tmp/kernel",
        baseEnv: {},
        pythonPath: "/usr/bin/python3",
      });
      expect(env["LD_LIBRARY_PATH"]).toBe("/usr/local/lib:/usr/local/lib64");
    } finally {
      if (previous === undefined) delete process.env["LD_LIBRARY_PATH"];
      else process.env["LD_LIBRARY_PATH"] = previous;
    }
  });
});
