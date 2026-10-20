/**
 * D17§C——监控面板滚动修复锚：.atf-m-root 增 height:100%+min-height:0+overflow-y:auto+
 * overscroll-behavior:contain（D11-2 重写后 pane body 高度固定、内容超界被裁——底部 GPU6/7
 * 与日志/产物区不可达）。布局与区块顺序零改。
 * 承载形态沿 monitorEnvSpark.test.ts 定案（jsdom 全局先于 client.js 真加载；
 * 断言面＝apply() 注入的 style 元素实文——非源码 grep）。
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { JSDOM } = vendorRequire("jsdom") as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dom: any = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
{
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver;
  g.requestAnimationFrame = dom.window.requestAnimationFrame;
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame;
}

const CLIENT_PATH = join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js");

describe("D17§C——.atf-m-root 滚动修复（apply() 注入样式表实文锚）", () => {
  it("注入的 style 含 .atf-m-root 滚动四件（height:100%/min-height:0/overflow-y:auto/overscroll-behavior:contain）", () => {
    let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    dom.window.__ModuleLoader__ = { load: (def: never) => { moduleDef = def as never; } };
    // eslint-disable-next-line no-new-func -- client.js 本体真加载
    new Function("window", readFileSync(CLIENT_PATH, "utf8"))(dom.window);
    expect(moduleDef).not.toBeNull();
    const slots = {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: () => () => undefined,
    };
    moduleDef!.factory(() => undefined).apply({
      slots,
      remote: {},
      sidebarRight: undefined,
      sidebarRightTabs: { register: () => () => undefined },
      inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) => fn({ slots, remote: {} }),
      effect: (fn: () => void) => { fn(); },
    });
    const style = dom.window.document.querySelector('style[data-plugin="@atf/dsh-atf-ui"]') as HTMLStyleElement | null;
    expect(style).not.toBeNull();
    const css = style!.textContent ?? "";
    expect(css).toContain("height:100%");
    expect(css).toContain("min-height:0");
    expect(css).toContain("overflow-y:auto");
    expect(css).toContain("overscroll-behavior:contain");
    // 锚定整条规则（.atf-m-root 一处、滚动属性挂在 root 上而非他处）
    const rule = css.split(";").filter((seg) => seg.includes("atf-m-root")).map((seg) => seg.trim());
    const rootRule = css.match(/\.atf-m-root\{[^}]*\}/);
    expect(rootRule).not.toBeNull();
    expect(rootRule![0]).toContain("overflow-y:auto");
    expect(rootRule![0]).toContain("min-height:0");
    expect(rootRule![0]).toContain("height:100%");
    expect(rootRule![0]).toContain("overscroll-behavior:contain");
    expect(css.match(/\.atf-m-root\{/g)?.length).toBe(1);
  });
});
