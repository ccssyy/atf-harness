# deploy/verify —— 实例真环境取证脚本

只做**取证**：不进 CI、不参与 `npm run build`、不改产品代码。用于门验收时在真实实例上
把"用户能不能看见/能不能继续"跑成可复核的图与 JSON，避免"单测绿、页面不可见"这类假过。

## verify_draft_card.py（B2c 草稿态「回到上次实验」卡）

```bash
# dev（容器内）
DSH_TOKEN=$(grep -h 'dsh web: ' /tmp/dsh-web-k28.log | tail -1 | sed 's/.*token=//') \
  python3 verify_draft_card.py --shot-dir /tmp/verify

# uat（atf-uat 容器内，端口 3081）
DSH_TOKEN=$(grep -h 'dsh web: ' /tmp/dsh-web-tongshi.log | tail -1 | sed 's/.*token=//') \
  python3 verify_draft_card.py --base-url http://127.0.0.1:3081 --shot-dir /tmp/verify
```

输出：`I-1-draft-card.png`（草稿态出卡）、`I-2-pending.png`（点击后「已选 ✓」）、
`draft-card.json`（判据机读结果，含 `verdict`）。退出码 0=PASS / 1=FAIL / 2=用法错。

判据五条：卡可见、文案含「回到上次实验」、点击后按钮转「已选」、`/atf-ui/` 前缀 POST 为 0、
pageerror 为空。

## 两条纪律

1. **口径要严在真信号上**：`/atf-ui/` 之外不统计 POST——vendor 侧读接口（`/api/session/list` 等）
   本身就是 POST，宽口径会把 0 淹成噪声，反过来制造假 FAIL。
2. **只读**：脚本不发送消息、不建会话、不写服务端状态；截图与 JSON 落 `/tmp`，不要落 run 目录。

## 依赖

容器内已装 Python Playwright（`/usr/local/bin/playwright`）与 chromium（`~/.cache/ms-playwright`），
无新增依赖；脚本不写死 token，一律 env/参数传入（token 每次 boot 轮换）。
