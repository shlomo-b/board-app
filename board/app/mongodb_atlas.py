"""MongoDB Atlas connection. Same pattern as CronBoard and AppHub."""

from __future__ import annotations

import logging
import os
import time
from urllib.parse import quote_plus

from pymongo import MongoClient

log = logging.getLogger("board")

USE_MONGODB = os.environ.get("USE_MONGODB", "false").strip().lower() in {"1", "true", "yes", "on"}
MONGO_URI = os.environ.get("MONGO_URI", "").strip()
MONGO_HOST = os.environ.get("MONGO_HOST", "").strip()
MONGO_DB_NAME = os.environ.get("MONGO_DB", "board").strip() or "board"
MONGO_USER = os.environ.get("MONGO_INITDB_ROOT_USERNAME", "").strip()
MONGO_PASSWORD = os.environ.get("MONGO_INITDB_ROOT_PASSWORD", "").strip()

_mongo: MongoClient | None = None


def using_atlas() -> bool:
    host = MONGO_HOST.lower()
    uri = MONGO_URI.lower()
    return (
        "mongodb+srv://" in uri
        or "mongodb.net" in uri
        or "mongodb.net" in host
        or host.startswith("mongodb+srv://")
    )


def mongo_uri() -> str:
    if MONGO_URI:
        return MONGO_URI
    user = quote_plus(MONGO_USER)
    password = quote_plus(MONGO_PASSWORD)
    host = MONGO_HOST.strip()
    if host.startswith("mongodb+srv://") or host.startswith("mongodb://"):
        return host
    if using_atlas():
        return f"mongodb+srv://{user}:{password}@{host}/{MONGO_DB_NAME}"
    return f"mongodb://{user}:{password}@{host}:27017/{MONGO_DB_NAME}?authSource=admin"


def mongo() -> MongoClient:
    global _mongo
    if _mongo is None:
        _mongo = MongoClient(
            mongo_uri(),
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            minPoolSize=4,
            maxPoolSize=20,
        )
    return _mongo


def mongo_db():
    return mongo()[MONGO_DB_NAME]


def mongo_status() -> dict[str, bool | str]:
    if not USE_MONGODB:
        return {"name": "mongodb", "connected": False}
    name = "mongodb-atlas" if using_atlas() else "mongodb"
    try:
        mongo().admin.command("ping")
        return {"name": name, "connected": True, "database": MONGO_DB_NAME}
    except Exception:
        return {"name": name, "connected": False, "database": MONGO_DB_NAME}


def wait_for_mongo(tries: int = 20) -> None:
    if not USE_MONGODB:
        raise RuntimeError("USE_MONGODB is off. This app stores boards in MongoDB.")
    log.info("Connecting to MongoDB Atlas database %s", MONGO_DB_NAME)
    last_error: Exception | None = None
    for attempt in range(1, tries + 1):
        try:
            mongo().admin.command("ping")
            log.info("MongoDB ping ok (%s/%s)", attempt, tries)
            return
        except Exception as exc:
            last_error = exc
            log.warning("MongoDB not ready yet (%s/%s): %s", attempt, tries, exc)
            time.sleep(1)
    raise RuntimeError(f"MongoDB is not reachable: {last_error}") from last_error
