/**
 * E2 测试夹具——真执行失败形态 mock：exit 1＋stdout 垃圾（非 JSON）＋stderr 带
 * 错误信息。驱动 preflight_failed 锚：stdout 解析失败才是真失败，note 必须同时
 * 含 stdout 与 stderr 摘要（禁空 note——用户/agent 拿得到归因线索）。
 */
process.stderr.write("mock_preflight_fail: simulated kernel internal error (E2 anchor)\n");
process.stdout.write("Traceback (most recent call last):\n  simulated crash before report\n");
process.exitCode = 1;
