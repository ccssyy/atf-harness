#!/usr/bin/env node
// 机制重复审计器（vendor overlap audit）——机械枚举 ATF 自研面 vs DSH vendor 能力。
//
// 为什么需要它：此前靠人工读代码审计「重复造轮子」，存在「没读到就不会报」的盲区
// （实测两轮仍漏 6 处）。本脚本把该审计变成可重复执行的机检：
//   npm run audit:vendor-overlap
// 输出：ATF 每个工具/模块 → 是否与 vendor 既有能力重复 → 分类（应换/保留/待判）。
//
// 判据来源（不硬编码结论，只硬编码「比对规则」）：
//   ① ATF 工具名取自 packages/extensions/*/src 与 src/ 的 defineTool name 字面量
//   ② vendor 工具名取自 vendor/dsh/deepseek-harness/packages/*/tool-*/src 的 name 字面量
//   ③ 同名去 atf_ 前缀后比对；再按 OVERLAP_RULES 的显式语义映射补充「异名同义」
//   ④ ATF 域前缀（atf_ 且不在映射内）默认判「训练域工具·保留」，但会列出来供人复核
//
// 退出码：0 = 无新增重复（相对白名单）；2 = 发现未登记重复（须处置或入白名单）
// 白名单：tools/vendor-overlap-allowlist.json（只减不增；新增重复须显式登记理由）
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(repoRoot, "vendor/dsh/deepseek-harness");
const allowlistPath = resolve(repoRoot, "tools/vendor-overlap-allowlist.json");

if (!existsSync(vendorRoot) || !existsSync(join(vendorRoot, "packages"))) {
  console.error(
    `vendor 树不在场或不完整：${vendorRoot}\n` +
      "（判据：vendor/dsh/deepseek-harness/packages 必须存在）\n" +
      "改法一：git submodule update --init vendor/dsh/deepseek-harness\n" +
      "改法二：worktree 场景下把主仓已构建的 vendor 软链进来（ln -s <主仓>/vendor/dsh/deepseek-harness vendor/dsh/deepseek-harness）"
  );
  process.exit(2);
}

/** 递归收集 .ts 文件（跳过 node_modules/lib/dist）。 */
const walkTs = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "lib" || entry === "dist" || entry === ".git") continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTs(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test.")) out.push(p);
  }
  return out;
};

/** 从文件集合抽取 `name: "<literal>"` 形态的工具名。 */
const extractToolNames = (files) => {
  const names = new Set();
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/name:\s*["']([a-z][a-z0-9_]*)["']/g)) {
      const n = m[1];
      // 噪音排除：schema 字段名/占位串，不是工具名
      if (["default", "atf", "tring", "trin", "ool", "kill", "register", "tool", "asename", "mage", "ef", "he", "rgs", "un"].includes(n)) continue;
      if (n.length < 3) continue;
      names.add(n);
    }
  }
  return names;
};

// ---------------------------------------------------------------- 采集

const atfFiles = [
  ...walkTs(resolve(repoRoot, "packages")),
  ...walkTs(resolve(repoRoot, "src")),
];
const vendorFiles = walkTs(resolve(vendorRoot, "packages"));

const atfTools = extractToolNames(atfFiles);
const vendorTools = extractToolNames(vendorFiles);

// fail-closed：vendor 扫描不到任何工具 = 树不完整（空目录/未初始化）——此时任何
// 「无重复」结论都是假绿，必须拒绝出结论。
if (vendorFiles.length === 0 || vendorTools.size === 0) {
  console.error(
    `vendor 树扫描为空：${String(vendorFiles.length)} 个 .ts 文件 / ${String(vendorTools.size)} 个工具名\n` +
      "这是 worktree 子模块未初始化或 vendor 被清空的形态——此时「无重复」结论不可信。\n" +
      "改法一：git submodule update --init vendor/dsh/deepseek-harness\n" +
      "改法二：把主仓已构建的 vendor 软链进来后重跑"
  );
  process.exit(2);
}

// ---------------------------------------------------------------- 比对规则

/**
 * 异名同义映射：ATF 工具 → vendor 对应能力（人工确认过的语义等价）。
 * 只登记「已确认重复」，不登记猜测。每条必须写证据（为什么等价）。
 */
const OVERLAP_RULES = {
  atf_read: { vendor: "read", why: "vendor fs/tool-fs 的 read 已实现 offset/limit/has_more 分页" },
  atf_write: { vendor: "write", why: "vendor fs/tool-fs 的 write" },
  atf_edit: { vendor: "edit", why: "vendor fs/tool-fs 的 edit（另有 str_replace_editor）" },
  atf_bash: { vendor: "bash", why: "vendor shell 族的 bash 工具" },
  atf_scratch_write: { vendor: "write", why: "vendor write 写入能力（scratch 只是路径约束）" },
  atf_scratch_exec: { vendor: "bash", why: "vendor bash 执行能力（scratch 只是 cwd 约束）" },
  atf_skill_read: { vendor: "skill", why: "vendor skill 族读技能能力" },
  atf_deferred_spawn: { vendor: "job_list", why: "vendor jobs 族后台任务注册" },
  atf_deferred_poll: { vendor: "job_output", why: "vendor jobs 族结果收取" },
  atf_deferred_cancel: { vendor: "job_kill", why: "vendor jobs 族取消" },
  atf_hello: { vendor: null, why: "装配自检探针，调试用——无生产价值，建议删" },
};

/** 训练域工具白名单：确认是 DSH 无对应的产品本体，不判重复。 */
const DOMAIN_TOOLS = new Set([
  "atf_pipeline_stage", "atf_run_training", "atf_evaluate", "atf_gate", "atf_joint_train",
  "atf_label_qc_inspect", "atf_label_qc_resolve", "atf_config_confirm", "atf_publish_confirm",
  "atf_publish_model", "atf_analyze_badcases", "atf_metrics_compare", "atf_run_list",
  "atf_report_read", "atf_records_query", "atf_workspace_status", "atf_fact_scan",
  "atf_create_experiment", "atf_rebind_workspace", "atf_prelaunch_report",
  "atf_training_preflight", "atf_quantize_annotations", "atf_attachments_assembly",
  "atf_admit_data", "atf_data_admission_request", "atf_preparation_propose",
  "atf_style_cluster_execute", "atf_launch_execute", "atf_gpu_status",
  // 非 atf_ 前缀的本地工具：同样属训练域（DSH 无对应）
  "ask_user_for_input",              // 需要用户输入（DSH 有 ask_user_question，但它走原生卡；此名是本地封装）
  "dispatch_training_subtask",       // 训练子任务派发（DSH subagent 有等价，属 #1 自研 loop 面——已在重复清单登记）
  "dispatch_parallel_training_subtask", // 并行派发（同上）
]);

// ---------------------------------------------------------------- 判定

const rows = [];
for (const tool of [...atfTools].sort()) {
  const bare = tool.replace(/^atf_/, "");
  const rule = OVERLAP_RULES[tool];
  let verdict;
  let vendorEq = null;
  let note = "";

  if (rule) {
    if (rule.vendor === null) {
      verdict = "建议删除";
      note = rule.why;
    } else if (vendorTools.has(rule.vendor)) {
      verdict = "重复·应换 vendor";
      vendorEq = rule.vendor;
      note = rule.why;
    } else {
      verdict = "待判（映射的 vendor 工具未找到）";
      vendorEq = rule.vendor;
      note = rule.why;
    }
  } else if (vendorTools.has(bare)) {
    verdict = "重复·同名（应换 vendor）";
    vendorEq = bare;
    note = "去 atf_ 前缀后与 vendor 工具同名";
  } else if (DOMAIN_TOOLS.has(tool)) {
    verdict = "训练域·保留";
    note = "DSH 无对应能力（产品本体）";
  } else {
    verdict = "未分类（须人工判定）";
    note = "既非已登记重复、也非已登记域工具——新增工具须补 DOMAIN_TOOLS 或 OVERLAP_RULES";
  }

  rows.push({ tool, vendorEq, verdict, note });
}

// ---------------------------------------------------------------- 白名单

const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, "utf-8"))
  : { approved_duplicates: [], note: "" };
const approved = new Set(allowlist.approved_duplicates ?? []);

const unarchived = rows.filter(
  (r) => (r.verdict.startsWith("重复") || r.verdict === "未分类（须人工判定）") && !approved.has(r.tool)
);

// ---------------------------------------------------------------- 输出

const byVerdict = new Map();
for (const r of rows) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);

console.log(`# 机制重复审计（vendor overlap）`);
console.log(`\nATF 工具 ${String(atfTools.size)} 个 ｜ vendor 工具 ${String(vendorTools.size)} 个\n`);

const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
const W1 = 26, W2 = 14, W3 = 34;
console.log(`${pad("ATF 工具", W1)}${pad("vendor 对应", W2)}${pad("判定", W3)}说明`);
console.log("-".repeat(W1 + W2 + W3 + 40));
for (const r of rows) {
  console.log(
    `${pad(r.tool, W1)}${pad(r.vendorEq ?? "—", W2)}${pad(r.verdict, W3)}${r.note}`
  );
}

console.log("\n## 汇总");
for (const [v, n] of [...byVerdict].sort((a, b) => b[1] - a[1])) console.log(`- ${v}: ${String(n)}`);

if (unarchived.length > 0) {
  console.error(`\n❌ 发现 ${String(unarchived.length)} 个未登记的重复/未分类工具：`);
  for (const r of unarchived) console.error(`   - ${r.tool}（${r.verdict}）`);
  console.error(
    "\n改法一：处置之（换成 vendor 能力，或确认属训练域后加入 DOMAIN_TOOLS）\n" +
      "改法二：确认要保留重复 → 加入 tools/vendor-overlap-allowlist.json 的 approved_duplicates 并写理由\n" +
      "（白名单只减不增：新增重复必须显式登记，禁止静默放过）"
  );
  process.exit(2);
}

console.log(`\n✅ 无未登记重复（已登记保留 ${String(approved.size)} 项）`);
