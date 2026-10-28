/**
 * D-a 防回退：`--field-config` **传前校验**（纯函数级）。
 *
 * 现场（dev 2026-10-28 webui 真机）：agent 显式传了 field_config（先相对后绝对），工具原样
 * 下传，内核按**自己进程的 CWD** 解析不到 → 静默降级 → 报「未显式传 --field-config」。
 * 错误归因导致 agent 连续四次撞同一句、怀疑传参链路/审批账本/白名单，读源码 16m41s。
 *
 * 这里锁三件事：
 * 1. 相对路径先绝对化（跨进程传相对路径必然歧义）；
 * 2. 文件不存在 → 不通过，且**解析后的绝对路径**必须给出（不能只说"没传"）；
 * 3. 报文指向 run 内登记副本槽位（正路），并明说「跨进程一律用绝对路径」。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldConfigPrecheckOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const runDirOf = () => {
  const dir = mkdtempSync(join(tmpdir(), "atf-fc-pure-"));
  mkdirSync(join(dir, "config", "experiment-setup", "awb"), { recursive: true });
  return dir;
};

describe("D-a fieldConfigPrecheckOf", () => {
  it("不存在的相对路径 → 不通过，且给出解析后的绝对路径（不是「没传」）", () => {
    const runDir = runDirOf();
    const verdict = fieldConfigPrecheckOf("scratch/field-config-awb.json", runDir, "awb");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.given).toBe("scratch/field-config-awb.json");
    // 关键：绝对路径在场的（否则调用方又要猜自己写到了哪）
    expect(verdict.resolved.startsWith("/")).toBe(true);
    expect(verdict.resolved).toContain("scratch/field-config-awb.json");
    // 报错指向正路（run 内槽位），并点明相对路径的解析歧义
    expect(verdict.note).toContain(`${runDir}/config/experiment-setup/awb/field-config.json`);
    expect(verdict.note).toContain("绝对路径");
  });

  it("不存在的绝对路径 → 不通过，resolved 与 given 相同（不做二次解析）", () => {
    const runDir = runDirOf();
    const verdict = fieldConfigPrecheckOf("/tmp/atf-does-not-exist-xyz.json", runDir, "awb");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.resolved).toBe("/tmp/atf-does-not-exist-xyz.json");
  });

  it("存在的文件 → 通过并给绝对路径（下游拿到的永远是绝对路径）", () => {
    const runDir = runDirOf();
    const target = join(runDir, "config", "experiment-setup", "awb", "field-config.json");
    writeFileSync(target, JSON.stringify({ document_type: "awb", fields: [] }), "utf8");
    const verdict = fieldConfigPrecheckOf(target, runDir, "awb");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.resolved).toBe(target);
  });

  it("doc_type 缺省时槽位提示用占位符（不编造单据类型）", () => {
    const runDir = runDirOf();
    const verdict = fieldConfigPrecheckOf("/tmp/atf-nope.json", runDir);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.note).toContain("<单据类型>");
  });
});
