<p align="right"><a href="README.md">English</a> | <b>简体中文</b></p>

# chat-local

> **定位：深度还原 DeepSeek 网页端的核心聊天体验，同时把会话和附件留在本机；通过 Anthropic 兼容接口，让更多模型也能使用这套聊天体验。**

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造。这里的「还原」指对话、思考、联网/深搜、引用、附件和语音等核心聊天链路，不包含 DeepSeek 账号体系、云端会话同步或官网的全部运营功能。

**适合：** 想要 DeepSeek 网页式聊天、历史留在本机、并且能接自己模型的人。

**不适合：** 需要 Agent、插件、RAG 知识库、多用户或移动端的人；这些请选专门平台。本项目刻意保持纯聊天。

## 项目状态

这是一个**社区快照（v0.1.1）**，不是持续维护的产品。

- 界面、消息协议和 DeepSeek 云端路径继承自 [chat-demo](https://github.com/deepseek-ai/chat-demo)，核心功能保留；自建后端路径做过冒烟测试。
- **未经过广泛测试**：DeepSeek 云端、ASR、OCR、TTS、不同模型服务和不同操作系统上的表现，主要交给社区验证。
- Issue 和 PR 随缘处理；使用前请自行备份 `data/`，不要把它当作唯一数据副本。
- 遇到问题请附上系统、模型 provider、复现步骤和相关日志，便于判断。

## 与 chat-demo 的关系

**使用 DeepSeek 云端时，本项目的云端对话功能与 [chat-demo](https://github.com/deepseek-ai/chat-demo) 保持一致**：对话、思考、联网/深度搜索、读链接、附件上传、语音输入和朗读沿用同一套 DeepSeek 官方接口与交互，云端请求链没有改写。

与原版相比，主要差异是会话改为本机 SQLite 存储，并新增了下方「功能」一节；这些功能里标注「仅自建后端」的只在自建模式生效。

## 快速开始

需要 Python 3.10+ 与 Node.js 20+。Windows x64 也可以直接下载 [Releases](https://github.com/Ken33372/chat-local-oss/releases) 里的便携包，解压后双击 `start.bat`，无需安装 Python 或 Node。

> 预构建便携包**不保证是最新版**：它按发版时点打包，落后于 `main` 是常态。想要最新功能，请从源码运行，或自行跑 `build.bat`。

```bash
pip install -r requirements.txt

cd web && npm install && npm run build && cd ..

python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
```

Windows 也可以直接双击 `build.bat` 和 `start.bat`。打开 `http://127.0.0.1:17865/`。

首次打开会出现配置向导：

- **DeepSeek 云端**：切到云端模式，在设置里填 DeepSeek API Key。
- **自建后端**：填 Base URL、API Key、模型名；高级里再配搜索、ASR、OCR（搜索选 SearXNG 时会多出一组重排配置）。

保存后写入 `data/config.json`，立即生效，不需要重启。也可以跳过向导，复制 `.env.example` 为 `.env` 手动配置；环境变量优先于向导保存的值。

> 云端模式仍然需要启动本机后端，因为会话和附件存在本机 SQLite，不走 DeepSeek 账号云同步。

## 两种模式

| | DeepSeek 云端 | 自建后端 |
|---|---|---|
| LLM | DeepSeek 官方 API | 任意 Anthropic 兼容模型（完全自定义） |
| 需要 | 一个 DeepSeek API Key | Base URL + API Key + 模型名 |
| 联网搜索 | DeepSeek 服务端工具 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | 你配置的 ASR provider |
| 朗读 | DeepSeek `/v1/tools/tts` | 你配置的 TTS provider（DeepSeek 或 OpenAI 兼容 `/v1/audio/speech`） |
| 历史 | 本机 SQLite | 本机 SQLite |

## 配置

配置有两个来源，优先级从高到低：

1. 环境变量 / 项目根目录的 `.env`（适合部署）
2. 首次运行向导写入的 `data/config.json`（适合普通用户）

不会读取其他项目的文件。

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 填了就自动把 LLM、ASR、OCR 指向 DeepSeek；朗读选 `deepseek` 时也复用这把 key（但要自己把 `TTS_PROVIDER` 打开）。**只对 `.env` 或系统环境变量生效**，首次运行向导里没有这一项 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 自建后端的 Anthropic 兼容接口 |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | 输入上限与单次最大输出，默认 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | 语音识别；OpenAI 兼容接口默认模型 `whisper-1`。根地址或以 `/v1` 结尾的地址（含 `/api/v1` 前缀）自动接 `/v1/audio/transcriptions`，填完整地址原样请求；响应认 `{text}`、`[{text}]`、`{segments:[{text}]}` 和纯文本 |
| `OCR_PROVIDER` | `none` / `deepseek` / `openai` |
| `OCR_BASE_URL` / `OCR_API_KEY` / `OCR_MODEL` | 文档/图片识别；OpenAI 兼容接口只支持图片。根地址自动接 `/v1/chat/completions`，填完整地址原样请求 |
| `TTS_PROVIDER` | `none` / `deepseek` / `openai` / `engine` / `template`；不配就没有朗读按钮 |
| `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` | 朗读接口。`deepseek` 可省略地址、复用 `DEEPSEEK_API_KEY`；`openai` 是 OpenAI 兼容的 `/v1/audio/speech`，自建引擎填服务根地址（默认模型名 `tts-1`）。地址里已经带路径（例如 `http://host:8090/api/tts/speech`）就原样请求，不再追加标准路径 |
| `TTS_VOICE` | 音色名，留空用服务默认（DeepSeek：`stella`；OpenAI：`alloy`） |
| `TTS_RESPONSE_FORMAT` | `wav`（默认）/ `mp3` / `opus` / `pcm`，仅 OpenAI 兼容这一路生效 |
| `TTS_MAX_CHARS` | 单次朗读请求的字数上限，默认 4000；超过就按句子切段逐段合成 |
| `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` | `template` 专用：完整地址、请求体 JSON 模板、音频取法（`body` / `base64:字段路径` / `url:字段路径`）、额外请求头 |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | 联网搜索。Tavily（`https://api.tavily.com`）和 AnySearch（`https://api.anysearch.com`）的 Base URL 可省略；SearXNG 必须填写。Tavily 需要 key；AnySearch 的 key 可留空（匿名限流）。`SEARCH_RESULTS` 取值 1–12，默认 6，可在向导里改 |
| `RERANK_PROVIDER` / `RERANK_BASE_URL` / `RERANK_API_KEY` / `RERANK_MODEL` / `RERANK_TIMEOUT` | 可选的重排接口，例如 `llama-server --reranking` 或 HuggingFace text-embeddings-inference。填根地址或以 `/v1` 结尾的地址自动接 `/v1/rerank`，填完整地址（TEI 的 `/rerank`）原样请求；响应认 `{"results":[...]}` 和顶层数组 `[{index,score}]` 两种形状。**只在 `SEARCH_PROVIDER=searxng` 这一路起作用**，细节见 [docs/search.zh-CN.md](docs/search.zh-CN.md) |
| `SEARCH_CANDIDATE_TARGET` / `SEARCH_CANDIDATE_MAX` / `SEARCH_MAX_PAGES` / `SEARCH_SNIPPET_CHARS` | SearXNG 翻页聚合的调优项，默认 20 / 60 / 5 / 500 |
| `SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` | 站点规则，逗号分隔。写 `example.com` 连子域一起算，写 `example.com/docs` 再限定路径前缀 |
| `CHAT_LOCAL_IMAGE_MODE` | `vision` / `auto` / `ocr`。默认 `vision`，直接把图片发给模型，**要求模型支持视觉/多模态**；`auto` 先发图，被拒时自动回退 OCR；`ocr` 只做 OCR、不发图。**模型不支持多模态时请设为 `auto` 或 `ocr`，否则发图会收到上游报错。** |

没配置的能力会从界面上隐藏（例如没有 ASR 就不显示麦克风），不会出现点了必然报错的按钮。

### 更多细节

- 两个可直接照抄的配置示例、朗读/ASR/OCR/重排的接口兼容说明：[docs/providers.zh-CN.md](docs/providers.zh-CN.md)
- SearXNG 的结果质量、重排开关、翻页聚合与实测耗时：[docs/search.zh-CN.md](docs/search.zh-CN.md)

## 功能

### 自建后端逐项自定义

LLM、搜索、ASR、OCR 分别配置，互不绑定：

- **LLM**：模型名、Base URL、API Key、上下文上限和单次最大输出都由你填写；使用 Anthropic 兼容协议（例如 DeepSeek 的 `/anthropic` 端点）。
- **ASR**：可选 DeepSeek `/v1/tools/asr` 或 OpenAI 兼容 `/v1/audio/transcriptions`。
- **OCR**：可选 DeepSeek `/v1/tools/ocr`（文档与图片）或 OpenAI 兼容视觉接口（仅图片）。
- **搜索**：可选 Tavily、AnySearch、SearXNG，或直接关闭。SearXNG 可以再挂自己的重排模型，开启多页聚合与相关性排序；不配就只取一页。
- 未配置的能力会自动隐藏；OpenAI 兼容的 LLM 尚未接入。

### 会话与数据

- **本机存储**：FastAPI + SQLite 保存会话和附件（`data/chat.db`、`data/files/`）。
- **历史导入导出**：支持 DeepSeek 官方 ZIP（`export_format_version: 3`）；覆盖、合并跳过重复、冲突另存副本三种方式，导入时可选择丢弃工具调用记录或图片原件。
- **对话搜索**：侧栏搜索消息正文，结果按会话分组并显示匹配片段；归档会话不参与搜索。
- **归档与恢复**：会话菜单 → 归档；设置 → 数据管理 → 查看归档，可打开、恢复或永久删除。
- **对话清理**：按 N 年前/月前或日期区间删除；也可移除所有会话里的工具调用记录和图片原件。

### 上下文与工具（仅自建后端）

- **上下文管理**：用量提示、本地压缩，以及可配置的上下文上限和单次最大输出。云端模式只有用量提示，上限由 DeepSeek 固定。
- **自动生成标题**：可选，默认关闭。首轮回复完成后，本地后端用第一条用户消息和助手正文额外请求一次模型生成标题；云端继续使用 DeepSeek 自带标题。
- **工具轮数**：界面可调一次回答里的最大联网工具轮数。云端由 DeepSeek 服务端决定，前端不发送该参数。

### 界面与配置

- **首次运行向导**：两种模式都能进入，但只负责写自建后端的配置。搜索选 SearXNG 时会多出一组重排输入框（Base URL / API Key / 模型名），填了 Base URL 就算开启多页聚合；高级里还能单独配朗读的 provider、地址、key、模型、音色与返回格式。
- **能力探测**：没配置的搜索、ASR 等入口自动隐藏。
- **界面修复**：深色模式下拉框、会话菜单定位、清理统计等问题。

## 能力对照

| 能力 | DeepSeek 云端 | 自建后端 |
|---|---|---|
| 对话/思考/停止/续写 | DeepSeek API | Anthropic 兼容接口 |
| 联网搜索、读网页 | DeepSeek 服务端工具，工具本身不计费 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | `deepseek` 或 OpenAI 兼容 ASR |
| 朗读 | DeepSeek `/v1/tools/tts` | `deepseek` 或 OpenAI 兼容 `/v1/audio/speech` |
| 图片 | 直传 DeepSeek | 直接发视觉；失败可回退 OCR |
| PDF/Word/PPT | DeepSeek Files API | DeepSeek OCR 或关闭 |

自建朗读支持四种接口形状（`openai` / `deepseek` / `engine` / `template`），覆盖常见自建 TTS 服务；四种形状的对照表、`template` 的四项配置和明确不支持的服务类型（如 ComfyUI 异步工作流）见 [docs/providers.zh-CN.md](docs/providers.zh-CN.md#朗读的四种接口形状)。

## 限制

- 本项目未经过广泛测试，详见上面的「项目状态」。
- 自建后端的 LLM 目前只支持 Anthropic 兼容协议（DeepSeek 的 `/anthropic` 端点、其他兼容服务）。OpenAI 兼容的 LLM 尚未接入。
- OpenAI 兼容 OCR 只处理图片；PDF/Word/PPT 请用 DeepSeek OCR 或先转图片。
- 导入/导出目前只支持 DeepSeek 导出格式。
- 朗读（云端与自建）都未做真机试听验证，属于「未经过广泛测试」的范围；自建朗读能不能出声，取决于你接的服务是否实现了 `/v1/audio/speech`。
- SearXNG 的两类已知问题（Brave 跳转链、上游引擎限流）见 [docs/search.zh-CN.md](docs/search.zh-CN.md#已知的两类脏数据)。

## 安全与隐私

- 服务默认只监听 `127.0.0.1`，写接口要求 `X-Chat-Local: 1` 请求头。
- 会话和附件保存在本机 `data/`，不依赖 DeepSeek 账号或云端会话同步；但云端模式仍会把对话内容发送给 DeepSeek API，自建模式才会把推理留在你配置的模型端。
- 开启联网搜索、ASR、OCR 时，对应内容会发送给你选择的 provider；不需要的能力可以直接关闭。
- 自建后端的密钥只放在 `.env` 或 `data/config.json`，保存后不会回传明文；两个位置都已被 `.gitignore` 排除。
- 配置向导的写接口只接受本机请求；如果服务监听在 `0.0.0.0`，向导不可写，只能用 `.env`。
- 云端模式的 API Key 存在浏览器 localStorage，和原版 chat-demo 一致。

## AI 辅助开发声明

本项目的代码、文档和重构大量使用了 **Qoder 中的 DeepSeek** 辅助生成和修改，并由人工审查、运行和取舍。AI 生成的代码可能存在错误、遗漏或安全问题，请在使用前自行评估；本项目与 DeepSeek 官方无关。

## 鸣谢

SearXNG 的搜索结果质量优化——用 `pageno` 做翻页聚合（候选目标数与上限、停止规则）、跨页去重、摘要清洗、站点黑白名单，以及把聚合来的候选交给重排模型选优而不是全塞进上下文——思路参考了 [DdogezD/claudium](https://github.com/DdogezD/claudium) 的搜索工具，默认值（20 条候选、最多 5 页、摘要 500 字）也沿用它的取值。

该仓库未声明许可证，因此本项目没有复制它的任何代码：以上功能是按思路重新实现的，claudium 也不是本项目的依赖。

## 许可

MIT，见 [LICENSE](LICENSE)。界面与消息协议来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）。
