#!/usr/bin/env node
// 模块/服务层机制重复审计器（module↔vendor-family overlap audit）。
//
// 与 audit-vendor-overlap.mjs 的分工：
//   - 那个扫「工具层」（ATF defineTool name ↔ vendor tool name），全机械；
//   - 本脚本扫「模块层」（ATF 自研模块目录 ↔ vendor 能力族），机械枚举 + 显式映射表。
//
// 为什么需要这一层：实测工具层审计器对 src/llm（2602 行）、atf-ui（3873 行）、
// core/session（1529 行）等**零覆盖**——而这些恰是重复规模最大的区域。
// 人工读代码审计两轮仍漏，故改为机械枚举保证「不漏模块」，判定语义由映射表固化。
//
// 用法：node tools/audit-module-overlap.mjs [--json]
// 退出码：0 = 无未登记重复；2 = 发现未登记重复/未分类模块
// 白名单：tools/module-overlap-allowlist.json（只减不增）
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(repoRoot, "vendor/dsh/deepseek-harness");
const allowlistPath = resolve(repoRoot, "tools/module-overlap-allowlist.json");
const asJson = process.argv.includes("--json");

if (!existsSync(join(vendorRoot, "packages"))) {
  console.error(
    `vendor 树不在场或不完整：${vendorRoot}\n` +
      "改法一：git submodule update --init vendor/dsh/deepseek-harness\n" +
      "改法二：worktree 场景软链主仓 vendor（ln -s <主仓>/vendor/dsh/deepseek-harness vendor/dsh/deepseek-harness）"
  );
  process.exit(2);
}

/** 统计某目录下 .ts 行数（跳过 node_modules/lib/dist/生成物）。 */
const countLines = (dir) => {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (["node_modules", "lib", "dist", ".git", "generated"].includes(e)) continue;
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".ts") && !e.endsWith(".d.ts") && !e.includes(".test.")) {
        try {
          total += readFileSync(p, "utf-8").split("\n").length;
        } catch {
          /* 不可读跳过 */
        }
      }
    }
  };
  walk(dir);
  return total;
};

// ---------------------------------------------------------------- ATF 模块清单（机械枚举）

/** 顶层扫描根：src/ 一级 + src/core/ 二级 + packages/extensions/ 一级。 */
const collectAtfModules = () => {
  const mods = [];
  const pushDir = (rel) => {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) return;
    mods.push({ path: rel, lines: countLines(abs) });
  };

  for (const e of readdirSync(resolve(repoRoot, "src"))) {
    const p = resolve(repoRoot, "src", e);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    if (e === "core") {
      for (const sub of readdirSync(p)) {
        const sp = join(p, sub);
        if (existsSync(sp) && statSync(sp).isDirectory()) pushDir(`src/core/${sub}`);
      }
    } else {
      pushDir(`src/${e}`);
    }
  }
  for (const e of readdirSync(resolve(repoRoot, "packages/extensions"))) {
    const p = resolve(repoRoot, "packages/extensions", e);
    if (existsSync(p) && statSync(p).isDirectory()) pushDir(`packages/extensions/${e}`);
  }
  return mods.filter((m) => m.lines > 0).sort((a, b) => b.lines - a.lines);
};

const atfModules = collectAtfModules();

// ---------------------------------------------------------------- vendor 族清单

const vendorFamilies = new Set(
  readdirSync(join(vendorRoot, "packages")).filter((e) => {
    try {
      return statSync(join(vendorRoot, "packages", e)).isDirectory();
    } catch {
      return false;
    }
  })
);

// ---------------------------------------------------------------- 映射表（语义判定，人审确认）

/**
 * ATF 模块 → vendor 族映射。判据：职责等价（同一个工程问题）。
 * verdict:
 *   "重复"     = vendor 有等价实现，ATF 自研属重复 → 应换
 *   "部分重复" = 有重叠但 ATF 有领域增量 → 评估收窄
 *   "领域保留" = vendor 无对应，属产品本体
 *   "待判"     = 需人工确认
 */
const MODULE_RULES = {
  "src/llm": { family: "llm", verdict: "重复", why: "provider/模型配置/adapter 与 vendor llm 族（llm-pi-ai/llm-retry/token-meter）职责等价" },
  "src/core/session": { family: "session", verdict: "重复", why: "compaction/sessionLog 与 vendor compaction 族 + session 族职责等价" },
  "src/core/tools": { family: "core", verdict: "部分重复", why: "canonical.ts 手搓 JSON Schema 校验器 ≈ vendor core/tools validateArgs；toolDefinition 含训练域描述属合理" },
  "src/core/workspace": { family: "workspace", verdict: "部分重复", why: "workspaceRegistry 直接改 vendor 存储文件（应走 ctx.workspaceRegistry）；run/段/GPU 属训练域保留" },
  "src/agent": { family: "subagent", verdict: "重复", why: "assembleV1Agent 自研 loop + sessionMirror + deferredTools + hooks 面，均 vendor 有对应" },
  "src/webui": { family: "api", verdict: "重复", why: "sessionManager/server 与 vendor api 族 session-controller 职责等价" },
  "src/rpc": { family: "typert", verdict: "待判", why: "JSON-RPC 传输层，vendor 有 typert-protocol——需确认是否等价" },
  "src/session": { family: "session", verdict: "待判", why: "228 行，需确认与 vendor session 族关系" },
  "src/tools": { family: "core", verdict: "待判", why: "114 行，疑似死代码" },
  "src/workspace": { family: "workspace", verdict: "待判", why: "154 行，需确认" },
  "src/bridge": { family: null, verdict: "领域保留", why: "Python 训练内核 stdio 桥接——vendor 无对应（产品本体）" },
  "src/core/generated": { family: null, verdict: "领域保留", why: "内核 stage_registry codegen 生成物——vendor 无此概念" },
  "packages/extensions/atf-tools": { family: null, verdict: "领域保留", why: "训练域 20+ 工具（atf_pipeline_stage 等），DSH 无对应——产品本体" },
  "packages/extensions/atf-ui": { family: null, verdict: "领域保留", why: "训练监控卡/槽位注入为领域定制；8 条路由全走 vendor webServer.register、SSE 为 monitor 增量推送（vendor 无等价物）——无自建 HTTP/SSE（G4 实测证伪原判词，证据见 atf-ui/CAPABILITY-BASELINE.md，2026-11-21 owner 批准改判）" },
  "packages/extensions/atf-subagent": { family: "subagent", verdict: "重复", why: "派发三件套包装，底层跑自研 loop（src/agent）——vendor subagent 族有完整替代" },
  "packages/extensions/atf-continuation": { family: null, verdict: "领域保留", why: "输出截断自动续写——已核实 vendor 无此能力" },
  "packages/extensions/atf-core": { family: null, verdict: "领域保留", why: "G2 迁入的 src/core/workspace A 类训练域逻辑（run 布局/段灯/GPU 探针/训练预检等）——vendor 无对应，产品本体" },
};

// ---------------------------------------------------------------- 判定

const rows = [];
for (const m of atfModules) {
  const rule = MODULE_RULES[m.path];
  let verdict;
  let family = null;
  let note;

  if (rule) {
    verdict = rule.verdict;
    family = rule.family;
    note = rule.why;
    if (family !== null && !vendorFamilies.has(family)) {
      verdict = "待判（映射的 vendor 族不存在）";
      note = `映射到 vendor 族 "${family}"，但该族不在 vendor 树中——映射表需更正。原判据：${rule.why}`;
    }
  } else {
    verdict = "未分类（须人工判定）";
    note = "新模块或未登记——须补 MODULE_RULES（判定属重复/领域保留）";
  }

  rows.push({ module: m.path, lines: m.lines, family, verdict, note });
}

// ---------------------------------------------------------------- 白名单

const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, "utf-8"))
  : { approved_duplicates: [], rationale: {} };
const approved = new Set(allowlist.approved_duplicates ?? []);

const offenders = rows.filter(
  (r) => (r.verdict.startsWith("重复") || r.verdict.startsWith("部分重复") || r.verdict.startsWith("未分类") || r.verdict.startsWith("待判"))
    && !approved.has(r.module)
);

// ---------------------------------------------------------------- 输出

if (asJson) {
  console.log(JSON.stringify({ modules: rows, vendorFamilies: [...vendorFamilies] }, null, 2));
} else {
  const totalAtf = rows.reduce((a, r) => a + r.lines, 0);
  console.log("# 模块/服务层机制重复审计（module ↔ vendor family）\n");
  console.log(`ATF 模块 ${String(rows.length)} 个（合计 ${String(totalAtf)} 行）｜ vendor 族 ${String(vendorFamilies.size)} 个\n`);

  const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const W1 = 38, W2 = 12, W3 = 22, W4 = 8;
  console.log(`${pad("ATF 模块", W1)}${pad("vendor 族", W2)}${pad("判定", W3)}${pad("行数", W4)}说明`);
  console.log("-".repeat(W1 + W2 + W3 + W4 + 50));
  for (const r of rows) {
    console.log(`${pad(r.module, W1)}${pad(r.family ?? "—", W2)}${pad(r.verdict, W3)}${pad(String(r.lines), W4)}${r.note}`);
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
    console.error(`\n❌ ${String(offenders.length)} 个模块未登记（重复/部分重复/待判/未分类）：`);
    for (const r of offenders) console.error(`   - ${r.module}（${r.verdict}，${String(r.lines)} 行）`);
    console.error(
      "\n改法一：处置（换成 vendor 能力，或确认属领域保留后改 MODULE_RULES 判定）\n" +
        "改法二：确认保留重复 → 加入 tools/module-overlap-allowlist.json 的 approved_duplicates 并写理由\n" +
        "（白名单只减不增）"
    );
  }
  process.exit(2);
}

if (!asJson) console.log(`\n✅ 无未登记重复（已登记保留 ${String(approved.size)} 项）`);
