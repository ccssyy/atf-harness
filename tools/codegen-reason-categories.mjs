#!/usr/bin/env node
// 批 5 3c codegen:升级告警三分表(need_user/self_heal/record)生成物。
// 双源 merge:
//   1) 内核 contracts/reason_codes.REASON_CODE_CATEGORY(内核码权威随内核仓);
//   2) harness 本地码(码定义在 harness 源码,单源随码走本仓)——**源码扫描自动
//      收集**,默认 self_heal,NEED_USER 白名单例外;白名单码不在扫描集即红(防漂移)。
// 消费契约:越集码(不在表内)默认 need_user(fail-closed 默认呈人——漏真告警的
// 代价大于多打扰);扫描本身是生产端闸:新增 harness 码自动进表(带默认分类),
// 不存在「新码漏登记越集」的敞口——新增码只在显式判为需要人时改白名单。
// 生成物不入手改,重生成:
//   npm run codegen:reason-categories
// 漂移防护:prebuild 断言 git diff --exit-code(源变更未重生成即红)。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const kernelRoot = process.env.ATF_KERNEL_SOURCE;
if (!kernelRoot) {
  console.error(
    "ATF_KERNEL_SOURCE 未设置——内核仓根须 env 注入(与单版本源门同源);" +
      "设置后重跑 npm run codegen:reason-categories"
  );
  process.exit(2);
}

// harness 侧需要人的码闭集(处置主体=用户:审批/凭据/用户暂停/用户卡未确认)。
// 只减不增口径同内核表;新增码默认 self_heal,确需呈人时移入本表并重生成。
const HARNESS_NEED_USER = new Set([
  "approval_denied",
  "approval_missing",
  "credential_consumed",
  "credential_invalid",
  "eval_release_paused_by_user",
  "user_decision_paused",
  "field_choice_unconfirmed",
]);

// ── harness 源码扫描(码收集面=error/code/reason_code(s) 键位的字符串字面值)──
const SCAN_ROOTS = ["packages/extensions/atf-tools/src", "packages/extensions/atf-ui/src", "src/core"];
const CODE_RE = /(?:error|code|reason_codes?)\s*:\s*["']([a-z][a-z0-9_]+)["']/g;
const CODE_SHAPE_RE = /^[a-z][a-z0-9_]{3,}$/;

const iterTsFiles = function* (root) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* iterTsFiles(full);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield full;
  }
};

const harnessCodes = new Set();
const allSourceText = [];
const repoRoot = process.cwd();
for (const rel of SCAN_ROOTS) {
  const abs = resolve(repoRoot, rel);
  for (const file of iterTsFiles(abs)) {
    const text = readFileSync(file, "utf8");
    allSourceText.push(text);
    for (const match of text.matchAll(CODE_RE)) {
      const code = match[1];
      if (CODE_SHAPE_RE.test(code) && code !== "true" && code !== "false" && code !== "null") {
        harnessCodes.add(code);
      }
    }
  }
}
// 白名单码允许出现在函数参位等非键位形态(trackBlock("credential_consumed") 一类)
// ——窄扫描收集不到时以宽校验(全源码文本在场)兜底注入,彻底不在场才是漂移。
const corpus = allSourceText.join("\n");
const orphanWhitelist = [...HARNESS_NEED_USER].filter((code) => !harnessCodes.has(code) && !corpus.includes(code));
if (harnessCodes.size < 50) {
  console.error(`harness 源码扫描码量异常偏少(${harnessCodes.size})——扫描面失效即红`);
  process.exit(2);
}
if (orphanWhitelist.length > 0) {
  console.error(`NEED_USER 白名单码不在扫描集(码名漂移或已退役): ${orphanWhitelist.join(", ")}`);
  process.exit(2);
}
for (const code of HARNESS_NEED_USER) harnessCodes.add(code);
const harnessList = [...harnessCodes].sort();
;

// ── 内核表 ──
const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(kernelRoot, "src"))})
from agentic_training_flow.contracts.reason_codes import REASON_CODE_CATEGORY
print(json.dumps(REASON_CODE_CATEGORY))
`;
const out = execFileSync("python3", ["-c", probe], { encoding: "utf-8", timeout: 60_000 });
const kernelCategories = JSON.parse(out);
const valid = new Set(["need_user", "self_heal", "record"]);
if (
  typeof kernelCategories !== "object" ||
  kernelCategories === null ||
  Array.isArray(kernelCategories) ||
  Object.keys(kernelCategories).length < 50 ||
  Object.entries(kernelCategories).some(([code, value]) => typeof code !== "string" || code === "" || !valid.has(value))
) {
  console.error(`内核 REASON_CODE_CATEGORY 输出形态非法: ${out.slice(0, 200)}`);
  process.exit(2);
}

// ── merge:内核表优先(同码重名时内核口径赢),harness 码默认 self_heal ──
const merged = { ...kernelCategories };
for (const code of harnessList) {
  if (!(code in merged)) merged[code] = HARNESS_NEED_USER.has(code) ? "need_user" : "self_heal";
}

const banner =
  "// 自动生成(批 5 3c codegen)——双源 merge:内核 contracts/reason_codes.REASON_CODE_CATEGORY +\n" +
  "// harness 源码扫描码(默认 self_heal,NEED_USER 白名单例外;白名单在 tools/codegen-reason-categories.mjs)。\n" +
  "// 请勿手改;重生成: npm run codegen:reason-categories (源=ATF_KERNEL_SOURCE 内核仓 + 本仓源码扫描)\n" +
  "// 三分表:need_user=呈人强文案/self_heal=软文案+自愈对冲/record=纯留痕;越集码默认 need_user(fail-closed)\n";
const body = JSON.stringify(merged);
const ts =
  `${banner}` +
  `export type ReasonCodeCategory = "need_user" | "self_heal" | "record";\n` +
  `export const REASON_CODE_CATEGORIES: Record<string, ReasonCodeCategory> = ${body};\n`;
const js =
  `${banner}` +
  `export const REASON_CODE_CATEGORIES = ${body};\n`;

const dirTs = "src/core/generated";
mkdirSync(dirTs, { recursive: true });
writeFileSync(`${dirTs}/reasonCategories.ts`, ts, "utf8");
writeFileSync(`${dirTs}/reasonCategories.js`, js, "utf8");
console.log(
  `reason-categories codegen ok: 内核 ${Object.keys(kernelCategories).length} 码 + harness ${harnessList.length} 码(need_user 白名单 ${HARNESS_NEED_USER.size} 命中)→ ${dirTs}/reasonCategories.ts + .js`,
);
