# 日语跟唱 (JP Lyrics Sing)

一个纯前端的日语歌词跟唱与学习工具。它可以搜索日语歌词，生成假名和罗马音，配合本地音频、Bilibili 或手动计时进行跟唱；也可以切换到日语学习模式，把输入的日语句子转换成假名、罗马音并朗读。

## 主要功能

- 歌词搜索：通过 lrclib.net 搜索同步歌词，支持纯文本歌词自动生成简单时间轴。
- 跟唱 / 阅读双模式：跟唱模式高亮当前句并自动滚动；阅读模式平铺全文，适合查读，并支持逐句朗读。
- 假名与罗马音：使用 kuroshiro + kuromoji 为日语生成 furigana 和 Hepburn 罗马音。
- 中文翻译：可显示歌词自带中文，也可用 MyMemory 免费 API 自动翻译。
- 多音频来源：支持本地音频、Bilibili 嵌入播放器，以及外部播放器手动计时。
- Kanogoma 补充注音：载入歌词后可尝试从 Kanogoma 获取更高质量注音、罗马音和中文翻译。
- Bilibili 候选音源：选中歌词后会自动搜索 Bilibili 视频候选，可一键载入。
- 读音修正：内置常见读音修正，也支持自定义 `汉字=假名|romaji` 词条。
- 日语学习模式：输入日语句子，转换为假名和罗马音，支持单句朗读和全文朗读。
- 日语 TTS：学习模式可选择不同音色，默认优先尝试百度/有道等中国区接口，再兜底到 VOICEVOX 和浏览器 ja-JP 语音。
- 零构建部署：纯 HTML / CSS / JavaScript，可直接静态托管。

## 快速开始

推荐用本地静态服务器打开，避免浏览器在 `file://` 下拦截词典或接口请求。

```powershell
python -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

也可以使用 Node 静态服务：

```powershell
npx serve .
```

## 歌词模式使用

1. 点击右上角「歌词 / 学习」按钮，确保处于「歌词」模式。
2. 在搜索框输入歌名和歌手，例如 `夜に駆ける YOASOBI`。
3. 点击「搜索歌词」，选择结果后会载入歌词并生成假名、罗马音。
4. 根据需要选择音频来源：
   - 「本地」：上传音频文件，再播放。
   - 「Bilibili」：粘贴 BV 链接或从候选视频中选择。
   - 「计时」：用于外部播放器，在音乐第 0 秒时点击开始。
5. 使用「跟唱 / 阅读」按钮切换显示方式。
6. 在阅读模式中点击每句右侧的朗读按钮，可单独朗读该句歌词。
7. 使用显示设置切换假名、罗马音、中文和自动翻译。

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
|---|---|
| 页面结构 | 原生 HTML / CSS / JavaScript |
| 分词与注音 | kuroshiro + kuromoji，词典文件放在 `dict/` |
| 罗马音 | kuroshiro Hepburn 转写，失败时使用内置 kana fallback |
| 在线歌词 | lrclib.net |
| 歌词注音补充 | Kanogoma 页面解析，部分场景经 r.jina.ai 读取 HTML |
| Bilibili 搜索 | Bilibili 搜索接口，失败时尝试网页代理/reader 兜底 |
| 中文翻译 | MyMemory 免费翻译 API |
| 学习模式朗读 | 百度/有道优先，VOICEVOX / tts.quest 多声线兜底，最后回退 Web Speech ja-JP |
| 音频播放 | 原生 `<audio>`、Bilibili iframe、手动计时器 |
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
- 免费翻译和 TTS 接口可能受网络、跨域、频率限制影响；应用会按中国区接口、VOICEVOX、浏览器日语语音顺序兜底。
- Bilibili 官方 iframe 不开放播放进度 API，因此使用手动计时同步歌词。
- 自动注音和罗马音无法保证所有专有名词、歌词特殊读法都完全准确，可用读音修正补充。
- Web Speech 回退朗读依赖系统/浏览器是否安装 Japanese / ja-JP 语音。

## 可选增强

- PWA 离线缓存。
- 歌词逐字高亮。
- 单词点击查词。
- LRC 时间轴编辑器。
- 更多日语 TTS 声线选择。
- 更高质量翻译接口配置。
