# chat-local

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造的本地聊天应用：会话和附件存在本机 SQLite，模型与工具由你自己配置。

> **定位：深度还原 DeepSeek 网页端的核心聊天体验，同时把会话和附件留在本机；通过 Anthropic 兼容接口，让更多模型也能使用这套前端。**

这里的「还原」指对话、思考、联网/深搜、引用、附件和语音等核心聊天链路，不包含 DeepSeek 账号体系、云端会话同步或官网的全部运营功能。数据留在本机不等于完全不出网：云端模式仍会把请求发送给你选择的 API，只有自建模型才能把推理留在本地。

两种用法：

- **DeepSeek 云端**：页面里填一个 DeepSeek API Key，对话、联网搜索、语音识别、朗读都由 DeepSeek 提供。
- **自建后端**：后端按 `base URL + API Key` 调用任意 Anthropic 兼容模型；搜索、ASR、OCR 可分别接 Tavily / AnySearch / SearXNG / DeepSeek / OpenAI 兼容接口，不配置就自动关闭。

## AI 辅助开发声明

本项目的代码、文档和重构大量使用了 **Qoder 中的 DeepSeek** 辅助生成和修改，并由人工审查、运行和取舍。AI 生成的代码可能存在错误、遗漏或安全问题，请在使用前自行评估；本项目与 DeepSeek 官方无关。

## 与 chat-demo 的关系

**使用 DeepSeek 云端时，本项目的云端对话功能与 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 保持一致**：对话、思考、联网/深度搜索、读链接、附件上传、语音输入和朗读沿用同一套 DeepSeek 官方接口与交互，云端请求链没有改写。

与原版相比，主要差异是会话改为本机 SQLite 存储，并新增了以下功能。标注「仅自建后端」的只在自建模式生效，云端模式不提供：

- **自建后端模式**（仅自建）：按 `base URL + API Key` 调用任意 Anthropic 兼容模型。
- **能力配置**（仅自建）：LLM、搜索、ASR、OCR 分别配置；未配置的入口自动隐藏。
- **首次运行向导**：两种模式都能进入，但只负责写自建后端的配置。
- **本机存储**：FastAPI + SQLite 保存会话和附件，替代纯浏览器存储。
- **历史导入导出**：支持 DeepSeek 官方 ZIP；三种导入方式，可选丢弃工具调用记录或图片原件。
- **归档与恢复**：归档会话不在侧栏显示，可在归档界面打开或恢复。
- **对话清理**：按 N 年前/月前或日期区间删除；可清理工具调用记录和图片原件。
- **上下文管理**（仅自建）：上下文用量提示、本地压缩，以及可配置的上下文上限和单次最大输出；云端只有用量提示，上限由 DeepSeek 固定。
- **工具轮数设置**（仅自建）：云端由 DeepSeek 服务端决定搜索/打开网页次数，前端不发送该参数。
- **界面修复**：深色模式下拉框、会话菜单定位、清理统计等问题。

## 项目状态

这是一个**社区快照（v0.1.0）**，不是持续维护的产品。

- 界面、消息协议和 DeepSeek 云端路径继承自 [chat-demo](https://github.com/deepseek-ai/chat-demo)，核心功能保留；自建后端路径做过冒烟测试。
- **未经过广泛测试**：DeepSeek 云端、ASR、OCR、TTS、不同模型服务和不同操作系统上的表现，主要交给社区验证。
- Issue 和 PR 随缘处理；使用前请自行备份 `data/`，不要把它当作唯一数据副本。
- 遇到问题请附上系统、模型 provider、复现步骤和相关日志，便于判断。

## 快速开始

需要 Python 3.10+ 与 Node.js 20+。

```bash
pip install -r requirements.txt
```

首次打开页面会出现配置向导：选 DeepSeek 云端，或填自建后端的 Base URL、API Key、模型名。保存后写入 `data/config.json`，立即生效，不需要重启。

也可以跳过向导，复制 `.env.example` 为 `.env` 后手动填写；环境变量优先于向导保存的值。

构建并启动：

```bash
cd web && npm install && npm run build && cd ..
python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
```

Windows 也可以直接双击 `build.bat` 和 `start.bat`。打开 `http://127.0.0.1:17865/`。

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
| `SEARCH_BASE_URL` / `SEARCH_API_KEY` / `SEARCH_RESULTS` | 联网搜索；AnySearch 的 key 可留空（匿名限流）；Tavily 需要 key |
| `CHAT_LOCAL_IMAGE_MODE` | `vision` / `auto` / `ocr` |

示例：只用 DeepSeek 自建后端

```env
DEEPSEEK_API_KEY=sk-xxx
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=tvly-xxx
```

示例：完全自建

```env
LLM_BASE_URL=http://127.0.0.1:8000
LLM_API_KEY=
LLM_MODEL=qwen3
SEARCH_PROVIDER=searxng
SEARCH_BASE_URL=http://127.0.0.1:8080
ASR_PROVIDER=openai
ASR_BASE_URL=http://127.0.0.1:9000
ASR_API_KEY=
ASR_MODEL=whisper-1
```

没配置的能力会从界面上隐藏（例如没有 ASR 就不显示麦克风），不会出现点了必然报错的按钮。

## 能力对照

| 能力 | DeepSeek 云端 | 自建后端 |
|---|---|---|
| 对话/思考/停止/续写 | DeepSeek API | Anthropic 兼容接口 |
| 联网搜索、读网页 | DeepSeek 服务端工具，工具本身不计费 | 你配置的搜索 provider |
| 语音输入 | DeepSeek `/v1/tools/asr` | `deepseek` 或 OpenAI 兼容 ASR |
| 朗读 | DeepSeek `/v1/tools/tts` | 暂不支持 |
| 图片 | 直传 DeepSeek | 直接发视觉；失败可回退 OCR |
| PDF/Word/PPT | DeepSeek Files API | DeepSeek OCR 或关闭 |

朗读（TTS）只在 DeepSeek 云端模式提供，调用 `/v1/tools/tts`；自建后端不显示朗读入口。云端 TTS 尚未做真机验证，属于「未经过广泛测试」的范围。

## 数据

- 会话与附件：`data/chat.db`、`data/files/`。
- 历史导入：支持 DeepSeek 官方导出 ZIP（`export_format_version: 3`），可覆盖、合并跳过重复、冲突另存副本；导入时可选择不导入工具调用记录或图片。
- 归档：会话菜单 → 归档；设置 → 数据管理 → 查看归档，可打开或恢复。
- 清理：按 N 年前/月前或日期区间删除；也可移除所有会话里的工具调用记录和图片原件。

## 限制

- 本项目未经过广泛测试，详见上面的「项目状态」。
- 自建后端的 LLM 目前只支持 Anthropic 兼容协议（DeepSeek 的 `/anthropic` 端点、其他兼容服务）。OpenAI 兼容的 LLM 尚未接入。
- OpenAI 兼容 OCR 只处理图片；PDF/Word/PPT 请用 DeepSeek OCR 或先转图片。
- 导入/导出目前只支持 DeepSeek 导出格式。

## 安全与隐私

- 服务默认只监听 `127.0.0.1`，写接口要求 `X-Chat-Local: 1` 请求头。
- 会话和附件保存在本机 `data/`，不依赖 DeepSeek 账号或云端会话同步；但云端模式仍会把对话内容发送给 DeepSeek API，自建模式才会把推理留在你配置的模型端。
- 开启联网搜索、ASR、OCR 时，对应内容会发送给你选择的 provider；不需要的能力可以直接关闭。
- 自建后端的密钥只放在 `.env` 或 `data/config.json`，保存后不会回传明文；两个位置都已被 `.gitignore` 排除。
- 配置向导的写接口只接受本机请求；如果服务监听在 `0.0.0.0`，向导不可写，只能用 `.env`。
- 云端模式的 API Key 存在浏览器 localStorage，和原版 chat-demo 一致。

## 许可

MIT，见 [LICENSE](LICENSE)。界面与消息协议来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）。
