/**
 * 批㊶-ISO D2①——tmux 测试 socket 全局 fixture（vitest setupFiles，逐测试文件生效）。
 *
 * 20261011/20261012 两次同型误杀事故的结构收口：含 tmux 操作的测试一律在本文件
 * 建立的独立测试 socket（`tmux -L atf-test-<runid>`）上进行，用毕销毁——对默认 socket
 * （生产 dev/UAT/同事手工会话）零触碰，逐用例 guard 升级为结构性规则。
 *
 * 双轴隔离（同 runid 派生）：
 *  - socket 轴：ATF_TMUX_TEST_SOCKET=atf-test-<runid>（生产面 tmuxCommand 单源读取，
 *    仅认 atf-test-* 值——测试命令带 `-L`）；
 *  - 命名域轴：ATF_TMUX_SESSION_PREFIX=atf-test-<runid>-（生产面 resolveSessionName
 *    单源读取——会话名前缀化，跨文件/跨进程/对生产全不可见）。
 *
 * runid 含 pid＋随机段——vitest 每测试文件独立模块注册表，本模块每文件实例化一次，
 * 并行 worker 互不冲突；afterAll kill-server（无服务端＝no-op）。
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterAll } from "vitest";

const runid = `${process.pid.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const socketName = `atf-test-${runid}`;

process.env["ATF_TMUX_TEST_SOCKET"] = socketName;
process.env["ATF_TMUX_SESSION_PREFIX"] = `${socketName}-`;

afterAll(() => {
  try { execSync(`tmux -L ${socketName} kill-server 2>/dev/null`); } catch { /* 无服务端＝已净 */ }
  // 真机实锚（批㊶-ISO 执行期）：kill-server 与服务端退出存在竞态时 socket 文件可残留——
  // unlink 兜底（死 socket 文件无害但不留痕；live 服务端不受影响——kill-server 已先行）
  try { unlinkSync(`${process.env["TMUX_TMPDIR"] ?? `/tmp/tmux-${process.getuid?.() ?? 0}`}/${socketName}`); } catch { /* 无残留＝已净 */ }
});

/** 本文件的测试 socket 名（`tmux -L` 值——测试直调 tmux 一律经 tmuxTest/tmuxTestOk 拼装）。 */
export const tmuxTestSocketName = (): string => socketName;

/** 本文件的会话命名域前缀（socket 名＋'-'——生产 resolveSessionName 消费同一 env）。 */
export const tmuxTestSessionPrefix = (): string => `${socketName}-`;

/** 测试 socket 上的 tmux 调用（失败即抛——建会话/收尾等预期成功的步骤用）。 */
export const tmuxTest = (args: string): string =>
  execSync(`tmux -L ${socketName} ${args}`, { encoding: "utf8" }) as string;

/** 测试 socket 上的 tmux 探测（退出码布尔化——has-session/kill-session 等允许失败的步骤用）。 */
export const tmuxTestOk = (args: string): boolean => {
  try {
    execSync(`tmux -L ${socketName} ${args}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
