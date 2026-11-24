# 自建后端的接口兼容与配置示例

README 只放"用不用、怎么跑起来"；这份文档放两类细节：可以直接照抄的配置示例，以及把外部推理服务接进来时各家的接口差异。

## 配置示例

所有配置都能写进项目根目录的 `.env`，或由首次运行向导写入 `data/config.json`（环境变量优先）。各能力互不绑定：没配的那一项只是不显示入口，不影响其他功能。

**每个能力最少要填什么**

| 能力 | 必填 | 可省（有默认） |
|---|---|---|
| 对话 | `LLM_BASE_URL`、`LLM_MODEL` | `LLM_PROVIDER`（默认 `anthropic`；OpenAI 兼容写 `openai`）、`LLM_API_KEY`（本机服务可空）、`LLM_CONTEXT_LIMIT`、`LLM_MAX_OUTPUT_TOKENS` |
| 搜索 | `SEARCH_PROVIDER`；选 `searxng` 时还要 `SEARCH_BASE_URL` | Tavily / AnySearch 的 Base URL、`SEARCH_RESULTS`（1–12，默认 6） |
| 重排 | `RERANK_PROVIDER` 与 `RERANK_BASE_URL`，**两个都要** | `RERANK_MODEL`、`RERANK_API_KEY`、`RERANK_TIMEOUT` |
| 向量 | `EMBEDDING_PROVIDER`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`EMBEDDING_DIM` | `EMBEDDING_API_KEY` |
| 语音输入 | `ASR_PROVIDER` 与 `ASR_BASE_URL` | `ASR_MODEL`（默认 `whisper-1`）、`ASR_API_KEY` |
| 附件解析 | 图片：`CHAT_LOCAL_IMAGE_PARSER`；文档：`CHAT_LOCAL_DOC_PARSER` | `OCR_OPENAI_*` / `OCR_DEEPSEEK_*` 两套凭据 |
| 朗读 | `TTS_PROVIDER` 与 `TTS_BASE_URL`；`engine` 这一档还必须填 `TTS_VOICE` | `TTS_MODEL`（默认 `tts-1`）、`TTS_RESPONSE_FORMAT`、`TTS_MAX_CHARS` |

只填 `RERANK_BASE_URL` 不会开启重排：`RERANK_PROVIDER` 默认是 `none`，两项缺一不可。

向量接口只给记忆的「高级检索」用，**维度必须手填且与模型一致**（写错不会自动纠正，使用时会报维度不一致并回退本地打分）。

### 示例 1：只有模型（最小可用）

```env
# 地址填到 /v1 之前：后端自己会拼 /v1/messages
LLM_BASE_URL=http://127.0.0.1:8000
LLM_MODEL=qwen3
# llama.cpp / Ollama 这类本机服务通常不校验 key，留空即可
LLM_API_KEY=
```

拿到：对话、思考、历史、上下文管理。搜索、语音、附件解析、朗读都不显示入口。

模型端支持两种协议，用 `LLM_PROVIDER` 选：默认 `anthropic` 走 `POST /v1/messages`（例如 DeepSeek 的 `/anthropic` 端点）；填 `openai` 走 `POST /v1/chat/completions`，Ollama、LM Studio、vLLM、llama.cpp 和各家云服务可以直接接，不需要额外网关。详见下方「对话模型的两条协议」。

### 示例 2：本地全家桶（模型 + 搜索 + 语音 + 朗读）

```env
# ---- 模型 ----
LLM_BASE_URL=http://127.0.0.1:8000
LLM_API_KEY=
LLM_MODEL=qwen3
LLM_CONTEXT_LIMIT=65536
LLM_MAX_OUTPUT_TOKENS=4096

# ---- 搜索：自建 SearXNG，不需要 key ----
SEARCH_PROVIDER=searxng
SEARCH_BASE_URL=http://127.0.0.1:8080

# ---- 重排：可选，但 SearXNG 的翻页聚合以它为前提 ----
# 接口要 OpenAI 兼容的 /v1/rerank（llama-server --reranking、TEI 的 /rerank 都行）
RERANK_PROVIDER=openai
RERANK_BASE_URL=http://127.0.0.1:8081
RERANK_MODEL=bge-reranker-v2-m3

# ---- 向量：可选，只给记忆高级检索用 ----
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://127.0.0.1:8080
EMBEDDING_MODEL=Qwen3-Embedding-0.6B-Q8_0
EMBEDDING_DIM=1024

# ---- 语音输入：whisper.cpp 这类 OpenAI 兼容 ASR ----
ASR_PROVIDER=openai
ASR_BASE_URL=http://127.0.0.1:9000
ASR_MODEL=whisper-1
ASR_API_KEY=

# ---- 附件解析：图片交给模型；文档本地抽文字（扫描件才需要 OCR） ----
CHAT_LOCAL_IMAGE_PARSER=vision
CHAT_LOCAL_DOC_PARSER=python
# 需要图片走 OCR 时：
# CHAT_LOCAL_IMAGE_PARSER=openai
# OCR_OPENAI_BASE_URL=http://127.0.0.1:9001
# OCR_OPENAI_MODEL=gpt-4o-mini
# OCR_OPENAI_API_KEY=
# 需要文档/图片走 DeepSeek OCR 时：
# OCR_DEEPSEEK_API_KEY=...

# ---- 朗读 ----
TTS_PROVIDER=openai
TTS_BASE_URL=http://127.0.0.1:9002
TTS_MODEL=tts-1
TTS_VOICE=alloy
TTS_RESPONSE_FORMAT=wav
```

每一项都可以单独删掉：删了对应功能就从界面消失，其他能力不受影响。SearXNG 的那一串调优变量（候选数、翻页数、摘要长度）走默认值即可，细节见 [search.zh-CN.md](search.zh-CN.md)。

### 示例 3：一把 DeepSeek key 打通（仅 `.env`）

这个快捷方式**只能写在 `.env` 或系统环境变量里**，首次运行向导没有「DeepSeek key」这一项；用向导配置的人需要在 LLM / 语音 / 附件解析三处分别选 `deepseek` 并各填一次 key（或者干脆改用 `.env`）。

```env
DEEPSEEK_API_KEY=sk-xxx
# 朗读不随 key 自动打开，想用再显式声明（地址和 key 会自动复用）
TTS_PROVIDER=deepseek
```

自动生效的部分：

- LLM → `https://api.deepseek.com/anthropic`，模型 `deepseek-flash`；写了 `LLM_PROVIDER=openai` 时地址改默认 `https://api.deepseek.com`（官方 OpenAI 兼容端点）；
- 语音输入 → `deepseek` 的 `/v1/tools/asr`；
- OCR → `deepseek` 的 `/v1/tools/ocr`（支持 PDF/Word/PPT 和图片）；
- 朗读 → 只在你写了 `TTS_PROVIDER=deepseek` 后启用（地址和 key 自动复用这把 key）。

**搜索不会因为这把 key 自动打开。** 自建后端的联网搜索要由本地工具循环执行，必须自己配 `SEARCH_PROVIDER`（Tavily / AnySearch / SearXNG）；只有 DeepSeek 云端模式才是服务端搜索。

想覆盖任何一项，直接写对应的环境变量即可（环境变量优先于这把 key 带来的默认值）。

## 工作区与角色卡

工作区在自建后端模式和云端模式下都能整理对话。自建后端模式还可在「设置 → 工作区」中给每个工作区绑定一张角色卡。后端按会话实际所属的工作区选提示词，优先级为「工作区卡 → 全局卡」；新对话使用创建时选中的工作区。未绑定对话统一收进侧栏的“不绑定工作区”；删除工作区只会把会话移入其中，不删除聊天。

ZIP 历史导出只包含会话和附件，不包含工作区定义与角色卡绑定；导入的会话归入“不绑定工作区”。

## 对话模型的两条协议

`LLM_PROVIDER` 决定后端向上游发哪种请求。两种协议下，联网搜索、读网页、引用角标、思考过程、附件（图片/OCR）、自动标题、上下文压缩都走同一套逻辑，不需要另配。

| `LLM_PROVIDER` | 上游接口 | 请求处理 | 典型服务 |
|---|---|---|---|
| `anthropic`（默认） | `POST /v1/messages`：根地址、`/anthropic`、`/v1` 这类前缀自动补；填到 `/messages` 的完整接口（任意路径，如 `/gw/v1/messages`）原样请求 | 原样转发 | DeepSeek 的 `/anthropic` 端点、放在任意路径下的 Anthropic 兼容网关 |
| `openai` | `POST /v1/chat/completions`（地址规则同 ASR / 重排：根地址或以 `/v1` 结尾自动拼，完整地址原样请求） | 请求改写成 OpenAI 结构，流式回复再翻译回 Anthropic 事件 | OpenAI、DeepSeek、Ollama、LM Studio、vLLM、llama.cpp 及各类网关 |

OpenAI 这一路对齐的细节：

- **思考过程**：认 `reasoning_content`（DeepSeek / vLLM）和 `reasoning` 两种字段，显示为思考块；模型不返回思考就不显示。
- **工具调用**：`tools` 转成 function calling；模型返回的 `tool_calls` 由本机执行 web_search / read_url，结果按 `role: tool` 回传，搜索卡片和引用编号照常显示。配好搜索后 read_url 始终声明，搜索开关只撤掉 web_search；find_in_page 还需开启深度思考。模型误调未声明的工具时只回一条“未执行”的 tool_result，回复继续。
- **用量**：`prompt_tokens` / `completion_tokens` 计入上下文提示；`prompt_tokens_details.cached_tokens` 记为缓存命中。
- **图片**：base64 图片转成 `image_url`（data URL）。上游模型要支持视觉；默认的 `CHAT_LOCAL_IMAGE_PARSER=vision` 在模型拒绝图片时会自动改用 OCR 重试一次（需配好 OCR 凭据），也可以直接选 `openai` 或 `deepseek`。
- **兼容兜底**：服务端不认 `stream_options` 时自动去掉重试一次；忽略 `stream` 直接回 JSON 的服务也能用。
- **自定义请求头**：`LLM_HEADERS` 填 JSON 对象，追加或覆盖请求头（默认 `User-Agent` 是 python-httpx，可在这里改成自己的身份）。两种协议都生效，标题和压缩请求也带上。可用占位符：

  | 占位符 | 值 |
  |---|---|
  | `{key}` | `LLM_API_KEY` |
  | `{session}` | 当前对话 ID，统一成 `ses_...` 形式 |
  | `{model}` | 模型名 |

  `{session}` 优先用前端随请求传来的会话 ID；直接调接口没传时，按第一条用户消息取哈希，同一对话保持稳定。探测类请求（健康检查、测试连接）没有会话，带 `{session}` 或 `{model}` 的头会自动跳过，不会把占位符原样发出去。

有些服务要求声明 agent 身份并给每个对话发稳定会话 ID（把 `User-Agent` 写成自己的名字，再在一个自定义头里放 `ses_...`）：

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL=your-model
LLM_API_KEY=sk-xxx
LLM_HEADERS={"User-Agent": "chat-local-oss/0.1.3", "x-session-id": "{session}"}
```

同一对话的所有请求（正文、工具轮次、自动标题、上下文压缩）都会带同一个 `ses_...`。

- **额外请求体字段**：`LLM_EXTRA_BODY` 填 JSON 对象，浅合并进上游请求体，两种协议通用，例如 `{"top_k": 40, "metadata": {"user_id": "u1"}}`。`messages` 和 `stream` 由本机生成，写了也会忽略；嵌套对象整体替换，不做深度合并。只认 `.env` / 系统环境变量，向导里没有这一项，非法 JSON 会在请求时报错而不是静默丢弃。

Ollama：

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen3:8b
LLM_API_KEY=
```

DeepSeek 的 OpenAI 端点（同一把 key）：

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-xxx
```

Azure OpenAI 这类要求 `api-key` 头和 `api-version` 查询参数的服务，用完整接口地址 + 自定义请求头即可接入，不需要额外网关：

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=2024-10-21
LLM_MODEL=DEPLOYMENT
LLM_API_KEY=your-azure-key
LLM_HEADERS={"api-key": "{key}"}
```

地址已经带完整路径时原样请求，所以查询参数会保留。Azure 没有 `/v1/models`，向导里的「测试连接」可能显示 404/405，但对话不受影响；健康检查把这类响应视为地址可达。

## 朗读的四种接口形状

自建朗读按**请求形状**分四档。音频推理服务没有统一协议，能对齐的只有"输入一段文字、输出一段音频"，所以每一档对应一类接口，遇到新服务先看它像哪档：

| provider | 请求体 | 地址规则 | 典型服务 |
|---|---|---|---|
| `openai` | `{model, input, voice, response_format}` | 根地址或以 `/v1` 结尾的地址（含 `/api/v1` 这类前缀）自动接 `/v1/audio/speech`；带了别的路径就原样用 | llama.cpp、audio.cpp、vLLM、TGI、Kokoro-FastAPI 及多数套壳 fork |
| `deepseek` | `{text, voice_id, format, filter_markdown}` | 官方 `/v1/tools/tts` | DeepSeek 官方 |
| `engine` | `{engine, input, voice, response_format}` | 填到接口级，原样请求（音色必填） | 用 `engine` 字段选模型的服务，例如自建模型控制台 |
| `template` | 你自己写的 JSON 模板，支持 `{text}` `{voice}` `{model}` `{format}` 占位 | 你填完整 URL | 自己用 PyTorch + FastAPI 包一层的任何服务；响应是 base64 字段或音频链接也能取 |

`template` 用 `TTS_TEMPLATE_URL` / `TTS_TEMPLATE_BODY` / `TTS_TEMPLATE_AUDIO` / `TTS_TEMPLATE_HEADERS` 四项配置，只能写在 `.env` 里，`.env.example` 有完整注释。

占位符只替换一次：正文里恰好出现 `{voice}` / `{format}` 这类文字会原样发给服务，不会被二次替换。

**明确不做的**：ComfyUI 这类"提交工作流 → 轮询任务 → 再下载产物"的异步服务。它不是单次请求就返回音频，要支持得单独写轮询适配器，而且每张工作流图都不一样。这类请先用别的网关把音频吐成 HTTP 接口，或提 issue 说明你的工作流。

自建后端的朗读由你配的 provider 决定：`deepseek` 走官方 `/v1/tools/tts`（返回 24 kHz 裸 PCM），`openai` 走 `/v1/audio/speech`（按 `TTS_RESPONSE_FORMAT` 返回 wav/mp3/opus/pcm）。朗读者先在本机把正文清洗成适合念的纯文本（去掉代码块、表格、公式、引用角标），再按句子边界切段逐段请求，播当前段时预取下一段，所以长回复不会被截断；单次请求的字数上限就是 `TTS_MAX_CHARS`。音色名和可用格式完全由你的服务决定，本项目不做校验。

没配 `TTS_PROVIDER` 时不显示朗读按钮，云端模式的朗读入口不受影响。

## 其他能力：ASR / OCR / 重排 / 向量

音频推理服务和 OCR 服务同样没有统一协议，本项目按"能对齐的最小约定"处理：

| 能力 | 请求形状 | 响应形状 | 地址规则 |
|---|---|---|---|
| ASR | 标准 multipart（`file` + `model`），whisper.cpp 与多数 fork 都认 | `{text}` / `{transcript}` / `{results\|segments:[{text}]}` / `[{text}]` / 纯文本；长 base64 串会被跳过 | 根地址或以 `/v1` 结尾的地址自动接 `/v1/audio/transcriptions`，完整地址原样请求 |
| OCR | DeepSeek 用 `/v1/tools/ocr`（文档与图片）；OpenAI 兼容走视觉 chat/completions（仅图片） | 两种都是取正文文本 | 同上，根地址或以 `/v1` 结尾的地址接标准路径 |
| 重排 | `{model, query, documents}` | `{"results":[{index,relevance_score}]}` 或顶层数组 `[{index,score}]`（TEI 的形状），网关套一层 `data` 也认 | 根地址或以 `/v1` 结尾的地址自动接 `/v1/rerank`，填 TEI 的 `/rerank` 原样请求 |
| 向量 | `{model, input:[...]}` | `{data:[{index, embedding:[...]}]}`（OpenAI 形状） | 根地址或以 `/v1` 结尾的地址自动接 `/v1/embeddings`，完整地址原样请求 |

PaddleOCR、MinerU、Surya 这类"正经 OCR 服务"没有统一协议，本项目目前不接；用 OpenAI 兼容视觉接口或 DeepSeek OCR 代替。

ComfyUI 这类异步工作流服务不接，原因见上一节末尾。
