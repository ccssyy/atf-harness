/**
 * 批㊶-NARR T2——叙事卫生护栏移植（内核 tests/tools/test_skill_narrative_hygiene.py →
 * harness 产品运行件，防新增回流；owner 产品原则「用户可见面零开发叙事」）。
 *
 * 扫描面＝产品运行件的字符串字面量（工具 description/note、错误回流文案、UI 渲染字符串、
 * console 面向用户输出）——TS 编译器 AST 精确扫 string literal/template span，注释与类型
 * 位置天然不在字面量面上；源码注释、单测文件（tests/）、vendor、dist、node_modules 豁免
 * （沿内核口径：注释属内部台账面，tests 属测试底座）。
 *
 * pattern＝内核精确闭集沿 harness 词表微调：带圈数字批次号／阿拉伯批次号／指令·决议·
 * 报告·交接件名／内部台账区引用（docs/_owner）。业务语义「批次号/每批/批量」不命中。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..");

const NARRATIVE_PATTERN = new RegExp(
  // 带圈数字批次号全四区段（批㊶＝㊱-㊿ 区；批㉕B＝㉑-㉟ 区；批⑳＝①-⑳ 区；㊀-㊿ 区兜底）
  "批[①-⑳㉑-㉟㊱-㊿㊀-㊿]"
  + "|批[0-9]+[A-Z]?" // 阿拉伯批次号（批35/批35K）
  + "|ATF_指令|ATF_决议|执行报告|会话交接" // 指令/决议/报告/交接件名
  + "|docs/_owner", // 内部台账区引用
);

/** 产品运行件根族（相对 repo；注释豁免由 AST 字面量扫描天然承载，目录面零豁免）。 */
const SCAN_ROOTS = [
  "src",
  "packages/extensions/atf-ui/src",
  "packages/extensions/atf-ui/client.js",
  "packages/extensions/atf-tools/src",
  "webui",
];

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "__pycache__", "fixtures"]);
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs"]);

/** 收集一个扫描根下的全部源码文件（目录递归；单文件根原样）。 */
function collectFiles(root: string): string[] {
  const abs = join(repo, root);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(name)) continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) { walk(p); continue; }
      if (!SOURCE_EXTS.has(name.slice(name.lastIndexOf(".")))) continue;
      out.push(p);
    }
  };
  walk(abs);
  return out;
}

/** 例外面：产品面无叙事但语义确需的点名豁免（逐条留痕——新增须报告登记）。 */
const LITERAL_ALLOWLIST: ReadonlyArray<{ file: string; text: string }> = [];

interface LiteralHit { file: string; line: number; text: string }

/**
 * 字符串字面量扫描器（确定性状态机——TS7 无完整解析 API，自备轻扫）。
 * 状态＝code／行注释／块注释／单引号／双引号／模板串／正则／插值体；两轴记账：
 * tdepth＝开着的模板串数（收口 backtick——tdepth 减到 0 回 code，否则回插值体）；
 * bstack＝插值链根记号（`${` 压 "t"）＋插值体内花括号记号（`{` 压 "b"）——`}` 弹栈
 * 弹到 "t" 即回模板串。字符串/注释/正则收口＝bstack 非空回插值体、否则回 code。
 * 正则字面量按「前一非空 code 字符 ∈ { ( , = : [ ! & | ? ; +- * % ~ ^ >」启发式进入
 * 并整体跳过（除法场景——前字符为标识符/数字/`)`/`]`——不误入）。注释天然不在
 * 字符串态＝豁免（沿内核口径：注释属内部台账面）。
 * @param text - 源码全文。
 * @returns 字符串内容片段及其 1-based 起始行。
 */
function scanStringLiterals(text: string): Array<{ startLine: number; content: string }> {
  type State = "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "regex" | "interp";
  const out: Array<{ startLine: number; content: string }> = [];
  let state: State = "code";
  let line = 1;
  let litStartLine = 1;
  let tdepth = 0; // 开着的模板串数
  const bstack: Array<"t" | "b"> = []; // 插值链：根记号 "t"（${ 所挂模板）与花括号记号 "b"
  let prevCode = ""; // 前一非空白 code 态字符（正则启发式）
  const pieces: string[] = [];
  let cur = "";
  const pushLit = (): void => {
    if (cur !== "") pieces.push(cur);
    if (pieces.length > 0) out.push({ startLine: litStartLine, content: pieces.join("\n") });
    pieces.length = 0;
    cur = "";
  };
  const afterCodeUnit = (): State => (bstack.length > 0 ? "interp" : "code");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "\n") line++;
    switch (state) {
      case "code":
      case "interp":
        if (ch === "/" && next === "/") { state = "line-comment"; i++; continue; }
        if (ch === "/" && next === "*") { state = "block-comment"; i++; continue; }
        if (ch === "'" || ch === '"' || ch === "`") {
          state = ch === "'" ? "single" : ch === '"' ? "double" : "template";
          if (state === "template") tdepth++;
          litStartLine = line;
          cur = "";
          continue;
        }
        if (ch === "/" && "([,=:[!&|?;+-*%~^>{} ".includes(prevCode)) { state = "regex"; continue; }
        if (state === "interp") {
          if (ch === "{") bstack.push("b");
          if (ch === "}") {
            const top = bstack.pop();
            if (top === "t") { state = "template"; cur = ""; prevCode = ""; continue; } // 插值收口——回宿主模板串
          }
        }
        if (!/\s/.test(ch)) prevCode = ch;
        continue;
      case "line-comment":
        if (ch === "\n") state = afterCodeUnit();
        continue;
      case "block-comment":
        if (ch === "*" && next === "/") { state = afterCodeUnit(); i++; }
        continue;
      case "single":
        if (ch === "\\") { i++; const esc1 = text[i] ?? ""; cur += esc1 === "\n" ? "" : esc1; continue; }
        if (ch === "'" || ch === "\n") { state = afterCodeUnit(); pushLit(); continue; }
        cur += ch;
        continue;
      case "double":
        if (ch === "\\") { i++; const esc2 = text[i] ?? ""; cur += esc2 === "\n" ? "" : esc2; continue; }
        if (ch === '"' || ch === "\n") { state = afterCodeUnit(); pushLit(); continue; }
        cur += ch;
        continue;
      case "template":
        if (ch === "\\") { i++; const esc3 = text[i] ?? ""; cur += esc3 === "\n" ? "" : esc3; continue; }
        if (ch === "`") {
          tdepth--;
          state = afterCodeUnit();
          pushLit();
          continue;
        }
        if (ch === "$" && next === "{") {
          state = "interp";
          bstack.push("t");
          pushLit();
          i++;
          continue;
        }
        cur += ch;
        continue;
      case "regex":
        if (ch === "\\") { i++; continue; }
        if (ch === "[") { // 字符类整体跳过（/ 可能出现在类内）
          i++;
          while (i < text.length && text[i] !== "]") { if (text[i] === "\\") i++; i++; }
          continue;
        }
        if (ch === "/") { state = afterCodeUnit(); prevCode = "/"; } // 正则收尾
        continue;
    }
  }
  return out;
}

/** 字符串字面量命中提取（.d.ts 声明面跳过；注释态经扫描器天然豁免）。 */
function literalHitsOfFile(file: string): LiteralHit[] {
  if (file.endsWith(".d.ts")) return [];
  const text = readFileSync(file, "utf8");
  const rel = file.slice(repo.length + 1);
  const hits: LiteralHit[] = [];
  for (const lit of scanStringLiterals(text)) {
    const lines = lit.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? "";
      if (NARRATIVE_PATTERN.test(ln)) {
        hits.push({ file: rel, line: lit.startLine + i, text: ln.trim().slice(0, 140) });
      }
    }
  }
  return hits.filter((hit) => !LITERAL_ALLOWLIST.some((w) => w.file === hit.file && hit.text.includes(w.text)));
}

describe("批㊶-NARR 叙事卫生护栏（产品运行件字符串字面量零开发叙事——用户可见面零开发叙事）", () => {
  it("守护面有效性：扫描根均在位且源码文件集非空（防空转）", () => {
    const all = SCAN_ROOTS.flatMap((root) => collectFiles(root));
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((f) => f.endsWith("atf-ui/client.js"))).toBe(true);
    expect(all.some((f) => f.includes("atf-tools/src"))).toBe(true);
    expect(all.some((f) => f.includes("workspaceTools"))).toBe(true);
  });

  it("产品运行件字符串字面量零开发叙事（红名单＝0——T1 清理后全仓绿为验收锚）", () => {
    const all = SCAN_ROOTS.flatMap((root) => collectFiles(root));
    const hits = all.flatMap((file) => literalHitsOfFile(file));
    expect(hits).toEqual([]);
  });
});
