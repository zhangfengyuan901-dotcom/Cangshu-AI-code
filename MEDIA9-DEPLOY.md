# PIKNO R2生成链路：brand.9

生产应用 `pikno-new-api:v1.0.0-rc.41-brand.9`，版本 `v1.0.0-rc.41-pikno.9`。

## 构建和回归

在项目根目录运行：

```powershell
docker build -f deploy/new-api/Dockerfile.media9 -t pikno-new-api:v1.0.0-rc.41-brand.9 deploy/new-api
node --test cloudflare/relay-media/worker.test.mjs cloudflare/relay-media/runtime.test.mjs cloudflare/relay-media/packy-runtime.test.mjs
```

构建依赖已有钱包源码镜像 `pikno-wallet7-test:latest`（实际digest `sha256:192f59e57cfacccecc8e6731d4f8936d5270f5731e3477bd043c80ba5b9a36bf`）和brand.8运行时（digest `sha256:88a5083f4f71958f06903a45fb82345e24ce335c22cb7a7a322a65859acfc33e`）。这些本地基镜像须保留；当前Dockerfile未声明可在完全空白环境独立重建。

生产Secret沿用media8两端已配置的密钥。文件内容不得放入命令行参数、报告或公开日志。

## 发布证据

- `private/media9-acceptance/result-packy-format-fixed.json`：5张引用（同一测试图片重复引用5次）真实图生图通过，账本扣费一致，响应589字节。
- 早期被上游拒绝的验收记录保留，未覆盖；每次付费尝试有独立标记，不可直接重跑已有脚本。
- `verify-media9-production.py`：生产同一网关的负向测试，临时令牌40秒过期，测试后删除；外部URL403、multipart415、数量400、未扣费。
- 公网 `/api/status` 返回200和pikno.9；无网关凭证访问 `/media/v1/packy` 返回401。
- `private/media9-video-acceptance/result-preflight2.json`：三宝R2参考图生成4秒480p视频成功，统一接口返回completed及视频URL，隔离计费0.04对应20000 quota，临时令牌已撤销。
- 生产三个渠道保持状态2；未改动生产价格、余额或支付设置。

## 回滚

ECS目录 `/opt/piknoai-relay/current`；备份 `.deploy-backups/media9-20261008` 包含compose.yaml、.env和数据库dump。brand.8镜像仍保留，回滚应用只需恢复备份compose.yaml，再对new-api执行现有四个compose文件的 `up -d --no-deps --no-build --wait new-api`。

此次未修改数据库结构，不应为应用回滚恢复整个数据库，否则会覆盖期间真实业务数据。Worker新版本仍兼容旧上传控制接口；必要时Cloudflare可回滚至media8版本。回滚后需再次检查状态接口及直传接口。

## 客户迁移

客户改用JSON携带本站R2引用，原图生图multipart请求返回415。调用步骤及示例见 `CUSTOMER-API.md` 和 `examples/media-edit.mjs`。图片结果链接最多2小时有效，须及时保存。视频直接使用任务结果outputs的URL下载，当前不推荐使用ECS内容代理。

限制：尚未完成每账户100图片并发压测、桌面应用切换、全部视频/音频组合验收。客户跨请求幂等仍未实现，不得在网络超时后自动重复生成。
