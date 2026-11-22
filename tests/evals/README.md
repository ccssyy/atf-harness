# tests/evals —— G6 分层 evals

按 `harness-flow` 的 eval-spec 成本四层组织。设计原则与本目录的分工：
**便宜的一层永远全跑，贵的才按触达面选**；能机械断言的不消耗 eval 预算。

| 文件 | 层 | 成本 | 断言对象 | 跑法 |
|---|---|---|---|---|
| `l0.structure.test.ts` | L0 结构/契约 | 秒级 | 源码与仓库树事实（import 深度、output.schema 声明面） | 永远全跑 |
| `l1.trajectory.test.ts` | L1 行为 eval | 秒级 | agent loop **实际调用了什么、传了什么、收到什么** | 全跑 |
| `l2.corpus.test.ts` | L2 端到端（真实语料回放） | 秒级（纯读盘） | 真机原始调用语料重放 + 契约/设计承诺两层断言 | 按触达面选（本批资产小，全跑） |
| `l3.incidents.test.ts` | L3 对抗（历史事故固化） | 秒级 | 每个历史事故的**坏形态**能否被拦 | 收口/发版批（本批全跑） |
| `_pipelineHarness.ts` | 夹具 | — | 段级 headless 驱动（非测试文件） | 被 L1/L3 import |

## 载体纪律（eval-spec §4.5 判据载体三分）

- **行为判据**（轨迹断言）走 **headless/段级驱动**：`_pipelineHarness.ts` 直驱
  `buildPipelineTool` + pi-agent-core `Agent`，**不经过 WebUI/鉴权/端口/隧道**。
  这些交互面与判据零关系，引入只会把鉴权、端口、壳混淆、env 丢失一起拖进来。
- **模型面＝faux provider**（`src/agent/fauxStream.ts`）：固定输出序列重放，
  **零真实 LLM 调用、零网络、零 GPU**（本批红线）。L1/L3 因此是秒级。
- **L2 不用 faux 冒充**：`fixtures/l2-*.json` 是真机会话记录里的原始调用参数与回执，
  原样保存（`provenance.session_sha256` 可复核）。faux 只能证明「给定输入代码怎么走」，
  真机语料证明「真实会话形态下工具怎么应答」——两者不可互换。

## 事故锚（围栏唯一合法来源是真实事故）

每条 L3 用例带编号 + 原症状 + 文档锚注释。当前覆盖 6 个：

| # | 事故 | 原症状摘要 | 落到哪 |
|---|---|---|---|
| 1 | 复验#24 | 「除 X 外的 N 个都要」被正则静默吞，卡消失凭据不落 | L1 + L3 |
| 2 | N5 | 「2 倍」被吞成「不增强」 | L1 + L3 |
| 3 | ci-bl-1103 | 用户改组数被无视，带原方案重出卡 → 循环确认 | L1 + L3 |
| 4 | B3c 断链 | `card_answers` 不进返回体，agent 看不到用户说了什么 | L1 + L3 |
| 5 | worktree 深度 | 4 级 import 在 worktree 绿、主仓红 | L0 + L3（判据敏感性） |
| 6 | schema 黑盒 | 11 位工具 output.schema 裸开放，agent 不知返回结构 | L0 + L3（入口枚举） |

## 演练拦截是完成判据，不是可选项

**全绿只证明没人违反，不证明拦得住。** 每条事故用例必须人为制造违规、证明它变红、
还原后变绿。演练记录见对应批次的交付报告。做不到的如实标注「未能演练拦截」并说明原因
——虚报演练比用例缺失更糟。

## 跑法

```bash
npx vitest run tests/evals          # 全部（秒级）
npx vitest run tests/evals/l3*      # 只跑事故对抗面
bash deploy/verify/pregate.sh       # 预合入全档（含 tsc/audit/codegen 确定性/rehearsal）
```
