// -*- coding: utf-8 -*-
// C5 负向断言（ADR-0022 / D300）：工具执行审批拦截面退役——退役符号闭集零在场。
// 判据：src/ 与 packages/extensions/ 全部 .ts 源码，剥离注释行后，闭集内符号作为
// 代码标识符出现即红（注释中的退役说明措辞豁免——「原 XXX 随 ADR-0022 退役」是
// 文档语义，不构成调用链）。
// 退役缘由（ADR-0022 去拦截留留账）：权限档位机/审批策略矩阵拦截行为/atf_permission_status/
// D284 headless 三态/denial 升级/GateLock/账本授权轨全部退役；确认卡轨与 exemptions
// 直通留痕保留（B/C 层——owner #33 与 ADR-0019 底线不动）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

/** 退役符号闭集（代码级标识符——剥注释后零在场）。 */
const RETIRED_SYMBOLS = [
  "approvalDecidedByOf",
  "approvalTailLineOf",
  "atf_permission_status",
  "buildHeadlessApproval",
  "ATF_HEADLESS_UNATTENDED_PRESET",
  "DENIAL_ESCALATION_LIMIT",
  "createGateLock",
  "GateLock",
  "ApprovalSemanticsContext",
  "approvalMissingBlock",
  "requiresApprovalFor",
  "ApprovalPolicy",
  "APPROVAL_POLICIES",
] as const;

/** 剥注释：逐字符状态机（// 行注释、/* 块注释、字符串字面量内不剥）。 */
const stripComments = (source: string): string => {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "str" | "template" = "code";
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1] as string | undefined;
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; i += 2; continue; }
      if (ch === '"') { mode = "str"; out += ch; i += 1; continue; }
      if (ch === "'") { mode = "str"; out += ch; i += 1; continue; }
      if (ch === "`") { mode = "template"; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === "line") {
      if (ch === "\n") { mode = "code"; out += ch; }
      i += 1; continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; i += 2; out += " "; continue; }
      if (ch === "\n") out += ch;
      i += 1; continue;
    }
    if (mode === "str") {
      if (ch === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
      if (ch === '"') { mode = "code"; }
      out += ch; i += 1; continue;
    }
    // template：模板串内 ${} 嵌套不展开（闭集符号不会出现在嵌套表达式——保守原样保留）
    if (ch === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
    if (ch === "`") { mode = "code"; }
    out += ch; i += 1; continue;
  }
  return out;
};

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name.startsWith(".atf-pinned")) continue;
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
};

describe("C5 负向断言（ADR-0022 审批拦截退役）", () => {
  it("退役符号闭集在 src/ 与 packages/extensions/ 源码（剥注释后）零在场", () => {
    const files = [...collectTsFiles(join(repoRoot, "src")), ...collectTsFiles(join(repoRoot, "packages"))];
    expect(files.length).toBeGreaterThan(50); // 扫描面在场锚（防目录错配静默空扫）
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const symbol of RETIRED_SYMBOLS) {
        if (code.includes(symbol)) violations.push(`${file}: ${symbol}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
