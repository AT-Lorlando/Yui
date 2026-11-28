"""Logs JSON sur stdout (une ligne = un objet) pour le pipeline Koya.

Convention homelab : `time` (epoch ms), `level`, `msg`, `app`, `service`, `env`,
`err` {type, message, stack}. stdlib uniquement : aucune dépendance de venv en
plus. Champs métier : `extra={"fields": {...}}` ; événement nommé : `extra={"event": "..."}`.
Ne jamais y mettre de transcription, de position ni de contenu de mail.
"""
import json
import logging
import os
import sys

APP = "yui"


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service
        mode = os.getenv("ENV", os.getenv("NODE_ENV", "prod")).lower()
        self.env = "dev" if mode in ("dev", "development") else "prod"

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "time": int(record.created * 1000),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            "app": APP,
            "service": self.service,
            "env": self.env,
        }
        event = getattr(record, "event", None)
        if event:
            out["event"] = event
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            for k, v in fields.items():
                out.setdefault(k, v)
        if record.exc_info and record.exc_info[0] is not None:
            etype, evalue, _ = record.exc_info
            out["err"] = {
                "type": etype.__name__,
                "message": str(evalue),
                "stack": self.formatException(record.exc_info),
            }
        # json.dumps échappe les \n : une seule ligne, stack comprise.
        return json.dumps(out, ensure_ascii=False, default=str)


def setup_logging(service: str) -> None:
    """Installe un handler JSON sur stdout. À appeler avant tout import qui logge."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
    logging.basicConfig(level=level, handlers=[handler], force=True)
