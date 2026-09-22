# ATF-Harness 走查单：L1c 提前批 pty 真实模型最小链（批前走查）— 2026-09-22

- **用途**：门 2 复核之批前走查（合并版指令 §三；走查属复核证据，**不宣称六跑通过**——六跑仍按执行单 owner 现场）。
- **形态**：pty 驱动、真实模型、**约 5 分钟**；执行人＝复核方（owner 批内授权已备，措辞 `1772676b…` §三-1）。
- **证据**：全程 `.typescript.txt` ＋ 落盘 `session.jsonl`（runs-root 下 run 目录）。
- **红线**：内核仓零写入；TUI `--peer real` 只读用 `.atf-pinned`（HEAD sha 与 pin `v0.7.3b1` 校验，fail-closed）；不 push 不发版。

---

## 一、env 对照表（`ATF_LLM_MAX_TOKENS` 按 llm.json 登记面各模型官方输出上限取值）

> 原则（owner 13:5x 指正）：reasoning 模型思考与 tool-call JSON 同吃输出预算，取**越高越不易生成截断**；**不超模型上限为唯一硬线**；与 zcode 自身用什么模型无关。

| 模型（llm.json 登记面） | 官方 context | 官方 max output | 依据来源（官方文档，2026-09-22 实核） | `ATF_LLM_MAX_TOKENS` 建议值 | `context_window` 配置 |
|---|---|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | **1M** | **384K**（393,216） | api-docs.deepseek.com/quick_start/pricing（模型详情表 CONTEXT LENGTH 1M／MAX OUTPUT 384K） | **131072** | **1000000**（已落 llm.json） |
| `deepseek-v4-pro`（DeepSeek-V4-Pro-0813） | **1M** | **384K**（393,216） | 同上（同表双列同值） | **131072** | **1000000**（已落 llm.json） |
| `glm-5.3` | **1M** | **128K**（131,072） | docs.bigmodel.cn／docs.z.ai GLM-5.3 产品页（Context 1M／Max Output 128K；Flash 页注明与 GLM-5.3 同参） | **131072**（=官方上限） | **1000000**（已落 llm.json） |
| `glm-5.3-flash` | **1M** | **128K**（131,072） | docs.z.ai/guides/llm/glm-5.3-flash（已核：Context Length 1M／Maximum Output Tokens 128K） | **131072**（=官方上限） | **1000000**（已落 llm.json） |

- **建议值口径**：统一 131072（≤ 全部登记模型官方上限；为旧值 4096 的 32 倍；DeepSeek 上限 393216 内、GLM 恰等于上限）。DeepSeek 如需顶格可用 393216（仍合法）。
- **未核实值一律标 `[待核实: 官方文档]`**：上表四模型均已官方页实核，**无待核实项**。
- **输入侧对齐（合并版 §三 连带）**：`context_window=1000000` 已补入 `~/.atf-harness/llm.json` 全部 5 个模型条目（含 deepseek-anthropic 协议别名，备份 `llm.json.bak-20260922`）→ compaction 触发水位生效值＝1M−25K=**975,000 tokens**，单条摘要上限＝min(125K,25K)×2=**50,000 字符**（旧回退值 24K/6_000 仅在未配置时使用）。

## 二、启动

```bash
cd /data/sam/ATF-Harness && npm run build
export ATF_LLM_CONFIG=/root/.atf-harness/llm.json
export ATF_LLM_MAX_TOKENS=131072          # 按上表；走查所选模型 ≤ 官方上限即可
# 真内核对端（--peer real）：ws-root 用既有时序夹具；内核取 ATF_CLI_PATH 覆盖 > .atf-pinned 缺省
node dist/ui/tui.js --peer real --ws-root <已就绪的 ws-root> --runs-root tmp/ui-runs
```

run-id 建议 `run-walk6-<short>`（走查目录隔离）。

## 三、最小链步骤（每步＝用户视角该看到什么）

| # | 操作（输入行） | 判定（走查判定 ①–⑤ 对应） |
|---|---|---|
| 1 | 按 prompt 输入 run-id 与触发指令（"登记 datasets/external/swb 并准备准入"） | 首屏过程流逐条可见；无系统视角行 |
| 2 | 等模型查询状态 | **概览人读行**出现（"已登记 N 批…"或 human_summary 结论行）；模型**不向用户复述枚举**（判定④辅助） |
| 3 | 等模型调 `atf_preparation_propose` | **① 聚类卡以人读中文＋推荐值出现**：`┌─ 确认卡 · 版式聚类参数（数据集 ds-…@…）`，含"分组粒度：\"page\""等六行推荐参数与"推荐参数（内核模板，可直接采用）" |
| 4 | 输入 `1`（按推荐确认） | `> 确认留痕`行；下一 turn 由确认卡规范化文本驱动；**② execute payload 与确认值逐字一致**（session.jsonl 里 `atf_style_cluster_execute` 的 `cluster_params` 六键与模板逐字比对） |
| 5 | 审批弹窗出现时核对回显后放行（`1`/`g`） | 弹窗文案含**逐参数中文回显**＋`（与确认卡一致）`；放行走既有 CAS 审批链 |
| 6 | 等模型复查 propose → 划分卡 | **划分卡**出现（划分比例 8:2 推荐）；输入 `1` 确认（或 `2` 后改"7:3"再回车验证逐项修改） |
| 7 | 等模型携 `split_policy` 发起 `atf_data_admission_request` → 审批放行 | 弹窗含划分比例回显；执行成功 |
| 8 | turn 收口 | **③ completed 出现三段摘要**："──── 本轮小结 ────／做了什么／产生了什么／下一步建议"；**④ 全程无降级提示行（"已收起"字样零出现）／无系统视角表述** |

异常分支（如触发即顺带核判定⑤）：provider 返回 429/配额错误 → 收口"卡在哪"行应显示**"模型服务用量已达上限（provider 侧配额/限流）：请核对账户额度或稍后重试；输入新指令即可继续本会话"**（人读提示，非"HTTP 429"裸码）。

## 四、证据归档

- pty 全程文本 → `docs/_owner/L1c提前批_pty证据_真实模型最小链_20260922.typescript.txt`；
- session.jsonl → `tmp/ui-runs/run-walk6-<short>/session.jsonl`（复制路径记入证据文件头）；
- 判定 ①–⑤ 逐条在证据文件尾打勾／记偏差。

## 五、复核后

复核通过＝**六跑前置完整**（六跑仍按执行单 owner 现场跑）；不 push 不发版。
