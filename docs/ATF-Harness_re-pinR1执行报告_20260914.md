# ATF-Harness re-pin R1 执行报告（窄 R1：通道对真实内核）

**签发**：harness 侧会话（zcode，`/data/sam/ATF-Harness`）
**日期**：2026-09-14
**依据**：《ATF-Harness_Owner指令_re-pin专项_R1_20260914.md》（按 AGENTS.md §4「re-pin 三步」执行）
**性质**：re-pin 专项执行报告——**本地提交未推送；不启动 R2、不启动 Phase 3、内核仓零改动**

---

## 1. pin 前后对比

| 字段 | 修正前（v2 起） | 修正后（R1） |
|---|---|---|
| `atf_upstream.tag` | `v0.2.0b7` | **`v0.6.0b0`** |
| `atf_upstream.commit_sha` | `a628f8b8e23b…` | **`b6db3496b34089147044be9c6b9a0a7ceb595e3a`** |
| `atf_upstream.pinned_at` | `"2026-09-08"` | **`"2026-09-14"`** |
| `atf_upstream.baseline` | 全量基线 970 passed / 129 skipped | **全量基线 1235 passed / 128 skipped（合计 1363；内核批次二发版实测）** |
| `atf_upstream.contract_version` | 1 | **1（保持——会话协议版本轴；内核方法面补登不 bump，桥接契约版本轴不随 re-pin 变动）** |

- **§3.1 切换存证**：旧副本 `a628f8b`（detached）确认无本地改动后 `worktree remove` → `worktree add .atf-pinned v0.6.0b0` → HEAD 实测 `b6db3496b340…` = `v0.6.0b0` ✓（禁用 `--force`，未遇阻）。
- 测试全程复验 `git -C .atf-pinned status --short` = **0 条改动**（内核 checkout 零污染）。

## 2. 契约变更项清单

| # | 变更 | 落点 |
|---|---|---|
| 1 | `derive_command.env` 新增 `ATF_SKILLS_AUTO_INSTALL: "0"`（内核 CLI 入口技能自举 `skills_install.ensure_skills_installed()` 默认写 `~/.agents/skills`，测试期必须关闭） | `bridge.contract.yaml` atf_cli 段 + **代码承载镜像** `src/bridge/atfCommand.ts::deriveAtfCommand`（与契约段一一对应，见 §5 偏离说明） |
| 2 | 契约测试扩充**真实会话断言**（「通道对真实内核成立」验证） | `tests/bridge/contract.pin.test.ts`：原"会话握手等待内核落地"skip 占位启用为两组真实断言（详见 §3） |
| 3 | `known_gaps` 更新：原"无 JSONL 会话模式"缺口由 `v0.6.0b0` `serve` 落地消除（`--version` 旗标仍缺）；`decision_20260908.atf_side_backlog` → `landed_v0.6.0b0` | `bridge.contract.yaml` atf_cli 段 |
| 4 | 头部「re-pin R1 登记 2026-09-14」块（切 pin 存证 / 两项契约变更 / 双轴口径 / R1 窄范围声明） | `bridge.contract.yaml` atf_upstream 段上方 |
| 5 | pin 镜像常量同步 | `src/bridge/atfCommand.ts`：`ATF_UPSTREAM_TAG` / `ATF_UPSTREAM_COMMIT_SHA` → v0.6.0b0 / b6db3496…（契约测试 pin 校验的承载，不同步则验收 2 必红） |
| 6 | 契约自检 pin 断言同步 | `tests/bridge/contract.file.test.ts`：tag/sha 锚定新值 + 「会话协议版本轴保持 1」断言 |

**R1 窄范围核对（不做项）**：mock 对端保留（`tests/fixtures/mock_atf.mjs` 零改动，runner 与三条冒烟仍走 mock）；工具面/账本面真实对端替换属 R2；未做真实写动作（未建真实工作区、无登记/推进/消费）；`src/` 业务语义零改动；Phase 3 未启。

## 3. 真实会话断言与原始输出

### 3.1 断言组（`contract.pin.test.ts`，未设 `ATF_CLI_PATH` 时整组仍跳过——语义不变）

1. **spawn 真实 CLI**：`python3 -m agentic_training_flow serve`，`cwd = ATF_CLI_PATH`，env = 契约 `derive_command.env`（含 `ATF_SKILLS_AUTO_INSTALL=0`）+ **HOME 指向临时夹具**（`mkdtemp`，用后即清）；
2. **握手**：`name === "atf"`、`version` 非空（实测 `"0.6.0b0"`）、`contract_version === EXPECTED_SESSION_CONTRACT_VERSION`（= 1）；
3. **帧配对**：连续两次 `atf.version` → id 逐条配对、结果一致无串扰；未知方法 → `method_not_found` 且连接保持（后续请求可用）；
4. **stdout 洁净**（原始字节流直验，不经连接层）：三请求直写 stdin → stdout 全字节流经严格 LF 分帧**零协议违规**、首字节即帧（无欢迎语）、逐帧过 `validateKernelFrame`、id 逐条回显 [1,2,3]；stderr 静默；exit 0；
5. **优雅关闭**：stdin end → 进程 **exit 0**（语义组与原始组各验一次）。

### 3.2 真实对端原始输出片段（手动探针，隔离 HOME + `ATF_SKILLS_AUTO_INSTALL=0`，pin 副本 @ `v0.6.0b0`）

```
$ printf '{"type":"request","id":1,"method":"atf.version","params":null}\n{"type":"request","id":2,"method":"atf.version","params":null}\n{"type":"request","id":3,"method":"atf.no_such_method","params":{}}\n{"type":"request","id":4,"method":"atf.version","params":null}\n' | ... python3 -m agentic_training_flow serve
{"id": 1, "ok": true, "result": {"contract_version": 1, "name": "atf", "version": "0.6.0b0"}, "type": "response"}
{"id": 2, "ok": true, "result": {"contract_version": 1, "name": "atf", "version": "0.6.0b0"}, "type": "response"}
{"error": {"code": "method_not_found", "message": "方法未注册:atf.no_such_method"}, "id": 3, "ok": false, "type": "response"}
{"id": 4, "ok": true, "result": {"contract_version": 1, "name": "atf", "version": "0.6.0b0"}, "type": "response"}
EXIT:0        （stderr 为空；临时 HOME 零写入；.atf-pinned status 零改动）
```

### 3.3 测试组实跑

```
✓ tests/bridge/contract.pin.test.ts (5 tests | 1 skipped) 1327ms
  （pin 校验 / derive 冒烟 / 真实会话语义组 / 真实会话 stdout 洁净组 全绿；
   1 skipped = 「契约环境自检」既有占位，与真实 CLI 无关）
```

## 4. 验收对照（指令 §4 六项）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | `.atf-pinned` HEAD == `b6db3496…`；pin 块四项更新 | ✅ HEAD 实测一致；tag/sha/pinned_at/baseline 全部更新，`contract_version` 保持 1 |
| 2 | 契约测试组对真实 CLI 全绿（含五项新断言）+ 原始输出 | ✅ 5 用例（4 过 1 占位跳过）；原始输出见 §3.2/§3.3 |
| 3 | 全量测试零回归（下限 = 修正前基线 200 passed / 2 skipped；新增计入） | ✅ **202 passed / 1 skipped（28 文件）**——基线 200 全保留；+2 = 两组真实会话断言；skip 2→1 = 原"等待内核落地"占位启用为真实断言；typecheck 通过 |
| 4 | diff 限于 bridge.contract.yaml、tests/bridge/*、tests/（如需）、docs/ | ✅ 另有 `src/bridge/atfCommand.ts`（pin 镜像常量 + derive env 承载）——见 §5 偏离说明 |
| 5 | 内核仓零改动；mock 保留；`src/` 业务语义零改动 | ✅ `.atf-pinned` status 全程 0 条改动；mock 文件未动；src 仅 pin 同步面（无业务语义变更） |
| 6 | 完成即停——不启 R2、不启 Phase 3 | ✅ 本批本地提交即止 |

**附加**：三冒烟全过（s5 / p2s2 / p2s3，仍走 mock，本批不动）；临时夹具目录零残留。

## 5. 偏离规范说明（仅一处，显式声明）

`src/bridge/atfCommand.ts`（+9/−2）不在指令 §4.4 的 diff 枚举内，但为 re-pin 必需适配（AGENTS.md §4 re-pin 第②步"红了修 harness 侧适配"）：①`ATF_UPSTREAM_TAG/COMMIT_SHA` 是契约 pin 块的测试承载镜像，不同步则 pin 校验红、验收 2 不可能达成；②`deriveAtfCommand` 的 env 与契约 `derive_command.env` 一一对应（文件头自述"与 bridge.contract.yaml 的 atf_cli 段一一对应"），若代码侧不补 `ATF_SKILLS_AUTO_INSTALL=0`，既有 `--help` 冒烟即触发技能自举写用户目录，违反隔离纪律（指令 §5.3）。**两处均为 pin 同步/配置面，无业务语义变更**，请 owner 核验追认。

**待收口事项（本指令范围外）**：AGENTS.md §4 仍记载"当前 pin：tag v0.2.0b7"——AGENTS.md 变更须 owner 批准且不在本指令 diff 范围，建议随本批 PR review 一并由 owner 侧更新。

## 6. 提交清单（本地提交，**未推送**）

1. `feat(contract)`：re-pin R1——pin 切至 v0.6.0b0 + 契约变更两项 + 真实会话断言（bridge.contract.yaml / src/bridge/atfCommand.ts / tests/bridge/*）；
2. `docs(contract)`：本报告 + 指令文档《ATF-Harness_Owner指令_re-pin专项_R1_20260914.md》入库。

推送待 owner 授权。R2（真实对端夹具 / 工具面与账本面端到端 / 真实写动作授权 / mock 退役评估）另行签发，本批不启。
