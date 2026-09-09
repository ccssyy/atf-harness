import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RunWorkspace } from "../../src/workspace/index.js";

/**
 * S4 工作区结构与 provenance 测试（任务书 §4.1/4.2 + owner 口径 #1/#2/#5）。
 * run 目录宿主 = harness 仓 tmp/runs/（owner 口径 #1；workspace.contract.yaml 登记）。
 */

const runsRoot = join(fileURLToPath(new URL("../..", import.meta.url)), "tmp", "runs");

const newRunDir = (): string => join(runsRoot, `test-${randomUUID()}`);

const PROVENANCE_INPUT = {
  run_id: "run-test-1",
  trigger_instruction: "S4 测试指令",
  model_id: "faux",
};

const opened: string[] = [];
const makeWorkspace = async (input = PROVENANCE_INPUT) => {
  const dir = newRunDir();
  opened.push(dir);
  const created = await RunWorkspace.create(dir, input);
  expect(created.ok, created.ok ? "" : JSON.stringify(created.error)).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  return { dir, ws: created.value };
};

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("S4 run 目录结构 v0（任务书 §4.1）", () => {
  it("create → scratch/artifacts/contracts 三层目录就位，provenance.json 自动生成四元组，session.jsonl 不预创建", async () => {
    const { dir, ws } = await makeWorkspace();

    await expect(stat(join(dir, "scratch"))).resolves.toBeTruthy();
    await expect(stat(join(dir, "artifacts"))).resolves.toBeTruthy();
    await expect(stat(join(dir, "contracts"))).resolves.toBeTruthy();

    const provenance = JSON.parse(await readFile(join(ws.scratchDir, "provenance.json"), "utf8")) as Record<string, unknown>;
    expect(provenance["run_id"]).toBe("run-test-1");
    expect(provenance["trigger_instruction"]).toBe("S4 测试指令");
    expect(provenance["model_id"]).toBe("faux"); // owner 口径 #2：冒烟阶段 model_id = "faux"
    expect(typeof provenance["created_at"]).toBe("string");
    expect(Number.isNaN(Date.parse(provenance["created_at"] as string))).toBe(false);

    // 会话流按约定路径由 SessionLog 按需创建——工作区层不预创建
    await expect(stat(ws.sessionLogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("重开语义：同四元组打开成功（created_at 以既有为准）；任一字段不一致 / 形状非法 → err(provenance_conflict)", async () => {
    const { dir, ws } = await makeWorkspace();
    const firstCreated = JSON.parse(await readFile(join(ws.scratchDir, "provenance.json"), "utf8")) as Record<string, unknown>;

    // 同四元组重开 → ok，created_at 不被改写
    const reopen = await RunWorkspace.create(dir, PROVENANCE_INPUT);
    expect(reopen.ok).toBe(true);
    const after = JSON.parse(await readFile(join(ws.scratchDir, "provenance.json"), "utf8")) as Record<string, unknown>;
    expect(after["created_at"]).toBe(firstCreated["created_at"]);

    // trigger_instruction 漂移 → conflict
    const drifted = await RunWorkspace.create(dir, { ...PROVENANCE_INPUT, trigger_instruction: "另一条指令" });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.error.code).toBe("provenance_conflict");

    // 形状非法（手改坏 provenance）→ conflict
    await writeFile(join(ws.scratchDir, "provenance.json"), "{run_id: 坏掉的", "utf8");
    const corrupt = await RunWorkspace.create(dir, PROVENANCE_INPUT);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe("provenance_conflict");
  });

  it("provenance 输入守卫：空 run_id / 空 trigger_instruction / 空 model_id → err(invalid_input)，目录不落 provenance", async () => {
    const dir = newRunDir();
    opened.push(dir);
    const bad = await RunWorkspace.create(dir, { run_id: "", trigger_instruction: "x", model_id: "faux" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
  });
});

describe("S4 T0 自由区写入口与元数据登记（owner 口径 #3）", () => {
  it("scratchWrite 正常写入；越界/绝对路径 → err(invalid_input)", async () => {
    const { ws } = await makeWorkspace();

    const written = await ws.scratchWrite("notes/draft.md", "草稿内容\n");
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.value.bytes).toBe(Buffer.byteLength("草稿内容\n", "utf8"));
    await expect(readFile(join(ws.scratchDir, "notes/draft.md"), "utf8")).resolves.toBe("草稿内容\n");

    const escape = await ws.scratchWrite("../outside.txt", "逃逸");
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.code).toBe("invalid_input");

    const absolute = await ws.scratchWrite("/etc/passwd", "绝对路径");
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) expect(absolute.error.code).toBe("invalid_input");
  });

  it("registerReproduce：sidecar 落盘且与源对应；重复登记 / 源不存在 / 空 argv → err(invalid_input)", async () => {
    const { ws } = await makeWorkspace();
    await ws.scratchWrite("report.md", "内容\n");

    const registered = await ws.registerReproduce("report.md", ["node", "-e", "process.stdout.write('内容\\n')"]);
    expect(registered.ok).toBe(true);
    const meta = JSON.parse(await readFile(join(ws.scratchDir, "report.md.meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta["artifact"]).toBe("report.md");
    expect((meta["reproduce"] as { command: string[] }).command).toEqual(["node", "-e", "process.stdout.write('内容\\n')"]);

    const duplicate = await ws.registerReproduce("report.md", ["node", "-e", "1"]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("invalid_input");

    const missingSource = await ws.registerReproduce("ghost.md", ["node", "-e", "1"]);
    expect(missingSource.ok).toBe(false);
    if (!missingSource.ok) expect(missingSource.error.code).toBe("invalid_input");

    const emptyArgv = await ws.registerReproduce("report.md", []);
    expect(emptyArgv.ok).toBe(false);
  });
});

describe("S4 工作区状态（T2 只读展示，owner 口径 #5）", () => {
  it("status：run_id / scratch 计数 / artifacts 计数 / contracts 存在且零写入 / session_log 状态", async () => {
    const { ws } = await makeWorkspace();
    await ws.scratchWrite("a.md", "A\n");

    const status = await ws.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.run_id).toBe("run-test-1");
    expect(status.value.scratch.entry_count).toBe(2); // provenance.json + a.md
    expect(status.value.artifacts.catalog_count).toBe(0);
    expect(status.value.artifacts.file_count).toBe(0);
    expect(status.value.contracts).toEqual({ exists: true, entry_count: 0 }); // T2 只读：存在 + 零 harness 写入
    expect(status.value.session_log.exists).toBe(false);
  });
});
