/**
 * 批次 R · H2-1——测试隔离 guard 自检（在 D51 锚测试 tests/core/testIsolationGuard.test.ts
 * 之上补五条断言；只补测试不改规则，规则变更需 owner 批）。
 *
 * 五条断言：
 *  1. 写 /data/atf/prodtest/** 被拦：② CJS 补丁事前抛 test_isolation_violation，零落盘；
 *  2. 写 /tmp/** 放行：独立前缀 zz-h2-isolation-selfcheck-，用毕清理并断言清理干净；
 *  3. ② 管不住的写入路径（子进程 shell 重定向 / node -e 内核脚本式 / 子进程经 symlink
 *     别名 / 进程内 promises 面 / 子进程改动与删除）由 ① mtime tripwire 后验抓到——全部
 *     在 /tmp 受控保护根上验证机制本身，零触碰真实 live 树；
 *  4. 边界根逐一核验（/data/atf/instances、/root/.atf、内核仓主工作树、pin worktree）：
 *     清单在列＋写目标事前被拦＋目标零落盘；
 *  5. 收尾：本套件对全部真实 live 根 beforeAll 快照 → afterAll 复检，本套件探针路径
 *     （唯一可能落盘面）零出现＝零 live 写入/零真实 tripwire 触发（环境并发写不归因自检，
 *     详见文末 afterAll 注释）＋/tmp 自检前缀无残留。
 *
 * 红线（安全设计）：任何用例不得真实写入 LIVE_WRITE_FORBIDDEN_ROOTS。对真实 live 路径
 * 只发「② 纯字符串前缀判定必拦」的 CJS sync 写调用，且首个用例先预检补丁在场（包装函数
 * 非 [native code]）——预检不过则说明拦截面失效，后续 live 写探测将无法安全发出。
 */
import { execSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LIVE_WRITE_FORBIDDEN_ROOTS, snapshotLiveTreeForTest, verifyTreeUntouched, type LiveTreeSnapshot,
} from "../fixtures/testIsolationGuard.js";

const TMP_PREFIX = "zz-h2-isolation-selfcheck-";

// guard setupFiles 首位已在同 worker 打过 ② 补丁——CJS 模块缓存共享，此处拿到同一对象
const fsCjs = createRequire(import.meta.url)("node:fs") as Record<string, (...args: unknown[]) => unknown>;

const tempRoots: string[] = [];
const newTempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  tempRoots.push(root);
  return root;
};

// 断言 5 的 live 快照对照（与 guard 生产面同口径：全量根；缺席根＝期间新增在场即违规）
const liveBefore = new Map<string, LiveTreeSnapshot>();
beforeAll(() => {
  for (const root of LIVE_WRITE_FORBIDDEN_ROOTS) liveBefore.set(root, snapshotLiveTreeForTest(root));
});

// /tmp 自建根清理与断言 5 收尾合并在**单个** afterAll 内（vitest 对多 afterAll 按注册逆序
// 执行且单 hook 失败会跳过其余 teardown——拆开写会先断言后清理，残留逐次累积）。清理惯例
// 沿用 D51 锚测试：node rmSync 清 /tmp 下 mkdtemp 自建根。

describe("批次R H2-1——测试隔离 guard 自检", () => {
  it("预检（安全门）：② CJS 写族补丁在场——包装函数非 [native code]，否则后续 live 写探测不得发出", () => {
    expect(String(fsCjs.writeFileSync)).not.toMatch(/\[native code\]/);
    expect(String(fsCjs.appendFileSync)).not.toMatch(/\[native code\]/);
    expect(LIVE_WRITE_FORBIDDEN_ROOTS.length).toBeGreaterThan(0);
  });

  it("断言1：写 /data/atf/prodtest/** 被拦——事前抛＋零落盘（被拦＝写入根本没发生）", () => {
    const probe = "/data/atf/prodtest/zz-h2-selfcheck/should-not-exist.json";
    expect(() => fsCjs.writeFileSync(probe, "x", "utf8")).toThrow(/test_isolation_violation: .*writeFileSync/);
    expect(() => fsCjs.appendFileSync(probe, "x", "utf8")).toThrow(/test_isolation_violation: .*appendFileSync/);
    expect(existsSync(probe), "被拦＝没落盘").toBe(false);
  });

  it("断言2：写 /tmp/** 放行——独立前缀＋用毕清理干净", () => {
    const root = newTempRoot();
    const target = join(root, "allowed.tmp");
    expect(() => fsCjs.writeFileSync(target, "ok", "utf8"), "/tmp 零误伤").not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("ok");
    writeFileSync(join(root, "esm-import-face.tmp"), "ok", "utf8"); // ESM 具名 import 面同样畅通
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root), "临时根应清理干净").toBe(false);
  });

  it("断言3：② 管不住的写入路径由 ① mtime tripwire 后验抓到（受控保护根——子进程/promises/别名）", async () => {
    // 受控保护根结构：outer/{protected/, alias -> protected}（全部在 /tmp 下）
    const outer = newTempRoot();
    const protectedRoot = join(outer, "protected");
    mkdirSync(protectedRoot);
    symlinkSync(protectedRoot, join(outer, "alias"));
    writeFileSync(join(protectedRoot, "seed-a.json"), "{\"v\":1}", "utf8");
    writeFileSync(join(protectedRoot, "seed-b.json"), "{\"v\":1}", "utf8");
    const before = snapshotLiveTreeForTest(protectedRoot);

    // (a) 子进程·shell 重定向写入——父进程 ② 补丁对子进程无效
    execSync(`printf x > '${join(protectedRoot, "shell-write.json")}'`);
    // (b) 子进程·node 脚本写入（内核脚本式）
    execSync(`node -e 'require("node:fs").writeFileSync(${JSON.stringify(join(protectedRoot, "child-write.json"))}, "x")'`);
    // (c) 子进程·经 symlink 别名路径写入——② 是纯字符串前缀判定，别名路径不在拦截面内
    execSync(`printf x > '${join(outer, "alias", "via-alias.json")}'`);
    // (d) 进程内 promises 面——② 只包 sync 写族，promises 不在拦截面内（写入真实发生，由 ① 兜底）
    await fsp.writeFile(join(protectedRoot, "promises-write.json"), "x", "utf8");
    // (e) 子进程改动已有文件（mtime 变化被抓）
    execSync(`printf y >> '${join(protectedRoot, "seed-a.json")}'`);
    // (f) 子进程删除已有文件（在场性变化被抓；rm 单文件于受控根内，非 rm -rf）
    execSync(`rm '${join(protectedRoot, "seed-b.json")}'`);

    const violations = verifyTreeUntouched(protectedRoot, before);
    for (const needle of ["shell-write.json", "child-write.json", "via-alias.json", "promises-write.json"]) {
      expect(violations.some((v) => v.includes(needle) && v.includes("新增写入")), `tripwire 应点名新增: ${needle}`).toBe(true);
    }
    expect(violations.some((v) => v.includes("seed-a.json") && v.includes("被改动")), "tripwire 应点名 mtime 改动").toBe(true);
    expect(violations.some((v) => v.includes("seed-b.json") && v.includes("被删除/移走")), "tripwire 应点名删除").toBe(true);
    // 漏面固化（仅受控根证据，不改规则）：promises 面确实绕过 ② 事前拦截——落盘已发生
    expect(existsSync(join(protectedRoot, "promises-write.json")), "promises 面不受 ② 事前拦（由 ① 兜底）").toBe(true);
  });

  it("断言4：边界根逐一——清单在列＋写目标被拦＋零落盘", () => {
    const BOUNDARY_ROOTS = [
      "/data/atf/instances",
      "/root/.atf",
      "/data/sam/AgenticTrainingFlow",
      "/data/sam/ATF-Harness/.atf-pinned",
    ] as const;
    for (const root of BOUNDARY_ROOTS) {
      expect(LIVE_WRITE_FORBIDDEN_ROOTS, `live 清单应含边界根: ${root}`).toContain(root);
      const probe = join(root, "zz-h2-selfcheck-should-not-exist.json");
      expect(() => fsCjs.writeFileSync(probe, "x", "utf8"), `写 ${root} 应被事前拦`).toThrow(/test_isolation_violation: .*writeFileSync/);
      expect(existsSync(probe), `被拦＝没落盘: ${probe}`).toBe(false);
    }
  });
});

// 断言 5：收尾断言——与 /tmp 清理同一 afterAll，先清临时根再验残留。
// 归因边界：机器上 atf-ui dev 服务周期性（实测 ~7s）重写 /data/atf/dev/runs/atf-ui/** 与
// /data/atf/datasets/atf-walkthrough/ws-walkthrough-pipeline/runs/atf-ui/**——① 层零漏报
// 但 mtime 证据无法归因写入者，全根判空会把环境并发写误记到自检头上。本套件全部代码中
// 唯一可能触达 live 的是探针写（且断言 1/4 已证被事前拦＝零落盘），故收尾强断言取
// 「探针路径在全部 live 根复检中零出现」＝本套件零 live 写入/零真实 tripwire 触发；
// 其余违规属环境并发写，只打印供 owner 审，不做失败断言（漏面细节见批次 R 回报）。
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  const liveViolations = [...liveBefore].flatMap(([root, snap]) =>
    verifyTreeUntouched(root, snap).map((v) => `${root}: ${v}`));
  const probeViolations = liveViolations.filter((v) => v.includes("zz-h2-selfcheck"));
  expect(probeViolations, "自检套件探针路径不得出现在任何 live 根（零 live 写入/零真实 tripwire 触发）").toEqual([]);
  const envNoise = liveViolations.filter((v) => !v.includes("zz-h2-selfcheck"));
  if (envNoise.length > 0) {
    console.error(`[h2-selfcheck] live 根窗口内检出非本套件写入（环境并发写——探针零出现，供 owner 审）×${String(envNoise.length)}：\n  ${envNoise.slice(0, 20).join("\n  ")}`);
  }
  const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));
  expect(leftovers, "自检临时根应全部清理").toEqual([]);
});
