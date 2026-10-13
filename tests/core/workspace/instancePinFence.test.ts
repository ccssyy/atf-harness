/**
 * 批㊶-ISO-2 S1 fence 锚——生产面 pin 路径裸写清零（沿 ISO 批 tmux fence 先例的防回潮规则）。
 *
 * `.atf-pinned` 路径字面量全仓生产面（src/＋packages 扩展源码）唯一合法落点＝单源模块
 * src/core/workspace/instancePin.ts（LEGACY_PIN_ROOT_RELPATH）；其余任何生产文件出现该
 * 字面量即红——pin 路径一律经 resolveInstancePinRoot／resolveInstanceKernelDir（实例
 * pin 根 env 注入后自动切换，无需逐点改码）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTANCE_PIN_ROOT_ENV,
  LEGACY_PIN_ROOT_RELPATH,
  resolveInstanceKernelDir,
  resolveInstancePinRoot,
} from "../../../src/core/workspace/instancePin.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SINGLE_SOURCE = join(repoRoot, "src", "core", "workspace", "instancePin.ts");
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

describe("批㊶-ISO-2 S1 fence 锚——生产面 pin 路径裸写清零", () => {
  it("生产面 .atf-pinned 字面量唯一落点＝instancePin.ts 单源（其余零残留）", () => {
    const files = [...walkTsFiles(join(repoRoot, "src")), ...walkTsFiles(join(repoRoot, "packages"))];
    expect(files.length).toBeGreaterThan(50); // 扫描面自证非空
    expect(files).toContain(SINGLE_SOURCE); // 单源在扫描域内（防挪位漂移）
    const violations: string[] = [];
    for (const file of files) {
      if (file === SINGLE_SOURCE) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes(LEGACY_PIN_ROOT_RELPATH)) violations.push(relative(repoRoot, file));
    }
    expect(violations).toEqual([]);
  });

  it("单源接线自证：env 名/回退名/消费链导出在位", () => {
    expect(INSTANCE_PIN_ROOT_ENV).toBe("ATF_INSTANCE_PIN_ROOT");
    expect(LEGACY_PIN_ROOT_RELPATH).toBe(".atf-pinned");
    expect(resolveInstancePinRoot({}, "/repo").source).toBe("fallback");
    expect(resolveInstanceKernelDir({}, "/repo")).toContain(".atf-pinned");
  });
});
