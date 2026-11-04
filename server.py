#!/usr/bin/env python3
"""Фасад-трекер В14 — сервер без внешних зависимостей (Python 3.9+ и SQLite из стандартной библиотеки).

Запуск:  python3 server.py            (порт 8080, база data/tracker.db)
Переменные окружения:
  PORT        — порт (по умолчанию 8080)
  HOST        — адрес (по умолчанию 127.0.0.1; наружу сайт выводит cloudflared)
  EDIT_TOKEN  — пароль на редактирование (пусто — красить может любой)
  DATA_DIR    — папка с базой и резервными копиями (по умолчанию ./data)
"""
import json, os, re, sqlite3, threading, time, shutil, gzip
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
DB_PATH = os.path.join(DATA_DIR, "tracker.db")
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")
EDIT_TOKEN = os.environ.get("EDIT_TOKEN", "").strip()
CORPORA = {"corpus1", "corpus2", "corpus3", "corpus4", "corpus5"}
WORK_TYPES = {"brackets", "insul1", "insul2", "rails", "firecut", "akp", "sfb", "keramogranit",
              "terracotta", "reveals", "flashings"}
MAX_BODY = 5 * 1024 * 1024
os.makedirs(DATA_DIR, exist_ok=True)

_lock = threading.Lock()
def db():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c

def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          corpus TEXT NOT NULL, work_type TEXT NOT NULL, action TEXT NOT NULL,
          add_idx TEXT NOT NULL DEFAULT '[]', remove_idx TEXT NOT NULL DEFAULT '[]',
          user TEXT, ts INTEGER, source TEXT DEFAULT 'web', created INTEGER);
        CREATE INDEX IF NOT EXISTS ev_corpus ON events(corpus, id);
        CREATE TABLE IF NOT EXISTS ks_areas(
          id TEXT PRIMARY KEY, corpus TEXT NOT NULL, name TEXT NOT NULL,
          x0 REAL, y0 REAL, x1 REAL, y1 REAL, created INTEGER, deleted INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        """)

def backup(keep=30):
    """Ежедневная копия базы в data/backups (хранится 30 последних)."""
    bdir = os.path.join(DATA_DIR, "backups"); os.makedirs(bdir, exist_ok=True)
    dst = os.path.join(bdir, time.strftime("tracker_%Y-%m-%d.db"))
    if os.path.exists(dst): return
    with db() as src, sqlite3.connect(dst) as out: src.backup(out)
    files = sorted(f for f in os.listdir(bdir) if f.startswith("tracker_"))
    for f in files[:-keep]: os.remove(os.path.join(bdir, f))

def backup_loop():
    while True:
        try: backup()
        except Exception as e: print("backup error:", e, flush=True)
        time.sleep(3600)

def ints(a):
    if not isinstance(a, list) or len(a) > 200000: raise ValueError("bad index list")
    return [int(x) for x in a]

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json"}

class H(BaseHTTPRequestHandler):
    server_version = "FacadeTracker/2"
    def log_message(self, fmt, *a):
        if self.path.startswith("/api/") and self.command == "GET": return
        print("%s %s" % (self.address_string(), fmt % a), flush=True)

    # ---------- helpers ----------
    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(b) > 2048
        if gz: b = gzip.compress(b, 5)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if gz: self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY: raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def can_edit(self):
        return not EDIT_TOKEN or self.headers.get("X-Edit-Token", "") == EDIT_TOKEN

    # ---------- routes ----------
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        try:
            if u.path == "/api/config":
                return self.send_json({"editPasswordRequired": bool(EDIT_TOKEN)})
            if u.path == "/api/check-token":
                return self.send_json({"ok": self.can_edit()})
            if u.path == "/api/events":
                corpus = q.get("corpus", [""])[0]
                if corpus not in CORPORA: return self.send_json({"error": "corpus"}, 400)
                after = int(q.get("after", ["0"])[0] or 0)
                with db() as c:
                    rows = c.execute("SELECT id, work_type, action, add_idx, remove_idx FROM events "
                                     "WHERE corpus=? AND id>? ORDER BY id", (corpus, after)).fetchall()
                    ep = c.execute("SELECT v FROM meta WHERE k='epoch'").fetchone()
                ev = [{"id": r["id"], "workType": r["work_type"], "action": r["action"],
                       "add": json.loads(r["add_idx"]), "remove": json.loads(r["remove_idx"])} for r in rows]
                # epoch меняется при импорте/перестройке журнала — клиент тогда перечитывает всё с нуля
                return self.send_json({"events": ev, "last": ev[-1]["id"] if ev else after,
                                       "epoch": ep["v"] if ep else "0"})
            if u.path == "/api/ks":
                corpus = q.get("corpus", [""])[0]
                with db() as c:
                    rows = c.execute("SELECT id,name,x0,y0,x1,y1 FROM ks_areas WHERE corpus=? AND deleted=0 "
                                     "ORDER BY created", (corpus,)).fetchall()
                return self.send_json({"areas": [dict(r) for r in rows]})
            return self.static(u.path)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if not self.can_edit(): return self.send_json({"error": "Нужен пароль на редактирование"}, 403)
            d = self.body()
            if u.path == "/api/events":
                corpus, wt, action = d.get("corpus"), d.get("workType"), d.get("action", "paint")
                if corpus not in CORPORA or wt not in WORK_TYPES or action not in ("paint", "clear"):
                    return self.send_json({"error": "bad event"}, 400)
                with _lock, db() as c:
                    cur = c.execute("INSERT INTO events(corpus,work_type,action,add_idx,remove_idx,user,ts,created) "
                                    "VALUES(?,?,?,?,?,?,?,?)",
                                    (corpus, wt, action, json.dumps(ints(d.get("add", []))),
                                     json.dumps(ints(d.get("remove", []))), str(d.get("user", ""))[:64],
                                     int(d.get("ts") or time.time() * 1000), int(time.time())))
                return self.send_json({"id": cur.lastrowid})
            if u.path == "/api/ks":
                corpus = d.get("corpus")
                if corpus not in CORPORA: return self.send_json({"error": "corpus"}, 400)
                aid = str(d.get("id") or ("ks%d" % (time.time() * 1000)))[:40]
                with _lock, db() as c:
                    c.execute("INSERT OR REPLACE INTO ks_areas(id,corpus,name,x0,y0,x1,y1,created) VALUES(?,?,?,?,?,?,?,?)",
                              (aid, corpus, str(d.get("name", "Участок"))[:120], float(d["x0"]), float(d["y0"]),
                               float(d["x1"]), float(d["y1"]), int(time.time() * 1000)))
                return self.send_json({"id": aid})
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)

    def do_DELETE(self):
        u = urlparse(self.path)
        if not self.can_edit(): return self.send_json({"error": "Нужен пароль на редактирование"}, 403)
        m = re.match(r"^/api/ks/([\w-]+)$", u.path)
        if m:
            with _lock, db() as c: c.execute("UPDATE ks_areas SET deleted=1 WHERE id=?", (m.group(1),))
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def static(self, path):
        if path in ("", "/"): path = "/index.html"
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        gz = fp + ".gz"
        if not fp.startswith(STATIC + os.sep) or not (os.path.isfile(fp) or os.path.isfile(gz)):
            return self.send_json({"error": "not found"}, 404)
        ext = os.path.splitext(fp)[1]
        accepts = "gzip" in self.headers.get("Accept-Encoding", "")
        use_gz = os.path.isfile(gz) and (accepts or not os.path.isfile(fp))
        src = gz if use_gz else fp
        st = os.stat(src)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304); self.end_headers(); return
        body = None
        if use_gz and not accepts:          # в репозитории лежит только .gz — распакуем для редкого клиента без gzip
            with open(gz, "rb") as f: body = gzip.decompress(f.read())
            use_gz = False
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        if use_gz: self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body) if body is not None else st.st_size))
        self.end_headers()
        if body is not None: self.wfile.write(body)
        else:
            with open(src, "rb") as f: shutil.copyfileobj(f, self.wfile)

def reload_watch():
    """Обновили server.py (git pull в GitHub Desktop) — выходим, служба launchd сразу запустит новую версию."""
    me = os.path.abspath(__file__)
    t0 = os.stat(me).st_mtime
    while True:
        time.sleep(3)
        try:
            if os.stat(me).st_mtime != t0:
                time.sleep(2)               # дать git дописать файл
                print("server.py обновлён — перезапуск", flush=True)
                os._exit(0)
        except FileNotFoundError:
            pass

if __name__ == "__main__":
    init_db()
    threading.Thread(target=backup_loop, daemon=True).start()
    threading.Thread(target=reload_watch, daemon=True).start()
    print(f"Фасад-трекер: http://{HOST}:{PORT}  (база {DB_PATH}, пароль на редактирование: "
          f"{'включён' if EDIT_TOKEN else 'выключен'})", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
