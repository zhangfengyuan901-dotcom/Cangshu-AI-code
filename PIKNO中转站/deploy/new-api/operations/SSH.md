# PIKNO 生产服务器登录

仓库配置记录的 ECS 地址为 `8.217.68.247`，SSH 用户为 `root`，端口为 `22`。首次登录前，请让项目所有者在云控制台核对实例地址、SSH 用户和 ED25519 主机指纹。当前仓库固定的指纹为 `SHA256:IqtjIIHOc9kQfDvEbrTBgzzoYUTp9K40sP583XRr44c`。

## 取得 SSH 授权

在接手机器上生成专用 SSH 密钥，让项目所有者通过云控制台或已有管理账号登记公钥。已有授权身份可以从所有者指定的密码库取得。私钥应保存在接手机器的受保护目录中。GitHub 仓库访问权和 ECS 登录权分别由所有者授予。

## 验证登录

在仓库根目录打开 PowerShell。将 `$key` 替换为已获授权的本机私钥路径。云控制台确认上述入口仍有效后执行以下命令。

```powershell
$relay = 'PIKNO中转站/deploy/new-api'
$known = (Resolve-Path -LiteralPath (Join-Path $relay 'ecs_known_hosts')).Path
$target = 'root@8.217.68.247'
$key = 'C:/path/to/approved-private-key'

ssh-keygen -lf $known
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes `
    -o ('UserKnownHostsFile="{0}"' -f $known) `
    -o IdentitiesOnly=yes -i $key $target hostname
```

若主机指纹不匹配，请停止并请所有者核查。遇到 `Permission denied (publickey)`，请核对 SSH 用户、公钥登记、私钥路径及本机文件权限。

## 只读核对生产部署

```powershell
python -B "$relay/operations/verify-relay.py" --ecs --ssh-target $target --identity-file $key
```

脚本读取仓库内的项目状态和固定主机公钥，核对公开路由及生产 Docker、数据库状态。它不会发起生成、扣费或付款。省略 `--ecs` 可仅核对公开路由。部署目录先前记录为 `/opt/piknoai-relay/current`，接手后以实际容器的挂载和 Compose 配置为准。
