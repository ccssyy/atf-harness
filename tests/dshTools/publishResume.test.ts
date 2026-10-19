/**
 * 批E4 测试锚——atf_publish_model 发布拷贝断点续传。
 *
 * 五锚（指令 §三）：①全量首跑 copied=total；②模拟中断（前 N 文件在位）重跑
 * reused=N 只补余、终态 manifest 与全量首跑逐文件一致（file/sha256/bytes/序——
 * published_at/resumed/status 为续传固有差异）；③源文件变更→重拷＋changed 计数；
 * ④目标损坏→重拷复原；⑤拷贝后校验失败（注入坏 copyFile）→publish_copy_verify_failed
 * 且（工具面）manifest 不写。另锚：真实 IO 中断（chmod 000）→publish_copy_interrupted
 * ＋已拷保留＋manifest 不写。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublishModelTool, publishCopyWithResume } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { createHash } from "node:crypto";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "e4-resume-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realSha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 造源 checkpoint（6 文件：5 平＋1 嵌套——嵌套路径兼验父目录自动创建）。 */
const seedSource = (root: string): { ckptDir: string; names: string[] } => {
  const ckptDir = join(root, "src-ckpt");
  mkdirSync(ckptDir, { recursive: true });
  const names = ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin", "nested/deep.bin"];
  for (const [i, name] of names.entries()) {
    mkdirSync(join(ckptDir, name, ".."), { recursive: true });
    writeFileSync(join(ckptDir, name), `payload-${i}-${"x".repeat(64)}`);
  }
  return { ckptDir, names };
};

describe("批E4——发布拷贝断点续传（publishCopyWithResume 纯函数＋工具面）", () => {
  it("①全量首跑：copied=total、reused=0；manifest 每文件 status=copied、resumed=false", () => {
    const root = tempRoot();
    const { ckptDir } = seedSource(root);
    const destDir = join(root, "pub", "run-e4", "checkpoint-30");
    const out = publishCopyWithResume(ckptDir, destDir);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.total).toBe(6);
      expect(out.copied).toBe(6);
      expect(out.reused).toBe(0);
      expect(out.changed_re_copied).toBe(0);
      expect(out.bytes_copied).toBe(out.bytes_total);
      expect(out.files.every((f) => f.status === "copied")).toBe(true);
      expect(existsSync(join(destDir, "nested", "deep.bin"))).toBe(true);
    }
  });

  it("②模拟中断续传：注入第 6 文件抛错→interrupted（已拷 5 保留）→重跑 reused=5 只补 1；终态 manifest 与全量首跑逐文件一致（file/sha256/bytes/序）", () => {
    const root = tempRoot();
    const { ckptDir } = seedSource(root);
    const destDir = join(root, "pub", "run-e4", "checkpoint-30");
    let n = 0;
    const interrupted = publishCopyWithResume(ckptDir, destDir, {
      copyFile: (src, dest) => {
        n += 1;
        if (n > 5) throw new Error("模拟中断：磁盘占位");
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      },
    });
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) {
      expect(interrupted.error).toBe("publish_copy_interrupted");
      expect(interrupted.copied).toBe(5);
      expect(interrupted.total).toBe(6);
    }
    // 已拷 5 保留（中断不清场）
    expect(existsSync(join(destDir, "a.bin"))).toBe(true);
    expect(existsSync(join(destDir, "nested", "deep.bin"))).toBe(false);
    // 重跑（真实 fs）：reused=5、只补 1
    const resumed = publishCopyWithResume(ckptDir, destDir);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.reused).toBe(5);
      expect(resumed.copied).toBe(1);
      // 与全量首跑逐文件对账（file/sha256/bytes/序——status/resumed 为续传固有差异）
      const fresh = publishCopyWithResume(ckptDir, join(root, "pub-fresh", "checkpoint-30"));
      expect(fresh.ok).toBe(true);
      if (fresh.ok) {
        expect(resumed.files.map((f) => [f.file, f.sha256, f.bytes])).toEqual(fresh.files.map((f) => [f.file, f.sha256, f.bytes]));
        // 序＝路径排序（a..e 前 5＝中断期已拷→reused；nested/deep.bin＝重跑补齐→copied）
        expect(resumed.files.map((f) => f.status)).toEqual(["reused", "reused", "reused", "reused", "reused", "copied"]);
      }
    }
  });

  it("③源文件中途变更：目标旧 sha 在场→重拷＋changed_re_copied=1＋status=copied＋新 sha 在册", () => {
    const root = tempRoot();
    const { ckptDir } = seedSource(root);
    const destDir = join(root, "pub");
    expect(publishCopyWithResume(ckptDir, destDir).ok).toBe(true);
    writeFileSync(join(ckptDir, "c.bin"), "changed-content-after-first-publish");
    const out = publishCopyWithResume(ckptDir, destDir);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.changed_re_copied).toBe(1);
      expect(out.copied).toBe(1);
      expect(out.reused).toBe(5);
      const c = out.files.find((f) => f.file === "c.bin");
      expect(c?.status).toBe("copied");
      expect(c?.sha256).toBe(realSha(join(ckptDir, "c.bin")));
    }
  });

  it("④目标损坏（sha 不匹配）：重拷复原至源 sha", () => {
    const root = tempRoot();
    const { ckptDir } = seedSource(root);
    const destDir = join(root, "pub");
    expect(publishCopyWithResume(ckptDir, destDir).ok).toBe(true);
    writeFileSync(join(destDir, "b.bin"), "corrupted bytes");
    const out = publishCopyWithResume(ckptDir, destDir);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.changed_re_copied).toBe(1);
      expect(realSha(join(destDir, "b.bin"))).toBe(realSha(join(ckptDir, "b.bin")));
    }
  });

  it("⑤拷贝后校验失败（注入写坏 copyFile）→publish_copy_verify_failed 且不写 manifest（工具面零 manifest）", async () => {
    const root = tempRoot();
    const { ckptDir } = seedSource(root);
    const destDir = join(root, "pub");
    const out = publishCopyWithResume(ckptDir, destDir, {
      copyFile: (src, dest) => {
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, `${readFileSync(src)}-but-corrupted`); // 写坏：copy 后目标 sha ≠ 源
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe("publish_copy_verify_failed");
      expect(out.file).toBe("a.bin");
      expect(out.copied).toBe(0);
    }
    // 工具面：真实 IO 中断（目标位预置同名目录→copyFileSync EISDIR 中途失败）
    // →publish_copy_interrupted＋已拷保留＋manifest 不写（root 运行 chmod 不阻读，故用目录占位形态）
    const runRoot = tempRoot();
    const runDir = join(runRoot, "run-int");
    const ckpt = join(runDir, "training", "checkpoint-30");
    mkdirSync(ckpt, { recursive: true });
    for (const name of ["f1.bin", "f2.bin", "f3.bin"]) writeFileSync(join(ckpt, name), `payload-${name}`);
    const orch = join(runDir, "eval", "1-20261019", "orch", "eval");
    mkdirSync(orch, { recursive: true });
    for (const f of ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]) writeFileSync(join(orch, f), "{}");
    const pubDir = join(runRoot, "pub", "run-int", "checkpoint-30");
    mkdirSync(join(pubDir, "f3.bin"), { recursive: true }); // 第三文件目标位被目录占位
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const tool = buildPublishModelTool(ctx, { runsRoot: runRoot }) as unknown as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const res = await tool.execute({ run_id: "run-int", checkpoint: "checkpoint-30", publish_root: join(runRoot, "pub") }, { callId: "t" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("publish_copy_interrupted");
    expect(res.copied).toBe(2);
    expect(res.total).toBe(3);
    expect(existsSync(join(pubDir, "f1.bin"))).toBe(true); // 已拷保留
    expect(existsSync(join(pubDir, "publish-manifest.json"))).toBe(false); // 半截清单不得为权威
  });
});
