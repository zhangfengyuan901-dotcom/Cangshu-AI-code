# PIKNO工作区

本目录维护仓鼠AI客户端和New API中转站。当前版本、证据和未完成问题统一见 `.agents/project-state.json`；开发规则见根和目标子工程 `AGENTS.md`。

| 工程 | 入口 |
| --- | --- |
| 客户端与测试 | `仓鼠AI/` |
| 客户端构建 | `仓鼠AI/release/current.json`、`仓鼠AI/scripts/stage-current-release.cjs` |
| 后端源码 / 构建 / 运维 | `PIKNO中转站/deploy/new-api/` |
| 账户前端 | `PIKNO中转站/build/hamster-trim44-web/` |
| 支付桥 / 工具控制 | `PIKNO中转站/deploy/lanjing-bridge/`、`PIKNO中转站/deploy/tool-control/` |
| 素材Worker | `PIKNO中转站/cloudflare/relay-media/` |
| 官网 / 对话 / 故障服务 | `仓鼠AI/website/`、`仓鼠AI/cloudflare/` |

客户端在其目录运行 `npm run release:check`。中转站以 `PIKNO中转站/` 为 Docker 构建上下文。`python -B PIKNO中转站/tools/check-project-context.py` 校验当前源码和构建入口。

依赖和产物按需生成。运行数据与私有配置使用工作区外的本地数据目录。原 Git 历史中的源码和独有改动放在 `source-history/*` 分支。

生产 ECS 登录步骤见[服务器登录指引](PIKNO%E4%B8%AD%E8%BD%AC%E7%AB%99/deploy/new-api/operations/SSH.md)。
