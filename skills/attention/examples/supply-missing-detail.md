# Supply — fill in a missing detail the agent cannot derive

A request-style NHA used when the agent has all the pieces of a task except one **factual** input that only a human can resolve — credentials, a numerical threshold, an account id, a policy interpretation. Demonstrates a tiny option set with an opt-in free-text path.

## CLI

```bash
first-tree attention raise \
  --chat infra-onboarding \
  --target yuezengwu \
  --subject "请补一个生产 Sentry DSN，我要把告警接进新服务" \
  --body @body.md \
  --requires-response \
  --meta tags[0]=supply \
  --meta tags[1]=credentials \
  --meta-json @options.json
```

## body.md

```markdown
## 问题
新服务 `orders-checkout` 准备接 Sentry，但我没有 prod 项目的 DSN。请提供一个，或者告诉我用现有的哪个项目。

## 背景
- staging 已经验证完毕，今晚上线
- Sentry 现有项目：`web-frontend`、`api-gateway`、`worker`（我能查到）
- prod 用什么项目我不确定 — 不想自己猜一个新项目名

## 我会怎么做
- 你回 "复用 api-gateway"：把告警全打到 api-gateway 项目下
- 你回 "新建 orders-checkout"：我去 Sentry web 建一个新项目，再回来配 DSN
- 你直接贴 DSN：我用这个 DSN 上线

## 这次决定的有效范围
仅本次上线的 `orders-checkout` 服务。下次新服务再单独问。
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "items": [
      { "value": "reuse-gateway", "label": "复用 api-gateway 项目" },
      { "value": "new-project",   "label": "新建 orders-checkout 项目" },
      {
        "value": "paste-dsn",
        "label": "直接贴 DSN（点我后写在自由回复里）",
        "input": { "type": "text", "placeholder": "https://...@sentry.io/..." }
      }
    ]
  },
  "fallback": "block deploy, ping #infra",
  "validityScope": "this service deploy only"
}
```

## Notes

- "Supply" 用在**信息缺失**而非**决策授权**的情境。如果你能自己 supply（查 tree、查 README、跑只读命令），就别用 NHA。
- 输入型选项（`input.type=text/number/datetime`）会触发 UI 在该选项下面渲染一个输入框；目前 web 简化为"勾这个选项 → 切到自由回复模式"，与 mockup 表现一致。
- 一次 supply NHA 应当只问**一个**事实点。如果是要补 3 个相关参数（同时缺 DSN、release token、env name），改用 `metadata.questions[]`（见 `multi-question-launch.md`）。
- 不要把答案写到一个 generic `notes` field 后期翻找；让人选/写到结构化 `answers` 里。
