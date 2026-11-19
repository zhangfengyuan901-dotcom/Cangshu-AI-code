# 仓鼠AI官网

静态官网由 Cloudflare Workers Static Assets 托管，大文件保存在私有 R2 桶 `hamster-ai-downloads`，仅通过官网 `/download/*` 的只读映射提供。

部署前先上传唯一正式发行文件（便携版）：

```powershell
npx wrangler r2 object put hamster-ai-downloads/releases/1.7.49/HamsterAI-Portable-1.7.49.exe --file="../dist/release-1.7.49/仓鼠AI-1.7.49-便携版.exe" --content-type=application/vnd.microsoft.portable-executable --remote
```

随后在本目录运行 `npx wrangler deploy`。版本升级时先上传新对象，再更新网页版本、大小、SHA-256 和 Worker 白名单，验证后部署。安装包及旧版下载路径不属于官网正式下载入口。

本轮发布使用已构建的 1.7.49 便携文件，不重建或修改发行文件：176,476,797 bytes，SHA-256 `0528b850538d58409a50b9c8d480dd7a38ef24e4cd6df27b5481408861f4b09e`。默认教程与 `/tutorials/1.7.49/` 对应新版三 Key、报价确认和逐节点手动执行；`/tutorials/1.7.46/` 保留为明确标识的旧版操作归档。教程截图来自离线模拟，演示名称、金额和连接状态不能作为实时服务或收费验收。

2026-10-18 已完成部署，Worker Version ID 为 `0ae60efc-efd2-4b9c-8623-2b6c85fb2c8d`。完整公开下载字节与SHA一致；HTTP13项、桌面／手机界面20项通过。详细记录见 `../docs/release-1.7.49-20261018.md`。

2026-10-19 下载优化已部署，当前Worker版本为 `9e42b9cc-09f9-4ea5-b57f-9e85e780eea9`，客户端文件不变。默认gateway不缓存，仅Download入口启用Workers Cache；必须保留固定路径白名单、查询归一、跨版本隔离和gateway对缓存响应的条件复核。不要覆盖同版本不可变对象。使用Wrangler4.151.1部署；不能只添加Cache-Control就当成已启用边缘缓存。详情见 `../docs/download-speed-20261019.md`；缓存已生效，但部分直连瓶颈仍需独立下载线路改善。
