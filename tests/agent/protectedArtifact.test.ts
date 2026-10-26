/**
 * A6 测试锚——受保护产物 denylist（指令件 dbedc099 §四）：
 * 写审计产物拒（protected_artifact_write，mtime/内容不变）／段摘要与事实轨拒／普通文件放行回归／
 * 读放行／符号链接 realpath 实锚拒／账本白名单内也拒／edit 同闸闭合。
 * 真实会话验收（agent 改 segments 被拒＋管线写不受影响）随批执行报告，不入本锚。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOL_HANDLERS,
  PROTECTED_ARTIFACT_WRITE,
  isProtectedArtifactPath,
} from "../../src/agent/fileTools.js";
import type { FileToolHost } from "../../src/agent/fileTools.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "a6-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRun = (): { root: string; runDir: string; segments: string } => {
  const root = tempRoot();
  const runDir = join(root, "ws", "runs", "r1");
  mkdirSync(join(runDir, "webui"), { recursive: true });
  mkdirSync(join(runDir, "facts"), { recursive: true });
  const segments = join(runDir, "webui", "segments.json");
  writeFileSync(segments, '[{"segment":"register"}]');
  return { root, runDir, segments };
};

const hostOf = (root: string, ledger?: string): FileToolHost => ({
  roots: [join(root, "ws")],
  env: ledger !== undefined ? { ATF_APPROVAL_LEDGER: ledger } : undefined,
});

describe("A6——受保护产物 denylist（atf_write 白名单后第二道）", () => {
  it("写 segments.json → 拒 protected_artifact_write＋指路；文件内容零变（mtime 语义＝零写入）", async () => {
    const { root, segments } = makeRun();
    const before = readFileSync(segments, "utf8");
    const r = await FILE_TOOL_HANDLERS["atf_write"]!(
      { path: segments, content: '[{"segment":"register"},{"segment":"label_qc"}]' },
      hostOf(root),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.reason).toBe(PROTECTED_ARTIFACT_WRITE);
    expect(r.error.message).toContain("请勿直接改写");
    // 错误文案零内部代号——先剥离文件路径再判定：临时目录随机名可能恰含 `K1`／`批㊶`
    // 一类字样（真机路径同样可能），那不是代号泄漏，误判会随随机种子飘。
    expect(r.error.message.split(segments).join("<path>")).not.toMatch(/K\d|批[㊶①-⑳A-Z]/);
    expect(readFileSync(segments, "utf8")).toBe(before); // 内容零变（零写入）
  });

  it("写 stage-register.summary.json 与 facts/owner.jsonl → 拒（.md 同形态）", async () => {
    const { root, runDir } = makeRun();
    for (const rel of ["stage-register.summary.json", "stage-register.summary.md", join("facts", "owner.jsonl")]) {
      const r = await FILE_TOOL_HANDLERS["atf_write"]!(
        { path: join(runDir, rel), content: "tampered" },
        hostOf(root),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe(PROTECTED_ARTIFACT_WRITE);
      expect(existsSync(join(runDir, rel))).toBe(false); // 零写入
    }
  });

  it("普通新文件（实验目录内其它路径）→ 放行（回归）", async () => {
    const { root, runDir } = makeRun();
    const target = join(runDir, "reports", "note.md");
    const r = await FILE_TOOL_HANDLERS["atf_write"]!(
      { path: target, content: "# 正常产物" },
      hostOf(root),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("# 正常产物");
  });

  it("读受保护文件 → 放行（read 零此闸）", async () => {
    const { root, segments } = makeRun();
    const r = await FILE_TOOL_HANDLERS["atf_read"]!({ path: segments }, hostOf(root));
    expect(r.ok).toBe(true);
    if (r.ok) expect(String((r.value as Record<string, unknown>)["content"])).toContain("register");
  });

  it("符号链接指向受保护文件 → 拒（realpath 实锚生效）", async () => {
    const { root, runDir, segments } = makeRun();
    const link = join(root, "ws", "linkdir");
    mkdirSync(link, { recursive: true });
    symlinkSync(runDir, join(link, "r1"));
    const r = await FILE_TOOL_HANDLERS["atf_write"]!(
      { path: join(link, "r1", "webui", "segments.json"), content: "via-symlink" },
      hostOf(root),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe(PROTECTED_ARTIFACT_WRITE);
    expect(readFileSync(segments, "utf8")).toBe('[{"segment":"register"}]');
  });

  it("审批账本即使落在白名单内 → 拒（env 单源；纯函数直测 realpath 形态）", async () => {
    const { root } = makeRun();
    const ledger = join(root, "ws", "ledger", "training-release.jsonl");
    mkdirSync(join(root, "ws", "ledger"), { recursive: true });
    writeFileSync(ledger, "{}\n");
    const r = await FILE_TOOL_HANDLERS["atf_write"]!({ path: ledger, content: '{"tampered":true}' }, hostOf(root, ledger));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe(PROTECTED_ARTIFACT_WRITE);
    expect(isProtectedArtifactPath(ledger, ledger)).toBe(true);
    expect(isProtectedArtifactPath(join(root, "ws", "runs", "r1", "webui", "segments.json"))).toBe(true);
    expect(isProtectedArtifactPath(join(root, "ws", "runs", "r1", "reports", "note.md"))).toBe(false);
  });

  it("edit 同闸闭合（直改既有审计件的绕过面）", async () => {
    const { root, segments } = makeRun();
    const r = await FILE_TOOL_HANDLERS["atf_edit"]!(
      { path: segments, old_string: "register", new_string: "hacked" },
      hostOf(root),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe(PROTECTED_ARTIFACT_WRITE);
    expect(readFileSync(segments, "utf8")).toBe('[{"segment":"register"}]');
  });
});
