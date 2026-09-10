// P2-S1 崩溃恢复测试子进程（被父进程 SIGKILL，验证各档 durability 契约）。
// 用法：node p2s1_fsync_child.mjs <dist/session/index.js 绝对路径> <logPath> <mode> <count> [batchMax] [batchWindowMs]
// 逐条 append，向 stdout 打印：
//   {"acked": <event.id>}    —— append 返回（逐条档 = 已 fsync；批量档 = 已写入 OS）
//   {"flushed": <event.id>}  —— 批量档刷盘水位线推进到该事件（unsyncedEvents 归零时刻）
// 写完后保活等待被杀。

const [, , distIndex, logPath, mode, countArg, batchMaxArg, batchWindowArg] = process.argv;
const { SessionLog, MockDigestResolver } = await import(distIndex);

const resolver = MockDigestResolver.withDigests([]);
const options =
  mode === "batch"
    ? { fsync: { mode: "batch", batchMaxEvents: Number(batchMaxArg ?? 4), batchWindowMs: Number(batchWindowArg ?? 30) } }
    : {};
const created = await SessionLog.create(logPath, resolver, options);
if (!created.ok) {
  process.stderr.write(`create failed: ${JSON.stringify(created.error)}\n`);
  process.exit(2);
}
const log = created.value;

const count = Number(countArg);
for (let i = 1; i <= count; i += 1) {
  const appended = await log.append({ type: "user/message", payload: { seq: i, text: "x".repeat(32) } });
  if (!appended.ok) {
    process.stderr.write(`append failed: ${JSON.stringify(appended.error)}\n`);
    process.exit(3);
  }
  const id = appended.value.event.id;
  process.stdout.write(`${JSON.stringify({ acked: id })}\n`);
  if (mode === "batch" && log.unsyncedEvents === 0) {
    process.stdout.write(`${JSON.stringify({ flushed: id })}\n`);
  }
}

setInterval(() => {}, 1 << 30); // 保活：等待父进程 SIGKILL（崩溃点在写入流中途）
