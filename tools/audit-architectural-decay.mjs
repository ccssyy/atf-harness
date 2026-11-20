#!/usr/bin/env node
// 架构腐化审计器（architectural decay audit）。
//
// 治什么：前三个审计器查「重复造轮子」（ATF vs vendor / harness vs 内核）。
// 本审计器查另一类：**工具内承载了本该由机制承载的东西**。
// 实锚：pipelineFace.ts 4389 行里 45 处 `if (args.stage === ...)`——流程语义
// 内嵌在工具代码里，既不是配置、不是状态机，也不是声明，新增段要改 45 处附近。
//
// 判据来源：harness-dev-discipline「用写规则代替装仪器」的对立面——
// 流程规则写进 if 分支，而不是声明式配置或状态机。
//
// 用法：node tools/audit-architectural-decay.mjs [--json]
// 退出码：0 = 无未登记告警；2 = 发现超阈值且未登记
// 白名单：tools/architectural-decay-allowlist.json（只减不增）
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = resolve(repoRoot, "tools/architectural-decay-allowlist.json");
const asJson = process.argv.includes("--json");

// ---------------------------------------------------------------- 阈值

const THRESHOLDS = {
  /** 单文件内 `args.stage ===` 分支数上限（声明式应替代） */
  stageBranches: 10,
  /** 单文件内「正则解析用户自由文本」处数上限（语义应归模型） */
  freeTextRegex: 3,
  /** 单函数行数上限 */
  functionLines: 200,
  /** 单文件行数上限（触发「该拆了」信号） */
  fileLines: 3000,
};

/** 判定「正则解析自由文本」的形态：对 custom/typed/text 变量做 match/replace。 */
const FREE_TEXT_REGEX_PATTERNS = [
  /(?:custom|customText|typed|typedText|freeText|userText)\.(?:match|replace|split)\(/g,
  /(?:custom|customText|typed|typedText)\s*\.match\(/g,
];

// ---------------------------------------------------------------- 采集

const walkTs = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (["node_modules", "lib", "dist", ".git", "generated"].includes(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTs(p, out);
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts") && !e.includes(".test.")) out.push(p);
  }
  return out;
};

const countMatches = (src, re) => {
  const r = new RegExp(re.source, "g");
  let n = 0;
  while (r.exec(src) !== null) n += 1;
  return n;
};

/**
 * 找超长函数——花括号配平，不用缩进推算。
 * 缩进法会把单行箭头函数的后续语句误算进函数体（实测把 1 行的
 * isNonEmptyString 算成 218 行）。
 *
 * 判据：从声明行起数 { 与 } 的净值，归零处即函数结束。先剔除字符串
 * 与行注释里的括号（粗粒度，足够本项目用）。
 */
const findLongFunctions = (src, maxLines) => {
  const lines = src.split("\n");
  const out = [];
  const declRe = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\()/;
  // 剔除：行注释、三种字符串字面量、**正则字面量**。
  // 正则必须剔除——`/{4,5}/` 里的花括号会被配平算法误计，实测把
  // 3 行的 extractMasterPort 算成 2761 行。
  const strip = (l) =>
    l
      .replace(/\/\/.*$/, "")
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/\/(?:[^\/\\\n]|\\.)+\/[gimsuy]*/g, "/RE/");
  for (let i = 0; i < lines.length; i += 1) {
    const m = declRe.exec(lines[i]);
    if (m === null) continue;
    const name = m[1] ?? m[2];
    let depth = 0;
    let started = false;
    let end = i;
    for (; end < lines.length; end += 1) {
      const l = strip(lines[end]);
      for (const ch of l) {
        if (ch === "{") { depth += 1; started = true; } else if (ch === "}") { depth -= 1; }
      }
      if (started && depth === 0) break;
      if (!started && /;\s*$/.test(l)) break;
    }
    const len = end - i + 1;
    if (len > maxLines) out.push({ name, line: i + 1, lines: len });
    i = end;
  }
  return out;
};

const atfSrcRoots = [
  resolve(repoRoot, "src"),
  resolve(repoRoot, "packages"),
];
const files = atfSrcRoots.flatMap((r) => walkTs(r));

const rows = [];
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  const lineCount = src.split("\n").length;
  const findings = [];

  const stageBranches = countMatches(src, /args\.stage ===/);
  if (stageBranches > THRESHOLDS.stageBranches) {
    findings.push({ metric: "stageBranches", value: stageBranches, limit: THRESHOLDS.stageBranches });
  }

  let freeTextRegex = 0;
  for (const re of FREE_TEXT_REGEX_PATTERNS) freeTextRegex += countMatches(src, re);
  if (freeTextRegex > THRESHOLDS.freeTextRegex) {
    findings.push({ metric: "freeTextRegex", value: freeTextRegex, limit: THRESHOLDS.freeTextRegex });
  }

  if (lineCount > THRESHOLDS.fileLines) {
    findings.push({ metric: "fileLines", value: lineCount, limit: THRESHOLDS.fileLines });
  }

  for (const fn of findLongFunctions(src, THRESHOLDS.functionLines)) {
    findings.push({ metric: "functionLines", value: fn.lines, limit: THRESHOLDS.functionLines, where: `${fn.name}@${fn.line}` });
  }

  if (findings.length > 0) {
    rows.push({ file: relative(repoRoot, file), findings });
  }
}

// ---------------------------------------------------------------- 白名单

const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, "utf-8"))
  : { approved: [], rationale: {} };
/** 白名单键形如 "文件:指标"，支持整文件豁免 "文件" */
const approved = new Set(allowlist.approved ?? []);

const offenders = rows.filter((r) => {
  if (approved.has(r.file)) return false;
  return r.findings.some((f) => !approved.has(`${r.file}:${f.metric}`));
});

// ---------------------------------------------------------------- 输出

const METRIC_ZH = {
  stageBranches: "流程段分支（args.stage ===）",
  freeTextRegex: "正则解析用户自由文本",
  functionLines: "超长函数",
  fileLines: "超大文件",
};

if (asJson) {
  console.log(JSON.stringify({ thresholds: THRESHOLDS, rows, offenderCount: offenders.length }, null, 2));
} else {
  console.log("# 架构腐化审计（工具内隐式流程语义）\n");
  console.log("阈值：" + Object.entries(THRESHOLDS).map(([k, v]) => `${METRIC_ZH[k] ?? k}>${String(v)}`).join(" ｜ ") + "\n");
  console.log(`扫描 ${String(files.length)} 个 .ts ｜ 命中 ${String(rows.length)} 个文件\n`);

  if (rows.length > 0) {
    const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
    const W1 = 46, W2 = 30;
    console.log(`${pad("文件", W1)}${pad("告警", W2)}`);
    console.log("-".repeat(W1 + W2 + 40));
    for (const r of rows) {
      const desc = r.findings
        .map((f) => `${METRIC_ZH[f.metric] ?? f.metric}=${String(f.value)}(>${String(f.limit)})${f.where ? `[${f.where}]` : ""}`)
        .join("；");
      console.log(`${pad(r.file, W1)}${pad(desc, W2)}`);
    }
  }

  console.log("\n## 汇总");
  const byMetric = new Map();
  for (const r of rows) for (const f of r.findings) byMetric.set(f.metric, (byMetric.get(f.metric) ?? 0) + 1);
  for (const [m, n] of [...byMetric].sort((a, b) => b[1] - a[1])) {
    console.log(`- ${METRIC_ZH[m] ?? m}: ${String(n)} 处`);
  }
}

if (offenders.length > 0) {
  if (!asJson) {
    console.error(`\n❌ ${String(offenders.length)} 个文件有未登记腐化告警：`);
    for (const r of offenders) console.error(`   - ${r.file}`);
    console.error(
      "\n改法一：重构（流程闸移出工具、正则解析改由模型理解、长函数拆分）\n" +
        "改法二：确认属架构固有形状 → 加入 tools/architectural-decay-allowlist.json 并写理由\n" +
        "（白名单只减不增；对象三分：可闭集不变量→堵、开放行为面→判据+回放、架构固有形状→显式化不修）"
    );
  }
  process.exit(2);
}

if (!asJson) console.log(`\n✅ 无未登记腐化告警（已登记 ${String(approved.size)} 项）`);
