# 工作区规则

- 使用简体中文。禁止创建或附带交付报告、HANDOFF及同类叙述文档；结果在对话简述。允许测试日志、机器校验结果及本工程技术记忆。
- 先确认任务事实与边界；条件充分即执行。未知事实须核验，不能把历史记录、模拟测试、健康检查写成真实客户验收。
- 当前版本、发布证据和未完事项只维护 `.agents/project-state.json`。本文件只维护长期规则和目录入口，禁止不断追加版本流水账。
- 默认只读本文件、目标子工程 AGENTS 和 state 中相关条目。按需定位源码及测试；不整读历史、不全盘递归展开。默认 `rg` 排除归档、产物和依赖，查这些目录时显式指定路径并使用 `--no-ignore`。

## 工程入口

| 范围 | 唯一维护入口 |
| --- | --- |
| 客户端 | `仓鼠AI/`，另读其 AGENTS；正式源码受 `release/source-manifest.json` 校验 |
| 中转站后端 | `PIKNO中转站/deploy/new-api/backend/`，另读其 AGENTS 和适用 `.agents/rules/` |
| 中转站前端 | `PIKNO中转站/build/hamster-trim44-web/`；Docker 从源码生成嵌入资源，滚动发布按需保留已用的旧静态哈希 |
| 后端构建、运维 | `PIKNO中转站/deploy/new-api/Dockerfile`、`PIKNO中转站/deploy/new-api/operations/` |
| 支付桥、工具控制 | `PIKNO中转站/deploy/lanjing-bridge/`、`PIKNO中转站/deploy/tool-control/` |
| 素材服务 | `PIKNO中转站/cloudflare/relay-media/wrangler.jsonc` 使用 TOS 包装与 `release/` 冻结业务源；ECS 存储入口在 `PIKNO中转站/deploy/tool-control/tos-migration/server.mjs` |
| 对话、报告、官网 | `仓鼠AI/cloudflare/llm-worker/`、`仓鼠AI/cloudflare/report-worker/`、`仓鼠AI/website/` |
| 源码和运行边界 | state 的 `protected_paths` 和 `maintenance`；本地开发数据与凭据在工作区外 |

## 保护边界

- 工作区长期保留应用和中转站的核心源码、锁文件和源资源。构建产物按需生成。保留有效 Git 对象、未提交的独有改动和必要故障证据。保留客户配置、Key、素材、会话、任务及结果。
- 故障修复只改已证实必要的边界，不借机改稳定生成、查询、规格、定价、计费和防重。旧 unknown 不清除、不重发、不虚构结算或退款。
- 免费检测和只读核对不授权收费生成、付款、邮件或客户登录。真实调用必须有该次明确授权。验证默认合成身份、假上游和隔离账本。
- Secret、Cookie、Key、正文、素材URL和客户路径不得进入工具输出、公共产物或日志。诊断只输出固定白名单元数据。
- ECS、Cloudflare、客户端是独立边界。线上动作前核验实际状态；不得恢复生产财务。素材控制只能有一个执行者，禁止CF/ECS双执行。
- 仓鼠Cloudflare发布显式使用 `--profile default`；各服务账号不同，先核验，不从父目录默认配置推断。
- 仓鼠AI客户端安装包仅通过用户指定的网盘链接分发。禁止上传安装包到R2作为客户下载源；官网不得提供或代理安装包直下载，旧下载入口只能跳转当前网盘。当前链接、提取码及版本维护在 state。
- 清理先检查引用、运行占用和真实路径，生成精确机器清单后删除。保留Git有效对象和未提交文件；不运行无范围 `clean`、`prune` 或递归删除。

## 上下文维护

- 完成任务后原位更新 state 的对应条目，记录实际证据、验证范围与尚存问题；不能将候选标成上线。
- 接口和功能合同放在最近子工程规则；细节以当前源码和针对测试为准。历史归档只用于追溯，不作为现状。
- 当前构建入口不得依赖一串历史发布目录。退役入口先确认替代构建与关键回归可运行。
