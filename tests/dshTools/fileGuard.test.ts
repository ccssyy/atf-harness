/**
 * 批㊶-H/I 测试锚——文件工具路径守卫（白名单派生＝配置声明面镜像＋pre-execute 守卫
 * ＋A7 DSH 挂载＋命令串扫描）＋产品资产零具体目录静态守护（增补裁定两条）。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveFileToolRoots, rootsFromEnvProfileText } from "../../src/agent/fileRoots.js";
import {
  absolutePathTokensFromCommand,
  bashCommandGuard,
  buildFileGuardTools,
  FILE_PATH_OUTSIDE_ALLOWLIST,
  pathsFromPreExecuteArgs,
  pathOutsideRoots,
  registerPathGuard,
} from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "file-guard-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-H 派生规则（配置声明面逐项镜像——守护测试②）", () => {
  it("派生集逐项等于声明面：config.workspace_root／env-profiles venv／五个 env 名镜像＋追加集，多一分不算", () => {
    const home = tempRoot();
    mkdirSync(join(home, ".atf", "env-profiles"), { recursive: true });
    const ws = join(home, "ws");
    const venv = join(home, "venv");
    writeFileSync(join(home, ".atf", "config.json"), JSON.stringify({ workspace_root: ws }));
    writeFileSync(join(home, ".atf", "env-profiles", "a800.json"), JSON.stringify({ train: { train_env: "system", eval_env: venv } }));
    writeFileSync(join(home, ".atf", "env-profiles", "notes.txt"), "非 json 不入派生");
    const runs = join(home, "runs");
    const kernel = join(home, "kernel");
    const execHome = join(home, "exec");
    const logs = join(home, "logs");
    const extra = join(home, "extra-declared");
    const derived = deriveFileToolRoots({
      env: {
        HOME: home,
        ATF_DSH_RUNS_ROOT: runs,
        ATF_DSH_KERNEL_DIR: kernel,
        ATF_DSH_EXEC_HOME: execHome,
        ATF_DSH_LOG_DIR: logs,
        ATF_V1_FILE_TOOL_ROOTS: `${extra}:${venv}`,
      },
      readFile: (path) => {
        try {
          return require("node:fs").readFileSync(path, "utf8") as string;
        } catch {
          return null;
        }
      },
      readDir: (path) => {
        try {
          return require("node:fs").readdirSync(path) as string[];
        } catch {
          return [];
        }
      },
    });
    expect(derived.roots).toEqual([runs, ws, venv, kernel, execHome, logs, extra]);
    expect(derived.sources).toEqual([
      "env:ATF_DSH_RUNS_ROOT",
      "config:workspace_root",
      "env-profile:a800.json",
      "env:ATF_DSH_KERNEL_DIR",
      "env:ATF_DSH_EXEC_HOME",
      "env:ATF_DSH_LOG_DIR",
      "env:ATF_V1_FILE_TOOL_ROOTS",
    ]);
  });

  it("声明缺席不猜：无 HOME／配置不可解析 → 仅 env 名镜像入集；train_env=system 不入派生", () => {
    expect(deriveFileToolRoots({ env: {}, readFile: () => null, readDir: () => [] }).roots).toEqual([]);
    expect(rootsFromEnvProfileText('{"train":{"train_env":"system","eval_env":"/v"}}')).toEqual(["/v"]);
    expect(rootsFromEnvProfileText("不是 json")).toEqual([]);
  });
});

describe("批㊶-H pre-execute 路径守卫（glob/grep/read_image 守卫＋vendor read/edit/write 封闭改道）", () => {
  const install = (roots: string[]) => {
    let listener: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
    const registered = registerPathGuard({ on: (event, l) => { listener = l as never; return () => true; } }, { roots, env: {} });
    expect(registered).toBe(true);
    return listener as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  };

  it("read_image 越界 → deny file_path_outside_allowlist（含越界路径＋合法根＋指引）；根内 → next() 放行", async () => {
    const root = tempRoot();
    const inside = join(root, "img.png");
    const guard = install([root]);
    let nextCalled = false;
    const denied = (await guard({ name: "read_image", arguments: { file_path: "/etc/passwd" } }, async () => {
      nextCalled = true;
      return { kind: "allow" };
    })) as { kind: string; reason: string };
    expect(nextCalled).toBe(false);
    expect(denied.kind).toBe("deny");
    expect(denied.reason).toContain(FILE_PATH_OUTSIDE_ALLOWLIST);
    expect(denied.reason).toContain("/etc/passwd");
    expect(denied.reason).toContain(root);
    const allowed = (await guard({ name: "read_image", arguments: { file_path: inside } }, async () => ({ kind: "allow" })));
    expect(allowed).toEqual({ kind: "allow" });
  });

  it("glob/grep 只校验显式 path（缺省＝cwd 不越界）；vendor read 恒 deny 带改道指引；未守卫名直通", async () => {
    const root = tempRoot();
    const guard = install([root]);
    expect(pathsFromPreExecuteArgs("glob", { pattern: "*.png" })).toEqual([]);
    const denyRead = (await guard({ name: "read", arguments: { path: join(root, "x.txt") } }, async () => ({ kind: "allow" }))) as { kind: string; reason: string };
    expect(denyRead.kind).toBe("deny");
    expect(denyRead.reason).toContain("atf_read");
    const passThrough = await guard({ name: "atf_read", arguments: { path: "/etc/passwd" } }, async () => ({ kind: "allow" }));
    expect(passThrough).toEqual({ kind: "allow" });
  });

  it("裸装配面（无 ctx.on）跳过不抛", () => {
    expect(registerPathGuard({}, { roots: [tempRoot()], env: {} })).toBe(false);
  });
});

describe("批㊶-H 命令串绝对路径扫描（atf_bash 守卫面——应用层 best-effort）", () => {
  it("越界绝对路径记号拒绝（含码与指引）；根内绝对路径与相对路径放行", () => {
    const root = tempRoot();
    const bad = bashCommandGuard("cat /etc/passwd", [root]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain(FILE_PATH_OUTSIDE_ALLOWLIST);
    expect(bashCommandGuard(`cat ${join(root, "a.txt")}`, [root]).ok).toBe(true);
    expect(bashCommandGuard("cat relative.txt", [root]).ok).toBe(true);
    expect(absolutePathTokensFromCommand("ls /a/b --x=/c/d")).toEqual(["/a/b"]);
    expect(pathOutsideRoots("/a/b", [root])).toBe(true);
  });
});

describe("批㊶-H/I A7 四件 DSH 挂载（buildFileGuardTools）＋产品资产零具体目录（守护测试①）", () => {
  it("挂载名单＝A7 四件；根内读直通成功；atf_bash 越界命令串结构化拒绝（不触执行）", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "hello.txt"), "白名单内内容");
    const tools = buildFileGuardTools({ roots: [root], env: {} }) as Array<{
      name: string;
      execute: (args: Record<string, unknown>, exec: { callId?: string }) => Promise<unknown>;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual(["atf_read", "atf_edit", "atf_write", "atf_bash"]);
    const read = (await tools[0]!.execute({ path: "hello.txt" }, { callId: "t1" })) as Record<string, unknown>;
    expect(JSON.stringify(read)).toContain("白名单内内容");
    const bash = (await tools[3]!.execute({ command: "cat /etc/passwd" }, { callId: "t2" })) as Record<string, unknown>;
    expect(bash["error"]).toBe(FILE_PATH_OUTSIDE_ALLOWLIST);
  });

  it("守护测试①：产品资产（src／packages／deploy）零硬编码绝对路径（/data｜/home｜盘符）", () => {
    const scan = (rootDir: string, base: string): string[] => {
      const hits: string[] = [];
      let entries: string[] = [];
      try {
        entries = readdirSync(rootDir);
      } catch {
        return hits;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const abs = join(rootDir, entry);
        let isDir = false;
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          hits.push(...scan(abs, base));
          continue;
        }
        if (!/\.(ts|js|mjs|yml|yaml|py)$/.test(entry)) continue;
        const text = readFileSync(abs, "utf8");
        if (text.includes("/data/") || text.includes("/home/")) hits.push(`${abs.slice(base.length + 1)}（/data|/home）`);
      }
      return hits;
    };
    const repo = join(import.meta.url.replace("file://", ""), "..", "..", "..");
    const hits = [
      ...scan(join(repo, "src"), repo),
      ...scan(join(repo, "packages"), repo),
      ...scan(join(repo, "deploy"), repo),
    ];
    expect(hits).toEqual([]);
  });
});
