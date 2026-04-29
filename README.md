# 🎤 日语跟唱 (JP Lyrics Sing)

一个零依赖的纯静态网页应用，用于跟唱日语歌曲，自带：

- 🈳 **假名 (Furigana)**：在汉字上方注音
- 🔤 **罗马音 (Romaji)**：Hepburn 拼写
- 🇨🇳 **中文翻译**：手写或一键自动翻译
- ⏱ **时间轴同步高亮**：根据音频进度自动滚动并高亮当前行
- 🔍 **在线搜索导入**：通过 [lrclib.net](https://lrclib.net) 直接搜索带时间轴的歌词
- 📱 **移动端适配**：响应式布局，触摸友好
- 🚀 **零构建**：纯 HTML/CSS/JS，可直接部署到 GitHub Pages、Vercel、Netlify、Cloudflare Pages 等

## 使用

1. **本地预览**：直接用浏览器打开 `index.html`，或在目录下起一个静态服务（推荐，避免某些 CORS 问题）：

   ```powershell
   # Python
   python -m http.server 8080
   # 或 Node
   npx serve .
   ```

   然后访问 <http://localhost:8080>。

2. **跟唱流程**：
   - 顶部搜索框输入「歌名 歌手」（如 `夜に駆ける YOASOBI`），点击带「同步」徽章的结果即可载入。
   - 在「手动导入 / 上传」处选择本地音频文件（mp3 / m4a / flac…）。
   - 播放音频，歌词会自动滚动并高亮。点击任意一行可跳转到该时间。
   - 顶部胶囊开关可控制是否显示假名 / 罗马音 / 中文，以及是否自动翻译中文。

3. **手动 LRC**：在文本框粘贴标准 LRC（含 `[mm:ss.xx]` 时间标签），或上传 `.lrc` 文件，点击「加载歌词」。

## 部署到 GitHub Pages

```powershell
git init
git add .
git commit -m "init jp lyrics sing"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后在仓库 **Settings → Pages → Source** 选择 `main` 分支根目录即可，几分钟后访问 `https://<你的用户名>.github.io/<仓库名>/`。

部署到 **Vercel / Cloudflare Pages / Netlify**：导入仓库，构建命令留空，输出目录设为 `/`（项目根）。

## 技术说明

| 功能 | 实现 |
|---|---|
| 分词 / 注音 | [kuroshiro](https://github.com/hexenq/kuroshiro) + [kuromoji](https://github.com/takuyaa/kuromoji.js)（CDN，纯前端） |
| 在线歌词 | [lrclib.net](https://lrclib.net) 公共 API（无需 key，CORS 友好） |
| 中文翻译 | [MyMemory](https://mymemory.translated.net/) 免费 API（每日匿名额度有限，质量一般） |
| 音频播放 | 原生 `<audio>` 标签，本地文件 `URL.createObjectURL` |

## 已知限制

- 首次使用时需下载 kuromoji 词典（约 2-5 MB），稍等片刻即可。
- MyMemory 翻译为机翻，重要场景建议手工校对；可关闭「自动翻译」开关以避免速率限制。
- 因浏览器同源/版权限制，不支持直接抓取流媒体平台音频；请自备音频文件。
- iOS Safari 需要用户手势才能播放音频（点击播放器即可）。

## 路线图（可选增强）

- [ ] PWA 离线缓存（manifest + service worker）
- [ ] 歌词逐字 (per-character) 高亮
- [ ] 单词点击查询字典
- [ ] 接入更优质的翻译（DeepL / OpenAI，需自备 key）
- [ ] 同步 LRC 编辑器，可手动调整时间戳
