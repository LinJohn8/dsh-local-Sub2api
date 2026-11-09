# dsh-local-sub2api

把 [Sub2API](https://github.com/Wei-Shaw/sub2api) 本地版内嵌到 DeepSeek Harness 的插件。

打开 DeepSeek Harness 时，插件会在本机自动启动一套私有的 Sub2API 服务（Sub2API + PostgreSQL + Redis，全部使用官方 Docker 镜像、只监听 `127.0.0.1`），并在 Harness 左侧栏添加一个 **Local Sub2api** 按钮。点击按钮后，右侧主面板直接显示 Sub2API 原本的管理界面，并且已经自动登录为本地管理员，不需要用户名密码、不需要公网服务器。

Sub2API 自身的上游账号、分组、渠道、API Key 等配置仍然在它自己的界面里完成（插件不会也不能替你填这些凭据）。

## 功能

- 随 DeepSeek Harness 启动而自动启动本地 Sub2API（可配置关闭）。
- Docker Desktop 没启动时，插件会尝试自动启动它，然后等待引擎就绪。
- 左侧栏按钮 **Local Sub2api** → 主面板内嵌 Sub2API 管理界面（iframe）。
- 自动登录：插件用本地生成的管理员账号调用 Sub2API 登录接口，把会话注入管理界面，界面打开即已登录。
- 管理界面内的所有原有功能都保留（账号、分组、密钥、模型广场、日志……）。
- 面板顶部状态栏：运行状态、刷新、停止、重启、在系统浏览器中打开。
- 中文/英文界面文案；跟随 Harness 的浅色/深色外观（内嵌界面会收到主题偏好）。
- 只监听本机回环地址，不对外网开放，也不依赖任何远程服务器。
- **适配现有厂商**：栈就绪后会自动把你已有的 OpenAI 兼容厂商（如皮卡丘中转、DSh Our Free Model、Qoder 中国版免费 Qwen3.8-Flash）作为上游账号接入 Sub2API，开箱即用。

## 环境要求

- Windows + 已安装 **Docker Desktop**（需要 WSL2 后端；插件会检查并尝试启动它）。
- 首次启动需要从 Docker Hub 拉取镜像（约 250 MB，取决于网络）。
- 端口 `18080`（Sub2API 本体）和 `18081`（供 Harness 内嵌的本地代理）在本机可用。
- 之后的服务启动通常几秒到几十秒。

## 使用

1. 打开 DeepSeek Harness。插件自动开始准备环境。
2. 左侧栏出现 **Local Sub2api** 按钮（侧栏展开时显示文字，收起时显示图标）。
3. 点击后进入面板：
   - 状态为“运行中”时自动显示 Sub2API 管理界面；
   - 首次启动会显示“启动中…”，等镜像拉取和数据库迁移完成即可；
   - 失败时面板会显示错误原因和重试按钮。
4. 在 Sub2API 界面里添加上游账号/分组/API Key。
5. 本机其它程序使用 Sub2API 提供的接口时，地址是 `http://127.0.0.1:18080`（例如 OpenAI 兼容接口 `http://127.0.0.1:18080/v1`），Key 用界面里创建的 `sk-...`。

## 设置页（推荐）

打开 **设置 → 本地 Sub2api**，有两个开关：

| 开关 | 作用 | 默认 |
| --- | --- | --- |
| **服务开关** | 立刻启动 / 停止本地 Sub2API 服务，并显示当前是「运行中」还是「已停止」 | 停止（不自动起） |
| **打开 Harness 时自动启动** | 记录下次打开 DeepSeek Harness 时是否自动拉起服务 | **关** |

两个开关都持久化在 `<dataDir>/preferences.json`，**不需要改 YAML、不用重载插件**。设置页里的开关优先于 `cordis.patch.yml` 的 `autoStart`；想恢复「以 YAML 为准」，删掉 `preferences.json` 即可。

## 配置

插件行 id 是 `local-sub2api`。在 Harness 配置目录的 `cordis.patch.yml`（本机为 `C:\Users\86158\.dsh\cordis.patch.yml` 或对应 profile 的 `cordis.patch.yml`）里覆盖同 id 行即可：

```yaml
- id: local-sub2api
  config:
    autoStart: false           # 随 Harness 自动启动本地服务（默认关闭）
    autoStartDocker: true      # Docker Desktop 未运行时尝试自动启动
    sub2apiPort: 18080         # Sub2API 本机端口
    proxyPort: 18081           # 内嵌面板使用的本地代理端口
    image: weishaw/sub2api:0.2.19   # 升级时改这里
    runMode: simple            # simple=本地单用户（隐藏 SaaS/计费）；standard=完整功能
    stopOnUnload: false        # 关闭 Harness 时是否停止容器
    # dataDir: 'D:\\dsh-sub2api'      # 自定义运行目录
    # dockerCommand: 'docker'
    # dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
```

修改 `sub2apiPort` / `image` 后，插件下次启动会重建对应容器；`proxyPort` 被占用时插件会自动顺延到下一个空闲端口，并在面板状态里显示实际端口。

## 适配现有厂商（model-vendor adapter）

很多 DeepSeek Harness 用户已经有现成的模型厂商：自家转发的 OpenAI 兼容网关（如 Our Free Model 的本地转发），或第三方中转（如皮卡丘中转 `https://sub.pikaqiu.shop/v1`）。这个插件会在本地 Sub2API 就绪并登录后，**自动把这些厂商作为 Sub2API 的上游账号接入**——你既有账号不错、又能在 Sub2API 统一管理和转发。

接入项通过 `adapterProviders` 配置，每项是一个 OpenAI 兼容端点（`platform: openai` + `type: apikey`，用 `baseUrl` + `apiKey` 透传）。默认内置三项：

```yaml
adapterProviders:
  pikaqiu:
    name: 皮卡丘中转                 # Sub2API 里的账号名（幂等：按名字查重）
    platform: openai
    type: apikey
    baseUrl: https://sub.pikaqiu.shop/v1
    apiKeySource: refs:PIKAQIU_API_KEY   # 密钥来源，见下
    concurrency: 3
    priority: 50
  our-free-model:
    name: DSh Our Free Model
    platform: openai
    type: apikey
    # 容器内要访问宿主机回环网关，必须用 host.docker.internal（127.0.0.1 是容器自己）
    baseUrl: http://host.docker.internal:8326/v1
    apiKeySource: file:openai-gateway\api-key
    concurrency: 3
    priority: 50
  qodercn:
    name: Qoder CN Qwen3.8-Flash     # Qoder 中国版免费 Qwen3.8-Flash
    platform: openai
    type: apikey
    baseUrl: http://host.docker.internal:8326/v1
    apiKeySource: file:openai-gateway\api-key
    concurrency: 3
    priority: 50
```

> **默认账号说明**
> - `our-free-model` 与 `qodercn` 都复用本机 channel-pack 的同一个 OpenAI 兼容网关（宿主机回环 `8326`，可用 `DSH_OPENAI_GATEWAY_PORT` 覆盖；密钥文件 `~/.dsh/openai-gateway/api-key`）。Sub2API 容器通过 Docker Desktop 的 `host.docker.internal` 访问它。
> - `qodercn` 就是 **Qoder 中国版（qoder.cn）的免费 Qwen3.8-Flash**：它在 channel pack 里是 `qfmodel`（`isFree=true`、`priceFactor=0`，不消耗积分、不限流），网关对外模型名是 **`qodercn/qfmodel`**——在 Sub2API 里用这个账号调用时，`model` 要填 `qodercn/qfmodel`。


### 密钥来源（`apiKeySource`）

适配器只在本机解析密钥，**绝不写回插件包或 git**，只通过回环 API 写入本机 Sub2API 数据库。三种写法：

| 写法 | 说明 | 示例 |
| --- | --- | --- |
| `env:NAME` | 读环境变量 | `env:PIKAQIU_API_KEY` |
| `refs:NAME` | 读 DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs` 项 | `refs:PIKAQIU_API_KEY` |
| `file:PATH` | 读一个本地文件的第一行（相对路径基于 `~/.dsh`） | `file:openai-gateway\api-key` |

某个厂商的密钥解析不到时，该厂商会被跳过（状态里显示 `skipped`），**不影响**插件启动和其余厂商的接入。

### 手动触发

栈就绪后会自动接入一次。也可以随时手动触发（例如补上密钥后重试）：

```powershell
Invoke-RestMethod http://127.0.0.1:54922/local-sub2api/action -Method Post -ContentType 'application/json' -Body '{"action":"provision-providers"}' | ConvertTo-Json
```

### 注意

- **Our Free Model 需要先启用它的本地转发**（设置的 `forward.enabled` 为 `true`），否则 `127.0.0.1:18899` 没有在监听、Sub2API 连不上。默认配置假定端口是 `18899`（被占用时会顺延，请按实际转发端口修改 `baseUrl` 里的端口）。
- 关闭自动接入可把 `adapterAutoProvision: false`；彻底关闭把 `adapterEnabled: false`。

## 数据与凭据

运行目录默认是 `%USERPROFILE%\.dsh\local-sub2api`（跟随 `DSH_HOME`）：

| 路径 | 内容 |
| --- | --- |
| `docker-compose.local.yml` | 插件生成的 compose 文件（每次启动重写） |
| `.env` | 自动生成的管理员账号、数据库密码、JWT 密钥（**敏感，不要外传**） |
| `data/sub2api` | Sub2API 配置与数据 |
| `data/postgres` | PostgreSQL 数据 |
| `data/redis` | Redis 数据 |

想直接用浏览器访问 Sub2API（不经 Harness）时：打开 `http://127.0.0.1:18080`，用 `.env` 里的 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录。插件生成的管理员账号只用于本机。

## 日常操作 / 排查

```powershell
# 查看状态（Harness 运行时）
Invoke-RestMethod http://127.0.0.1:54922/local-sub2api/status | ConvertTo-Json

# 容器状态与日志
docker ps --filter name=dsh-local-sub2api
docker logs -f dsh-local-sub2api

# 手动停掉整套服务（插件停止按钮之外）
docker compose -f "$env:USERPROFILE\.dsh\local-sub2api\docker-compose.local.yml" down

# 完全重置本地数据（会丢失所有 Sub2API 配置/账号）
docker compose -f "$env:USERPROFILE\.dsh\local-sub2api\docker-compose.local.yml" down
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\local-sub2api\data"
```

常见问题：

- **提示 Docker 不可用**：打开 Docker Desktop，等它显示 “Engine running”，再点面板里的重试。Docker 的 WSL2 后端缺失时需先在 Docker Desktop 设置里启用。
- **端口被占用**：面板错误会提示；改 `sub2apiPort` 或 `proxyPort` 后重试。
- **首次启动很慢**：在拉镜像 / 跑数据库迁移，正常现象；可看 `docker logs`。
- **面板里显示登录页**：说明自动登录失败（例如有人改过管理员密码）。此时用 `.env` 里的账号登录一次，或在面板点重启；也可以删除 `.env` 让插件重新生成管理员（同时清空 `data` 目录才生效）。

## 卸载

在 Harness 的 插件 / Plugins 页面里停用并移除 `dsh-local-sub2api` 即可。容器不会自动删除，按上面 `docker compose down` 清理；数据目录可保留用于以后恢复。

## 说明与限制

- 内嵌的是 Sub2API 自己的 Web 界面（第三方页面），它不读取 Harness 的 DOM 或组件，因此 Harness 的主题变量只通过注入的主题偏好间接生效；界面外观以 Sub2API 自身为准。
- 本地代理会去掉 Sub2API 返回的 `X-Frame-Options` / CSP `frame-ancestors`，否则它不允许被 iframe 内嵌；这是内嵌所必需的，代理只监听 `127.0.0.1`。
- 自动登录依赖插件管理的管理员账号；如果你在 Sub2API 里修改了管理员密码，需要同步修改 `.env` 或让插件重新生成（见上）。
- `runMode: simple` 会隐藏 Sub2API 的多用户/SaaS/付费相关功能，适合本机单人使用；需要完整功能改成 `standard`。
- 本插件不实现 Harness 内的 Sub2API 设置表单；Sub2API 的接口/上游配置仍在其自身界面完成。
