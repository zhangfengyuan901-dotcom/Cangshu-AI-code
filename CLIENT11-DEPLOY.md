# PIKNO 第二阶段验收与发布记录

## 构建

- 基线：brand.10；目标：`pikno-new-api:v1.0.0-rc.41-brand.11`。
- 前端覆盖目录 client10 + client11，共 13 个第二阶段文件，client11-manifest.json 记录源文件 SHA256。
- 最终镜像 manifest：`sha256:b6bdcbae5bc10fccc3399567c283a299e7262fb9f237161f26b9bc306a4ea07c`。
- 归档：output/pikno-client11-image.tar，248433152 字节。
- 归档 SHA256：`b11b582a9d73de5a79c7f3e841ecd1f0182fa0891c0fd9d7782930b9ce31071e`。
- 构建时间：2026-10-08；前端版本 `v1.0.0-rc.41-pikno.11`。

## 已完成验收

- Windows Node 与 Docker Linux Node：37 个测试文件，684 项测试全部通过。覆盖客户/管理员、卡片价格、分组动态计费、固定人民币充值、消费明细与任务结果。
- typecheck、变更文件 oxlint、oxfmt、生产构建通过。
- 原 media9 和固定 CNY 后端补丁完整保留，Go controller/router/openai 回归通过。
- 初始 Linux Bun Vitest 遇到已有循环 Zod 导入兼容问题；测试运行器改用固定摘要 Node 24 镜像，仍执行全部 684 项测试。依赖安装及前端构建继续使用 Bun 1.4.0。
- 浏览器使用本地合成数据，不消耗客户余额，不调用真实上游或创建充值订单。
- 客户卡片、详情不请求性能指标；管理员仍保留性能条、筛选侧栏及高级工具。
- 消费记录默认 20 条，隐藏流式/Tokens/耗时列与 RPM/TPM。列设置可恢复高级列，管理员保持 100 条及完整统计。订阅历史标记未移除。
- API 面板使用本站地址、复制按钮和已验证的 R2 接入文档，不推测模型参数或限流。
- 模型接口业务失败显示重试而非空模型；恢复接口后点击重试重新显示模型。
- 桌面 1440px 与手机 390px 检查通过，截图在 output/playwright/client11-*。

## 发布保护

deploy-client11.sh 检查旧镜像、SHA256、无未完成任务，备份四份 compose、环境文件和数据库；仅更新 new-api 镜像。健康检查失败回滚 compose。发布前后比较渠道状态与系统选项摘要。

备份目标：`/opt/piknoai-relay/current/.deploy-backups/client11-20261008`（仅 root 可读）。

回滚：恢复该目录的 compose.yaml 到 current，使用原四份 compose 执行 `up -d --no-deps --no-build --wait new-api`。只回滚镜像，不恢复数据库以免覆盖新业务数据。

## 生产结果

2026-10-08 21:50（北京时间）已完成发布与公网核验：

- 应用 brand.11 健康；支付桥、PostgreSQL、Redis 健康，Cloudflare Tunnel 持续运行。
- 服务器校验归档 SHA256 成功，发布脚本输出 CLIENT11_HEALTHY_CONFIG_UNCHANGED。
- 备份已落盘；渠道状态及系统选项摘要前后一致。三条渠道仍为关闭，未开放任何收费模型。
- 公网版本 pikno.11、币种 CNY；定价接口成功，公开模型数 0（与关闭状态一致）。
- 开发文档及页面 HTTP 200；未登录渠道管理、充值信息、媒体上传、图片生成、Worker 接口均 HTTP 401。
- 公网验收结果：output/client11-production-acceptance-20261008.json。没有创建真实充值订单或生成任务。
