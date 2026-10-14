# 胶囊卡前缀闭包语义（定版登记）

本文件是 atf-ui 八段胶囊卡**段显示态语义**的定版登记（纯文档——以码为源，不改写语义）。
语义源＝`src/server.ts` `scanRunDir` 段显示态构造区（owner 保序裁定注释在码，批㊶-S3 窗口 B 定版）；
四态渲染判定＝`src/snapshot.js` `segmentStatus`；八段序＝`src/server.ts` `SEGMENT_ORDER_KEYS`
（register → label_qc → experiment_config → publish → split → admission → training → evaluate）。
**变更本语义＝显式 PR＋owner review**（本文件与码注释须同步修订）。

## 1. 保序语义（核心）

八段显示态必须**保序**：`done` 恒为前缀；后段完成蕴含前段发生；"间隔完成／后成前未成"
（✓○✓○）是不合逻辑状态，不得显示；「评估✓训练○」倒挂形态被前缀语义自然排除。

- 码锚：`server.ts` `scanRunDir` 内 `doneMap[key] = maxEvidenceIdx >= idx`（前缀判定）——显示
  done 集恒为 `SEGMENT_ORDER_KEYS` 的前缀，任何 `idx > maxEvidenceIdx` 的段一律非 done。
- 下游渲染（`snapshot.js` `segmentStatus`）只在前缀之外产生 `active`（且至多一段，见 §3），
  前缀内不会被 pending-confirm 等信号越序置 ●。

## 2. 证据图三源

进入前缀闭包的证据（`rawDone`）由三源构成：

1. **事实轨**：`webui/segments.json` 工具执行成功记录（`segmentFacts.ts` `appendSegmentFact`；
   挂点＝atf_admit_data→register、atf_label_qc_inspect→label_qc、atf_config_confirm→experiment_config、
   atf_publish_confirm→publish）；`scanRunDir` 内事实折入循环 `if (hasSegmentFact(dir, key)) rawDone[key] = true`。
2. **在盘锚（启发式，前序段）**：registration.json/dataset（register）、label_qc/qc（label_qc）、
   webui/config-snapshot.json（experiment_config）、segment-* 报告或 contract-candidate.json（publish）、
   split 或 dataset/split（split）、launch/train.sh 等（admission）。
3. **收尾段完成锚**：training＝`trainingAnchorPresent`（training/loss-series.json 或
   adapter_model.safetensors 或 all_results.json——LlamaFactory 真实完成产物）；evaluate＝
   `eval/metrics_summary.json` 或 `evalRoundAnchored`（含 `eval/<round>/orch/eval/metrics_summary.json`
   现役轮产物位）。**出现即事实**——历史 run 重评形态由此不再冻结 0/8。

事实语义细项：**training 段事实＝start 放行（非完成）、evaluate 段事实＝编排启动（非完成）**——
两段不入事实轨（事实折入循环显式排除），完成语义只认完成产物锚。

## 3. 活跃期边界

训练活跃期（本轮重跑／OOM 降档重发）证据不入前缀——训练段回落边界显示 ●（active），
evaluate 回落 pending。

- 码锚：`scanRunDir` 内 `trainingActiveNow = rawDone.training && trainingActiveLive(...)`；
  `evidence["training"] = rawDone.training && !trainingActiveNow`；
  `evidence["evaluate"] = rawDone.evaluate && !trainingActiveNow`——活跃期两段证据从证据图剔除，
  前缀止于 admission，训练段落边界。
- 渲染侧（`snapshot.js` `segmentStatus`）：`key === "training" && run.training.active === true` →
  `active`（先于 done 判定——重跑期间不显示历史轮的 ✓）；前缀内段 done 优先于 pending-confirm
  （陈旧确认卡不越序置 ●——frontier 纪律）。

## 4. done＝前缀闭包（末位证据截断）

显示 done＝**末位证据截断的前缀**：`maxEvidenceIdx`＝证据图中最后一个为 true 的段序号，
`doneMap[key] = maxEvidenceIdx >= idx`。历史 run 前段锚缺口由后段证据**反蕴含**补齐
（登记→体检→…必然已发生——顺序管线中后段完成即前段发生的执行背书），不再出现
✓○✓○ 间隔态；frontier（首个非 done 段）之后的段如实 pending，不猜测。

## 5. 码锚与变更纪律

| 面 | 落点 |
| --- | --- |
| 语义源（证据图＋前缀闭包＋活跃期边界） | `src/server.ts` `scanRunDir` 段显示态构造区（owner 保序裁定注释块在码） |
| 八段序 | `src/server.ts` `SEGMENT_ORDER_KEYS`（与 `runFacts.ts` `SEGMENT_ORDER` 同源序） |
| 四态渲染判定 | `src/snapshot.js` `segmentStatus`（done/active/failed/pending） |
| 事实轨写者 | `src/core/workspace/segmentFacts.ts`（appendSegmentFact；挂点见其文件头） |
| 消费渲染 | `panel.ts`（面板八段卡四态）／`client.js`（浮卡/dock/通知卡）——只渲染 status，不再推导 |

**变更本语义＝显式 PR＋owner review**；码内 owner 裁定注释块与本文件须同步修订。

## 6. 出处链

批㊶-S3 窗口 B S-B2 根因修复②（owner 保序裁定"done 恒为前缀"，码内注释定版）→
批㊶-PIN5 决议 D4①（候裁转生效）→ 本件补登（批㊶-D4，2026-10-14；落点修正：
module-contracts/SKILL 无 UI 显示面章节，语义归属 atf-ui 扩展包自身文档——侦察实证随指令件登记）。
