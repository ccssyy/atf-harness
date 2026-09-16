/**
 * 三段式文案模板单测（L1b B2）：①事实→②原因→③修复 统一形态（内联/多行两形态；
 * provider 配置失败同源）。
 */
import { describe, expect, it } from "vitest";
import {
  formatThreePartInline,
  formatThreePartLines,
  providerConfigThreePart,
} from "../../src/core/index.js";

describe("三段式文案（B2）", () => {
  it("内联/多行两形态段落齐全且有序", () => {
    const error = { fact: "X 失败（fail-closed）", cause: "Y 缺失", fix: "补 Z 后重试" };
    const inline = formatThreePartInline(error);
    expect(inline).toBe("①X 失败（fail-closed） ②原因：Y 缺失 ③修复：补 Z 后重试");
    const lines = formatThreePartLines(error);
    expect(lines).toBe("①X 失败（fail-closed）\n②原因：Y 缺失\n③修复：补 Z 后重试");
  });

  it("provider 配置失败：事实/原因/修复三段同源；修复指引不含凭据值", () => {
    const threePart = providerConfigThreePart("api_key_env 指向的环境变量缺失或为空", "配置文件经 ATF_LLM_CONFIG 指定（两层清单，0600）");
    const text = formatThreePartLines(threePart);
    expect(text).toContain("①provider 配置加载失败（fail-closed）");
    expect(text).toContain("②原因：api_key_env 指向的环境变量缺失或为空");
    expect(text).toContain("③修复：检查 provider 配置");
    expect(text).toContain("不落文件");
  });
});
