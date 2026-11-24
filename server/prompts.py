"""提示词：设置 → 提示词。命名角色卡 + 全局生效的一张。

卡片只是追加在内置规则之后的文本；内置身份、语言、附件规则永远在前，改不掉。
存在 data/prompts.json，保存后下一轮请求立即生效。
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

import config

MAX_CARDS = 30
MAX_NAME = 40
MAX_DESC = 200
MAX_TEXT = 8000
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _path() -> Path:
    return config.DATA_DIR / "prompts.json"


def _one_line(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _body(value: object) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if len(text) > MAX_TEXT:
        raise ValueError(f"角色卡正文最多 {MAX_TEXT} 字")
    return text


def _empty() -> dict:
    return {"active": "", "cards": []}


def load() -> dict:
    try:
        body = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty()
    if not isinstance(body, dict):
        return _empty()
    cards = []
    for item in body.get("cards") or []:
        if not isinstance(item, dict):
            continue
        card_id = str(item.get("id") or "")
        if not _ID_RE.match(card_id):
            continue
        cards.append(
            {
                "id": card_id,
                "name": _one_line(item.get("name"), MAX_NAME),
                "description": _one_line(item.get("description"), MAX_DESC),
                "text": str(item.get("text") or "")[:MAX_TEXT],
            }
        )
    active = str(body.get("active") or "")
    if active not in {card["id"] for card in cards}:
        active = ""
    return {"active": active, "cards": cards}


def save(body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("提示词数据格式不正确")
    raw_cards = body.get("cards")
    if not isinstance(raw_cards, list):
        raise ValueError("cards 必须是数组")
    if len(raw_cards) > MAX_CARDS:
        raise ValueError(f"角色卡最多 {MAX_CARDS} 张")
    cards: list[dict] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for item in raw_cards:
        if not isinstance(item, dict):
            raise ValueError("角色卡格式不正确")
        name = _one_line(item.get("name"), MAX_NAME)
        if not name:
            raise ValueError("角色卡名称不能为空")
        key = name.lower()
        if key in seen_names:
            raise ValueError(f"已有同名角色卡：{name}")
        seen_names.add(key)
        text = _body(item.get("text"))
        if not text:
            raise ValueError(f"角色卡「{name}」的正文不能为空")
        card_id = str(item.get("id") or "")
        if not _ID_RE.match(card_id) or card_id in seen_ids:
            card_id = uuid.uuid4().hex[:12]
        seen_ids.add(card_id)
        cards.append(
            {
                "id": card_id,
                "name": name,
                "description": _one_line(item.get("description"), MAX_DESC),
                "text": text,
            }
        )
    active = str(body.get("active") or "")
    if active and active not in seen_ids:
        raise ValueError("选中的角色卡不存在")
    current_cards = load()["cards"]
    removed_ids = {card["id"] for card in current_cards} - seen_ids
    if removed_ids:
        # 局部导入避免 storage ↔ prompts 的循环导入。
        import storage

        bound = storage.workspaces_for_cards(removed_ids)
        if bound:
            workspace = bound[0]
            card_id = workspace["cardId"]
            card_name = next(
                (card["name"] for card in current_cards if card["id"] == card_id),
                card_id,
            )
            raise ValueError(
                f"角色卡「{card_name}」仍被工作区「{workspace['name']}」绑定，"
                "请先解绑后再删除"
            )
    state = {"active": active, "cards": cards}
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return state


def stats() -> dict:
    """调试面板用：当前生效卡片与正文长度。"""
    state = load()
    name = ""
    chars = 0
    for card in state["cards"]:
        if card["id"] == state["active"]:
            name = card["name"]
            chars = len(card["text"])
            break
    return {"cards": len(state["cards"]), "active": name, "chars": chars}


def _card_text(state: dict, card_id: str) -> str:
    if not card_id:
        return ""
    for card in state["cards"]:
        if card["id"] == card_id:
            return card["text"]
    return ""


def card_text(card_id: str) -> str:
    """按 ID 取角色卡正文；ID 不存在时返回空串。"""
    return _card_text(load(), str(card_id or ""))


def active_text() -> str:
    """全局生效卡的便捷解析。"""
    state = load()
    return _card_text(state, state["active"])
