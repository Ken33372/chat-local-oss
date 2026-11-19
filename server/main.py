"""chat-local 后端：会话存储 API、本地模型代理、语音转写与静态前端托管。"""
from __future__ import annotations

import asyncio
import json

import httpx
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import ai
import config
import setup_store
import storage
from providers import asr as asr_provider
from providers import ocr as ocr_provider
from providers import search
from providers import tts as tts_provider

app = FastAPI(title="chat-local", version="0.1.2")
storage.init()


def guard(request: Request) -> None:
    """简单的本机调用校验：跨站页面无法伪造自定义头，避免被别处网页写入本地数据。"""
    if request.headers.get("x-chat-local") != "1":
        raise HTTPException(status_code=403, detail="缺少 X-Chat-Local 请求头")


# ---------------- 会话存储 ----------------

@app.get("/api/chat/sessions")
def list_sessions() -> dict:
    return {"sessions": storage.list_sessions()}


@app.get("/api/chat/search")
def search_sessions(q: str = "") -> dict:
    return {"results": storage.search_sessions(q)}


@app.get("/api/chat/sessions/{session_id}")
def load_session(session_id: str):
    session = storage.load_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


@app.put("/api/chat/sessions/{session_id}")
async def save_session(session_id: str, request: Request) -> dict:
    guard(request)
    session = await request.json()
    if not isinstance(session, dict) or session.get("id") != session_id:
        raise HTTPException(status_code=400, detail="会话 ID 不一致")
    storage.save_session(session)
    return {"ok": True}


@app.patch("/api/chat/sessions/{session_id}/title")
async def rename_session(session_id: str, request: Request) -> dict:
    guard(request)
    body = await request.json()
    storage.rename_session(session_id, str(body.get("title") or ""))
    return {"ok": True}


@app.patch("/api/chat/sessions/{session_id}/archive")
async def archive_session(session_id: str, request: Request) -> dict:
    guard(request)
    body = await request.json()
    storage.set_archived(session_id, bool(body.get("archived")))
    return {"ok": True, "archived": bool(body.get("archived"))}


# ---------------- 维护：清理与归档 ----------------

def _time_filter(body: dict) -> tuple[int | None, int | None, int | None]:
    def number(key: str) -> int | None:
        value = body.get(key)
        return int(value) if isinstance(value, (int, float)) else None

    return number("olderThan"), number("from"), number("to")


def _clean_flags(body: dict) -> tuple[bool, bool]:
    return bool(body.get("toolRecords")), bool(body.get("images"))


@app.post("/api/chat/maintenance/preview")
async def maintenance_preview(request: Request) -> dict:
    guard(request)
    body = await request.json()
    older_than, start, end = _time_filter(body if isinstance(body, dict) else {})
    clean_tools, clean_images = _clean_flags(body if isinstance(body, dict) else {})
    return storage.maintenance_preview(older_than, start, end, clean_tools, clean_images)


@app.post("/api/chat/maintenance/delete")
async def maintenance_delete(request: Request) -> dict:
    guard(request)
    body = await request.json()
    older_than, start, end = _time_filter(body if isinstance(body, dict) else {})
    if older_than is None and start is None and end is None:
        raise HTTPException(status_code=400, detail="缺少时间条件")
    return storage.delete_sessions_by_time(older_than, start, end)


@app.post("/api/chat/maintenance/clean")
async def maintenance_clean(request: Request) -> dict:
    guard(request)
    body = await request.json()
    clean_tools, clean_images = _clean_flags(body if isinstance(body, dict) else {})
    if not clean_tools and not clean_images:
        raise HTTPException(status_code=400, detail="未选择清理内容")
    return storage.clean_sessions(clean_tools, clean_images)


@app.delete("/api/chat/sessions/{session_id}")
def delete_session(session_id: str, request: Request) -> dict:
    guard(request)
    storage.delete_session(session_id)
    return {"ok": True}


@app.post("/api/chat/files/{file_id}")
async def upload_file(
    file_id: str,
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(""),
    mime: str = Form(""),
) -> dict:
    guard(request)
    data = await file.read()
    storage.save_file(file_id, name or file.filename or "附件", mime or file.content_type or "", data)
    return {"ok": True, "id": file_id, "size": len(data)}


@app.get("/api/chat/files/{file_id}")
def download_file(file_id: str):
    loaded = storage.read_file(file_id)
    if not loaded:
        raise HTTPException(status_code=404, detail="附件不存在")
    _, meta = loaded
    path = storage.file_path(file_id)
    return FileResponse(path, media_type=meta.get("mime") or "application/octet-stream")


# ---------------- 历史导入暂存 ----------------

@app.post("/api/chat/staging/clear")
def clear_staging(request: Request) -> dict:
    guard(request)
    storage.clear_staging()
    return {"ok": True}


@app.post("/api/chat/staging/sessions")
async def add_staging_session(request: Request) -> dict:
    guard(request)
    session = await request.json()
    storage.add_staging_session(session)
    return {"ok": True}


@app.post("/api/chat/staging/files/{file_id}")
async def upload_staging_file(
    file_id: str,
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(""),
    mime: str = Form(""),
) -> dict:
    guard(request)
    data = await file.read()
    storage.save_staging_file(file_id, name or file.filename or "", mime or file.content_type or "", data)
    return {"ok": True}


@app.post("/api/chat/staging/file-types")
async def staging_file_types(request: Request) -> dict:
    guard(request)
    body = await request.json()
    types = body.get("types") if isinstance(body, dict) else None
    if not isinstance(types, dict):
        raise HTTPException(status_code=400, detail="types 必须是对象")
    storage.update_staging_file_types({str(k): str(v) for k, v in types.items()})
    return {"ok": True}


@app.post("/api/chat/staging/commit")
async def commit_staging(request: Request) -> dict:
    guard(request)
    mode = "replace"
    try:
        body = await request.json()
        if isinstance(body, dict) and body.get("mode"):
            mode = str(body["mode"])
    except json.JSONDecodeError:
        pass
    try:
        return storage.commit_staging(mode)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


# ---------------- 首次运行配置 ----------------

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _setup_writable(request: Request) -> bool:
    """只允许本机页面写配置；监听 0.0.0.0 时禁用向导写入。"""
    client = request.client.host if request.client else ""
    return client in _LOOPBACK_HOSTS and config.HOST in _LOOPBACK_HOSTS


def _masked_status() -> dict:
    caps = config.capabilities()
    return {
        "configured": caps["llm"],
        "writable": config.HOST in _LOOPBACK_HOSTS,
        "config_file": "data/config.json",
        "llm": {
            "base_url": config.LLM_BASE_URL,
            "model": config.LLM_MODEL,
            "has_key": bool(config.LLM_API_KEY),
            "context_limit": config.LLM_CONTEXT_LIMIT,
            "max_output_tokens": config.LLM_MAX_OUTPUT_TOKENS,
        },
        "search": {
            "provider": config.SEARCH_PROVIDER,
            "base_url": config.SEARCH_BASE_URL,
            "has_key": bool(config.SEARCH_API_KEY),
            "results": config.SEARCH_RESULTS,
        },
        "asr": {
            "provider": config.ASR_PROVIDER,
            "base_url": config.ASR_BASE_URL,
            "has_key": bool(config.ASR_API_KEY),
            "model": config.ASR_MODEL,
        },
        "ocr": {
            "provider": config.OCR_PROVIDER,
            "base_url": config.OCR_BASE_URL,
            "has_key": bool(config.OCR_API_KEY),
            "model": config.OCR_MODEL,
        },
        "rerank": {
            "provider": config.RERANK_PROVIDER,
            "base_url": config.RERANK_BASE_URL,
            "has_key": bool(config.RERANK_API_KEY),
            "model": config.RERANK_MODEL,
        },
        "tts": {
            "provider": config.TTS_PROVIDER,
            "base_url": config.TTS_BASE_URL,
            "has_key": bool(config.TTS_API_KEY),
            "model": config.TTS_MODEL,
            "voice": config.TTS_VOICE,
            "response_format": config.TTS_RESPONSE_FORMAT,
            "template_url": config.TTS_TEMPLATE_URL,
            "template_audio": config.TTS_TEMPLATE_AUDIO,
        },
        "capabilities": caps,
    }


@app.get("/api/setup/status")
def setup_status() -> dict:
    return _masked_status()


@app.post("/api/setup/test")
async def setup_test(request: Request) -> dict:
    guard(request)
    if not _setup_writable(request):
        raise HTTPException(status_code=403, detail="服务不是仅本机监听，请改用 .env 配置")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    try:
        normalized = setup_store.normalize(body, setup_store.load(config.DATA_DIR))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    llm = normalized.get("llm") or {}
    base = str(llm.get("base_url") or "").rstrip("/")
    model = str(llm.get("model") or "")
    if not base or not model:
        raise HTTPException(status_code=400, detail="请填写 Base URL 和模型名")
    headers = {"anthropic-version": "2023-06-01"}
    key = str(llm.get("api_key") or "")
    if key:
        headers["x-api-key"] = key
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(8, connect=5)) as client:
            response = await client.get(f"{base}/v1/models", headers=headers)
        models = []
        if response.status_code == 200:
            payload = response.json()
            models = [item.get("id") for item in payload.get("data") or [] if item.get("id")]
        return {
            "ok": response.status_code < 500,
            "status": response.status_code,
            "models": models,
            "detail": "" if response.status_code < 500 else response.text[:300],
        }
    except Exception as error:
        return {"ok": False, "status": 0, "models": [], "detail": str(error)}


@app.post("/api/setup/save")
async def setup_save(request: Request) -> dict:
    guard(request)
    if not _setup_writable(request):
        raise HTTPException(status_code=403, detail="服务不是仅本机监听，请改用 .env 配置")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    try:
        setup_store.save(config.DATA_DIR, body)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    config.reload()
    return _masked_status()


@app.post("/api/setup/clear")
def setup_clear(request: Request) -> dict:
    guard(request)
    if not _setup_writable(request):
        raise HTTPException(status_code=403, detail="服务不是仅本机监听，请改用 .env 配置")
    setup_store.clear(config.DATA_DIR)
    config.reload()
    return _masked_status()


# ---------------- 本地模型与工具 ----------------

@app.post("/api/ai/messages")
async def messages(request: Request):
    guard(request)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    try:
        generator = await ai.stream_chat(body, request)
    except ai.UpstreamError as error:
        raise HTTPException(status_code=503, detail=str(error))
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/ai/asr")
async def asr(request: Request, file: UploadFile = File(...)) -> dict:
    guard(request)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="音频为空")
    if not asr_provider.available():
        raise HTTPException(status_code=400, detail="未配置 ASR，请在 .env 设置 ASR_PROVIDER")
    try:
        text = await asyncio.to_thread(
            asr_provider.transcribe, file.filename or "recording.wav", data
        )
    except asr_provider.ProviderError as error:
        raise HTTPException(status_code=503, detail=str(error))
    return {"text": text}


@app.post("/api/ai/ocr")
async def ocr(request: Request, file: UploadFile = File(...)) -> dict:
    guard(request)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if not ocr_provider.available():
        raise HTTPException(status_code=400, detail="未配置 OCR，请在 .env 设置 OCR_PROVIDER")
    try:
        text = await asyncio.to_thread(
            ocr_provider.ocr, file.filename or "document.pdf", data
        )
    except ocr_provider.ProviderError as error:
        raise HTTPException(status_code=503, detail=str(error))
    return {"text": text}


@app.post("/api/ai/tts/plan")
async def tts_plan(request: Request) -> dict:
    """朗读第一步：本机剥掉 markdown、按句切段，返回每段纯文本。"""
    guard(request)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    if not tts_provider.available():
        raise HTTPException(status_code=400, detail="未配置朗读，请在 .env 设置 TTS_PROVIDER")
    return tts_provider.plan(str(body.get("text") or ""))


@app.post("/api/ai/tts")
async def tts_speech(request: Request):
    """朗读第二步：一段文本合成一次，返回音频字节与容器类型。"""
    guard(request)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    if not tts_provider.available():
        raise HTTPException(status_code=400, detail="未配置朗读，请在 .env 设置 TTS_PROVIDER")
    text = str(body.get("text") or "")
    try:
        audio, mime = await asyncio.to_thread(
            tts_provider.synthesize, text, str(body.get("voice") or "")
        )
    except tts_provider.ProviderError as error:
        raise HTTPException(status_code=503, detail=str(error))
    return Response(content=audio, media_type=mime)


@app.post("/api/ai/title")
async def generate_title(request: Request) -> dict:
    guard(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体必须是对象")
    user = str(body.get("user") or "").strip()
    assistant = str(body.get("assistant") or "").strip()
    if not user and not assistant:
        raise HTTPException(status_code=400, detail="缺少对话内容")
    try:
        return {"title": await ai.generate_title(user, assistant)}
    except ai.UpstreamError as error:
        raise HTTPException(status_code=503, detail=str(error))


@app.post("/api/ai/compress")
async def compress_context(request: Request) -> dict:
    guard(request)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")
    transcript = str(body.get("transcript") or "")
    if not transcript.strip():
        raise HTTPException(status_code=400, detail="没有可压缩的内容")
    try:
        summary = await ai.compress(transcript, str(body.get("previous_summary") or ""))
    except ai.UpstreamError as error:
        raise HTTPException(status_code=503, detail=str(error))
    return {"summary": summary}


@app.get("/api/health")
async def health() -> dict:
    llm = await ai.health()
    return {
        "ok": llm.get("ok", False),
        "llm": llm,
        # 搜索健康检查会真发一次 HTTP 探测（SearXNG + 重排），放线程里跑，别卡住事件循环
        "search": await asyncio.to_thread(search.health),
        "asr": asr_provider.health(),
        "ocr": ocr_provider.health(),
        "tts": tts_provider.health(),
        "capabilities": config.capabilities(),
        "limits": {
            "context": config.LLM_CONTEXT_LIMIT,
            "output": config.LLM_MAX_OUTPUT_TOKENS,
        },
        "model": config.LLM_MODEL,
    }


# ---------------- 前端静态文件 ----------------

if config.WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=config.WEB_DIST, html=True), name="web")
else:

    @app.get("/")
    def missing_build() -> HTMLResponse:
        return HTMLResponse(
            "<h1>前端尚未构建</h1><p>在 web 目录运行 <code>npm run build</code> 后重启本服务。</p>",
            status_code=503,
        )
