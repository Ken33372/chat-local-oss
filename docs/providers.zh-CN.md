# 自建后端的接口兼容与配置示例

README 只放"用不用、怎么跑起来"；这份文档放两类细节：可以直接照抄的配置示例，以及把外部推理服务接进来时各家的接口差异。

## 配置示例

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

RERANK_BASE_URL=http://127.0.0.1:8080
RERANK_MODEL=bge-reranker-v2-m3
```

## 朗读的四种接口形状

自建朗读按**请求形状**分四档。音频推理服务没有统一协议，能对齐的只有"输入一段文字、输出一段音频"，所以每一档对应一类接口，遇到新服务先看它像哪档：

| provider | 请求体 | 地址规则 | 典型服务 |
|---|---|---|---|
| `openai` | `{model, input, voice, response_format}` | 根地址自动接 `/v1/audio/speech`；带了别的路径就原样用 | llama.cpp、audio.cpp、vLLM、TGI、Kokoro-FastAPI 及多数套壳 fork |
| `deepseek` | `{text, voice_id, format, filter_markdown}` | 官方 `/v1/tools/tts` | DeepSeek 官方 |
| `engine` | `{engine, input, voice, response_format}` | 填到接口级，原样请求（音色必填） | 用 `engine` 字段选模型的服务，例如自建模型控制台 |
| `template` | 你自己写的 JSON 模板，支持 `{text}` `{voice}` `{model}` `{format}` 占位 | 你填完整 URL | 自己用 PyTorch + FastAPI 包一层的任何服务；响应是 base64 字段或音频链接也能取 |

`template` 用 `TTS_TEMPLATE_URL` / `TTS_TEMPLATE_BODY` / `TTS_TEMPLATE_AUDIO` / `TTS_TEMPLATE_HEADERS` 四项配置，只能写在 `.env` 里，`.env.example` 有完整注释。

**明确不做的**：ComfyUI 这类"提交工作流 → 轮询任务 → 再下载产物"的异步服务。它不是单次请求就返回音频，要支持得单独写轮询适配器，而且每张工作流图都不一样。这类请先用别的网关把音频吐成 HTTP 接口，或提 issue 说明你的工作流。

自建后端的朗读由你配的 provider 决定：`deepseek` 走官方 `/v1/tools/tts`（返回 24 kHz 裸 PCM），`openai` 走 `/v1/audio/speech`（按 `TTS_RESPONSE_FORMAT` 返回 wav/mp3/opus/pcm）。朗读者先在本机把正文清洗成适合念的纯文本（去掉代码块、表格、公式、引用角标），再按句子边界切段逐段请求，播当前段时预取下一段，所以长回复不会被截断；单次请求的字数上限就是 `TTS_MAX_CHARS`。音色名和可用格式完全由你的服务决定，本项目不做校验。

没配 `TTS_PROVIDER` 时不显示朗读按钮，云端模式的朗读入口不受影响。

## 其他能力：ASR / OCR / 重排

音频推理服务和 OCR 服务同样没有统一协议，本项目按"能对齐的最小约定"处理：

| 能力 | 请求形状 | 响应形状 | 地址规则 |
|---|---|---|---|
| ASR | 标准 multipart（`file` + `model`），whisper.cpp 与多数 fork 都认 | `{text}` / `{transcript}` / `{results\|segments:[{text}]}` / `[{text}]` / 纯文本 | 根地址自动接 `/v1/audio/transcriptions`，完整地址原样请求 |
| OCR | DeepSeek 用 `/v1/tools/ocr`（文档与图片）；OpenAI 兼容走视觉 chat/completions（仅图片） | 两种都是取正文文本 | 同上，根地址自动接标准路径 |
| 重排 | `{model, query, documents}` | `{"results":[{index,relevance_score}]}` 或顶层数组 `[{index,score}]`（TEI 的形状），网关套一层 `data` 也认 | 根地址自动接 `/v1/rerank`，填 TEI 的 `/rerank` 原样请求 |

PaddleOCR、MinerU、Surya 这类"正经 OCR 服务"没有统一协议，本项目目前不接；用 OpenAI 兼容视觉接口或 DeepSeek OCR 代替。

ComfyUI 这类异步工作流服务不接，原因见上一节末尾。
