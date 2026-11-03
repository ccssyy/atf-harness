/**
 * ci-bl-1103 隔离收口锚（#29 containment 落地面）。
 *
 * 现场症状（dev ci-bl-test-1103-2 重验）：会话工作区缺 field-config，agent 经
 * atf_bash 枚举 workspaces/ 父目录、atf_read 读取隔壁 ci-bl-test-1103 工作区的
 * 字段配置成功——白名单根=workspaces 父层，粒度不到会话工作区。owner 批2-4 #29
 * 裁定「白名单∩会话工作区」：会话 cwd 在白名单根内时本调用可读根收窄为该工作区。
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pathOutsideRoots, sessionRootsOf } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const execWithCwd = (cwd: string): unknown => ({
  agent: { session: { header: { cwd } } },
});

describe("会话工作区 containment（sessionRootsOf）", () => {
  it("会话 cwd 在白名单根内 → 有效根收窄为该工作区（兄弟工作区路径越界）", () => {
    const parent = mkdtempSync(join(tmpdir(), "contain-"));
    dirs.push(parent);
    const mine = join(parent, "ci-bl-test-1103-2");
    const sibling = join(parent, "ci-bl-test-1103");
    mkdirSync(mine);
    mkdirSync(sibling);
    const roots = sessionRootsOf(execWithCwd(mine), [parent]);
    expect(roots).toEqual([mine]);
    expect(pathOutsideRoots(sibling, roots)).toBe(true);
    expect(pathOutsideRoots(join(mine, "field-config", "ci-field-config.json"), roots)).toBe(false);
  });

  it("无 cwd / cwd 不在白名单内 → 原引用返回（CLI 单会话/测试现状零变更）", () => {
    const parent = mkdtempSync(join(tmpdir(), "contain-b-"));
    dirs.push(parent);
    const outside = mkdtempSync(join(tmpdir(), "contain-outside-"));
    dirs.push(outside);
    const roots1 = sessionRootsOf({ agent: { session: { header: {} } } }, [parent]);
    expect(roots1).toEqual([parent]);
    const roots2 = sessionRootsOf(execWithCwd(outside), [parent]);
    expect(roots2).toEqual([parent]);
    expect(sessionRootsOf(execWithCwd(outside), [])).toEqual([]);
  });
});
