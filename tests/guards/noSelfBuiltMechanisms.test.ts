import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 禁自建门禁（ADR-0019 决定 1/6；B0 任务书对抗用例）。
 *
 * 拦截：新增代码重新引入 vendor 能力包族已覆盖的手搓机制。
 * 白名单＝存量 B 档件（2026-11-04 侦察实锚）；B1-B5 逐批收编退役时
 * 同步删除条目并删源文件——退役即删不留双轨（ADR-0019 决定 6）。
 * 报错即修复指令：文案必须指向 vendor 替代件与 ADR-0019 判定表编号。
 */

const SRC_ROOT = join(process.cwd(), "src");

/** 存量 B 档白名单（相对 src/ 路径）；随退役批清空。 */
const ALLOWLIST = new Set<string>([
  "core/session/constants.ts", // faux 上下文预算常量 → B1（compaction 族+spill 收编）退役
  "core/session/constantsBudget.ts", // 同上
  "agent/deferredFace.ts", // scratch 轮询形态 → B3（jobs 收编）退役
  "agent/deferredTools.ts", // 同上
  "agent/index.ts", // 存量引用面 → 随 B3 迁移
  "agent/cli.ts", // 同上
  "core/run/noProgress.ts", // 无进展控制面 → B3（guard 收编）退役
  "core/run/noProgressCrossTurn.ts", // 同上
]);

/** 手搓上下文阈值（faux compaction 的 24K 硬编码形态）。 */
const FORBIDDEN_THRESHOLD = /\b(24000|24_000)\b/;
/** 手搓轮询（长间隔 setInterval 等待外部完成的 scratch 形态）。 */
const FORBIDDEN_POLLING = /setInterval\([^,]+,\s*[0-9]{4,}\)/;

interface Violation {
  file: string;
  rule: string;
  message: string;
}

/** 对单文件文本做检查（导出供演练与样例断言复用）。 */
export function checkText(relPath: string, text: string): Violation[] {
  if (ALLOWLIST.has(relPath)) return [];
  const hits: Violation[] = [];
  if (FORBIDDEN_THRESHOLD.test(text)) {
    hits.push({
      file: relPath,
      rule: "hand-rolled-context-threshold",
      message:
        "禁新增手搓上下文阈值（faux compaction 形态）。改用 vendor compaction 族（tool-result-pruner/image-offload）＋spill；接线指引＝ADR-0019 判定表 #2/#3/#4（B1 批），装配态见 docs/b1-recon-live-wiring-20261104.md",
    });
  }
  if (FORBIDDEN_POLLING.test(text)) {
    hits.push({
      file: relPath,
      rule: "scratch-polling",
      message:
        "禁新增手搓轮询（scratch poll 形态）。改用 vendor jobs 族（tool-jobs 已在 dev 装配）；接线指引＝ADR-0019 判定表 #5（B3 批），装配态见 docs/b1-recon-live-wiring-20261104.md",
    });
  }
  return hits;
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listTsFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("禁自建门禁（ADR-0019）", () => {
  it("手搓阈值样例报红且报错含修复指令", () => {
    const hits = checkText("some/new/file.ts", "const LIMIT = 24000;");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain("ADR-0019 判定表 #2/#3/#4");
    expect(hits[0].message).toContain("spill");
  });

  it("手搓轮询样例报红且报错含修复指令", () => {
    const hits = checkText("some/new/file.ts", "const t = setInterval(tick, 30000);");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain("ADR-0019 判定表 #5");
    expect(hits[0].message).toContain("jobs");
  });

  it("白名单存量件不报红", () => {
    expect(checkText("core/session/constantsBudget.ts", "export const X = 24000;")).toHaveLength(0);
  });

  it("src 全量扫描：白名单外零命中（新增手搓机制即红）", () => {
    const violations = listTsFiles(SRC_ROOT).flatMap((f) =>
      checkText(relative(SRC_ROOT, f), readFileSync(f, "utf8")),
    );
    expect(
      violations,
      violations.map((v) => `${v.file}: ${v.message}`).join("\n"),
    ).toEqual([]);
  });
});
