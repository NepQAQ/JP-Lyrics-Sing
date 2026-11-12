# 日语跟唱 (JP Lyrics Sing)

一个纯前端的日语歌曲跟唱练习与学习工具：曲库管理、歌词编辑、逐字 KTV 高亮、假名 / 罗马音注音、单句循环练习、编辑历史撤销，全部在浏览器本地完成，无需后端服务器。

> **界面与功能来源**：本版界面与功能整体移植自 [WaterEmissary/jp-lyrics-studio](https://github.com/WaterEmissary/jp-lyrics-studio)——由本项目（JP Lyrics Sing）衍生重构的姊妹项目，两作者已沟通并达成一致。衍生版原为 Python FastAPI + SQLite 后端；本仓库保留其前端界面与新功能，但**不引入 Python 服务器**，持久化与在线歌词源全部改为纯客户端实现（详见下文「架构说明」）。

## 主要功能

| 类别 | 功能 |
|------|------|
| 曲库 | 左侧曲库列表（筛选 / 徽章：有音频、同步/估算时间轴、手动修改行数）；歌曲信息编辑；更换/删除音频；删除歌曲 |
| 本地导入 | 一次选择 / 拖入多个文件，按扩展名 → MIME → 文件头 / 文本内容自动识别「歌曲」与「歌词」（识别错可手动改）；多首歌一起导入时按文件名自动配对；NCM 在浏览器 Web Worker 中还原并读取歌名/歌手；歌名优先级：NCM 元数据 > LRC `[ti]/[ar]` > 文件名 `歌手 - 歌名`；无歌词时导入后自动打开联网搜索 |
| 联网歌词 | 网易云（经自建 Worker 代理，含翻译 / 逐字 yrc）、LRCLIB（同步 / 纯文本）、曲库内搜索；结果可「新建到曲库」或「绑定到当前歌曲（保留已上传音频）」；同来源同 ID 去重 |
| 自动补充 | 逐字时间轴（网易云 yrc 优先，PetitLyrics 兜底，本地导入的歌也会自动获取一次）；Marumaru 注音（演唱读法）+ 中文；MyMemory 机器翻译补全中文 |
| 播放 | 本地音频 / 计时器（配合外部播放器）两种音源；全局倍速 0.5–1.5×（变速保持音高，可关）；歌词偏移 ±0.1s 微调与一键「对齐」（A）；单句播放 / 单句循环（起止按逐字时间或音拍估算，不会切进下一句）；上/下一句；逐字 KTV 进度（无逐字数据时按音拍加权）；跟唱模式自动居中 |
| 打轴 | 纯文本歌词边听边按 `T` 给每句打时间，完成后时间轴变为「同步」 |
| 分词显示 | kuromoji 分词后按「文节」组合成单词（`風に`、`触った`、`中で`）；单词样式：边框 / 交替底色 / 下划线 / 无，可「仅长句启用」；布局：分行（原文 / 罗马音 / 中文）或逐词对照（每个词竖排：注音-汉字-罗马音）；悬停原文词 ↔ 罗马音词互相高亮 |
| 编辑 | 编辑模式（E）：点选单词，Shift 多选 → 合并 / 拆分 / 5 色高亮 / 边框 / 连读 / 停顿 / 备注 / 声调；行编辑器（双击行或 ✎）：原文、时间、字间切分、逐词假名（平/片假名）、逐词罗马音、整行罗马音覆盖、中文；全文编辑（LRC）；编辑可同步到本曲相同歌词（副歌） |
| 持久化 | 所有修改保存在浏览器本地（IndexedDB）；修改历史可逐条撤销（同一次操作同步的多行作为一组撤销；全文编辑前自动快照）；我的词典：自定义词与读音，自动分词时整体识别，对所有歌曲生效 |
| 其它 | 学习模式（任意日语句子分词注音 + 朗读，多音色 TTS）；导出 TXT（原文/分词/假名/罗马音/中文任意组合）与 LRC；浅色/深色/跟随系统；字号缩放；移动端适配；快捷键 |

快捷键：`空格` 播放/暂停 · `←/→` 上/下一句 · `[ / ]` 降速/升速 · `R` 单句循环 · `A` 对齐（在某句刚开始唱时按）· `E` 编辑模式 · `T` 打点（打轴中）· `Esc` 取消选中 · 行编辑器 `Ctrl+Enter` 保存。

## 架构说明

本项目为**零构建纯前端**（原生 ES Modules，无 npm / 无打包步骤），可直接静态托管：

```
浏览器（全部逻辑）
├── public/js/*.js        16 个 ES Modules（曲库 / 播放 / 编辑 / 搜索 / 导出 / 学习…）
├── public/js/api.js      数据层：IndexedDB + localStorage 持久化、LRC 解析、在线源请求
├── public/ncm-worker.js  NCM 本机还原（Web Worker）
├── public/lib/           kuromoji.js、kuroshiro、aes-js（NCM）
└── public/dict/          kuromoji IPADIC 词典（长缓存）

Cloudflare Worker（可选，同仓库 worker/，部署在
https://jp-lyrics-proxy.nepqaq.workers.dev）
└── /api/search、/api/lyric          网易云歌词（yrc 逐字 / tlyric 翻译 / yromalrc 罗马音）
    /api/marumaru/search、/api/marumaru/lyric   Marumaru 注音歌词页代理
```

与衍生版 jp-lyrics-studio（Python FastAPI + SQLite）的差异：

- **持久化**：衍生版存服务端 SQLite；本版改为纯客户端——设置存 `localStorage`，歌曲 / 歌词行 / 编辑历史 / 快照 / 我的词典 / 音频（Blob）全部存浏览器 `IndexedDB`。数据模型（Song / Line / Word）与衍生版一致。
- **音频**：衍生版由服务器 FileResponse（HTTP Range）提供；本版音频以 Blob 存 IndexedDB，播放时生成 object URL，进度拖动由浏览器本地解码支持，不上传任何文件。
- **在线歌词源**：衍生版经 Python 服务端转发；本版改为浏览器直连（LRCLIB / PetitLyrics / MyMemory / TTS 均允许 CORS）+ 自建 Cloudflare Worker 代理（网易云 / Marumaru 无 CORS 头，必须经代理）。
- **LRC 解析 / 生成**：衍生版在服务端 lrc.py；本版在客户端 api.js 内实现（含双语行合并、纯文本合成时间轴）。

## 第三方服务一览

本应用为纯前端项目，所有功能通过浏览器直接调用以下第三方服务实现，无需后端服务器。

### CDN 资源

| 服务 | 用途 | 是否必须 |
|------|------|----------|
| [Google Fonts](https://fonts.googleapis.com/) | 加载 Inter、Noto Sans JP/SC、Zen Maru Gothic 字体 | 否（缺失时回退系统字体） |
| [unpkg CDN](https://unpkg.com/) | 加载 kuromoji、kuroshiro、kuroshiro-analyzer-kuromoji 库 | 是（假名/罗马音生成依赖） |

### 歌词与时间轴

| 服务 | 端点 | 用途 | CORS | 是否必须 |
|------|------|------|------|----------|
| [LRCLIB](https://lrclib.net/) | `GET https://lrclib.net/api/search` | 歌词搜索，返回多个候选结果（含行级时间轴、纯文本歌词、元数据） | 允许 | 是（主搜索入口） |
| 网易云歌词代理（自建 Worker） | `GET {PROXY}/api/search`、`GET {PROXY}/api/lyric` | 网易云歌词：`yrc` 逐字时间轴、`tlyric` 人工中文翻译、`yromalrc` 罗马音 | 由 Worker 提供 | 否（不可用时自动回退 LRCLIB） |
| [PetitLyrics](https://petitlyrics.com/) | `POST https://p0.petitlyrics.com/api/GetPetitLyricsData.php` | 获取 Type 3 逐字时间轴（每个字都有 starttime/endtime），用于 KTV 式渐变高亮 | 允许 (`*`) | 否（无数据时回退线性估算） |
| [marumaru-x.com](https://www.marumaru-x.com/) | `GET {PROXY}/api/marumaru/search/<关键词>`、`GET {PROXY}/api/marumaru/lyric?url=...` | 搜索带 ruby 注音的日文歌词页，获取注音、罗马音和中文翻译（Worker 代理解析） | 由 Worker 提供 | 否（补充来源，国内直连） |

### 翻译

| 服务 | 端点 | 用途 | 是否必须 |
|------|------|------|----------|
| [MyMemory](https://mymemory.translated.net/) | `GET https://api.mymemory.translated.net/get` | 日语歌词自动翻译为中文 | 否（仅在开启「自动翻译」时调用） |

### 语音合成 (TTS)

| 服务 | 端点 | 用途 | 调用优先级 |
|------|------|------|------------|
| [百度翻译 TTS](https://fanyi.baidu.com/) | `GET https://fanyi.baidu.com/gettts?lan=jp` | 日语朗读 | 1（中国区优先） |
| [有道词典 TTS](https://dict.youdao.com/) | `GET https://dict.youdao.com/dictvoice?le=jap` | 日语朗读 | 2（中国区兜底） |
| [VOICEVOX (tts.quest)](https://tts.quest/) | `GET https://api.tts.quest/v3/voicevox/synthesis` | 多声线日语朗读（青山龍星、玄野武宏、春日部つむぎ等） | 3（指定声线时使用） |
| [Google Translate TTS](https://translate.google.com/) | `GET https://translate.google.com/translate_tts?tl=ja` | 日语朗读 | 4（海外兜底） |
| 浏览器 Web Speech API | 内置 `speechSynthesis` | 系统日语语音朗读 | 5（最终兜底，需系统安装 ja-JP 语音） |

## 网易云歌词源（自建 Cloudflare Worker）

网易云的歌词接口不带 CORS 头，浏览器无法直接读取，因此本项目附带一个可选的轻量代理 `worker/`，部署在 Cloudflare Workers 上。部署一次后，访客无需任何配置。

搜索时会同时请求「网易云歌词」与「LRCLIB」两个来源，先到先显示；网易云不可用时自动回退到 LRCLIB，不影响原有功能。

网易云来源相对 LRCLIB 的优势：

- `yrc` 逐字时间轴（不是每首歌都有，没有时回退到行级时间轴 + PetitLyrics 匹配）；
- `tlyric` / `ytlrc` 人工中文翻译，与歌词行同源，天然对齐；
- `yromalrc` 罗马音。

前端默认指向已部署的代理地址，可用以下方式覆盖或关闭：

```js
// 浏览器控制台执行，改为本地调试用的 Worker
localStorage.setItem('jplrc-proxy-base', 'http://127.0.0.1:8787');

// 临时关闭网易云来源，只走 LRCLIB
localStorage.setItem('jplrc-proxy-off', '1');

// 恢复默认
localStorage.removeItem('jplrc-proxy-base');
localStorage.removeItem('jplrc-proxy-off');
```

自行部署 Worker：

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

部署后把 `wrangler.jsonc` 里的 `ALLOWED_ORIGINS` 改成你自己的站点域名（已默认允许 localhost 任意端口）。

## 云同步（可选）

Worker 可扩展为云同步后端：用户在前端注册**自建账号**（用户名 + 密码，无需任何微软账号），把设置、我的词典、歌词与上传的音频同步到云端。架构与数据流：

```
浏览器（本地优先，IndexedDB 仍是工作副本）
        │  自建账号 JWT（Bearer）
        ▼
Cloudflare Worker（唯一后端入口）
├── /api/auth/*、/api/cloud/*   账号 / 配置 / 词典 / 歌词
│     └─ 服务主体（client credentials）→ Dataverse Web API
└── /api/cloud/audio            音频二进制
      └─ 服务主体 → Microsoft Graph → SharePoint 文档库（Sites.Selected）
```

特性：

- **本地优先**：未登录时与纯本地版本完全一致；登录后拉取合并（逐曲按 `updated_at` last-write-wins），保存时写本地并防抖约 3 秒推云端；编辑历史 / 撤销永远纯本地。
- **音频**：上传一次、下载后缓存进 IndexedDB；未配置 SharePoint 时音频仅本地，其余照常同步（UI 明示）。
- **零构建不变**：前端仍是原生 ES Modules，无构建步骤。
- **优雅降级**：云端未配置时前端不显示任何云同步 UI，游客模式零影响。

自建部署需要配置 Entra 应用注册、Dataverse 应用用户与安全角色、SharePoint 站点授权（Sites.Selected）及 Worker secrets，完整步骤见 **[docs/cloud-setup.md](docs/cloud-setup.md)**；配套管理脚本在 `scripts/`（建表、SharePoint 授权、重置密码）。

## 快速开始

推荐用本地静态服务器打开，避免浏览器在 `file://` 下拦截词典或接口请求。

```powershell
python -m http.server -d public 8000
```

然后访问 `http://localhost:8000`。也可以使用 Node 静态服务：`npx serve public`。

## 数据存储说明

默认所有数据保存在**当前浏览器**中（不经过任何服务器）：

- `localStorage`：界面设置（主题、字号、显示开关、倍速、音色等）。
- `IndexedDB`（库名 `jp-lyrics-studio`）：歌曲与歌词行、编辑历史与快照、我的词典、音频文件（Blob）。

因此：换浏览器 / 换设备 / 清除站点数据后曲库会清空；重要歌曲请用「导出 LRC」备份。音频以 Blob 形式存储，播放时生成 object URL，支持进度拖动，但大音频文件会占用浏览器存储配额（通常数百 MB 起，各浏览器不同）。

开启**云同步**（见上文「云同步」一节）后：设置、词典、歌词与音频会同步到云端（Dataverse + SharePoint，经自建 Worker），本地 IndexedDB 仍是工作副本，编辑历史与撤销保持纯本地。

## 本地 NCM 文件

在导入时选择 `.ncm` 文件，网页通过本地 Web Worker 还原原始音频并读取歌名 / 歌手元数据，全程在本机完成，不上传文件。原始 MP3 会直接作为 MP3 播放；其他格式保持原样，不进行有损转码，也不保证所有浏览器均支持。

NCM 算法参考 [ncmdump-js](https://github.com/ant-cave/ncmdump-js/tree/aa127b694a8cf151d2cc03bf89a439f4c6298dc1)，AES 实现使用 [aes-js 3.1.2](https://github.com/ricmoo/aes-js/tree/v3.1.2)，均为 MIT 许可，完整版权和许可文本见 `public/lib/NCM-LICENSES.txt`。

## 技术说明

| 功能 | 实现 |
|------|------|
| 页面结构 | 原生 HTML / CSS / JavaScript（ES Modules，零构建） |
| 数据层 | `public/js/api.js`：IndexedDB（歌曲/行/历史/快照/词典/音频）+ localStorage（设置） |
| 分词与注音 | kuroshiro + kuromoji，词典文件放在 `public/dict/`，库通过 unpkg CDN 加载 |
| 罗马音 | kuroshiro Hepburn 转写，失败时使用内置 kana fallback |
| 歌词搜索 | LRCLIB API（浏览器直连）+ 网易云（Worker 代理） |
| 逐字时间轴 | 网易云 yrc（Worker 代理）优先，PetitLyrics API（Type 3）兜底 |
| KTV 渐变高亮 | CSS `background-clip: text` + `linear-gradient` + `requestAnimationFrame` |
| 歌词注音补充 | marumaru-x.com 歌词页，经自建 Worker 代理抓取解析（国内直连） |
| 中文翻译 | MyMemory 免费翻译 API（浏览器直连） |
| 学习模式朗读 | 百度/有道优先，VOICEVOX / tts.quest 多声线兜底，最后回退 Web Speech ja-JP |
| 音频播放 | 原生 `<audio>`（IndexedDB Blob → object URL）、手动计时器 |
| LRC 导入/导出 | 客户端解析 / 生成（含双语行合并、纯文本合成时间轴） |

## 项目结构

```text
.
├── public/               # 静态前端（零构建，可直接托管）
│   ├── index.html        # 单页：顶栏、曲库侧栏、歌词区、学习区、播放条、所有 <dialog>
│   ├── css/app.css       # 全部样式（:root 颜色 token，深色模式只改 token）
│   ├── js/               # 16 个 ES Modules（api / state / main / library / song / player /
│   │                     #   render / editor / search / timing / analyzer / kana / study /
│   │                     #   export / tts / util）
│   ├── ncm-worker.js     # NCM 还原 + 元数据解密（Web Worker）
│   ├── lib/              # kuromoji.js、kuroshiro、aes-js、NCM-LICENSES.txt
│   └── dict/             # kuromoji IPADIC 词典（长缓存）
├── worker/               # Cloudflare Worker 代理（网易云 / Marumaru）+ 云同步后端
│   └── src/              #   index.js（代理路由）、cloud.js（云同步路由）、auth.js（JWT/PBKDF2）、
│                         #   dataverse.js、graph.js、http.js
├── scripts/              # 云同步管理脚本（建表 / SharePoint 授权 / 重置密码）
├── docs/                 # cloud-setup.md：云同步部署指南
├── tests/                # node --test 离线回归（ncm-worker、云同步）
├── entry.js              # Worker 入口（wrangler 引用）
└── wrangler.jsonc        # Worker 部署配置（静态资产指向 public/）
```

## 部署

前端是纯静态项目，可部署到 GitHub Pages、Vercel、Netlify、Cloudflare Pages 等平台（输出目录 `public/`，构建命令留空）。Worker 部署见上文「网易云歌词源」一节。

## 已知限制

- 未开启云同步时，所有数据仅存当前浏览器，清除站点数据或换设备后曲库清空；重要歌曲请导出 LRC 备份（开启云同步后可跨设备恢复，见「云同步」一节）。
- 首次生成假名需要加载 kuromoji 词典，可能需要等待几秒。
- 直接双击打开 `index.html` 时，部分浏览器可能拦截本地词典请求；建议使用本地服务器。
- PetitLyrics 逐字时间轴为日本曲库，非日语歌曲可能无数据；此时回退到线性估算渐变。
- 免费翻译和 TTS 接口可能受网络、跨域、频率限制影响；应用会按中国区接口、VOICEVOX、浏览器日语语音顺序兜底。
- Marumaru 代理依赖 marumaru-x.com 的页面结构，站点改版时需要更新解析逻辑。
- 自动注音和罗马音无法保证所有专有名词、歌词特殊读法都完全准确，可用「我的词典」与行编辑器修正。
- Web Speech 回退朗读依赖系统/浏览器是否安装 Japanese / ja-JP 语音。

## 致谢与许可

- **界面与功能**：整体移植自 [WaterEmissary/jp-lyrics-studio](https://github.com/WaterEmissary/jp-lyrics-studio)（基于本项目重构的衍生版，作者间已沟通授权）。衍生项目本身无 LICENSE 文件，移植时保留其功能与界面设计并在此注明来源。
- **分词**：[kuromoji.js](https://github.com/takuyaa/kuromoji.js)（Apache-2.0，含 IPADIC 词典）。
- **注音 / 罗马音**：[kuroshiro](https://github.com/hexenq/kuroshiro) 及 kuroshiro-analyzer-kuromoji（MIT）。
- **NCM 还原**：算法参考 [ncmdump-js](https://github.com/ant-cave/ncmdump-js)，AES 实现使用 [aes-js 3.1.2](https://github.com/ricmoo/aes-js/tree/v3.1.2)，均为 MIT；完整版权和许可文本见 `public/lib/NCM-LICENSES.txt`。
- **歌词 / 翻译 / TTS 服务**：LRCLIB、PetitLyrics、marumaru-x.com、MyMemory、百度 / 有道 / VOICEVOX / Google TTS，见上文「第三方服务一览」。
