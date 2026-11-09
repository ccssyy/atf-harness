/**
 * 批㊶-ISO D2① tmux 测试隔离 fixture(vitest setupFiles,逐测试文件生效)——
 * D239 缓解版:隔离轴从 socket(-L 独立 server)迁到**命名域**(主 server 前缀会话)。
 *
 * 背景与边界:
 *  - 20261011/12 误杀事故的结构保证不变:测试对生产会话零触碰;
 *  - D239(台账):dev 容器对新 tmux server fork 恒「lost server」(2026-10-28 后),
 *    主 server(默认 socket,atf-dsh 实例)常活——隔离改靠唯一前缀会话名实现;
 *  - 清理=按前缀逐会话 kill-session,**禁 kill-server**(主 server 承载生产会话)。
 *
 * 双 env 语义(ATF_TMUX_TEST_SOCKET 保留为测试态标记,不再映射 -L):
 *  - ATF_TMUX_SESSION_PREFIX=atf-test-<runid>-:会话命名域(生产面 resolveSessionName
 *    单源消费——会话名前缀化,跨文件/跨进程/对生产全不可见);
 *  - runid 含 pid+随机段——vitest 每测试文件独立模块注册表,并行 worker 不冲突。
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";

const runid = `${process.pid.toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const socketName = `atf-test-${runid}`;

process.env["ATF_TMUX_TEST_SOCKET"] = socketName;
process.env["ATF_TMUX_SESSION_PREFIX"] = `${socketName}-`;

/** 按前缀逐会话清理(命名域轴收尾——禁 kill-server,主 server 承载生产会话;
 *  导出供直调域测试(atfUi D73 等)复用同款收尾)。 */
export const killPrefixedSessions = (prefix: string = `${socketName}-`): void => {
  let names: string[] = [];
  try {
    names = execSync("tmux list-sessions -F \"#{session_name}\"", { encoding: "utf8" }) // # 须引号包裹:裸 # 词首被 shell 当注释致 -F 空值
      .split("\n")
      .filter((name) => name.startsWith(prefix));
  } catch {
    return; /* 无 server/无会话=已净 */
  }
  for (const name of names) {
    try { execSync(`tmux kill-session -t ${name} 2>/dev/null`); } catch { /* 已不在=净 */ }
  }
};

afterAll(() => killPrefixedSessions()); // 箭头包裹:直传带默认参函数会被 vitest 误判 fixture 形态

/** 本文件的测试 socket 名(D239 缓解:仅作测试态标记与会话前缀基,不再作 -L 值)。 */
export const tmuxTestSocketName = (): string => socketName;

/** 本文件的会话命名域前缀(socket 名+'-'——生产 resolveSessionName 消费同一 env)。 */
export const tmuxTestSessionPrefix = (): string => `${socketName}-`;

/** 主 server 上的 tmux 调用(失败即抛——建会话/收尾等预期成功的步骤用;
 *  D239 缓解:不带 -L=默认 socket 常活主 server,隔离靠 atf-test- 前缀会话名)。 */
export const tmuxTest = (args: string): string =>
  execSync(`tmux ${args}`, { encoding: "utf8" }) as string;

/** 主 server 上的 tmux 探测(退出码布尔化——has-session/kill-session 等允许失败的步骤用)。 */
export const tmuxTestOk = (args: string): boolean => {
  try {
    execSync(`tmux ${args}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
