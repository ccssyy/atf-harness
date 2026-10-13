/**
 * 批㊶-ISO E2.2——禁默认 socket 结构锚（防回潮规则，取代批㊶-W 时代逐用例 guard）。
 *
 * 20261011/20261012 两次同型误杀事故（测试缺 guard kill-session 误杀真训）的结构收口：
 *  ① tests/ 内任何 tmux 命令字符串必须携带独立测试 socket（`-L`，D2① fixture 轴）——
 *     含 tmux 操作的测试对默认 socket 零触碰成为结构性规则，不再依赖逐用例自觉；
 *  ② 生产面（src/＋packages 源码）零裸 tmux 命令字符串——一律经 tmuxLiveness tmuxCommand
 *     单源构造（会话命名域＋测试 socket 注入点同源）；
 *  ③ fixture 接线自证（vitest setupFiles 注册＋本进程 env 在位——防静默脱钩）。
 *
 * 扫描形态：字符串/模板字面量内 `tmux <子命令>`（has-session/kill-session/new-session/
 * list-* 等闭集）——合规形态 `tmux -L <sock> …` 不入匹配；中文叙述文本（如「tmux 会话消失」）
 * 非命令形态零误报。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TMUX_TEST_SOCKET_ENV } from "../../../src/core/workspace/tmuxLiveness.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

// tmux 子命令闭集（命令形态判据——`tmux ` 后紧跟子命令方视为命令字符串）
const TMUX_SUBCOMMANDS = [
  "has-session", "kill-session", "new-session", "list-sessions", "list-panes",
  "kill-server", "start-server", "send-keys", "capture-pane", "rename-session",
  "attach-session", "detach-session", "display-message", "set-option", "show-options", "source-file",
].join("|");
// 引号紧邻 tmux＋子命令＝命令字符串字面量（模板/单/双引号三形态）
const CMD_LITERAL_RE = new RegExp(`(["'` + "`" + `])tmux\\s+(${TMUX_SUBCOMMANDS})\\b[^"'` + "`" + `]*\\1`, "g");

const SKIP_DIRS = new Set(["node_modules", "dist", "lib", ".git"]);

function walkTsFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTsFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

/** 单文件违规面：命令形态字面量中未携带测试 socket（-L）者。 */
const violationsIn = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of text.matchAll(CMD_LITERAL_RE)) {
    const literal = m[0];
    if (literal.includes("-L")) continue;
    found.push(literal.replace(/\s+/g, " ").slice(0, 120));
  }
  return found;
};

describe("批㊶-ISO E2.2 结构锚——禁默认 socket（防回潮规则）", () => {
  it("fixture 接线自证：vitest setupFiles 注册测试 socket fixture＋本进程 env 在位", () => {
    const cfg = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(cfg).toContain("tests/fixtures/tmuxTestSocket.ts");
    expect(process.env[TMUX_TEST_SOCKET_ENV] ?? "").toMatch(/^atf-test-/);
  });

  it("tests/ 全部 tmux 命令字符串携带测试 socket（-L）——零默认 socket 调用", () => {
    const files = walkTsFiles(join(repoRoot, "tests"));
    expect(files.length).toBeGreaterThan(50); // 扫描面自证非空（全量测试文件在扫）
    const violations: string[] = [];
    for (const file of files) {
      for (const literal of violationsIn(file)) violations.push(`${relative(repoRoot, file)}：${literal}`);
    }
    expect(violations).toEqual([]);
  });

  it("生产面零裸 tmux 命令字符串——一律经 tmuxLiveness tmuxCommand 单源构造", () => {
    const files = [...walkTsFiles(join(repoRoot, "src")), ...walkTsFiles(join(repoRoot, "packages"))];
    expect(files.length).toBeGreaterThan(50); // 扫描面自证非空
    const violations: string[] = [];
    for (const file of files) {
      for (const literal of violationsIn(file)) violations.push(`${relative(repoRoot, file)}：${literal}`);
    }
    expect(violations).toEqual([]);
  });
});
