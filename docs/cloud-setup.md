# 云同步部署指南（Dataverse + SharePoint）

本指南面向**站点管理员**，描述如何配置云同步后端。配置完成后，用户可在前端注册自建账号（用户名 + 密码，无需任何微软账号），把设置、词典、歌词与上传的音频同步到云端。

**未配置云同步时，前端行为与纯本地版本完全一致**（游客模式零影响）；配置不完整时按能力优雅降级（见下文「降级行为」）。

## 架构总览

```
浏览器（本地优先）
├── IndexedDB 仍是工作副本（编辑历史 / 撤销永远纯本地）
├── 登录后：拉取云端 → 与本地按 updated_at 逐曲 last-write-wins 合并
├── 保存时：写本地 + 防抖约 3 秒推送云端
└── 音频：上传一次；下载后缓存进 IndexedDB
        │  HTTPS + Bearer JWT（自建账号）
        ▼
Cloudflare Worker（唯一后端入口，worker/src/）
├── /api/auth/*   注册 / 登录 / 会话（JWT HS256，PBKDF2 密码哈希，登录限速）
├── /api/cloud/*  用户数据 / 歌曲元数据与歌词 JSON
│     │  client credentials（服务主体）
│     ▼
│   Dataverse Web API（结构化数据：账号、配置、词典、歌词）
└── /api/cloud/audio（音频二进制）
      │  client credentials
      ▼
    Microsoft Graph → SharePoint 文档库（Sites.Selected，仅授权站点）
```

- **最终用户不需要任何微软账号**：所有微软侧访问都由 Worker 用服务主体（client credentials）完成。
- Worker 现有的歌词代理路由（`/api/search`、`/api/lyric`、`/api/marumaru/*`）行为不变。

## 降级行为

| 缺失配置 | 表现 |
|----------|------|
| `JWT_SECRET` 或 Dataverse 任一变量缺失 | `/api/auth/*`、`/api/cloud/*` 返回结构化错误（`AUTH_NOT_CONFIGURED` / `CLOUD_NOT_CONFIGURED`），前端顶栏不显示账户按钮，设置里不显示云同步开关 |
| `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` 缺失 | 账号、歌词、配置正常同步；**音频仅本地**，同步指示器显示「已同步（音频仅本地）」 |
| Worker 部署但前端未登录 | 与纯本地版本完全一致 |

## 配置清单（总览）

1. [Entra 应用注册 + 客户端密钥](#1-entra-应用注册)
2. [Dataverse：创建应用用户 + 安全角色](#2-dataverse-应用用户与安全角色)
3. [Dataverse：建表（运行脚本）](#3-建表)
4. [SharePoint：Sites.Selected 站点授权](#4-sharepoint-站点授权)
5. [Worker：vars 与 secrets](#5-worker-配置)
6. [部署与验证](#6-部署与验证)
7. [运维：重置密码 / 调整 PBKDF2 迭代](#7-运维)

---

## 1. Entra 应用注册

在 [Microsoft Entra 管理中心](https://entra.microsoft.com) → **标识** → **应用** → **应用注册** → **新建注册**：

- 名称：如 `JLS Cloud Sync`
- 受支持的帐户类型：**仅此组织目录中的帐户**（单租户）
- 重定向 URI：留空（服务主体不需要）

注册后记下：

| 值 | 用途 |
|----|------|
| **应用程序（客户端）ID** | `DATAVERSE_CLIENT_ID` |
| **目录（租户）ID** | `DATAVERSE_TENANT_ID` |

**API 权限**（应用注册 → API 权限 → 添加权限）：

| API | 权限类型 | 权限 | 是否需要管理员同意 |
|-----|----------|------|--------------------|
| Microsoft Graph | 应用程序权限 | `Sites.Selected` | **是**（点击「代表 {组织} 授予管理员同意」） |

> Dataverse 侧**不需要**添加 Dynamics CRM API 权限：client credentials 场景下访问由第 2 步的应用用户 + 安全角色控制。

**证书或密码**（应用注册 → 证书和密码 → 新客户端密码）：创建后立即复制**值**（离开页面后不可再查）：

| 值 | 用途 |
|----|------|
| 密码**值** | `DATAVERSE_CLIENT_SECRET`（Worker secret） |

## 2. Dataverse 应用用户与安全角色

在 [Power Platform 管理中心](https://admin.powerplatform.microsoft.com) → **环境** → 选择目标环境 → **设置** → **用户 + 权限** → **应用用户**：

1. **新建应用用户** → 选择上一步注册的应用（`JLS Cloud Sync`）→ 创建。
   - 应用用户是**每环境一个**：换环境需重复此步骤。
   - 若报「The user is not a member of the organization」，通常是环境选错或应用用户未建。
2. 为该应用用户分配安全角色（见下）。

### 最小权限安全角色

建议新建专用角色（环境 → 设置 → 用户 + 权限 → 安全角色 → 新建），只勾选以下**用户级**（User）权限：

| 表 | Create | Read | Write | Delete | Append | Append To |
|----|--------|------|-------|--------|--------|-----------|
| `jls_user`（JLS User） | ✓ | ✓ | ✓ | ✓ | | ✓ |
| `jls_user_data`（JLS User Data） | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `jls_song`（JLS Song） | ✓ | ✓ | ✓ | ✓ | ✓ | |

> **Append To（追加到）** 在 `jls_user` 上是必需的：创建带 owner 查找列的行时，平台要求对被引用表具有该权限。缺它会在注册 / 保存时报 403。

把该角色分配给第 1 步创建的应用用户即可。**不要**给应用用户 System Administrator。

## 3. 建表

建表脚本使用 Web API 元数据接口（`EntityDefinitions` / `RelationshipDefinitions`），需要应用用户**临时**具有「系统自定义员（System Customizer）」角色：

1. 给应用用户临时分配 **System Customizer** 角色。
2. 运行脚本（Node 18+，无需安装依赖）：

   ```powershell
   $env:DATAVERSE_TENANT_ID     = "<租户 ID>"
   $env:DATAVERSE_ENV_URL       = "https://<组织>.api.crm.dynamics.com"
   $env:DATAVERSE_CLIENT_ID     = "<客户端 ID>"
   $env:DATAVERSE_CLIENT_SECRET = "<客户端密码>"
   node scripts/create-dataverse-tables.mjs
   ```

   - `DATAVERSE_ENV_URL` 是** API 根**（形如 `https://org12345.api.crm.dynamics.com`，注意 `.api.`），不是 Web 界面地址。
   - 脚本幂等：已存在的表 / 列 / 关系会跳过，可安全重复执行。
   - 默认表前缀 `jls`；若你的发布者前缀不同，加 `--prefix <前缀>`，并在 Worker 配置同名 `DATAVERSE_PREFIX`。
3. 建表完成后**撤销**应用用户的 System Customizer 角色（保留第 2 步的最小权限角色）。

### 表结构参考

逻辑名 / 列名与 Worker 端 `worker/src/cloud.js` 的 `schema()` 约定一致：

**jls_user**（实体集 `jls_users`，每账号一行）

| 列 | 类型 | 说明 |
|----|------|------|
| `jls_userid` | GUID（主键） | 平台自动生成 |
| `jls_username` | String(32)，主名列 | 用户名（3–32 字符；Worker 查重保证唯一） |
| `jls_email` | String(254) | 可选邮箱 |
| `jls_password_hash` | String(512) | PBKDF2-SHA256 哈希（hex） |
| `jls_salt` | String(64) | 16 字节随机盐（hex） |
| `jls_iterations` | Integer | 该账号的 PBKDF2 迭代次数 |
| `createdon` | DateTime | 平台自动 |

**jls_user_data**（实体集 `jls_user_datas`，每账号一行）

| 列 | 类型 | 说明 |
|----|------|------|
| `jls_user_dataid` | GUID（主键） | |
| `jls_name` | String(100)，主名列 | 仅用于后台展示 |
| `jls_owner` | Lookup → jls_user | 所属账号（级联删除）；OData 导航属性名为 `jls_Owner`（保留 SchemaName 大小写），创建行用 `jls_Owner@odata.bind` 绑定，过滤用 `_jls_owner_value` |
| `jls_config_json` | Memo(1048576) | 前端设置 JSON |
| `jls_dictionary_json` | Memo(1048576) | 我的词典 JSON |
| `jls_updated_at` | String(32) | 客户端 epoch 毫秒（LWW 用） |

**jls_song**（实体集 `jls_songs`，每首歌一行）

| 列 | 类型 | 说明 |
|----|------|------|
| `jls_songid` | GUID（主键） | |
| `jls_title` | String(200)，主名列 | 歌名 |
| `jls_song_id` | String(64) | 客户端歌曲 ID（与 IndexedDB 一致） |
| `jls_owner` | Lookup → jls_user | 所属账号（级联删除）；导航属性 `jls_Owner`，绑定 `jls_Owner@odata.bind`，过滤 `_jls_owner_value` |
| `jls_artist` | String(200) | 歌手 |
| `jls_badges` | String(4000) | 列表元数据 JSON（时长 / 徽章 / 音频信息） |
| `jls_lyric_json` | Memo(1048576) | 整曲歌词 JSON（多行文本列上限即 1048576 字符） |
| `jls_audio_path` | String(400) | SharePoint 路径 `Songs/{userId}/{songId}` |
| `jls_updated_at` | String(32) | 客户端 epoch 毫秒（LWW 用） |

> **命名与大小写注意**：owner 查找列的 OData **导航属性名**保留 Lookup SchemaName 的大小写，
> 即 `{prefix}_Owner`（如 `jls_Owner`）——创建行必须用 `jls_Owner@odata.bind` 绑定注解
> （OData 绑定大小写敏感，小写 `jls_owner` 会报 400 "undeclared property"）；
> 而过滤用的**结构属性** `_jls_owner_value` 是小写。大 JSON 列（config / dictionary / lyric）
> 必须用 Memo（多行文本）类型：自定义 String 列上限 4000 字符，与格式无关。

## 4. SharePoint 站点授权

音频经 Graph API 存入 SharePoint 文档库，使用 **Sites.Selected** 场景：应用只能访问被显式授权的站点。

1. 准备一个 SharePoint 站点与文档库（可复用现有站点，建议专用站点如 `/sites/JLS`）。
2. **临时**给应用添加 Graph 应用程序权限 `Sites.FullControl.All` 并管理员同意（授权动作本身需要它；完成后移除，仅保留 `Sites.Selected`）。
3. 运行授权脚本（自动解析站点 ID、授予 write 权限、列出文档库 ID）：

   ```powershell
   $env:DATAVERSE_TENANT_ID     = "<租户 ID>"
   $env:DATAVERSE_CLIENT_ID     = "<客户端 ID>"
   $env:DATAVERSE_CLIENT_SECRET = "<客户端密码>"
   node scripts/grant-sharepoint-site.mjs --site "contoso.sharepoint.com:/sites/JLS"
   ```

   输出形如：

   ```
   站点：JLS（https://contoso.sharepoint.com/sites/JLS）
     SHAREPOINT_SITE_ID = 1a2b...,3c4d...
   已授予应用站点「write」权限（可读写站点内文件）。
   文档库（任选其一作为 SHAREPOINT_DRIVE_ID）：
     Documents             SHAREPOINT_DRIVE_ID = b1c2...
   ```

4. 记下 `SHAREPOINT_SITE_ID` 与 `SHAREPOINT_DRIVE_ID`，回到应用注册移除 `Sites.FullControl.All`。
5. （可选）撤销授权：`node scripts/grant-sharepoint-site.mjs --site <站点> --revoke`。

> 不想配置音频存储？跳过本节即可——Worker 检测到 `SHAREPOINT_*` 缺失时，音频同步自动降级为仅本地，其余功能不受影响。

## 5. Worker 配置

本仓库有两份 wrangler 配置，对应两种部署形态：

| 配置 | Worker 名 | 形态 |
|------|-----------|------|
| 根目录 `wrangler.jsonc` | `jp-lyrics-sing-dev` | Worker + 静态资产（`public/`），`/api/*` 走 Worker，其余走静态 |
| `worker/wrangler.jsonc` | `jp-lyrics-proxy` | 纯代理（前端托管在 GitHub Pages 等） |

**给实际部署的那份配置**添加 vars（明文，非机密）：

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://<你的前端域名>,http://localhost:8765",
  "DATAVERSE_TENANT_ID": "<租户 ID>",
  "DATAVERSE_ENV_URL": "https://<组织>.api.crm.dynamics.com",
  "DATAVERSE_CLIENT_ID": "<客户端 ID>",
  "SHAREPOINT_SITE_ID": "<站点 ID>",
  "SHAREPOINT_DRIVE_ID": "<文档库 ID>"
}
```

- 前端与 Worker 不同源时，务必把前端域名加进 `ALLOWED_ORIGINS`（云路由额外放行同源与 localhost）。
- `DATAVERSE_PREFIX`（可选，默认 `jls`）：建表用了其他前缀时设置。
- `PBKDF2_ITERATIONS`（可选，默认 `100000`）：见下文「CPU 限制」。

**secrets**（机密，用 wrangler 设置，不进仓库）：

```powershell
npx wrangler secret put DATAVERSE_CLIENT_SECRET --name <worker名>
npx wrangler secret put JWT_SECRET --name <worker名>
```

- `JWT_SECRET`：至少 32 字符的随机串，例如 PowerShell 生成：`-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })`。
- 换 `JWT_SECRET` 会使所有已登录用户立即登出（可用于紧急踢下线）。

本地开发：复制 `worker/.dev.vars.example` 为 `worker/.dev.vars`（已被 .gitignore 忽略）填入同样的值，`npx wrangler dev` 即可。

## 6. 部署与验证

```powershell
cd worker        # 或仓库根目录（资产形态）
npx wrangler deploy
```

按顺序验证（把 `<WORKER>` 换成部署地址）：

```powershell
# 1. 状态：三个布尔都应为 true（未配 SharePoint 时 sharepoint=false 属预期）
curl https://<WORKER>/api/cloud/status
# → {"cloud":{"dataverse":true,"auth":true,"sharepoint":true}}

# 2. 注册
curl -X POST https://<WORKER>/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{"username":"tester","password":"test12345"}'
# → {"token":"...","user":{"id":"...","username":"tester","email":null}}

# 3. 会话
curl https://<WORKER>/api/auth/me -H "Authorization: Bearer <token>"

# 4. 用户数据
curl -X PUT https://<WORKER>/api/cloud/user-data -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" -d '{"configJson":"{}","dictionaryJson":"{}"}'

# 5. 歌曲列表
curl https://<WORKER>/api/cloud/songs -H "Authorization: Bearer <token>"

# 6. 原有代理路由不受影响
curl "https://<WORKER>/api/search?keyword=テスト"
```

最后打开前端页面：顶栏出现账户按钮 → 注册 / 登录 → 首次登录会询问「上传本地数据到云端」→ 同步指示器显示「已同步」。

## 7. 运维

### 重置用户密码

```powershell
node scripts/reset-password.mjs <用户名> [新密码]
```

- 省略新密码时随机生成并打印。
- 旧 JWT 在过期前（最长 30 天）仍有效；需立即失效请更换 `JWT_SECRET`。

### PBKDF2 迭代次数与 CPU 限制

密码哈希默认 PBKDF2-SHA256 **100000** 次迭代。**免费版 Workers 每请求约 10ms CPU**，注册 / 登录时哈希计算可能超限（表现为 `1102 Worker exceeded CPU time` 或请求被杀）。两种解法：

- 调低迭代：`"PBKDF2_ITERATIONS": "10000"`（vars）。**只影响新注册账号**——已有账号按行内存储的 `jls_iterations` 验证；如需统一调低，用 `reset-password.mjs --iterations 10000` 重置存量账号。
- 升级 Workers 付费版（CPU 上限大幅提高），保持 100000。

### 登录限速

按「用户名 + IP」内存限速：15 分钟窗口内 10 次失败后返回 `429 RATE_LIMITED`（带 `Retry-After`）。Worker 实例重启或多实例部署时计数会重置，属尽力而为防护。

### 数据位置与删除

- 结构化数据在 Dataverse 环境所在区域；音频在 SharePoint 站点所在区域。
- 删除账号：删除 `jls_user` 行会级联删除其 `jls_user_data` 与 `jls_song` 行；音频文件需另行从文档库 `Songs/{userId}/` 删除（或整站删除时随站点消失）。

## 故障排查

| 现象 | 原因 / 处理 |
|------|-------------|
| `/api/cloud/status` 返回 `dataverse:false` | vars 未配置或拼错；`DATAVERSE_ENV_URL` 应为 `https://<组织>.api.crm.dynamics.com` |
| 注册 / 登录报 `CLOUD_REQUEST_FAILED`，正文含 `The user is not a member of the organization` | 目标环境没有该应用的应用用户（第 2 步） |
| 写入报 403 / `Principal user is missing privileges` | 安全角色缺权限；注意 `jls_user` 需要 **Append To** |
| 建表脚本报 403 | 应用用户缺 System Customizer 角色（建表期间临时授予） |
| 音频上传报 `AUDIO_NOT_CONFIGURED` | `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` 未配置（预期降级） |
| 音频上传报 403 | Sites.Selected 未授予该站点，或授权后移除了 `Sites.Selected` 权限本身 |
| 注册 / 登录偶发失败、无响应体 | CPU 超限 → 调低 `PBKDF2_ITERATIONS`（见上） |
| 前端跨域报错 | 前端域名不在 `ALLOWED_ORIGINS` |
| 歌词保存报 413 | 单曲歌词 JSON 超过 1048576 字符（Dataverse 多行文本列上限） |
