/**
 * F9 锚：会话附件目录（<DSH 家>/attachments）只读开白——read/list/unzip -l 这类只读命令
 * 可执行；写/解包落盘仍拒（报错带 atf_attachments_assembly 唯一入口指引）；其它路径围栏
 * 行为不变。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENTS_ONLY_ENTRY_HINT,
  bashCommandGuard,
  buildFileGuardTools,
  FILE_PATH_OUTSIDE_ALLOWLIST,
  readOnlyCommandIs,
  WORKSPACE_PATH_OUTSIDE_ALLOWLIST,
  workspaceFenceGuard,
} from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "f9-att-"));
  roots.push(root);
  return root;
};
const savedRunsRoot = process.env["ATF_DSH_RUNS_ROOT"];
beforeEach(() => { /* 每例自设 env */ });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedRunsRoot === undefined) delete process.env["ATF_DSH_RUNS_ROOT"];
  else process.env["ATF_DSH_RUNS_ROOT"] = savedRunsRoot;
});

describe("F9 只读命令判定（纯函数）", () => {
  it("读命令/列目录命令为真；写/解包/重定向为假", () => {
    expect(readOnlyCommandIs("cat /a/b.md")).toBe(true);
    expect(readOnlyCommandIs("ls -l /a/b && cat /a/c")).toBe(true);
    expect(readOnlyCommandIs("unzip -l /a/b.zip")).toBe(true);
    expect(readOnlyCommandIs("unzip -o /a/b.zip -d /tmp/out")).toBe(false);
    expect(readOnlyCommandIs("tar -tf /a/b.tar")).toBe(true);
    expect(readOnlyCommandIs("tar -xf /a/b.tar")).toBe(false);
    expect(readOnlyCommandIs("cat /a/b > /a/c")).toBe(false);
    expect(readOnlyCommandIs("rm -f /a/b")).toBe(false);
    expect(readOnlyCommandIs("")).toBe(false);
  });
});

describe("F9 两层守卫的附件只读开白", () => {
  const ATT = "/tmp/att-fixture/attachments";

  it("bashCommandGuard：附件内只读放行、写拒（带唯一入口指引）；其它越界文案不变", () => {
    const ws = tempRoot();
    const read = bashCommandGuard(`cat ${ATT}/a.md`, [ws], { readOnlyRoots: [ATT] });
    expect(read.ok).toBe(true);
    const list = bashCommandGuard(`unzip -l ${ATT}/a.zip`, [ws], { readOnlyRoots: [ATT] });
    expect(list.ok).toBe(true);
    const write = bashCommandGuard(`unzip -o ${ATT}/a.zip -d ${ws}`, [ws], { readOnlyRoots: [ATT] });
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.message).toContain(FILE_PATH_OUTSIDE_ALLOWLIST);
      expect(write.message).toContain(ATTACHMENTS_ONLY_ENTRY_HINT);
    }
    const outside = bashCommandGuard("cat /etc/passwd", [ws], { readOnlyRoots: [ATT] });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.message).toContain("/etc/passwd");
      expect(outside.message).not.toContain(ATTACHMENTS_ONLY_ENTRY_HINT);
    }
    // 未给只读开白面＝既有行为（附件路径也拒）
    expect(bashCommandGuard(`cat ${ATT}/a.md`, [ws]).ok).toBe(false);
  });

  it("workspaceFenceGuard：附件内只读放行、写拒；其它围栏外路径文案不变", () => {
    const ws = tempRoot();
    const fence = { writable: ws, readable: [ws], readOnlyRoots: [ATT] };
    expect(workspaceFenceGuard(`cat ${ATT}/a.md`, fence).ok).toBe(true);
    const write = workspaceFenceGuard(`cp ${ATT}/a.md ${ATT}/b.md`, fence);
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.code).toBe(WORKSPACE_PATH_OUTSIDE_ALLOWLIST);
      expect(write.message).toContain(ATTACHMENTS_ONLY_ENTRY_HINT);
    }
    const outside = workspaceFenceGuard("cat /etc/passwd", fence);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.message).not.toContain(ATTACHMENTS_ONLY_ENTRY_HINT);
    // 未给只读开白面＝既有行为
    expect(workspaceFenceGuard(`cat ${ATT}/a.md`, { writable: ws, readable: [ws] }).ok).toBe(false);
  });
});

describe("F9 atf_bash 真实执行面（附件读得到、写被挡）", () => {
  it("cat 上传附件成功；unzip -o 落盘被拒并指 atf_attachments_assembly", async () => {
    const home = tempRoot();
    const ws = tempRoot();
    const runs = join(home, "runs");
    mkdirSync(runs, { recursive: true });
    const uploaded = join(home, "attachments", "v1", "files", "aa", "字段清单.md");
    mkdirSync(join(home, "attachments", "v1", "files", "aa"), { recursive: true });
    writeFileSync(uploaded, "# 字段清单\n提货单号", "utf8");
    process.env["ATF_DSH_RUNS_ROOT"] = runs;

    // 白名单根**不含** attachments（证明开白来自 F9 只读面，不是派生面⑧）
    const tools = buildFileGuardTools({ roots: [ws], env: { DSH_HOME: home, ATF_DSH_RUNS_ROOT: runs } }, { runsRoot: runs }) as Array<{
      name: string;
      execute: (args: Record<string, unknown>, exec: { callId?: string }) => Promise<unknown>;
    }>;
    const bash = tools.find((tool) => tool.name === "atf_bash");
    if (bash === undefined) throw new Error("atf_bash 未挂载");

    const read = (await bash.execute({ command: `cat ${uploaded}` }, { callId: "f9-1" })) as Record<string, unknown>;
    expect(JSON.stringify(read)).toContain("字段清单");
    expect(read["error"]).toBeUndefined();

    const blocked = (await bash.execute({ command: `unzip -o ${join(home, "attachments", "a.zip")} -d ${ws}` }, { callId: "f9-2" })) as Record<string, unknown>;
    expect(blocked["error"]).toBe(FILE_PATH_OUTSIDE_ALLOWLIST);
    expect(String(blocked["message"])).toContain(ATTACHMENTS_ONLY_ENTRY_HINT);
  });
});
