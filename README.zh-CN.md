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

```bash
pip install -r requirements.txt

cd web && npm install && npm run build && cd ..

python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
```

Windows 也可以直接双击 `build.bat` 和 `start.bat`。打开 `http://127.0.0.1:17865/`。

首次打开会出现配置向导：

- **DeepSeek 云端**：切到云端模式，在设置里填 DeepSeek API Key。
- **自建后端**：填 Base URL、API Key、模型名；高级里再配搜索、ASR、OCR。

保存后写入 `data/config.json`，立即生效，不需要重启。也可以跳过向导，复制 `.env.example` 为 `.env` 手动配置；环境变量优先于向导保存的值。

> 云端模式仍然需要启动本机后端，因为会话和附件存在本机 SQLite，不走 DeepSeek 账号云同步。

## 两种模式

| | DeepSeek 云端 | 自建后端 |
|---|---|---|
| LLM | DeepSeek 官方 API | 任意 Anthropic 兼容模型（完全自定义） |
| 需要 | 一个 DeepSeek API Key | Base URL + API Key + 模型名 |
| 联网搜索 | DeepSeek 服务端工具 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | 你配置的 ASR provider |
| 朗读 | DeepSeek `/v1/tools/tts` | 不支持，不显示入口 |
| 历史 | 本机 SQLite | 本机 SQLite |

## 配置

配置有两个来源，优先级从高到低：

1. 环境变量 / 项目根目录的 `.env`（适合部署）
2. 首次运行向导写入的 `data/config.json`（适合普通用户）

不会读取其他项目的文件。

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 填了就自动把 LLM、ASR、OCR 指向 DeepSeek |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 自建后端的 Anthropic 兼容接口 |
| `LLM_CONTEXT_LIMIT` / `LLM_MAX_OUTPUT_TOKENS` | 输入上限与单次最大输出，默认 131072 / 8192 |
| `ASR_PROVIDER` | `none` / `deepseek` / `openai` |
| `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` | 语音识别；OpenAI 兼容接口默认模型 `whisper-1` |
| `OCR_PROVIDER` | `none` / `deepseek` / `openai` |
| `OCR_BASE_URL` / `OCR_API_KEY` / `OCR_MODEL` | 文档/图片识别；OpenAI 兼容接口只支持图片 |
| `SEARCH_PROVIDER` | `none` / `tavily` / `anysearch` / `searxng` |
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | 联网搜索。Tavily（`https://api.tavily.com`）和 AnySearch（`https://api.anysearch.com`）的 Base URL 可省略；SearXNG 必须填写。Tavily 需要 key；AnySearch 的 key 可留空（匿名限流） |
| `CHAT_LOCAL_IMAGE_MODE` | `vision` / `auto` / `ocr` |

没配置的能力会从界面上隐藏（例如没有 ASR 就不显示麦克风），不会出现点了必然报错的按钮。

### 示例：自建后端模式，用 DeepSeek 的 Anthropic 接口当模型 + Tavily 搜索

这个示例只适用于**自建后端模式**。模型来自 DeepSeek，但联网搜索由本项目的本地工具循环执行，所以需要单独配置搜索 provider。

```env
LLM_BASE_URL=https://api.deepseek.com/anthropic
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-flash

SEARCH_PROVIDER=tavily
SEARCH_API_KEY=tvly-xxx
# SEARCH_BASE_URL 可省略，默认 https://api.tavily.com
```

如果使用 **DeepSeek 云端模式**，联网搜索由 DeepSeek 服务端完成，不要再配置 `SEARCH_PROVIDER`。

### 示例：完全自建

```env
LLM_BASE_URL=http://127.0.0.1:8000
LLM_API_KEY=
LLM_MODEL=qwen3
LLM_CONTEXT_LIMIT=65536
LLM_MAX_OUTPUT_TOKENS=4096

SEARCH_PROVIDER=searxng
SEARCH_BASE_URL=http://127.0.0.1:8080

ASR_PROVIDER=openai
ASR_BASE_URL=http://127.0.0.1:9000
ASR_API_KEY=
ASR_MODEL=whisper-1
```

## 功能

### 自建后端逐项自定义

LLM、搜索、ASR、OCR 分别配置，互不绑定：

- **LLM**：模型名、Base URL、API Key、上下文上限和单次最大输出都由你填写；使用 Anthropic 兼容协议（例如 DeepSeek 的 `/anthropic` 端点）。
- **ASR**：可选 DeepSeek `/v1/tools/asr` 或 OpenAI 兼容 `/v1/audio/transcriptions`。
- **OCR**：可选 DeepSeek `/v1/tools/ocr`（文档与图片）或 OpenAI 兼容视觉接口（仅图片）。
- **搜索**：可选 Tavily、AnySearch、SearXNG，或直接关闭。
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

- **首次运行向导**：两种模式都能进入，但只负责写自建后端的配置。
- **能力探测**：没配置的搜索、ASR 等入口自动隐藏。
- **界面修复**：深色模式下拉框、会话菜单定位、清理统计等问题。

## 能力对照

| 能力 | DeepSeek 云端 | 自建后端 |
|---|---|---|
| 对话/思考/停止/续写 | DeepSeek API | Anthropic 兼容接口 |
| 联网搜索、读网页 | DeepSeek 服务端工具，工具本身不计费 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | `deepseek` 或 OpenAI 兼容 ASR |
| 朗读 | DeepSeek `/v1/tools/tts` | 暂不支持 |
| 图片 | 直传 DeepSeek | 直接发视觉；失败可回退 OCR |
| PDF/Word/PPT | DeepSeek Files API | DeepSeek OCR 或关闭 |

朗读（TTS）只在 DeepSeek 云端模式提供，自建后端不显示朗读入口；云端 TTS 尚未做真机验证，属于「未经过广泛测试」的范围。

## 限制

- 本项目未经过广泛测试，详见上面的「项目状态」。
- 自建后端的 LLM 目前只支持 Anthropic 兼容协议（DeepSeek 的 `/anthropic` 端点、其他兼容服务）。OpenAI 兼容的 LLM 尚未接入。
- OpenAI 兼容 OCR 只处理图片；PDF/Word/PPT 请用 DeepSeek OCR 或先转图片。
- 导入/导出目前只支持 DeepSeek 导出格式。
- 自建后端没有 TTS。

## 安全与隐私

- 服务默认只监听 `127.0.0.1`，写接口要求 `X-Chat-Local: 1` 请求头。
- 会话和附件保存在本机 `data/`，不依赖 DeepSeek 账号或云端会话同步；但云端模式仍会把对话内容发送给 DeepSeek API，自建模式才会把推理留在你配置的模型端。
- 开启联网搜索、ASR、OCR 时，对应内容会发送给你选择的 provider；不需要的能力可以直接关闭。
- 自建后端的密钥只放在 `.env` 或 `data/config.json`，保存后不会回传明文；两个位置都已被 `.gitignore` 排除。
- 配置向导的写接口只接受本机请求；如果服务监听在 `0.0.0.0`，向导不可写，只能用 `.env`。
- 云端模式的 API Key 存在浏览器 localStorage，和原版 chat-demo 一致。

## AI 辅助开发声明

本项目的代码、文档和重构大量使用了 **Qoder 中的 DeepSeek** 辅助生成和修改，并由人工审查、运行和取舍。AI 生成的代码可能存在错误、遗漏或安全问题，请在使用前自行评估；本项目与 DeepSeek 官方无关。

## 许可

MIT，见 [LICENSE](LICENSE)。界面与消息协议来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）。
