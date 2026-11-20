#!/usr/bin/env node
// 跨仓重复审计器（harness ↔ 内核）。
//
// 为什么需要它：前两个审计器都只扫「ATF vs DSH vendor」。但 ATF 自身有两个仓：
//   - harness（TS，宿主层）
//   - 内核（Python，训练流程）
// 同一产品两个仓之间也会重复实现同一职责（实锚：段灯双源——harness
// src/core/workspace/segmentFacts.ts 自建八段事实轨 vs 内核 phase_projection.py
// 的 PhaseKind 11 值生命周期）。这个方向此前完全没扫过。
//
// 用法：node tools/audit-cross-repo-overlap.mjs [--json]
// 退出码：0 = 无未登记重复；2 = 发现未登记跨仓重复
// 白名单：tools/cross-repo-overlap-allowlist.json（只减不增）
//
// 判据来源：CROSS_REPO_RULES 显式登记「harness 侧某能力 ↔ 内核侧某能力」的等价关系。
// 机械部分保证「不漏模块」，语义判定由映射表固化。
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "/data/sam/AgenticTrainingFlow";
const allowlistPath = resolve(repoRoot, "tools/cross-repo-overlap-allowlist.json");
const asJson = process.argv.includes("--json");

// 内核仓不在场 → fail-closed（防「无重复」假绿）
if (!existsSync(join(kernelRoot, "src"))) {
  console.error(
    `内核仓不在场或不完整：${kernelRoot}\n` +
      "（判据：<kernel>/src 必须存在）\n" +
      "改法一：设 ATF_KERNEL_SOURCE 指向内核仓根后重跑\n" +
      "改法二：确认内核仓已 clone 到该路径"
  );
  process.exit(2);
}

/** 递归收集文件（按扩展名过滤，跳过构建产物）。 */
const walkByExt = (dir, exts, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (["node_modules", "lib", "dist", ".git", "__pycache__", ".worktrees", "build", "generated"].includes(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkByExt(p, exts, out);
    else if (exts.some((x) => e.endsWith(x)) && !e.includes(".test.") && !e.includes("_test.")) out.push(p);
  }
  return out;
};

const countLines = (files) => {
  let n = 0;
  for (const f of files) {
    try {
      n += readFileSync(f, "utf-8").split("\n").length;
    } catch {
      /* 跳过 */
    }
  }
  return n;
};

// ---------------------------------------------------------------- 两侧能力盘点

const harnessFiles = walkByExt(resolve(repoRoot, "src"), [".ts"]);
const kernelFiles = [
  ...walkByExt(resolve(kernelRoot, "src"), [".py"]),
  ...walkByExt(resolve(kernelRoot, "skills"), [".py"]),
];

// ---------------------------------------------------------------- 显式映射规则

/**
 * harness 侧能力 ↔ 内核侧能力。
 * verdict：
 *   "重复"     = 两侧做同一件事，应指定单一 owner
 *   "部分重复" = 有重叠但各有领域增量
 *   "领域保留" = 两侧职责不同（产品结构本就如此）
 *   "待判"     = 需人工确认
 */
const CROSS_REPO_RULES = {
  "src/core/workspace/segmentFacts.ts": {
    kernel: "application/phase_projection.py",
    verdict: "重复",
    why: "harness 自建八段事实轨（webui/segments.json）vs 内核 PhaseKind 11 值生命周期——同一「流程到哪一步」两套投影",
  },
  "src/core/workspace/runFacts.ts": {
    kernel: "application/flow_anchor.py",
    verdict: "待判",
    why: "harness 从 run 目录聚合事实 vs 内核 TrainingFlowAnchor/v1 派生投影——需确认是否同一职责",
  },
  "src/core/tools/toolDefinition.ts": {
    kernel: "session/tools.py",
    verdict: "部分重复",
    why: "harness 工具定义（含 canonical_output schema）vs 内核 serve 面 16 方法——桥接契约两侧各自声明，需确认是否应单源",
  },
  "src/bridge/bridgeCommand.ts": {
    kernel: "session/tools.py",
    verdict: "领域保留",
    why: "桥接命令构造属 harness 侧职责（spawn 内核），内核无对应",
  },
  "src/core/workspace/bootPreflight.ts": {
    kernel: "runtime_probe.py",
    verdict: "待判",
    why: "harness 启动预检 vs 内核运行时探针——可能有重叠的环境检查",
  },
};

// ---------------------------------------------------------------- 判定

const rows = [];
for (const [harnessRel, rule] of Object.entries(CROSS_REPO_RULES)) {
  const harnessAbs = resolve(repoRoot, harnessRel);
  const harnessFileExists = existsSync(harnessAbs);
  const harnessLines = harnessFileExists
    ? readFileSync(harnessAbs, "utf-8").split("\n").length
    : 0;
  const kernelAbs = resolve(kernelRoot, "src/agentic_training_flow", rule.kernel);
  const kernelExists = existsSync(kernelAbs);
  rows.push({
    harness: harnessRel,
    harnessLines: harnessFileExists ? harnessLines : 0,
    kernel: rule.kernel,
    kernelExists,
    verdict: kernelExists ? rule.verdict : "待判（内核侧文件不存在）",
    why: rule.why,
  });
}

// 反向：内核侧有没有 harness 也做了但没登记的知名模块（机械提示，不判重）
const kernelHints = [
  "application/phase_projection.py",
  "application/flow_anchor.py",
  "session/tools.py",
  "runtime_probe.py",
  "application/stage_registry.py",
].map((rel) => ({
  rel,
  present: existsSync(resolve(kernelRoot, "src/agentic_training_flow", rel)),
  registered: Object.values(CROSS_REPO_RULES).some((r) => r.kernel === rel),
}));

// ---------------------------------------------------------------- 白名单

const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, "utf-8"))
  : { approved_duplicates: [], rationale: {} };
const approved = new Set(allowlist.approved_duplicates ?? []);

const offenders = rows.filter(
  (r) => (r.verdict.startsWith("重复") || r.verdict.startsWith("部分重复") || r.verdict.startsWith("待判"))
    && !approved.has(r.harness)
);

// ---------------------------------------------------------------- 输出

if (asJson) {
  console.log(JSON.stringify({ rows, kernelHints, kernelRoot }, null, 2));
} else {
  console.log("# 跨仓重复审计（harness ↔ 内核）\n");
  console.log(`内核仓：${kernelRoot}`);
  console.log(`harness .ts ${String(harnessFiles.length)} 个 ｜ 内核 .py ${String(kernelFiles.length)} 个\n`);

  const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const W1 = 42, W2 = 34, W3 = 22;
  console.log(`${pad("harness 侧", W1)}${pad("内核侧", W2)}${pad("判定", W3)}说明`);
  console.log("-".repeat(W1 + W2 + W3 + 40));
  for (const r of rows) {
    console.log(`${pad(r.harness, W1)}${pad(r.kernel, W2)}${pad(r.verdict, W3)}${r.why}`);
  }

  const unregistered = kernelHints.filter((h) => h.present && !h.registered);
  if (unregistered.length > 0) {
    console.log("\n## 内核侧在场但未登记的知名模块（可能是遗漏的跨仓重复）");
    for (const h of unregistered) console.log(`- ${h.rel}`);
  }

  const byVerdict = new Map();
  for (const r of rows) {
    const k = r.verdict.replace(/（.*$/, "");
    byVerdict.set(k, (byVerdict.get(k) ?? 0) + 1);
  }
  console.log("\n## 汇总");
  for (const [v, n] of [...byVerdict].sort((a, b) => b[1] - a[1])) console.log(`- ${v}: ${String(n)}`);
}

if (offenders.length > 0) {
  if (!asJson) {
    console.error(`\n❌ ${String(offenders.length)} 项跨仓重复未登记：`);
    for (const r of offenders) console.error(`   - ${r.harness} ↔ ${r.kernel}（${r.verdict}）`);
    console.error(
      "\n改法一：指定单一 owner（哪一侧该保留），另一侧退役或改为消费对方产物\n" +
        "改法二：确认两侧职责不同 → 加入 tools/cross-repo-overlap-allowlist.json 并写理由\n" +
        "（白名单只减不增）"
    );
  }
  process.exit(2);
}

if (!asJson) console.log(`\n✅ 无未登记跨仓重复（已登记保留 ${String(approved.size)} 项）`);
