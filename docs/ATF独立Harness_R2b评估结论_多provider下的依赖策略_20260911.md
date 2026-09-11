# ATF 独立 Harness——R2b 评估结论（多 provider 下的依赖策略）

**日期**:2026-09-11 ｜ **状态**:待 owner 确认（本文件即确认载体）
**依据**:《ATF独立Harness_Phase2任务书_20260910.md》§4 设计要求 3（owner 决策五口径）+《ATF-Harness_Owner决议与启动指令_P2S2闭合_P2S3启动_20260911.md》§4 口径 #8
**结论先行**:**建议维持 R2a（零外部运行时依赖）**——`dependencies` 保持为空。Phase 2 全程无网络需求，引入依赖无消费面；未来真实 Provider 接入（Phase 3+）优先以 Node 内置 fetch + 自研薄适配层承载，届时另行评估，未经 owner 确认不动依赖面。

---

## 1. 评估问题与范围

R2b 问的是:多 provider 需求下，R2a 路线（零 npm 运行时依赖，`dependencies` 恒空；devDependencies 仅 typescript / vitest / @types/node 构建测试工具）是否维持。评估范围:

| 层 | 现状 | 是否在本次评估内 |
|---|---|---|
| L2–L4（harness 本仓，TS） | 零依赖；provider 面 = 脚本化 Faux ×2（`faux` / `faux-alt`） | **是** |
| L1（ATF 内核，Python） | 独立仓独立依赖策略，经 stdio JSONL 桥接，无代码级依赖 | 否（两仓永不合并，ADR 既定） |

## 2. 多 provider 需求的实际形态（按阶段）

1. **Phase 2（当前）**:第二 provider = 脚本化 Faux 变体（P2-S3 已交付）。任务书 §4 明令「不接真实 Provider、不产生网络调用」——**本阶段对第三方依赖的消费面为零**。
2. **Phase 3（宿主嵌入）**:provider 配置面按 ADR-09 C9 定案——B 自管基线 + A 宿主注入（凭据句柄机制属 Phase 3 鉴权面，尚未定型）。真实 Provider 出现的前提是 owner 显式授权（AGENTS.md 硬约束 4），且凭据/端点不进载荷明文的红线决定了接入形态是「薄适配 + 凭据句柄」，不是「SDK 全家桶」。
3. **Phase 4+（条件阶段）**:不受本结论约束，届时重评。

## 3. 候选方案对照

| 方案 | 内容 | 评估 |
|---|---|---|
| A. 维持 R2a | `dependencies` 恒空；真实 Provider（若获批）用 Node ≥22 内置 `fetch` + 自研薄适配层（接口 = 既有 `LlmProvider`，P2-S3 已定型） | **推荐**。无供应链攻击面、无传递依赖审计负担、`LlmProvider` 接口面已定死使适配层成本可控（单实现百行级）；Node 内置 fetch 覆盖 HTTP/SSE 流式读取 |
| B. 引入官方 SDK（openai / anthropic 类） | 依赖 SDK 承载真实协议、重试、流式 | 不推荐本期引入:① Phase 2 零消费面，未使用依赖 = 纯风险;② 具体厂商选型依赖 Phase 3 dispatch/凭据句柄定案，现在选必返工;③ SDK 传递依赖树大，与 TCB 最小化（硬约束 6）和脱敏纪律张力最大;④ 锁定厂商协议，与多 provider 抽象目标相悖 |
| C. 引入通用 LLM 网关库（litellm 类） | 一层抽象对接多厂商 | 不推荐:运行时重（常带代理服务形态）、Python 生态为主、与零依赖承诺冲突最烈 |

## 4. 结论与理由（建议维持 R2a）

1. **消费面为零**:Phase 2 全程 Faux（任务书明令），无网络调用路径——此刻引入任何运行时依赖都是无消费者的纯风险敞口。
2. **需求形态未定型**:真实 Provider 的接入形态受 Phase 3 鉴权面（凭据句柄）与 dispatch 注入语义支配；提前引入 SDK 层会被 Phase 3 决策推翻，返工成本高于自研薄适配层从零起步。
3. **TCB 最小化是契约级承诺**:`dependencies` 为空写入口径（硬约束 6 / 多份 owner 决议），是审计面最小的直接承载；本结论经 owner 确认前维持不变。
4. **R2a 不阻塞未来**:P2-S3 已把 `LlmProvider` 抽象、注册表面（`ProviderRegistry` ≥2 id）、热切换事实面（`provider/switch`）定型——真实 Provider = 新增一个实现类 + 薄 HTTP 适配，不动消费面（ADR-09 §1.4「届时零改动」承诺的兑现载体已在）。

## 5. 若未来推翻本结论（触发条件与路径）

- **触发**:owner 显式授权接真实 Provider，且 Phase 3 鉴权面定案后评估认为自研适配成本不可接受（如协议演化过快、流式语义复杂度超预期）。
- **路径**:书面提议（引入理由 / 具体包与版本 / 传递依赖清单与审计 / 替代方案再对照）→ owner 批准 → 显式 PR 改 `package.json` + 锁版本 + 供应链审查（license / 维护活跃度 / 安装脚本）→ 契约登记更新。
- **回滚**:依赖以单适配层文件为隔离边界（`src/llm/` 内），删除依赖 + 适配层即回到 R2a，会话/桥接/审批各层无耦合。

## 6. 验收锚点

- 本结论交 **owner 确认**；确认前 `dependencies` 保持为空（启动决议口径 #8 / 纪律不变条款 3）。
- P2-S3 VERIFY 实测:`package.json` 无 `dependencies` 字段。
