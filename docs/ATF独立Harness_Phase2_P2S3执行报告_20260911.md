# ATF 独立 Harness Phase 2——P2-S3 执行报告

**执行人**:zcode(A800_5005:/data/sam/ATF-Harness)
**日期**:2026-09-11
**依据**:《ATF-Harness_Owner决议与启动指令_P2S2闭合_P2S3启动_20260911.md》+《ATF独立Harness_Phase2任务书_20260910.md》§4 + ADR-09 §1.4(C9)
**结论先行**:**S3 四项要求与追加断言全部落地,验收标准全过**——186 passed / 2 skipped(基线 169 零回归 + 新增 17 条)、`smoke:p2s3` 新增并全过、`smoke:p2s2` / `smoke:s5` 保持全过、`dependencies` 为空、`schema_version` = 1、`bridge.contract_version` = 1、pin `a628f8b` 未动。R2b 结论 = **维持 R2a**,已单独成文待 owner 确认。

---

## 1. 执行记录(对照决议 §4 执行序列)

| 步骤 | 结果 |
|---|---|
| ① 阅读决议 + 任务书 §4 + ADR-09 §1.4 | 完成,无冲突;预拍口径十二条直接采用 |
| ② BUILD(口径 #1–#12) | 完成,见 §2 |
| ③ VERIFY(验收 1–4 + 基线 + 两条既有冒烟) | 完成,见 §3 |
| ④ 执行报告 + R2b 结论文档 | 本文件 +《ATF独立Harness_R2b评估结论_多provider下的依赖策略_20260911.md》 |
| ⑤ 本地提交不 push | 完成(§5);**Phase 2 收尾报告与 tag 决议另候指令** |

## 2. BUILD 改动清单

### 2.1 启用位与契约(口径 #1)

| 文件 | 改动 |
|---|---|
| `src/session/schema.ts` | `provider/switch` 移出保留位 → **enabled 12/12**;`SESSION_RESERVED_EVENT_TYPES` 改为空集(类型标注 `readonly SessionEventType[]`,机制保留);`SESSION_ENABLED_EVENT_TYPES` = 全集别名;**`SESSION_SCHEMA_VERSION` 保持 1**,头注标注推进来源 |
| `session.contract.yaml` | 事件枚举节更新(enabled 11→12、保留位集合为空、不 bump);新增 `provider_switch` 节(B 自管基线 / 注册面 / 载荷定死形态 / 边界 / digest 连续性 / 原子性 / 场景表达 / 投影定位) |

### 2.2 src/llm/——第二 Provider + 注册与切换(口径 #2/#3)

| 文件 | 改动 |
|---|---|
| `src/llm/provider.ts` | `LlmProvider` 接口新增 `readonly providerId: string`(切换 from/to 与报告 turn 归属的依据);头注更新 |
| `src/llm/fauxProvider.ts` | `providerId = "faux"`;新增 `fromSteps` 静态构造(注册面用),`fromBranch` 既有路径不动 |
| `src/llm/fauxVariantProvider.ts`(**新**) | 第二实现 `FauxVariantProvider`,`providerId = "faux-alt"`,脚本化 Faux 变体,零网络零依赖 |
| `src/llm/providerRegistry.ts`(**新**) | `ProviderRegistry`(register/has/ids/create,**注册面外 = null 不猜测回退**)+ `createDefaultProviderRegistry()`(默认注册 `faux` / `faux-alt` 两个 id) |
| `src/llm/scenario.ts` | 步骤白名单六类 → **七类**(+`provider_switch` = 越界切换请求的表达);分支级可选 `segments: [{provider_id, reason?, steps}]`(**一段 = 一个 turn**,段间切换即合法边界);校验:steps 与 segments 互斥、每段 steps 非空、`segments[0].provider_id === scenario.provider`(一致性交叉校验);`provider` 字段仍恒 "faux"(家族标识) |

### 2.3 src/run/——切换点编排 + 落盘(口径 #4–#7)

| 文件 | 改动 |
|---|---|
| `src/run/providerSwitch.ts`(**新**) | 编排原语:`ProviderSwitchPayload`(口径 #4 定死形态)、`checkSwitchBoundary`(口径 #5:仅无 open turn 合法)、`verifyDigestContinuity`(口径 #6:流内 `ref_invalid` 必须为零 + 逐条引用 resolver 复核 + resolver 自身故障即断裂,pre/post 两阶段)、`buildSwitchPayload` |
| `src/run/runner.ts` | 段分支模式:`branch.segments` 声明时按段推进——段耗尽(非末段)= 段边界:收口当前 turn(`turn/end`,reason=`provider_switch`)→ **切换协议固定顺序**:注册面 → 边界复核 → digest 前复核 → 落盘 `provider/switch` → digest 后复核 → 激活新 provider → 新 `turn/start`;任一前置失败 = 不落事件、不切换;落盘后复核失败 = 流不可信 → run 终局 failed(1)且新 provider 不激活(口径 #7 原子性,无半生效态)。turn 内 `provider_switch` 步骤 = 越界请求:结构化 block `provider_switch_out_of_boundary`,不落事件、非终局(同 provider 继续)。报告新增可选 `turns`(逐 turn provider 归属 + 决策数)与 `switches`(switched/rejected 记录)——仅段分支或发生过切换请求时携带。**单 provider 分支(无 segments)路径逐位不变**(S5 四分支零回归实证) |
| `src/run/smokeP2S3.ts`(**新**) | 冒烟命令:交替分支(faux → faux-alt → faux 三 turn 两切换,含准入事实引用跨切换)+ 越界反例分支;断言面见 §3 |
| `src/run/index.ts` | 导出切换原语与报告类型 |

### 2.4 场景 / 脚本 / 测试(口径 #9)

| 文件 | 改动 |
|---|---|
| `scenarios/provider-alternation.json`(**新**) | 两分支:`ALT_two_provider_alternation`(三段交替 + 准入 + surface_scan 引用)、`ALT_out_of_boundary_rejected`(turn 内切换请求被拒后原 provider 收束) |
| `package.json` | 仅新增 `"smoke:p2s3"` 脚本(口径 #10 允许) |
| `tests/session/schema.test.ts` | 启用位断言更新至 12/12 + 保留位空集;`provider/switch` 写入/replay 正例(原「保留位反例」随集合清空按机制保留) |
| `tests/llm/scenario.test.ts` | 新增 segments/provider_switch 解析 describe(正例 + 反例族:互斥/空段/未声明字段/初始 provider 不一致) |
| `tests/llm/providerRegistry.test.ts`(**新**) | 注册面两 id / 未命中 null / 第二实现回放与段隔离 |
| `tests/run/providerSwitch.test.ts`(**新**) | 边界判据 / 载荷定死形态 / digest 连续性正例 + 三类断裂反例(标记残留 / digest 不一致 / resolver 故障)/ 空流等价 |
| `tests/run/providerSwitchE2e.test.ts`(**新**) | runner 端到端:合法切换(载荷逐字段 / 边界形态 / 原子性 / 首 turn 归属 + 决策文本实证)、越界拒绝(不落事件 + 非终局)、注册面未命中(fail-closed 终局 + 不落事件) |

### 2.5 禁改面核对

`src/session/` 其余文件(compaction / durability / tail-repair)、`src/tools/`、`src/bridge/`、`bridge.contract.yaml`、`src/workspace/`、S5 场景脚本与四分支断言——**零改动**(`git status` 实证,§3)。

## 3. VERIFY 验收对照(决议 §4 验收 1–4 + 任务书 §4)

| 验收项 | 结果 | 实证 |
|---|---|---|
| 交替分支冒烟通过 | ✅ | `smoke:p2s3` 十六项断言全过(输出随下) |
| turn 边界外切换被拒反例 | ✅ | OOB 分支:`provider_switch_out_of_boundary` + 全流零 switch 事件 + completed(非终局) |
| R2b 结论交 owner 确认 | ✅(待确认) | 《R2b 评估结论》已单独成文,结论 = 维持 R2a;**确认前 `dependencies` 为空已实证** |
| `dependencies` 仍为空 | ✅ | `package.json` 无 `dependencies` 字段 |
| 追加:越界不落事件断言 | ✅ | 冒烟 + e2e 双覆盖 |
| 追加:digest 断裂反例(不放行 + 不落事件) | ✅ | 原语级三类反例(标记残留 / digest 漂移 / resolver 故障)均 `provider_switch_digest_broken` |
| 追加:原子性(无半生效) | ✅ | 切换协议顺序固定(落盘 → 后复核 → 才激活);e2e 断言 switch 事件 ⟺ 新 provider 生效 |
| 追加:切换后首 turn 归属新 provider | ✅ | 报告 `turns` 归属 `[faux, faux-alt, faux]` + turn2 首条决策文本 = faux-alt 段脚本实证 |
| 追加:载荷字段与口径 #4 一致 | ✅ | 冒烟逐字段断言 + e2e `toEqual` 精确匹配(无凭据无端点) |
| 基线 169 passed / 2 skipped 零回归 | ✅ | **186 passed / 2 skipped**(26 文件)= 基线 + 新增 17 条,零回归 |
| `smoke:p2s2` / `smoke:s5` 保持全过 | ✅ | 两者全过(p2s2 含无句柄警告) |
| `schema_version` = 1;`bridge.contract_version` 不动;pin 不动 | ✅ | 1 / 1 / `a628f8b` |

复跑输出摘录:

```
Test Files  26 passed (26)
     Tests  186 passed | 2 skipped (188)
```

```
P2-S3 冒烟通过 ✓（交替切换 + 越界拒绝 + 载荷/边界/digest/原子性断言全过）
P2-S2 冒烟通过 ✓(六类应答 + 升级 + headless 等价 + 无句柄警告)
S5 冒烟通过 ✓（七项总验收全过）
```

## 4. 偏离与决策点(决议未明定处的口径补全,逐项报告)

1. **第三 block 原因 `provider_switch_unknown_provider`(口径未覆盖的防御路径)**:注册面未命中的切换目标必须有 fail-closed 处置——不落事件、非终局(段边界处因无决策可用折算 run 故障终局)。与两条预拍原因同族同纪律,已登记契约与报告,不构成语义扩张。
2. **turn/段模型的具体化**:口径 #5「仅 turn 边界合法」在既有 runner(单 turn/分支)下不可表达合法切换——以 `segments`(一段 = 一个 turn)具体化:段边界 = 声明式合法切换点;段内 `provider_switch` 步骤 = 越界请求的可表达形态(反例承载)。单 provider 分支零改动。
3. **`boundary.turn_index` 语义定死**:口径未明定义,取「被本切换关闭的 turn 序号(1 起,边界位于该 turn 之后)」,与 `after_event_id`(关闭 turn 的 turn/end 事件 id)对称,已登记契约。
4. **`turn/end` reason 新增值 `provider_switch`**:段收口留痕需要;turn/end payload.reason 为自由 JSON 面,不影响既有枚举。
5. **场景 `cite_admitted_fact` 语义对齐**:初版误将引用标志放在 admit 自身步骤(该标志语义 = 引用**此前**准入事实,B1 同例),BUILD 自测中发现并修正为 surface_scan 步骤携带——执行序语义与 S5 一致。
6. **scenario schema 白名单六类 → 七类**:Phase 1 closure 表述「无第七类」由本 slice 按任务书 §4 演进,严格收口纪律不变(未知 type 仍一律拒绝)。
7. **性能**:未新增实测(口径 #12);`provider/switch` 落盘为逐条档单事件写入,无新路径。

## 5. 提交清单(本地 main,**未 push**)

| # | commit | 内容 |
|---|---|---|
| 1 | `feat(llm,run,session): P2-S3 多 provider 与热切换` | 启用位 + 第二 Provider/注册表 + 切换编排 + runner 集成 + 场景/冒烟/脚本 + 测试(含契约登记) |
| 2 | `docs(phase2): P2S3 执行报告 + R2b 评估结论 + 决议入库` | 本报告 + R2b 文档 + P2-S3 启动决议入库 |

## 6. 下一步建议

1. owner review P2-S3,重点:§4.1(unknown_provider 防御原因)与 §4.2(段模型具体化);
2. R2b 结论(维持 R2a)请 owner 确认(§3 验收第 3 项的确认动作);
3. 确认后 Phase 2 四切片(D1/S1/S2/S3)全部闭合 → **Phase 2 收尾报告与 `v0.2.0` tag 决议另候 owner 指令**;本会话完成即停。
