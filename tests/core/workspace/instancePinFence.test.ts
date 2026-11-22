/**
 * G7／D9 fence 锚——生产面「pin 路径字面量」与「pin env 读取」双双清零（防回潮）。
 *
 * 沿革：原锚要求 `.atf-pinned` 字面量唯一落点＝instancePin.ts 单源，并自证「回退共享态
 * 在路」。pin 退役后判据反转：**生产面任何文件都不得再出现 pin 路径字面量或 pin env 名**
 * ——单源模块本身也不例外（它已重写为纯内核目录解析）。
 *
 * 为什么用反向断言而不是删掉整个文件：退役最怕的是悄悄回潮（某处又 readFileSync pin 树）。
 * 机检落点保留在此，判据从「唯一落点」改成「零落点」。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "lib", ".git"]);
/** 历史沿革注释豁免面：只剩说明性文字、无活引用的文件。 */
const HISTORY_ONLY = new Set([join(repoRoot, "src", "core", "workspace", "instancePin.ts")]);

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

describe("G7／D9 fence 锚——pin 概念零残留（生产面）", () => {
  const files = [...walkTsFiles(join(repoRoot, "src")), ...walkTsFiles(join(repoRoot, "packages"))];

  it("扫描面自证非空且覆盖单源模块", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join(repoRoot, "src", "core", "workspace", "instancePin.ts"));
  });

  it("pin 路径字面量（.atf-pinned）在消费面零残留", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file.includes(join("packages", "extensions", "atf-ui", "node_modules"))) continue;
      if (HISTORY_ONLY.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      if (text.includes(".atf-pinned")) violations.push(relative(repoRoot, file));
    }
    expect(violations).toEqual([]);
  });

  it("pin env 名（ATF_INSTANCE_PIN_ROOT）无活读取（仅允许出现在退役说明注释中）", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (HISTORY_ONLY.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      // 活读取形态：env[...] 或 env. 取键，或 process.env 直取
      const activeRead = /(?:env(?:ironment)?|process\.env)\s*\[\s*["'`]ATF_INSTANCE_PIN_ROOT["'`]\s*\]/;
      if (activeRead.test(text)) violations.push(relative(repoRoot, file));
    }
    expect(violations).toEqual([]);
  });

  it("单源模块不再导出 pin 专属符号（INSTANCE_PIN_ROOT_ENV／LEGACY_PIN_ROOT_RELPATH）", async () => {
    const mod = await import("../../../src/core/workspace/instancePin.js");
    expect("INSTANCE_PIN_ROOT_ENV" in mod).toBe(false);
    expect("LEGACY_PIN_ROOT_RELPATH" in mod).toBe(false);
    // 现行导出面
    expect(typeof mod.resolveKernelDir).toBe("function");
    expect(typeof mod.resolveInstanceKernelDir).toBe("function");
  });
});
