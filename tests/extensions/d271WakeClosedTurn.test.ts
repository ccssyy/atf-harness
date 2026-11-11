/** D271 eval:训练完成 watcher——轮已闭场景的 wake(1109-6 实锚:agent 训完前
结束轮次,status 轮询侧 wake 永不触发;watcher 挂 launch 生命周期,不依赖轮存活)。

- 端到端:launch 成功注册 watcher→模拟轮次关闭(无轮询)→completion.json 落盘
  →断言 followup 唤醒被触发(1109-6 RED 形态:现无 watcher 即永不触发)。
- 防御:轮次关闭+超时未完成→watcher 静默清理不唤醒(不虚报)。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCompletionWake } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("D271 训练完成 watcher（轮已闭场景 wake）", () => {
  it("完成文件落盘→followup 唤醒触发（不依赖 status 轮询）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d271-ok-"));
    dirs.push(dir);
    mkdirSync(join(dir, "training"), { recursive: true });
    const calls: unknown[] = [];
    const exec = { agent: { followup: (m: unknown) => { calls.push(m); } } };
    const stop = registerCompletionWake(dir, exec, 10, 1);
    // 模拟训练完成:completion.json 落盘(D50 锚,training/completion.json)
    writeFileSync(join(dir, "training", "completion.json"), JSON.stringify({ status: "ok" }), "utf-8");
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.stringify(calls[0]);
    expect(msg).toContain("训练已完成");
  });

  it("超时未完成→watcher 静默清理,不虚报唤醒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d271-timeout-"));
    dirs.push(dir);
    const calls: unknown[] = [];
    const exec = { agent: { followup: (m: unknown) => { calls.push(m); } } };
    const stop = registerCompletionWake(dir, exec, 10, 1); // maxMinutes=1 → 10ms 间隔下按比例换算仍远超
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(calls.length).toBe(0);
  });
});
