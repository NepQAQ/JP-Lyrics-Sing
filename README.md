# 日语跟唱 (JP Lyrics Sing)

一个纯前端的日语歌词跟唱与学习工具。搜索日语歌词，生成假名和罗马音，配合本地音频或手动计时进行跟唱；支持 PetitLyrics 逐字时间轴实现 KTV 式卡拉OK渐变高亮；也可以切换到日语学习模式，把输入的日语句子转换成假名、罗马音并朗读。

## 主要功能

- 歌词搜索：通过 LRCLIB 搜索同步歌词，支持纯文本歌词自动生成简单时间轴。
- 逐字时间轴：自动从 PetitLyrics 获取 Type 3 逐字同步数据，实现 KTV 式逐字渐变高亮。
- 跟唱 / 阅读双模式：跟唱模式高亮当前句并自动滚动；阅读模式平铺全文，适合查读，并支持逐句朗读。
- 阅读模式歌曲练习：可选显示本地原歌曲逐句播放、单句循环、倍速与整体时间偏移，不替代原有 TTS 朗读。
- 假名与罗马音：使用 kuroshiro + kuromoji 为日语生成 furigana 和 Hepburn 罗马音。
- 罗马音标记：拖选罗马音添加中文一至四声、连读线或文字备注，也可在字母间插入中断 `/`；标记保存在当前浏览器。
- 中文翻译：可显示歌词自带中文，也可用 MyMemory 免费 API 自动翻译。
- 多音频来源：支持本地音频文件（含 NCM 本机还原）、手动计时模式。
- Marumaru 补充注音：载入歌词后自动从 marumaru-x.com 获取更高质量注音、罗马音和中文翻译（经同域 Worker 代理）。
- 读音修正：内置常见读音修正，也支持自定义 `汉字=假名|romaji` 词条。
- 日语学习模式：输入日语句子，转换为假名和罗马音，支持单句朗读和全文朗读。
- 日语 TTS：学习模式可选择不同音色，默认优先尝试百度/有道等中国区接口，再兜底到 VOICEVOX 和浏览器 ja-JP 语音。
- 零构建部署：纯 HTML / CSS / JavaScript，可直接静态托管。

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
| [MyMemory](https://mymemory.translated.net/) | `GET https://api.mymemory.translated.net/get` | 日语歌词自动翻译为中文 | 否（仅在开启"自动翻译"时调用） |

### 语音合成 (TTS)

| 服务 | 端点 | 用途 | 调用优先级 |
|------|------|------|------------|
| [百度翻译 TTS](https://fanyi.baidu.com/) | `GET https://fanyi.baidu.com/gettts?lan=jp` | 日语朗读 | 1（中国区优先） |
| [有道词典 TTS](https://dict.youdao.com/) | `GET https://dict.youdao.com/dictvoice?le=jap` | 日语朗读 | 2（中国区兜底） |
| [VOICEVOX (tts.quest)](https://tts.quest/) | `GET https://api.tts.quest/v3/voicevox/synthesis` | 多声线日语朗读（青山龍星、玄野武宏、春日部つむぎ等） | 3（指定声线时使用） |
| [Google Translate TTS](https://translate.google.com/) | `GET https://translate.google.com/translate_tts?tl=ja` | 日语朗读 | 4（海外兜底） |
| 浏览器 Web Speech API | 内置 `speechSynthesis` | 系统日语语音朗读 | 5（最终兜底，需系统安装 ja-JP 语音） |

### 媒体播放

| 服务 | 端点 | 用途 | 是否必须 |
|------|------|------|----------|
| [YouTube IFrame API](https://developers.google.com/youtube/iframe_api) | `https://www.youtube.com/iframe_api` | 嵌入 YouTube 播放器（代码保留，UI 已移除入口） | 否 |

### 数据流示意

```
用户搜索歌名
    │
    ▼
LRCLIB API ──→ 返回多个候选（歌名/歌手/时间轴/歌词文本）
    │
    ▼ 用户选中一首
    │
    ├──→ kuroshiro + kuromoji 生成假名/罗马音（依赖 unpkg CDN）
    │
    ├──→ PetitLyrics API（后台并行）──→ Type 3 逐字时间轴
    │         └──→ 匹配到歌词行 → KTV 逐字渐变高亮
    │
    ├──→ Marumaru 代理接口（后台并行）──→ 高质量注音歌词 + 中文翻译
    │
    └──→ MyMemory API（按需）──→ 自动中文翻译
```

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

## 快速开始

推荐用本地静态服务器打开，避免浏览器在 `file://` 下拦截词典或接口请求。

```powershell
python -m http.server 8000
```

然后访问 `http://localhost:8000`

也可以使用 Node 静态服务：

```powershell
npx serve .
```

## 歌词模式使用

1. 点击右上角「歌词 / 学习」按钮，确保处于「歌词」模式。
2. 在搜索框输入歌名和歌手，例如 `夜に駆ける YOASOBI`。
3. 点击「搜索歌词」，选择结果后会载入歌词并生成假名、罗马音。
4. 后台自动获取 PetitLyrics 逐字时间轴，匹配成功后状态栏显示匹配行数。
5. 根据需要选择音频来源：
   - 「本地」：选择音频文件，再点击播放器播放。支持选择 `.ncm`，浏览器会在本机后台还原音频并加载，不上传文件。
   - 「计时」：用于外部播放器，在音乐第 0 秒时点击开始。
6. 使用「跟唱 / 阅读」按钮切换显示方式。
7. 在阅读模式中点击每句右侧的朗读按钮，可单独朗读该句歌词。
8. 使用显示设置切换假名、罗马音、中文和自动翻译。

## 阅读模式：原歌曲逐句练习

1. 切换到「阅读」模式，在控制面板的「显示设置」勾选「歌曲逐句练习」。每次打开页面默认关闭；关闭时不会添加行内按钮或占用歌词空间，原有朗读、跟唱、计时及学习模式保持独立。
2. 在「本地 → 音频」上传歌曲，并搜索带同步时间轴的歌词或导入真实 LRC；两者先后顺序不限。音频由浏览器在本机解码，不上传、不识别歌曲内容，也不根据文件名或时长判定匹配。看到「本地音频已关联 · 同步时间轴可用」后，仍需自行确认歌曲版本一致。
3. 每句原有的 `🔊` TTS 按钮旁会出现独立的 `▶` 原歌曲按钮。点击播放该句，再次点击或点「停止练习」停止；未开启循环时到句末自动停止。空白时间标签作为间奏边界保留，不生成按钮；重复时间戳共享至下一不同时间标签的片段，不会被当成几十毫秒的短句。若来源提供了句子时长，会以该句末为上限；没有句末标签的最后一句播放至音频结束（可能包含尾奏）。
4. 可开启「循环当前句」，或选择 0.5× / 0.75× / 1× / 1.25× / 1.5×。倍速仅用于练习片段，退出片段后恢复原播放器速度。控制面板自动收起时，练习工具栏仍可使用。
5. 「偏移（秒）」校准整体时间轴：**正数延后**音频中的起止位置，例如歌词标记 12 秒、演唱实际在 13 秒，填 `1`；负数提前，例如填 `-0.5` 提前半秒。修改偏移会停止当前片段，下一次点击使用新偏移；音频范围外的部分会裁掉，完全越界的句子不显示按钮。换音频或重新载入歌词后偏移归零。校准只影响练习片段，不修改导出的 LRC 或普通整行跳转。
6. 切句、换音频或歌词、切换模式/音源、TTS 朗读、拖动原生播放器进度或暂停，都会取消当前片段循环。点击「隐藏练习」或取消勾选即可一键收起工具栏及原歌曲按钮，不影响 TTS 按钮。

**时间轴限制：**纯文本歌词、Marumaru 单独载入时生成的时间轴仅用于估算，不能启用原歌曲逐句按钮；即使后台补到了 PetitLyrics 逐字数据，也不会自动将估算的行级时间轴升级为同步时间轴。缓存会保存来源类型和原始句界；无法确认来源的旧缓存需重新搜索同步歌词或重新导入 LRC。编辑估算/旧缓存的文本不会自动升级来源类型，应上传真正带同步时间轴的 LRC 文件。浏览器不支持/无法解码的音频会显示错误，片段播放失败也会在工具栏提示。后台标签页的浏览器计时节流可能影响句末停止精度，不承诺采样级切片。

### 本地 NCM 文件

在「本地 → 音频」选择 `.ncm` 后，网页通过本地 Web Worker 还原原始音频，待浏览器成功加载后显示实际格式。原始 MP3 会直接作为 MP3 播放；其他格式保持原样，不进行有损转码，也不保证所有浏览器均支持。转换仅为本次播放使用，不生成下载文件，不读取封面或歌曲元数据，也不上传音频；请选择有权使用的文件。

转换或解码失败时会显示错误。不同 NCM 版本和损坏文件不一定支持；支持 Web Worker、Blob 和对应音频格式的现代浏览器才能使用。转换需要在内存中暂存文件和还原音频，大文件或内存较小的手机可能失败，请关闭其他页面或选择较小的文件。移动浏览器可能要求手动点击播放。真实同步歌词需要另行搜索或导入并确认版本；文件转换不会自动识别歌曲或校准时间轴。

NCM 算法参考 [ncmdump-js](https://github.com/ant-cave/ncmdump-js/tree/aa127b694a8cf151d2cc03bf89a439f4c6298dc1)，AES 实现使用 [aes-js 3.1.2](https://github.com/ricmoo/aes-js/tree/v3.1.2)，均为 MIT 许可，完整版权和许可文本见 `public/lib/NCM-LICENSES.txt`。

开发回归验证无需安装依赖：在仓库根目录执行 `node --test tests\audio-file.test.cjs tests\ncm-worker.test.cjs tests\song-practice.test.cjs`（Node.js 18+）。

## 罗马音标记

1. 在“显示设置”中开启“标记罗马音”，应用会自动切换到阅读模式。
2. 用鼠标拖选或在手机上长按选择一段罗马音。
3. 选择标记类型并点击“应用”：
    - “一声 / 二声 / 三声 / 四声”分别使用平、升、降升、降的声调线。
    - “连读”使用底部实线，适合把需要一口读出的词组连在一起。
    - “备注”使用点线和短标签，适合记录吐字、停顿等提示。
4. 要在两个字母之间添加中断，单击对应位置，选择“中断”并应用，显示为 `/`。
5. 要删除标记，重新选择对应范围或单击中断位置，再点击“清除所选标记”。

标记以日语原句和罗马音内容为依据保存在浏览器 `localStorage` 中；相同歌词再次载入时会自动恢复。若罗马音内容因读音修正而改变，需要重新添加对应标记。

## 本地歌词导入

在「本地」标签页中切到「LRC 歌词」，可以上传 `.lrc` 文件或粘贴标准 LRC 文本。

LRC 格式示例：

```text
[00:12.30]君の名前を呼んだ
[00:16.80]夜空に消えていった
```

如果在线结果只有纯文本歌词，应用会自动按固定间隔生成简易时间轴，并切换到计时模式。

## 日语学习模式

点击右上角「歌词 / 学习」按钮切换到「学习」模式。

1. 输入一句或多句日语。
2. 点击「转换」。
3. 页面会按句子显示日语原文、假名和罗马音。
4. 点击每句右侧的朗读按钮可朗读单句。
5. 在「朗读音色」中选择中国区优先、低沉男声、男声、女声等不同输出。
6. 点击「朗读全部」会朗读所有输入的日语原文。

默认选项会优先尝试百度/有道等中国区更容易访问的免费日语语音接口；如果浏览器或网络拦截，再回退到 [VOICEVOX / tts.quest](https://tts.quest/) 指定声线。若外部接口都不可用，最后回退到浏览器内置 Web Speech；此时系统或浏览器需要安装 Japanese / ja-JP 语音。

## 读音修正

点击右上角「读音修正」按钮可以维护自定义读音词典。

每行一条：

```text
二人=ふたり|futari
明日=あした|ashita
今日=きょう|kyou
```

格式说明：

- `汉字=假名`：只指定假名，罗马音会尽量自动生成。
- `汉字=假名|romaji`：同时指定假名和罗马音。
- 以 `#` 开头的行会被忽略。

保存后可点击「重新生成假名」应用到当前歌词。

## 技术说明

| 功能 | 实现 |
|------|------|
| 页面结构 | 原生 HTML / CSS / JavaScript |
| 分词与注音 | kuroshiro + kuromoji，词典文件放在 `dict/`，库通过 unpkg CDN 加载 |
| 罗马音 | kuroshiro Hepburn 转写，失败时使用内置 kana fallback |
| 歌词搜索 | LRCLIB API（返回多候选 + 行级时间轴） |
| 逐字时间轴 | PetitLyrics API（Type 3，每个字含 starttime/endtime） |
| KTV 渐变高亮 | CSS `background-clip: text` + `linear-gradient` + `requestAnimationFrame` |
| 歌词注音补充 | marumaru-x.com 歌词页，经自建 Worker 代理抓取解析（国内直连） |
| 中文翻译 | MyMemory 免费翻译 API |
| 学习模式朗读 | 百度/有道优先，VOICEVOX / tts.quest 多声线兜底，最后回退 Web Speech ja-JP |
| 音频播放 | 原生 `<audio>`、手动计时器 |
| 本地状态 | localStorage 保存主题、模式、读音修正等设置 |

## 项目结构

```text
.
├── index.html       # 页面结构与控件
├── styles.css       # 主题、布局、歌词和学习模式样式
├── app.js           # 核心逻辑：搜索、渲染、播放、学习模式
├── dict/            # kuromoji 本地词典
└── history version/ # 历史版本备份，不参与当前运行
```

## 部署

这是一个纯静态项目，可部署到 GitHub Pages、Vercel、Netlify、Cloudflare Pages 等平台。

GitHub Pages 示例：

```powershell
git init
git add .
git commit -m "init jp lyrics sing"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后在仓库 Settings -> Pages 中选择 `main` 分支根目录。

Vercel / Netlify / Cloudflare Pages：构建命令留空，输出目录使用项目根目录。

## 已知限制

- 首次生成假名需要加载 kuromoji 词典，可能需要等待几秒。
- 直接双击打开 `index.html` 时，部分浏览器可能拦截本地词典请求；建议使用本地服务器。
- PetitLyrics 逐字时间轴为日本曲库，非日语歌曲可能无数据；此时回退到线性估算渐变。
- PetitLyrics API 每次请求只返回 1 条结果，无法让用户从多个候选中选择，因此搜索仍以 LRCLIB 为主。
- 免费翻译和 TTS 接口可能受网络、跨域、频率限制影响；应用会按中国区接口、VOICEVOX、浏览器日语语音顺序兜底。
- Marumaru 代理依赖 marumaru-x.com 的页面结构，站点改版时需要更新解析逻辑。
- 自动注音和罗马音无法保证所有专有名词、歌词特殊读法都完全准确，可用读音修正补充。
- Web Speech 回退朗读依赖系统/浏览器是否安装 Japanese / ja-JP 语音。
