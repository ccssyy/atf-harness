/**
 * D182 机检锚:裁决账本读侧守卫+治理面改道。
 * owner 语义主张:裁决依据只认当前 run 账本与当前会话用户输入——
 * agent 跨 run 考古(UAT 实锤:翻 2026-10-29 裁决原话)在文件面四路
 * (atf_read/glob/grep/read_image+atf_bash 命令串)全部 deny+改道。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildFileGuardTools } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

const toolOf = (name: string): { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> } => {
  const root = mkdtempSync(join(tmpdir().toString(), "d182-"));
  const tools = buildFileGuardTools({ roots: [root], env: {} }) as Array<{ name?: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> }>;
  const found = tools.find((tool) => (tool as { name?: string }).name === name);
  if (found === undefined) throw new Error(`${name} not mounted`);
  return found as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
};
import { join } from "node:path";

describe("D182 裁决账本读侧守卫", () => {
  it("atf_read 读裁决账本文件 → deny+改道(atf_label_qc_inspect/显式引用指路)", async () => {
    const read = toolOf("atf_read");
    const result = await read.execute(
      { path: "/data/ws-1029/experiments/x/run-awb-01/publish/awb/35a8f449/label-adjudication-requests.json" },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("label_adjudication_ledger_redirect");
    expect(String(result.message)).toContain("atf_label_qc_inspect");
    expect(String(result.message)).toContain("显式");
  });

  it("atf_bash 命令串含裁决账本文件名 → deny+改道(命令串考古同样拦)", async () => {
    const bash = toolOf("atf_bash");
    const result = await bash.execute(
      { command: "cat /data/ws-1029/run-awb-01/publish/awb/35a8f449/label-adjudication-requests.json | head" },
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("label_adjudication_ledger_redirect");
  });

  it("非裁决文件不受影响(守卫不误伤正常读写)", async () => {
    const read = toolOf("atf_read");
    const root = mkdtempSync(join(tmpdir().toString(), "d182-ok-"));
    const result = await read.execute({ path: join(root, "notes.md") }, {});
    // 文件不存在报 not_found 是正常路径——只要不是裁决改道码
    expect(result.error).not.toBe("label_adjudication_ledger_redirect");
  });
});
