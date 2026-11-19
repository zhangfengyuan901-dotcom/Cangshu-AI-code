# 仓鼠AI官网

官网由 Cloudflare Workers Static Assets 托管。客户端安装包仅通过用户指定的网盘分享，当前链接、提取码和文件名读取 `.agents/project-state.json` 的 `client.distribution`。

禁止将安装包上传到 R2、放入官网静态目录或通过官网代理传输。旧 `/download/*` 地址只跳转当前网盘，不返回安装包内容。

从工作区根目录使用唯一发布入口：

```powershell
python 仓鼠AI/scripts/publish-website.py preflight
python 仓鼠AI/scripts/publish-website.py stage --apply
python 仓鼠AI/scripts/publish-website.py deploy --apply
python 仓鼠AI/scripts/publish-website.py verify
```

发布工具固定使用 Cloudflare `default` profile，先核验实际生产版本与绑定，再冻结源码并发布网页资源。不得恢复旧 R2 下载版本。发布证据与当前版本仅维护在 state，不在本文件追加版本记录。
