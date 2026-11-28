<p align="right"><b>简体中文</b> | <a href="README.en.md">English</a></p>

# chat-local

> **定位：深度还原 DeepSeek 网页端的核心聊天体验，同时把会话和附件留在本机；通过 Anthropic / OpenAI 兼容接口，让更多模型也能使用这套聊天体验。**

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造。这里的「还原」指对话、思考、联网/深搜、引用、附件和语音等核心聊天链路，不包含 DeepSeek 账号体系、云端会话同步或官网的全部运营功能。

**适合：** 想要 DeepSeek 网页式聊天、历史留在本机、并且能接自己模型的人。

**不适合：** 需要 Agent、插件、RAG 知识库、多用户或移动端的人；这些请选专门平台。本项目刻意保持纯聊天。

## 项目状态

这是一个**社区快照（v0.1.4）**，不是持续维护的产品。

- 界面、消息协议和 DeepSeek 云端路径继承自 [chat-demo](https://github.com/deepseek-ai/chat-demo)，核心功能保留；自建后端核心路径已有离线回归测试，仍不能替代真实环境实测。
- **未经过广泛测试**：DeepSeek 云端、ASR、OCR、TTS、不同模型服务和不同操作系统上的表现，主要交给社区验证。
- **`main` 可能继续包含 v0.1.4 之后的修复**；Release 便携包按发版时点打包，不保证是最新版。想要最新代码请从源码运行或自行构建。
- Issue 和 PR 随缘处理；使用前请自行备份 `data/`，不要把它当作唯一数据副本。
- 遇到问题请附上系统、模型 provider、复现步骤和相关日志，便于判断。

## 与 chat-demo 的关系

**使用 DeepSeek 云端时，本项目的云端对话功能与 [chat-demo](https://github.com/deepseek-ai/chat-demo) 保持一致**：对话、思考、联网/深度搜索、读链接、附件上传、语音输入和朗读沿用同一套 DeepSeek 官方接口与交互，云端请求链没有改写。

与原版相比，主要差异是会话改为本机 SQLite 存储，并新增了下方「功能」一节；这些功能里标注「仅自建后端」的只在自建模式生效。

## 快速开始

### 方式一：从源码运行

1. **准备环境**：Python 3.10+、Node.js 20+（`python --version`、`node --version` 能显示版本即可）。
2. **拿到源码**：

   ```bash
   git clone https://github.com/Ken33372/chat-local-oss.git
   cd chat-local-oss
   ```

   没有 git 就下载仓库 ZIP 解压，效果一样。
3. **装后端依赖并构建前端**（都在项目根目录执行）：

   ```bash
   pip install -r requirements.txt
   cd web && npm install && npm run build && cd ..
   ```

   想隔离 Python 依赖，可以先 `python -m venv .venv`，激活后再执行 `pip install`。
4. **启动后端**：

   ```bash
   python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
   ```
5. **打开验证**：浏览器访问 `http://127.0.0.1:17865/`；`http://127.0.0.1:17865/api/health` 能返回 JSON 说明服务正常。

Windows 上第 3 步的前端部分和第 4 步也可以换成现成脚本：`pip install -r requirements.txt` 仍要手动执行一次，然后双击 `build.bat`（装前端依赖 + 构建），再双击 `start.bat`（启动并自动打开浏览器），`stop.bat` 停止。

### 方式二：便携包（不用装环境）

Windows x64 可以直接下载 [Releases](https://github.com/Ken33372/chat-local-oss/releases) 里的便携包，解压后双击 `start.bat`，无需安装 Python 或 Node。

> 预构建便携包**不保证是最新版**：它按发版时点打包，落后于 `main` 是常态。想要最新功能，请从源码运行，或自行跑 `build.bat`。

### 第一次打开

还没配置时，首次打开会出现分步向导：先选 **DeepSeek 云端**（填 Key 即完成，会直接跳到数据管理）或 **自定义后端**；自定义依次配置模型 → 可选功能（搜索、附件解析、语音、重排与向量），模型配完后可勾选需要哪些功能，后续每一步都能跳过。保存后立即生效。

已经用 `.env` 配好的可以直接跳过向导。两种配置来源的优先级、向导入口和全部变量见下方 [配置](#配置)。

### 开发与测试

仓库带有离线回归测试，不读取 `.env` 或 `data/`，也不需要真实模型或 API Key：

```bash
python -m unittest discover -s tests
cd web && npm test && npm run type && npm run lint
```

前端生产构建仍使用 `cd web && npm run build`（或根目录的 `build.bat`）。

## 两种模式

| | DeepSeek 云端 | 自建后端 |
|---|---|---|
| LLM | DeepSeek 官方 API | 任意 Anthropic 或 OpenAI 兼容模型（完全自定义） |
| 需要 | 一个 DeepSeek API Key | Base URL + API Key + 模型名 |
| 历史 | 本机 SQLite | 本机 SQLite |

各项能力的来源差异见下方 [能力对照](#能力对照)。

> 云端模式也需要本机后端在跑：会话和附件存在本机 SQLite，不走 DeepSeek 账号云同步。

## 配置

配置有两个来源，优先级从高到低：

1. 环境变量 / 项目根目录的 `.env`（适合高级用户，可以完全不经过向导；改完需重启服务）
2. 首次运行向导写入的 `data/config.json`（适合普通用户；保存后立即生效）

向导只在检测到模型未配置时出现；之后想改，入口在 设置 → 通用设置 → 服务配置。不会读取其他项目的文件。

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 填了就自动把 LLM、ASR 与 DeepSeek 版 OCR 指向 DeepSeek；朗读选 `deepseek` 时也复用这把 key（但要自己把 `TTS_PROVIDER` 打开）。**只对 `.env` 或系统环境变量生效**，首次运行向导里没有这一项 |
| `LLM_PROVIDER` | `anthropic`（默认，`POST /v1/messages`）/ `openai`（`POST /v1/chat/completions`，可接 Ollama、LM Studio、vLLM 等）。两种协议下搜索、引用、思考、附件、标题、压缩行为一致，细节见 [docs/providers.zh-CN.md](docs/providers.zh-CN.md#对话模型的两条协议) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 自建后端的模型接口；Anthropic 兼容填 `/anthropic` 这类前缀或完整的 `/v1/messages` 地址，OpenAI 兼容填根地址、`/v1` 结尾或完整接口地址 |
| `LLM_HEADERS` | 额外请求头，JSON 对象。占位符：`{key}` 引用 `LLM_API_KEY`，`{session}` 是当前对话 ID（形如 `ses_...`），`{model}` 是模型名。用于 Azure 自定义鉴权、身份声明和会话 ID（例如 `{"User-Agent": "chat-local-oss/0.1.4", "x-session-id": "{session}"}`）；自定义头会覆盖同名默认头 |
| `LLM_EXTRA_BODY` | 额外请求体字段，JSON 对象，浅合并进上游请求体（两种协议通用）；`messages` 与 `stream` 由本机生成，写了也会忽略。**只对 `.env` 或系统环境变量生效**，向导里没有这一项 |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | 输入上限与单次最大输出，默认 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | 语音识别；OpenAI 兼容接口默认模型 `whisper-1`。根地址或以 `/v1` 结尾的地址（含 `/api/v1` 前缀）自动接 `/v1/audio/transcriptions`，填完整地址原样请求；响应认 `{text}`、`[{text}]`、`{segments:[{text}]}` 和纯文本 |
| `CHAT_LOCAL_IMAGE_PARSER` | `vision`（跟随模型，默认）/ `openai` / `deepseek`：图片解析方式。被模型拒绝时自动回退 OCR |
| `CHAT_LOCAL_DOC_PARSER` | `python`（默认）/ `deepseek`：文档解析方式。`python` 在本地抽 PDF/docx/pptx 的文字层；抽不出（扫描件）再回退 DeepSeek OCR（若已配置） |
| `OCR_OPENAI_BASE_URL` / `OCR_OPENAI_API_KEY` / `OCR_OPENAI_MODEL` | 图片选 `openai` 时用；只处理图片，根地址自动接 `/v1/chat/completions` |
| `OCR_DEEPSEEK_BASE_URL` / `OCR_DEEPSEEK_API_KEY` / `OCR_DEEPSEEK_MODEL` | 图片或文档选 `deepseek` 时用；地址留空默认 `https://api.deepseek.com` |
| `TTS_PROVIDER` | `none` / `deepseek` / `openai` / `engine` / `template`；不配就没有朗读按钮 |
| `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` | 朗读接口。`deepseek` 可省略地址、复用 `DEEPSEEK_API_KEY`；`openai` 是 OpenAI 兼容的 `/v1/audio/speech`，自建引擎填服务根地址（默认模型名 `tts-1`）。地址里已经带路径（例如 `http://host:8090/api/tts/speech`）就原样请求，不再追加标准路径 |
| `TTS_VOICE` | 音色名，留空用服务默认（DeepSeek：`stella`；OpenAI：`alloy`） |
| `TTS_RESPONSE_FORMAT` | `wav`（默认）/ `mp3` / `opus` / `pcm`，仅 OpenAI 兼容这一路生效 |
| `TTS_MAX_CHARS` | 单次朗读请求的字数上限，默认 4000；超过就按句子切段逐段合成 |
| `TTS_TEMPLATE_URL` / `_BODY` / `_AUDIO` / `_HEADERS` | `template` 专用：完整地址、请求体 JSON 模板、音频取法（`body` / `base64:字段路径` / `url:字段路径`）、额外请求头 |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | 联网搜索。Tavily（`https://api.tavily.com`）和 AnySearch（`https://api.anysearch.com`）的 Base URL 可省略；SearXNG 必须填写。Tavily 需要 key；AnySearch 的 key 可留空（匿名限流）。`SEARCH_RESULTS` 取值 1–12，默认 6，可在向导里改 |
| `RERANK_PROVIDER` / `RERANK_BASE_URL` / `RERANK_API_KEY` / `RERANK_MODEL` / `RERANK_TIMEOUT` | 可选的重排接口，例如 `llama-server --reranking` 或 HuggingFace text-embeddings-inference。填根地址或以 `/v1` 结尾的地址自动接 `/v1/rerank`，填完整地址（TEI 的 `/rerank`）原样请求；响应认 `{"results":[...]}` 和顶层数组 `[{index,score}]` 两种形状。搜索的 SearXNG 聚合与记忆高级检索共用；细节见 [docs/search.zh-CN.md](docs/search.zh-CN.md) 与 [docs/context.zh-CN.md](docs/context.zh-CN.md) |
| `EMBEDDING_PROVIDER` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 可选的向量接口（OpenAI 兼容 `/v1/embeddings`），只给记忆的「高级检索」用。`EMBEDDING_DIM` 必须与模型一致（Qwen3-Embedding-0.6B 为 1024）；模型或维度变化会重算全部向量。没配或调用失败时自动回退本地打分。注意：高级检索每轮多一次向量请求，配了重排再多一次（本机实测约 1–2 秒）。 |
| `SEARCH_CANDIDATE_TARGET` / `SEARCH_CANDIDATE_MAX` / `SEARCH_MAX_PAGES` / `SEARCH_SNIPPET_CHARS` | SearXNG 翻页聚合的调优项，默认 20 / 60 / 5 / 500 |
| `SEARCH_ALLOWED_DOMAINS` / `SEARCH_BLOCKED_DOMAINS` | 站点规则，逗号分隔。写 `example.com` 连子域一起算，写 `example.com/docs` 再限定路径前缀 |
| `CHAT_LOCAL_IMAGE_MODE` | 旧变量，仅用于迁移：没写 `CHAT_LOCAL_IMAGE_PARSER` 时，`ocr` 会映射到旧 OCR 服务，其余按 `vision` 处理。新配置请用 `CHAT_LOCAL_IMAGE_PARSER` |

没配置的能力会从界面上隐藏（例如没有 ASR 就不显示麦克风），不会出现点了必然报错的按钮。

### 更多细节

- 两个可直接照抄的配置示例、朗读/ASR/附件解析/重排的接口兼容说明：[docs/providers.zh-CN.md](docs/providers.zh-CN.md)
- SearXNG 的结果质量、重排开关、翻页聚合与实测耗时：[docs/search.zh-CN.md](docs/search.zh-CN.md)

## 功能

### 自建后端逐项自定义

LLM、搜索、ASR、附件解析分别配置，互不绑定：

- **LLM**：模型名、Base URL、API Key、上下文上限和单次最大输出都由你填写；协议可选 Anthropic 兼容（例如 DeepSeek 的 `/anthropic` 端点）或 OpenAI 兼容（Ollama、LM Studio、vLLM、各家云服务）。
- **ASR**：可选 DeepSeek `/v1/tools/asr` 或 OpenAI 兼容 `/v1/audio/transcriptions`。
- **附件解析**：图片可选「跟随模型 / OpenAI 兼容 OCR / DeepSeek」；文档可选「Python 文本解析 / DeepSeek」。Python 解析在本地抽 PDF/docx/pptx 的文字层，不花 OCR 费用；扫描件自动回退 DeepSeek OCR（若已配置）。
- **搜索**：可选 Tavily、AnySearch、SearXNG，或直接关闭。SearXNG 可以再挂自己的重排模型，开启多页聚合与相关性排序；不配就只取一页。
- 未配置的能力会自动隐藏。

### 会话与数据

- **本机存储**：FastAPI + SQLite 保存会话、工作区和附件（`data/chat.db`、`data/files/`）。
- **工作区**：侧栏顶部 `+` 新建工作区，选中工作区行内 `+` 新建对话；工作区 `⋯` 只保留重命名、角色设置和删除。会话菜单统一用“移动到…”弹窗选择目标，不随工作区数量增加菜单项。在该工作区下开启的新对话会自动归入其中；未绑定对话统一收进侧栏的“不绑定工作区”。删除工作区只会把会话移入“不绑定工作区”，不删除聊天。
- **历史导入导出**：支持 DeepSeek 官方 ZIP（`export_format_version: 3`）；覆盖、合并跳过重复、冲突另存副本三种方式，导入时可选择丢弃工具调用记录或图片原件。ZIP 只保存会话与附件，不保存工作区和角色卡；导入的会话归入“不绑定工作区”。
- **对话搜索**：侧栏搜索消息正文，结果按会话分组并显示匹配片段；归档会话不参与搜索。
- **归档与恢复**：会话菜单 → 归档；设置 → 数据管理 → 查看归档，可打开、恢复或永久删除。
- **对话清理**：按 N 年前/月前或日期区间删除；也可移除所有会话里的工具调用记录和图片原件。

### 上下文与工具（仅自建后端）

- **上下文管理**：用量提示、本地压缩，以及可配置的上下文上限和单次最大输出。云端模式只有用量提示，上限由 DeepSeek 固定。
- **自动生成标题**：可选，默认关闭。首轮回复完成后，本地后端用第一条用户消息和助手正文额外请求一次模型生成标题；云端继续使用 DeepSeek 自带标题。
- **工具轮数**：界面可调一次回答里的最大联网工具轮数。云端由 DeepSeek 服务端决定，前端不发送该参数。
- **工具开关**：配好搜索后，读链接始终启用（实际能否取到正文仍取决于搜索 provider）；“联网搜索”开关只控制搜索与页内查找（页内查找还需开启深度思考）。模型误调本轮未启用的工具时会跳过该调用并继续回答，不会中断。
- **长期记忆（仅自建后端，默认关闭）**：设置 → 记忆。记忆存在本机 `chat.db`，每次对话按「置顶+最近 / 本地关键词 / 向量（可选重排）」三档之一注入若干条；关键词和向量模式未命中时不会硬塞最近记忆，无置顶条目时发送空块。模型可查询、可提议写入或修改，提议要你逐条确认才生效；每条可带一行说明用于检索匹配，支持手动整理近似条目；支持导出为 txt 与导入 txt/JSON（重复条目自动跳过）。自动会话摘要尚未实现。注入规则、开关与上限见 [docs/context.zh-CN.md](docs/context.zh-CN.md)。

- **提示词（角色卡）**：设置 → 提示词。命名卡片 + 全局生效一张，正文只追加在内置规则之后；最多 30 张、每张 8000 字，存在 `data/prompts.json`。自建后端可给每个工作区绑定不同角色卡，优先级为「工作区卡 → 全局卡」；“跟随默认角色”、未绑定、旧会话或卡片失效时回退全局卡。云端模式可用工作区整理对话，但不绑定角色卡。

### 界面与配置

- **首次运行向导**：第一步选 DeepSeek 云端或自定义后端；云端填好 Key 即完成并跳到数据管理。自定义依次配置模型 → 可选功能（搜索、附件解析、语音、重排与向量），之后每一步都能跳过；重排、Embedding 与朗读也在这一步里展开。保存后立即生效，之后可从 设置 → 通用设置 重新打开。
- **能力探测**：没配置的搜索、ASR 等入口自动隐藏。
- **使用统计**：设置 → 使用统计。汇总请求数、输入 / 缓存读取 / 输出 tokens、缓存命中率与估算费用，可按 7 / 30 / 90 天查看并按模型拆分；单价按每百万 tokens 自行填写（0 表示不计费）。缓存命中率 = 缓存读取输入 ÷ 总输入，总输入 = 未命中输入 + 缓存创建输入 + 缓存读取输入，输出 tokens 不参与。只统计对话请求，记录存在本机 `chat.db`；本机模式由后端累计整次请求（含多轮工具），云端由前端上报，失败时会排队补传。
- **调试面板**：侧栏标题 1.5 秒内连点 5 次打开。状态页看各服务和向量库的配置与覆盖情况，也显示提示词生效卡与字数、记忆相关度门槛、搜索启用引擎数和朗读音色；日志页看后端最近 800 行（含请求与耗时），探针页会真实请求一次 LLM / Embedding / Rerank / 搜索 / 记忆检索 / 语音输入 / 朗读并显示结果与耗时。
- **界面修复**：深色模式下拉框、会话菜单定位、清理统计等问题。
- **流式性能优化**：当前会话的订阅已隔离，避免每个 token 都带动整个应用重渲染；上下文估算按约 250ms 节流；长消息和长会话列表使用浏览器延迟渲染；流式期间未闭合的代码块、公式和流程图延后高亮，停止后渲染最终完整内容；附件原件按文件 ID 缓存，正在使用的地址不释放，空闲缓存限制数量。目标是降低长对话卡顿，不能保证所有设备都不卡。

## 能力对照

| 能力 | DeepSeek 云端 | 自建后端 |
|---|---|---|
| 对话/思考/停止/续写 | DeepSeek API | Anthropic 或 OpenAI 兼容接口 |
| 联网搜索、读网页 | DeepSeek 服务端工具，工具本身不计费 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | `deepseek` 或 OpenAI 兼容 ASR |
| 朗读 | DeepSeek `/v1/tools/tts` | `deepseek` 或 OpenAI 兼容 `/v1/audio/speech` |
| 图片 | 直传 DeepSeek | 跟随模型 / OpenAI 兼容 OCR / DeepSeek |
| PDF/Word/PPT | DeepSeek Files API | Python 文本解析 / DeepSeek OCR |

自建朗读支持四种接口形状（`openai` / `deepseek` / `engine` / `template`），覆盖常见自建 TTS 服务；四种形状的对照表、`template` 的四项配置和明确不支持的服务类型（如 ComfyUI 异步工作流）见 [docs/providers.zh-CN.md](docs/providers.zh-CN.md#朗读的四种接口形状)。

## 限制

- 本项目未经过广泛测试，详见上面的「项目状态」。
- OpenAI 兼容 OCR 只处理图片；PDF/Word/PPT 默认本地解析，扫描件需要 DeepSeek OCR，老 `.doc` 请先另存为 `.docx`。
- 导入/导出目前只支持 DeepSeek 导出格式。
- 朗读（云端与自建）都未做真机试听验证，属于「未经过广泛测试」的范围；自建朗读能不能出声，取决于你接的服务是否实现了 `/v1/audio/speech`。
- 使用统计只覆盖对话请求，标题生成、附件解析、向量与重排等后台调用不计入；单价只用于估算，以服务商账单为准。
- SearXNG 的两类已知问题（Brave 跳转链、上游引擎限流）见 [docs/search.zh-CN.md](docs/search.zh-CN.md#已知的两类脏数据)。

## 安全与隐私

- 服务默认只监听 `127.0.0.1`，写接口要求 `X-Chat-Local: 1` 请求头。
- 会话和附件保存在本机 `data/`，不依赖 DeepSeek 账号或云端会话同步；但云端模式仍会把对话内容发送给 DeepSeek API，自建模式才会把推理留在你配置的模型端。
- 开启联网搜索、ASR、OCR 时，对应内容会发送给你选择的 provider；不需要的能力可以直接关闭。
- 自建模式用 SearXNG 读网页时，会拒绝本机、内网和保留地址（含跳转后的地址），并限制单次正文大小；Tavily 与 AnySearch 的正文提取发生在服务商侧。
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
