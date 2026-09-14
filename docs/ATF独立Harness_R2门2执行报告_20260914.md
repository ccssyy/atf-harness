# ATF 独立 Harness——R2 门 2 执行报告（真实对端端到端）

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF独立Harness_R2任务书_真实对端夹具与工具面端到端_20260914.md》§2 ＋《ATF-Harness_Owner决议与指令_R2门1评审_门2放行_20260914.md》（§2 四项裁决 ＋ §3 三项边界标注 ＋ §2.4 真实写授权）
**性质**：门 2 执行报告——**本地提交未推送，推送待 owner 另行授权**；内核仓零改动；runner 默认链路与三条既有冒烟保持 mock

---

## 1. 交付物清单

| # | 交付物 | 落点 |
|---|---|---|
| 1 | D3 契约补登：`atf_admit_data.params` 增可选 `pin`；bump 口径固化入「版本轴注记」；`contract_version` 保持 2 | `bridge.contract.yaml` |
| 2 | TOOL_DEFINITIONS 对等同步（模型可见参数增可选 `pin`；4 工具面不变） | `src/tools/toolDefinition.ts` |
| 3 | 夹具模块：三层隔离根工厂（mkdtemp 前缀 `/tmp/atf-r2-*`）＋ 真实 `atf init` 装机 ＋ 十目录骨架 ＋ journal/summary 制样 ＋ 注入式对端工厂（D1） | `tests/run/realPeer/fixture.ts` |
| 4 | 真对端测试两组（`ATF_CLI_PATH` 门控） | `tests/run/realPeer/e2eChain.test.ts`、`failClosed.test.ts` |
| 5 | `smoke:r2` 七段总验收冒烟 ＋ 脚本 | `src/run/smokeR2.ts` ＋ `package.json` |
| 6 | 契约自检扩展（pin 参数 ＋ bump 口径断言） | `tests/bridge/contract.file.test.ts` |

**分支纪律**：工作在 `work/20260914-r2-real-peer` 短命分支（独立 worktree）完成，验毕 `--no-ff` 合回 main（`c4c0043`），分支与 worktree 已删除——任务书 §4.2 全流程履行。

## 2. 端到端原始输出（smoke:r2 实跑摘录，全量输出见提交前实跑记录）

```
—— R2 真对端专项冒烟（通道+业务方法面，mock 轨不受影响）——
✓ [1] pin 校验：HEAD == pin（v0.6.0b0 / b6db3496…）
✓ [2] atf init（临时 HOME 隔离）退出码 0
✓ [2] 夹具制样（init + 十目录 + journal 3 行 + 双 lane summary）就绪
✓ [3] spawn 真实 serve + 握手（会话协议版本 = 1）
✓ [3] bind_run 绑定合成 run            （留痕 event：session/run-bound，payload to_run_id）
✓ [3] workspace_status：空登记面 admitted_count=0
✓ [3] fact_scan：3 条 operation-journal（journal-event:<run>:1..3）
✓ [3] G1 query（大小写归一化）= pass（lane-a/b 最坏裁决聚合）
✓ [3] G2 query = warn + reason_codes 并集（["split_checksum_stale"]）
✓ [3] admit_data（真实写，授权范围 /tmp/atf-r2-*）返回 dataset-registry 三元组
✓ [3] 落盘证据：registration.json 存在且 sha256 可复算
✓ [3] 写后复读 admitted_count=1；fact_scan 计数 3→4（dataset-registry 入索引）
✓ [3] G1 advance → 同会话 query 反读一致（边界：内存登记，非落盘）
✓ [3] 优雅关闭 exit 0
✓ [4] no_run_bound / unknown_run / 错误后连接保持 / unknown_gate / admission_state_unavailable /
       gate_verdict_not_registered / 坏 journal internal_error / 账本空链 not_found / approval_record_mismatch
       ——八类反例逐一命中，反例会话优雅关闭 exit 0
✓ [5] 注入式对端（D1）：预录链 query 恰 1 条 approved head → 逐值一致消费 consumed →
       重复消费 approval_already_consumed → 缺省 query 只回可消费记录（空）
✓ [6] 隔离：pin 副本 git status 零改动；temp HOME 无 .agents/skills 泄漏；写盘全部位于 /tmp/atf-r2-*
R2 冒烟通过 ✓（七段总验收全过）   EXIT:0
```

## 3. 真实写落盘证据（唯一真实磁盘写 = admit_data）

- **路径**：`/tmp/atf-r2-ws-XXXX/datasets/r2-fixture-ds-1@<pin>/registration.json`（pin 为 12 位十六进制，由内核 canonical_digest 派生，例如实跑 `03d8297a4660`）；
- **内容摘要**：`{"dataset_id": "r2-fixture-ds-1", "l1_dir": null, "pin": "03d8297a4660", "refs": {"source_ref": "r2-fixture-sour…"}}`（schema `DatasetRegistration/v1`）；
- **文件 sha256**：`4c6c91811184eaeebf82886d51c00660dba52c673c70850648882c4ba1e354bb`（当次实跑值，逐次内容含时间戳会变化，验证口径 = 夹具侧复算一致 + 响应三元组 digest 形态合法）；
- **复核链**：响应 `fact_id` = 目录名 = `<dataset_id>@<pin>`；写后 `workspace_status.admitted_count` 0→1、`fact_scan` 计数 3→4（dataset-registry 入索引）；
- **清理**：夹具 cleanup `rm -rf`，冒烟末尾断言临时根零残留。

## 4. 隔离断言结果（每组用例与冒烟均执行）

| 断言 | 结果 |
|---|---|
| pin 副本 `git status --short` 全程零改动 | ✅（main 合并后复核实测 0 行） |
| temp HOME 无 `.agents/skills/`（技能自举关闭 + HOME 隔离双保险） | ✅ |
| 写盘路径前缀全部位于 `/tmp/atf-r2-*` 夹具根 | ✅（夹具常量保证 + 冒烟断言） |
| 数据全合成（`r2-fixture-*` 标识），零真实业务内容 | ✅ |
| 真实 `~/.atf` 不可达（HOME 隔离） | ✅（init 实证 config 落临时 HOME） |
| 夹具清理零残留 | ✅ |

## 5. 三项边界标注（决议 §3，如实入档；smoke:r2 第 [7] 段字面输出）

1. **场景迁移另批**：`admission-to-g2` 等场景脚本迁真内核涉及 run_id/workspace 参数化与 Faux 回放适配——本批不做，R2 以 `smoke:r2` 达成端到端验收；场景迁移列为 R2 收尾评估项或另批。
2. **mock↔内核 event 键差异**：mock 覆盖绑定发 `{from,to}`；内核**首绑也发**且键为 `{from_run_id, to_run_id}`——已登记「mock 退役评估」清单，本批不统一；契约措辞"payload 含 from/to run_id"两者皆容，不构成契约违反。
3. **「内存登记」不得写成「已落盘」**：闸门推进（G 系/完整性）与账本消费**仅在会话进程内存**，进程结束即消亡；本报告验证口径 = **同会话 query 反读**，不表述为"持久化/可重建"。R2 之后"跨进程事实可重建"仍依赖 harness 自己的 append-only 会话日志与工作区文件。
4. **（防误读项）**：R2 的 run 为合成最小 run（`r2-fixture-*`），**R2 验收通过 ≠ 业务级可用**；真实训练链路端到端（含真实数据与真实 effect）仍需独立授权与独立批次。

## 6. 四项裁决落实对照

| 裁决 | 落实 |
|---|---|
| D1 注入式对端（接受，三条约束） | ✅ 仅存在于 `tests/run/realPeer/` 与 smoke:r2 测试面（`src/` 生产路径零注入——runner/executor/bridge 未动）；同源注入（PYTHONPATH/PYTHONDONTWRITEBYTECODE/ATF_SKILLS_AUTO_INSTALL + HOME 隔离，夹具工厂单点）；本报告 §5.2/§5.3 已标注（本条即约束 3 的履行） |
| D2 完整性 Gate advance 可选扩展 | ✅ 按"不阻塞"执行：覆盖 query（`gate_verdict_not_registered`）与 `unknown_gate` 分支；完整 advance 未实现（内核侧 B2-2 单测已覆盖求值，跨进程重复覆盖收益有限） |
| D3 pin 参数补登 + bump 口径固化 | ✅ 契约补登（纯增量，不 bump，`contract_version: 2` 不动）；bump 口径表写入「版本轴注记」；TOOL_DEFINITIONS 对等；契约自检新增断言 |
| D4 真实写授权 | ✅ 严格限 `/tmp/atf-r2-*` 夹具根内合成数据；真实磁盘写仅 admit_data 一处（§3 证据）；禁区（真实 `~/.atf`、`~/.agents`、内核仓、业务数据）零触碰 |

## 7. 验收对照（任务书 §2.5 ＋ 决议 §4.3）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 端到端链路全绿：bind_run → workspace_status → fact_scan → gate query → admit_data（写）→ gate advance → ledger_query → ledger_consume（写，注入式） | ✅ smoke:r2 七段全过 ＋ realPeer 组 4 用例全过 |
| 2 | fail-closed 反例组：no_run_bound / unknown_run / unknown_gate / admission_state_unavailable / gate_verdict_not_registered / 空链 not_found / 坏 journal internal_error / 重复消费 approval_already_consumed | ✅ 八类全部命中预期错误码（mismatch 附加覆盖），错误后连接保持全程成立 |
| 3 | 真实写落盘证据 ＋ 隔离断言 | ✅ §3/§4 |
| 4 | 全量零回归，两轨：设 `ATF_CLI_PATH` **207 passed / 1 skipped（30 文件）**（基线 202 全保留＋新增 5）；未设 **202 passed / 9 skipped**（全绿，真对端组门控跳过）；typecheck 通过 | ✅ |
| 5 | 三条既有冒烟保持 mock 不动 ＋ `smoke:r2` | ✅ s5/p2s2/p2s3 全过（零改动）；smoke:r2 两态验证（无路径优雅 skip / 有路径全过） |
| 6 | 内核仓零改动；`dependencies` 恒空；runner 默认链路 mock | ✅ |
| 7 | mock 退役评估（任务书 §2.6） | ✅ 见 §8 |

## 8. mock 退役评估（任务书 §2.6，结论供 owner 裁量）

**建议：保留 mock（本批不退役）**。理由：①三条既有冒烟与 runner 默认链路全部依赖 mock（CI/常规开发不依赖真内核——双轨硬约束的载体）；②mock 的错误码粒度与内核存在已知差异面（`admission_state_unavailable`/`gate_verdict_not_registered` 等内核细粒度码 mock 未实现），对齐成本高于收益；③event 键差异（边界标注 2）待统一。**退役清单（留存待后续裁量）**：a) event payload 键差异；b) admit pin 派生算法差异（mock=sha256(dataset_id)[:12] vs 内核 canonical_digest({dataset_id, source_ref})[:12]）；c) mock 账本预录方法面（ledger_record）在内核提供产品级预录入口后的对齐；d) 错误码细粒度对齐。触发条件建议：runner 默认链路切真内核（场景迁移批）时再评估。

## 9. 内核侧议题登记确认（决议 §5，本仓不插队、不阻塞）

审批跨进程可见性（ApprovalLedger 纯内存 + CLI serve 无 owners 注入）、会话级预录入口、完整性 Gate 求值入参文档化——三项均已登记为内核侧议题，harness 侧以注入式对端（D1）与边界标注（§5.3）过渡，不阻塞、不插队。

## 10. 提交清单（本地提交，**未推送**）

1. `3f8656a` `feat(r2)`：门 2 工作笔（契约补登 + 夹具 + 测试 + smoke:r2，8 文件 +1031/−1，分支合入）；
2. `c4c0043` `merge`：`work/20260914-r2-real-peer` → main（分支与 worktree 已删）；
3. 本报告入库提交（`docs(r2)`）。

**完成即停**：推送待 owner 另行授权；不启 Phase 3；内核仓零改动。
