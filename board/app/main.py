"""Small Jira-like board. Cards stay on the board document and are also copied
into one MongoDB collection per column, the same way AppHub stores each section."""

from __future__ import annotations

import logging
import os
import re
import secrets
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app import saml as saml_mod
from app.mongodb_atlas import mongo_db, mongo_status, wait_for_mongo

log = logging.getLogger("board")
logging.basicConfig(level=logging.INFO)

DEFAULT_COLUMNS = ("SPRINT BACKLOG", "IN PROGRESS", "IN TEST", "DONE")
STATIC = Path(__file__).resolve().parent.parent / "static"

APP_USER = os.environ.get("BOARD_USER", "").strip()
APP_PASSWORD = os.environ.get("BOARD_PASSWORD", "")
if not APP_USER or not APP_PASSWORD:
    raise RuntimeError("BOARD_USER and BOARD_PASSWORD are required")

app = FastAPI(title="Board")


def _session_secret() -> str:
    col = mongo_db().settings
    doc = col.find_one({"_id": "session"})
    secret = str((doc or {}).get("secret") or "").strip()
    if secret:
        return secret
    value = secrets.token_hex(32)
    col.replace_one({"_id": "session"}, {"_id": "session", "secret": value}, upsert=True)
    return value


def _same(left: str, right: str) -> bool:
    return secrets.compare_digest(left.encode().ljust(256, b"\0"), right.encode().ljust(256, b"\0"))


wait_for_mongo()
_https_only = os.environ.get("SESSION_HTTPS_ONLY", "false").strip().lower() in {"1", "true", "yes", "on"}
app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret(),
    session_cookie="board_session",
    same_site="lax",
    https_only=_https_only,
)
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
saml_mod.attach(app)


def require_login(request: Request, *, allow_viewer: bool = False) -> None:
    if not request.session.get("user"):
        raise HTTPException(status_code=401, detail="Not logged in")
    if not allow_viewer:
        saml_mod.reject_viewer_write(request)


class CardIn(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=200)
    task: str = Field(default="", max_length=200)
    createdAt: str = ""
    updatedAt: str = ""


class ColumnIn(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=60)
    collection: str = ""
    cards: list[CardIn] = Field(default_factory=list)


class BoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    columns: list[ColumnIn] = Field(min_length=4, max_length=4)


class BoardCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class LoginIn(BaseModel):
    username: str
    password: str


def _clean(value: str) -> str:
    return " ".join(value.split())


def _time(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > 40:
        raise HTTPException(400, "Bad time")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Bad time")
    return value


RESERVED_COLLECTIONS = {"boards", "settings", "sso_login_users"}


def _boards():
    return mongo_db()["boards"]


def _collection_slug(column_name: str, used: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", column_name.lower()).strip("_")[:40] or "column"
    if slug in RESERVED_COLLECTIONS or slug.startswith("system"):
        slug = f"column_{slug}"[:50]
    base = slug
    number = 2
    while slug in used:
        slug = f"{base}_{number}"[:50]
        number += 1
    used.add(slug)
    return slug


def _used_collections() -> set[str]:
    used = set(RESERVED_COLLECTIONS)
    for doc in _boards().find({}, {"columns.collection": 1}):
        for column in doc.get("columns") or []:
            name = str(column.get("collection") or "").strip()
            if name:
                used.add(name)
    return used


def _ensure_collection(name: str) -> None:
    database = mongo_db()
    if name not in set(database.list_collection_names()):
        database.create_collection(name)


def _card_out(doc: dict) -> dict:
    return {
        "id": str(doc.get("id") or doc["_id"]),
        "title": doc.get("title") or "",
        "task": doc.get("task") or "",
        "createdAt": doc.get("createdAt") or "",
        "updatedAt": doc.get("updatedAt") or "",
    }


def _load_cards(column: dict) -> list[dict]:
    # Cards already live on the board document. Reading each column collection
    # here was a separate Atlas round trip and made switching boards take seconds.
    return [_card_out(card) for card in column.get("cards") or []]


def _public(doc: dict) -> dict:
    columns = []
    for column in doc.get("columns") or []:
        columns.append({
            "id": column["id"],
            "name": column["name"],
            "collection": column.get("collection") or "",
            "cards": _load_cards(column),
        })
    return {"id": doc["_id"], "name": doc["name"], "columns": columns}


def _copy_cards(board_id: str, columns: list[dict]) -> None:
    """Copy cards into the column collections. Existing board documents stay."""
    database = mongo_db()
    for column in columns:
        name = column["collection"]
        _ensure_collection(name)
        collection = database[name]
        ids: list[str] = []
        for index, card in enumerate(column.get("cards") or []):
            ids.append(card["id"])
            collection.replace_one(
                {"_id": card["id"]},
                {
                    "_id": card["id"],
                    "boardId": board_id,
                    "columnId": column["id"],
                    "title": card["title"],
                    "task": card.get("task") or "",
                    "createdAt": card.get("createdAt") or "",
                    "updatedAt": card.get("updatedAt") or "",
                    "order": index,
                },
                upsert=True,
            )
        collection.delete_many({
            "boardId": board_id,
            "columnId": column["id"],
            "_id": {"$nin": ids},
        })


def _assign_collections(columns: list[dict], stored: dict[str, dict] | None = None) -> None:
    stored = stored or {}
    used = _used_collections()
    for column in columns:
        previous = stored.get(column["id"]) or {}
        name = str(previous.get("collection") or column.get("collection") or "").strip()
        if name and name not in RESERVED_COLLECTIONS:
            column["collection"] = name
            used.add(name)
            continue
        column["collection"] = _collection_slug(column["name"], used)


def migrate_board_columns() -> None:
    used = _used_collections()
    for doc in list(_boards().find()):
        changed = False
        for column in doc.get("columns") or []:
            name = str(column.get("collection") or "").strip()
            if not name or name in RESERVED_COLLECTIONS:
                column["collection"] = _collection_slug(column.get("name") or "column", used)
                changed = True
            else:
                used.add(name)
            _ensure_collection(column["collection"])
            for index, card in enumerate(column.get("cards") or []):
                if not card.get("id"):
                    continue
                mongo_db()[column["collection"]].replace_one(
                    {"_id": card["id"]},
                    {
                        "_id": card["id"],
                        "boardId": doc["_id"],
                        "columnId": column["id"],
                        "title": card.get("title") or "",
                        "task": card.get("task") or "",
                        "createdAt": card.get("createdAt") or "",
                        "updatedAt": card.get("updatedAt") or "",
                        "order": index,
                    },
                    upsert=True,
                )
        if changed:
            _boards().replace_one({"_id": doc["_id"]}, doc)


def _new_board(name: str) -> dict:
    columns = [
        {"id": str(uuid.uuid4()), "name": column_name, "collection": "", "cards": []}
        for column_name in DEFAULT_COLUMNS
    ]
    _assign_collections(columns)
    for column in columns:
        _ensure_collection(column["collection"])
    return {"_id": str(uuid.uuid4()), "name": _clean(name), "columns": columns}


@app.on_event("startup")
def startup() -> None:
    wait_for_mongo()
    migrate_board_columns()


@app.get("/api/health")
def health() -> dict:
    return mongo_status()


@app.post("/api/login")
def login(body: LoginIn, request: Request) -> dict:
    if not (_same(body.username, APP_USER) and _same(body.password, APP_PASSWORD)):
        raise HTTPException(status_code=401, detail="Wrong username or password")
    request.session["user"] = body.username
    saml_mod.clear_sso_session(request)
    return {"user": body.username, "mongodb": mongo_status(), **saml_mod.session_user_info(request)}


@app.post("/api/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request) -> dict:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not logged in")
    return {"user": user, "mongodb": mongo_status(), **saml_mod.session_user_info(request)}


@app.get("/api/boards")
def list_boards(request: Request) -> list[dict]:
    require_login(request, allow_viewer=True)
    docs = _boards().find({}, {"name": 1}).sort("name", 1)
    return [{"id": doc["_id"], "name": doc["name"]} for doc in docs]


@app.post("/api/boards")
def create_board(body: BoardCreate, request: Request) -> dict:
    require_login(request)
    name = _clean(body.name)
    if not name:
        raise HTTPException(400, "Board name is required")
    doc = _new_board(name)
    _boards().insert_one(doc)
    return _public(doc)


@app.get("/api/boards/{board_id}")
def get_board(board_id: str, request: Request) -> dict:
    require_login(request, allow_viewer=True)
    doc = _boards().find_one({"_id": board_id})
    if not doc:
        raise HTTPException(404, "Board not found")
    return _public(doc)


@app.put("/api/boards/{board_id}")
def save_board(board_id: str, body: BoardIn, request: Request) -> dict:
    require_login(request)
    name = _clean(body.name)
    if not name:
        raise HTTPException(400, "Board name is required")
    existing = _boards().find_one({"_id": board_id})
    if not existing:
        raise HTTPException(404, "Board not found")
    columns = []
    seen_columns: set[str] = set()
    seen_cards: set[str] = set()
    for column in body.columns:
        column_name = _clean(column.name)
        if not column_name:
            raise HTTPException(400, "Column name is required")
        if column.id in seen_columns:
            raise HTTPException(400, "Duplicate column")
        seen_columns.add(column.id)
        cards = []
        for card in column.cards:
            title = _clean(card.title)
            if not title:
                raise HTTPException(400, "Card title is required")
            if card.id in seen_cards:
                raise HTTPException(400, "Duplicate card")
            seen_cards.add(card.id)
            cards.append({
                "id": card.id,
                "title": title,
                "task": _clean(card.task),
                "createdAt": _time(card.createdAt),
                "updatedAt": _time(card.updatedAt),
            })
        columns.append({
            "id": column.id,
            "name": column_name,
            "collection": "",
            "cards": cards,
        })
    stored = {column["id"]: column for column in existing.get("columns") or []}
    _assign_collections(columns, stored)
    doc = {"_id": board_id, "name": name, "columns": columns}
    _boards().replace_one({"_id": board_id}, doc)
    _copy_cards(board_id, columns)
    return _public(doc)


@app.delete("/api/boards/{board_id}")
def delete_board(board_id: str, request: Request) -> dict:
    require_login(request)
    result = _boards().delete_one({"_id": board_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Board not found")
    return {"ok": True}


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(STATIC / "img" / "favicon-32.png", media_type="image/png")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(
        STATIC / "index.html",
        headers={"Cache-Control": "no-store"},
    )


app.mount("/static", StaticFiles(directory=STATIC), name="static")
