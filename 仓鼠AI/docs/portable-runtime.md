# 1.6.1 单 EXE 便携版

## 1.6.1 长路径修复

客户日志中的失败发生在 PowerShell/.NET 解压深层依赖路径，尚未启动 Python，与端口无关。本版改为内置 Node ZIP 流式解压，Windows 文件读写显式使用 Unicode 扩展路径（`\\?\`），不依赖客户 .NET 长路径配置或修改注册表。临时目录缩短为 `r-随机码`；成功后的版本缓存路径不变，已有完整缓存仍可复用。原来的失败残留不会被当成可用环境，也不会删除客户数据。

不再通过 PowerShell 获取解压错误，中文错误直接以 JavaScript Unicode 字符串写入诊断日志，避免系统代码页乱码；旧日志的乱码无法恢复。新增 `RUNTIME_EXTRACT_FAILED`、`RUNTIME_EXTRACT_TIMEOUT` 和 `PATH_TOO_LONG` 错误类别。

回归测试使用客户同名文件，组合中文、空格及超过 400 字符的完整路径；并检查路径穿越、NTFS 数据流、符号链接、损坏 ZIP 与未列入清单的文件均被拒绝。

## 客户使用

Windows 10/11 x64：双击便携版 EXE，进入主应用；第一次打开工作台时自动释放内置环境。此阶段不用安装 Python、不用管理员权限，也不用下载依赖。磁盘与安全软件会影响首次释放耗时，请等候几分钟并保持主应用开启。

默认端口 8000 不可用时自动选择空闲端口。不要收藏固定端口，使用应用按钮打开当前页面。浏览器只在健康检查确认本次主应用创建的服务及工作流版本后打开。连续点击两个工作台共用一个启动流程、一个 Python 服务。发生绑定竞态最多重试三次；不能启动仍可导出脱敏诊断。

运行环境缓存在用户数据目录 `runtimes/<环境版本>`；首次先校验内置 ZIP，再释放至临时目录，逐文件校验成功后启用。以后每次主应用启动后首次打开工作台检查缓存完整性；同次运行直接复用。损坏缓存保留为 `*-replaced-*`，重新释放干净副本，不覆盖用户配置和素材。

单 EXE 是分发形式，不表示不写本地文件。请预留至少 3 GB 空闲空间供便携程序临时释放、运行环境缓存及更新使用；素材和视频结果另计。配置、资产、任务与运行环境分开保存；更新无需重新导入素材或填写 Key。

正常关闭主应用会结束其拥有的工作台进程。Windows 下工作台还持有主应用进程句柄，主应用异常退出时随之退出，避免残留服务。关闭工作台浏览器标签不结束主应用；关闭主应用会中断本地工作流，不撤销已提交的上游付费请求。不会为了端口冲突终止其他软件。

离线可打开界面和查看本地数据；生成、素材上传、多模态分析仍需要网络、有效 Key 和上游可用。

## 构建与依赖固定

- Python：官方 Windows x64 嵌入式 3.12.10（与当前依赖锁兼容）；下载校验 SHA-256。不能直接复制 `.venv`。后续升级 Python 或依赖需重新做兼容测试。
- `smart-video-agent/runtime-requirements.lock` 从 `uv.lock` 导出，包括传递依赖版本与下载哈希，不包含开发依赖。更新锁后执行 `npm run runtime:build`。
- 开发机 uv 按哈希安装到嵌入式目录，构建时只检查智能体、创意反推、媒体依赖和 FFmpeg；客户侧不安装依赖。许可文件保留在 Python 根目录及各包的 dist-info 内。
- `python-runtime.json` 记录归档及文件哈希。`npm run dist` 先验证离线包与锁文件、启动脚本一致，缺失或陈旧则阻止发布。
- 运行时使用 `-I` 与 `._pth` 隔离，显式加入当前工作流路径，不使用客户 `PYTHONHOME`、`PYTHONPATH` 或用户 site-packages。
- 构建命令：`npm ci` → `npm run runtime:build` → `npm test` → `node scripts/qa-portable-runtime.cjs` → `npm run dist`。
- `npm run runtime:build` 需要联网以及 electron-builder 缓存中的 7za，或设置 `HAMSTER_BUILD_7ZIP` 为开发机上的 7za.exe。客户解压使用内置 ZIP 读取组件，无额外下载或解压进程。

参考：[Python 官方嵌入式发行说明](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)、[Python 3.12.10 发布文件](https://www.python.org/downloads/release/python-31210/)、[uv 依赖锁定说明](https://docs.astral.sh/uv/pip/compile/)。

诊断和自动切换端口不能绕过系统安全策略。安全软件隔离内置文件、磁盘不足或禁止本地监听仍可能导致失败；请使用「账户 → 启动诊断」导出信息。
