# 仓鼠AI

Electron 本地客户端，包含账户、图片与视频生成、工具、对话、素材、任务记录、画布及本机 Codex 只读模式。

主工程维护当前正式运行源码。当前版本、官网状态和验证证据以父目录 `.agents/project-state.json` 为准；未发布改动保存在独立分支或隔离归档，不参与正式构建。

| 模块 | 维护入口 |
| --- | --- |
| 主进程与安全窗口 | `electron/`、`server.js` |
| 账户与中转站 | `pikno.cjs`、`pikno-client.cjs`、`pikno-key-store.cjs` |
| 任务与素材 | `tasks.cjs`、`media.cjs`、`media-metadata.cjs`、`assets.cjs` |
| 对话 | `pikno-inference.cjs`、`smart-video-agent/chat.py`、`chat_media.py`、`chat-ui/` |
| 界面与画布 | `public/`、`canvas/` |
| 正式构建合同 | `release/current.json`、`release/source-manifest.json` |
| 构建入口 | `scripts/stage-current-release.cjs` |
| 回归 | `tests/`、`smart-video-agent/test_*.py` |

```powershell
npm test
npm run test:release
npm run release:check
npm run release:stage -- --out release-build-check
```

stage 从主工程复制固定清单中的正式源码、运行依赖及源码资源。运行二进制和已有编译资源取自唯一当前发行目录。构建使用 stage 中的 `builder.json` 与 `electron-builder --publish never`；`npm run dist` 通过同一受控入口构建。已有输出不会被覆盖。

`npm run test:release` 按 `tests/release-suite.json` 执行正式版合同回归。`npm test` 执行完整开发回归，尚存问题记录在项目状态中；两套结果分别记录，不能互相替代。

`npm start` 与 `npm run electron` 运行正式主工程。客户 Key 由主进程系统加密保存。四用途使用同账户余额，对话使用专用 Key。素材能力以当前已发布线路为准。价格、账户隔离、防重及数据保护规则见本目录 `AGENTS.md`。

离线回归、构建核验和真实客户验收分别记录。真实生成、付款、邮件与登录按本次明确授权执行。
