/**
 * 用户可见面零开发叙事守护（批㊶-J；owner 升格产品原则）。
 *
 * 凡是用户/同事在产品里能看到的文字——工具 description、错误回流 message、
 * 卡面 label——不得出现批次号（批㊶/批35 等）、指令件名（ATF_指令/ATF_执行报告/
 * ATF_会话交接）、内部台账区引用（docs/_owner）、内部工程代号（\bP\d{1,2}\b）。
 * 这类内容只活在内部台账（docs/_owner/ 与 memory），不进产品可见面。
 * 扫描面＝src 全部 .ts；代码注释（行注释与块注释）不在用户可见面，剔除后扫描——
 * 守住"用户可见字符串零命中"状态（批㊶-J 段 0 grep 实证零命中，本测试防回潮）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const NARRATIVE_PATTERN =
  /批[㊀-㊿]|批[0-9]+[A-Z]?|ATF_指令|ATF_执行报告|ATF_会话交接|docs\/_owner|\bP[0-9]{1,2}\b/;

/** 收集 src/ 全部 .ts 文件（稳定排序）。 */
function collectTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "__pycache__") continue;
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.startsWith("smoke")) {
        // smoke*.ts 冒烟脚本＝开发态工具（文件名自带阶段代号，输出进 dev 终端），
        // 不属产品运行时用户可见面——豁免；生产面（工具 description/message/label）全扫。
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** 剔除行注释（//…）与块注释（/* … *\/）后剩余的"用户可见文本"。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("用户可见面零开发叙事（批㊶-J 防回潮）", () => {
  const files = collectTsFiles(SRC_ROOT);

  it("扫描面非空（守护有效性）", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file.replace(REPO_ROOT + "/", "")} 用户可见字符串无开发叙事`, () => {
      const text = stripComments(readFileSync(file, "utf8"));
      const hits: string[] = [];
      for (const [i, line] of text.split("\n").entries()) {
        const m = NARRATIVE_PATTERN.exec(line);
        if (m !== null) hits.push(`L${i + 1} [${m[0]}]: ${line.trim().slice(0, 110)}`);
      }
      expect(hits, hits.slice(0, 10).join("\n")).toEqual([]);
    });
  }
});
