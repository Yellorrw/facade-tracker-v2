#!/usr/bin/env python3
"""Фасады — трекер выполнения фасадных работ. Сервер без внешних зависимостей (Python 3.9+, SQLite).

Запуск:  python3 server.py           (порт 8080, база data/tracker.db)
Учётные записи:  python3 manage.py add-admin ЛОГИН   (первый администратор, пароль вводится в Терминале)

Переменные окружения:
  PORT      — порт (по умолчанию 8080)
  HOST      — адрес (по умолчанию 127.0.0.1)
  DATA_DIR  — папка с базой и резервными копиями (по умолчанию ./data)

Объекты лежат в projects/<код>/: project.json (название, корпуса) и data/ (геометрия, только .gz).
Геометрия и закраска отдаются только вошедшим пользователям, у которых есть доступ к объекту.
"""
import gzip, hashlib, hmac, json, os, re, secrets, shutil, sqlite3, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
PROJECTS = os.path.join(ROOT, "projects")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
DB_PATH = os.path.join(DATA_DIR, "tracker.db")
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")

WORK_TYPES = {"brackets", "insul1", "insul2", "rails", "fc_adj", "fc_box", "fc_strip", "akp", "sfb",
              "keramogranit", "terracotta", "reveals", "flashings"}
ROLES = ("viewer", "editor")
MAX_BODY = 2 * 1024 * 1024
SESSION_DAYS = 30
PBKDF2_ITER = 310000
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9._@-]{3,40}$")
FILE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
os.makedirs(DATA_DIR, exist_ok=True)

# ───────────────────────── база ─────────────────────────
_lock = threading.Lock()
def db():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c

def _cols(c, table):
    return {r[1] for r in c.execute("PRAGMA table_info(%s)" % table)}

def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          corpus TEXT NOT NULL, work_type TEXT NOT NULL, action TEXT NOT NULL,
          add_idx TEXT NOT NULL DEFAULT '[]', remove_idx TEXT NOT NULL DEFAULT '[]',
          user TEXT, ts INTEGER, source TEXT DEFAULT 'web', created INTEGER);
        CREATE TABLE IF NOT EXISTS ks_areas(
          id TEXT PRIMARY KEY, corpus TEXT NOT NULL, name TEXT NOT NULL,
          x0 REAL, y0 REAL, x1 REAL, y1 REAL, created INTEGER, deleted INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          login TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
          pw TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
          created INTEGER, pw_changed INTEGER);
        CREATE TABLE IF NOT EXISTS access(
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(user_id, project));
        CREATE TABLE IF NOT EXISTS sessions(
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created INTEGER, expires INTEGER, last_seen INTEGER, ip TEXT);
        """)
        # v2 → v3: у событий и участков КС появился объект; всё, что было раньше, — В14
        for t in ("events", "ks_areas"):
            if "project" not in _cols(c, t):
                c.execute("ALTER TABLE %s ADD COLUMN project TEXT NOT NULL DEFAULT 'v14'" % t)
        c.execute("CREATE INDEX IF NOT EXISTS ev_proj ON events(project, corpus, id)")
        if not c.execute("SELECT 1 FROM meta WHERE k='epoch:v14'").fetchone():
            old = c.execute("SELECT v FROM meta WHERE k='epoch'").fetchone()
            c.execute("INSERT INTO meta(k,v) VALUES('epoch:v14',?)", (old["v"] if old else "0",))
    migrate_v3()

def migrate_v3():
    """Отсечка, откосы и отливы раньше красились по сетке панелей, теперь — по окнам и элементам АР.
    Один раз переносим уже накрашенное: элемент считается выполненным, если касается закрашенной панели."""
    path = os.path.join(PROJECTS, "v14", "migrate_v3.json.gz")
    with db() as c:
        if c.execute("SELECT 1 FROM meta WHERE k='mig_v3'").fetchone() or not os.path.isfile(path): return
    mp = json.load(gzip.open(path))
    new_of = {"firecut": [("fc_adj", "w"), ("fc_box", "w"), ("fc_strip", "w")],
              "reveals": [("reveals", "r")], "flashings": [("flashings", "f")]}
    with _lock, db() as c:
        moved = 0
        for corpus, m in mp.items():
            for old, targets in new_of.items():
                filled = set()
                rows = c.execute("SELECT action, add_idx, remove_idx FROM events WHERE project='v14' AND corpus=? "
                                 "AND work_type=? ORDER BY id", (corpus, old)).fetchall()
                for r in rows:
                    if r["action"] == "clear": filled.clear()
                    filled.update(json.loads(r["add_idx"])); filled.difference_update(json.loads(r["remove_idx"]))
                c.execute("DELETE FROM events WHERE project='v14' AND corpus=? AND work_type=?", (corpus, old))
                for wt, key in targets:
                    idx = sorted({j for i in filled for j in m.get(str(i), {}).get(key, [])})
                    if idx:
                        c.execute("INSERT INTO events(project,corpus,work_type,action,add_idx,remove_idx,user,ts,source,created) "
                                  "VALUES('v14',?,?,'paint',?,'[]','перенос v3',?,'migrate',?)",
                                  (corpus, wt, json.dumps(idx), int(time.time() * 1000), int(time.time())))
                        moved += len(idx)
        c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('epoch:v14',?)", (str(int(time.time())),))
        c.execute("INSERT INTO meta(k,v) VALUES('mig_v3','1')")
    print("Перенос закраски отсечки/откосов/отливов на окна: %d элементов" % moved, flush=True)

def backup(keep=30):
    bdir = os.path.join(DATA_DIR, "backups"); os.makedirs(bdir, exist_ok=True)
    dst = os.path.join(bdir, time.strftime("tracker_%Y-%m-%d.db"))
    if os.path.exists(dst): return
    with db() as src, sqlite3.connect(dst) as out: src.backup(out)
    os.chmod(dst, 0o600)
    files = sorted(f for f in os.listdir(bdir) if f.startswith("tracker_"))
    for f in files[:-keep]: os.remove(os.path.join(bdir, f))

def housekeeping_loop():
    while True:
        try:
            backup()
            with db() as c: c.execute("DELETE FROM sessions WHERE expires<?", (int(time.time()),))
        except Exception as e: print("housekeeping error:", e, flush=True)
        time.sleep(3600)

# ───────────────────────── пароли и сессии ─────────────────────────
def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITER, salt.hex(), dk.hex())

_DUMMY = None
def verify_password(pw, stored):
    global _DUMMY
    if not stored:      # нет такого пользователя — считаем хеш всё равно, чтобы время ответа не выдавало логины
        _DUMMY = _DUMMY or hash_password("x")
        stored = _DUMMY
    try:
        algo, it, salt, dk = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return algo == "pbkdf2_sha256" and hmac.compare_digest(got.hex(), dk)
    except Exception:
        return False

def check_new_password(pw):
    if not isinstance(pw, str) or len(pw) < 8: return "Пароль — не короче 8 символов"
    if len(pw) > 200: return "Слишком длинный пароль"
    return None

def tok_hash(t): return hashlib.sha256(t.encode()).hexdigest()

class RateLimit:
    """Не больше N неудачных входов за окно — с одного адреса и на один логин."""
    def __init__(self, n, window): self.n, self.window, self.d, self.l = n, window, {}, threading.Lock()
    def blocked(self, key):
        with self.l:
            now = time.time(); lst = [t for t in self.d.get(key, []) if now - t < self.window]
            self.d[key] = lst; return len(lst) >= self.n
    def hit(self, key):
        with self.l: self.d.setdefault(key, []).append(time.time())
    def reset(self, key):
        with self.l: self.d.pop(key, None)
RL_IP, RL_LOGIN = RateLimit(20, 900), RateLimit(6, 900)

class ApiError(Exception):
    def __init__(self, code, msg): super().__init__(msg); self.code, self.msg = code, msg

# ───────────────────────── объекты ─────────────────────────
_proj_cache = {"t": 0, "v": {}}
def projects():
    if time.time() - _proj_cache["t"] < 10: return _proj_cache["v"]
    out = {}
    if os.path.isdir(PROJECTS):
        for slug in sorted(os.listdir(PROJECTS)):
            pj = os.path.join(PROJECTS, slug, "project.json")
            if SLUG_RE.match(slug) and os.path.isfile(pj):
                try:
                    p = json.load(open(pj, encoding="utf-8")); p["slug"] = slug
                    p["_corpora"] = {c["id"] for c in p.get("corpora", [])}
                    out[slug] = p
                except Exception as e: print("project.json %s: %s" % (slug, e), flush=True)
    _proj_cache.update(t=time.time(), v=out)
    return out

def public_project(p, role):
    return {"slug": p["slug"], "name": p.get("name", p["slug"]), "short": p.get("short", p["slug"]),
            "description": p.get("description", ""), "corpora": p.get("corpora", []),
            "hiddenWorkTypes": p.get("hiddenWorkTypes", {}), "role": role}

def ints(a):
    if not isinstance(a, list) or len(a) > 200000: raise ApiError(400, "Неверный список элементов")
    out = []
    for x in a:
        if not isinstance(x, int) or isinstance(x, bool) or x < 0 or x > 10000000: raise ApiError(400, "Неверный номер элемента")
        out.append(x)
    return out

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".bin": "application/octet-stream", ".woff2": "font/woff2"}

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
       "frame-ancestors 'none'")

class H(BaseHTTPRequestHandler):
    server_version = "web"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def version_string(self): return "web"
    def log_message(self, fmt, *a):
        if self.command == "GET" and (self.path.startswith("/api/p/") or self.path.startswith("/assets/")): return
        print("%s %s" % (self.client_ip(), fmt % a), flush=True)
    def send_error(self, code, message=None, explain=None):
        try: self.send_json({"error": "Ошибка запроса"}, code if 400 <= code < 600 else 400)
        except Exception: pass

    # ---------- общее ----------
    def client_ip(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):      # за Caddy на этом же маке — настоящий адрес в заголовке
            xf = self.headers.get("X-Forwarded-For", "")
            if xf: return xf.split(",")[0].strip()[:64]
        return peer
    def is_https(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and self.headers.get("X-Forwarded-Proto") == "https"

    def sec_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if self.is_https(): self.send_header("Strict-Transport-Security", "max-age=31536000")

    def send_json(self, obj, code=200, cookies=()):
        b = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(b) > 2048
        if gz: b = gzip.compress(b, 5)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if gz: self.send_header("Content-Encoding", "gzip"); self.send_header("Vary", "Accept-Encoding")
        for ck in cookies: self.send_header("Set-Cookie", ck)
        self.sec_headers()
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def redirect(self, to):
        self.send_response(302); self.send_header("Location", to); self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store"); self.sec_headers(); self.end_headers()

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY: raise ApiError(413, "Слишком большой запрос")
        if n and "application/json" not in self.headers.get("Content-Type", ""): raise ApiError(415, "Нужен JSON")
        try: d = json.loads(self.rfile.read(n) or b"{}")
        except Exception: raise ApiError(400, "Неверный JSON")
        if not isinstance(d, dict): raise ApiError(400, "Неверный JSON")
        return d

    def csrf_ok(self):
        # изменения принимаются только от страниц этого же сайта: свой заголовок + совпадение Origin
        if self.headers.get("X-Requested-With") != "fasady": return False
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host", "")
            if urlparse(origin).netloc != host: return False
        return True

    def cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name: return v
        return None
    def session_cookie(self, token, max_age):
        attrs = ["sid=%s" % token, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
        if self.is_https(): attrs.append("Secure")
        return "; ".join(attrs)

    _user = False
    def user(self):
        """Текущий пользователь по cookie сессии или None."""
        if self._user is not False: return self._user
        self._user = None
        t = self.cookie("sid")
        if t and re.match(r"^[A-Za-z0-9_-]{20,100}$", t):
            now = int(time.time())
            with db() as c:
                r = c.execute("SELECT u.id, u.login, u.name, u.is_admin, s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id "
                              "WHERE s.token_hash=? AND s.expires>? AND u.active=1", (tok_hash(t), now)).fetchone()
                if r:
                    self._user = {"id": r["id"], "login": r["login"], "name": r["name"], "admin": bool(r["is_admin"])}
                    if now - (r["last_seen"] or 0) > 300:
                        c.execute("UPDATE sessions SET last_seen=?, expires=? WHERE token_hash=?",
                                  (now, now + SESSION_DAYS * 86400, tok_hash(t)))
        return self._user
    def need_user(self):
        u = self.user()
        if not u: raise ApiError(401, "Нужно войти")
        return u
    def need_admin(self):
        u = self.need_user()
        if not u["admin"]: raise ApiError(403, "Только для администратора")
        return u
    def role_in(self, u, slug):
        if u["admin"]: return "editor"
        with db() as c:
            r = c.execute("SELECT role FROM access WHERE user_id=? AND project=?", (u["id"], slug)).fetchone()
        return r["role"] if r else None
    def need_project(self, slug, edit=False):
        u = self.need_user()
        p = projects().get(slug)
        role = self.role_in(u, slug) if p else None
        if not p or not role: raise ApiError(404, "Объект не найден")
        if edit and role != "editor": raise ApiError(403, "Только просмотр")
        return u, p, role

    # ---------- маршруты ----------
    def handle_any(self, method):
        self._user = False            # соединение keep-alive обслуживает несколько запросов — пользователь определяется заново
        u = urlparse(self.path); path = u.path
        try:
            if method in ("POST", "DELETE") and not self.csrf_ok(): raise ApiError(403, "Запрос отклонён")
            if path.startswith("/api/"):
                return self.api(method, path, parse_qs(u.query))
            if method != "GET": raise ApiError(405, "Метод не поддерживается")
            if path in ("/", "/index.html"): return self.static_file("home.html")
            m = re.match(r"^/p/([a-z0-9_-]{1,40})/?$", path)
            if m:
                usr = self.user()
                if not usr: return self.redirect("/?next=" + m.group(1))
                if not (m.group(1) in projects() and self.role_in(usr, m.group(1))): return self.redirect("/")
                return self.static_file("tracker.html")
            m = re.match(r"^/assets/([A-Za-z0-9_.-]{1,60})$", path)
            if m: return self.static_file(m.group(1))
            if path == "/favicon.ico": return self.static_file("favicon.svg")
            raise ApiError(404, "Не найдено")
        except ApiError as e:
            return self.send_json({"error": e.msg}, e.code)
        except Exception as e:
            print("ERROR %s %s: %r" % (method, path, e), flush=True)
            return self.send_json({"error": "Ошибка сервера"}, 500)

    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_DELETE(self): self.handle_any("DELETE")
    def do_PUT(self): self.send_json({"error": "Метод не поддерживается"}, 405)
    do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = do_PUT
    def do_HEAD(self): self.send_json({}, 405)

    def api(self, method, path, q):
        # --- вход / выход ---
        if path == "/api/login" and method == "POST":
            d = self.body(); ip = self.client_ip()
            login = str(d.get("login", "")).strip()[:40]; pw = str(d.get("password", ""))[:200]
            if RL_IP.blocked(ip) or RL_LOGIN.blocked(login.lower()):
                raise ApiError(429, "Слишком много попыток. Попробуйте через 15 минут")
            with db() as c:
                r = c.execute("SELECT id, pw, active FROM users WHERE login=?", (login,)).fetchone()
            ok = verify_password(pw, r["pw"] if r else None) and r and r["active"]
            if not ok:
                RL_IP.hit(ip); RL_LOGIN.hit(login.lower()); time.sleep(0.4)
                raise ApiError(401, "Неверный логин или пароль")
            RL_LOGIN.reset(login.lower())
            t = secrets.token_urlsafe(32); now = int(time.time())
            with db() as c:
                c.execute("INSERT INTO sessions(token_hash,user_id,created,expires,last_seen,ip) VALUES(?,?,?,?,?,?)",
                          (tok_hash(t), r["id"], now, now + SESSION_DAYS * 86400, now, ip))
            print("вход: %s с %s" % (login, ip), flush=True)
            return self.send_json({"ok": True}, cookies=[self.session_cookie(t, SESSION_DAYS * 86400)])
        if path == "/api/logout" and method == "POST":
            t = self.cookie("sid")
            if t:
                with db() as c: c.execute("DELETE FROM sessions WHERE token_hash=?", (tok_hash(t),))
            return self.send_json({"ok": True}, cookies=[self.session_cookie("", 0)])

        # --- я и мои объекты ---
        if path == "/api/me" and method == "GET":
            u = self.need_user(); P = projects()
            if u["admin"]: lst = [public_project(p, "editor") for p in P.values()]
            else:
                with db() as c:
                    rows = c.execute("SELECT project, role FROM access WHERE user_id=?", (u["id"],)).fetchall()
                lst = [public_project(P[r["project"]], r["role"]) for r in rows if r["project"] in P]
            return self.send_json({"user": {"login": u["login"], "name": u["name"], "admin": u["admin"]}, "projects": lst})
        if path == "/api/me/password" and method == "POST":
            u = self.need_user(); d = self.body()
            with db() as c: r = c.execute("SELECT pw FROM users WHERE id=?", (u["id"],)).fetchone()
            if not verify_password(str(d.get("old", "")), r["pw"]): raise ApiError(400, "Текущий пароль неверный")
            err = check_new_password(d.get("new"))
            if err: raise ApiError(400, err)
            t = self.cookie("sid")
            with db() as c:
                c.execute("UPDATE users SET pw=?, pw_changed=? WHERE id=?", (hash_password(d["new"]), int(time.time()), u["id"]))
                c.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (u["id"], tok_hash(t or "")))
            return self.send_json({"ok": True})

        # --- администрирование ---
        if path.startswith("/api/admin/"):
            return self.admin_api(method, path)

        # --- объект ---
        m = re.match(r"^/api/p/([a-z0-9_-]{1,40})/(info|events|ks|data/[A-Za-z0-9_.-]{1,80}|ks/[\w-]{1,40})$", path)
        if not m: raise ApiError(404, "Не найдено")
        slug, rest = m.group(1), m.group(2)
        if rest == "info" and method == "GET":
            usr, p, role = self.need_project(slug)
            return self.send_json({"project": public_project(p, role),
                                   "user": {"login": usr["login"], "name": usr["name"], "admin": usr["admin"]}})
        if rest.startswith("data/") and method == "GET":
            self.need_project(slug)
            name = rest[5:]
            if not FILE_RE.match(name) or ".." in name: raise ApiError(404, "Не найдено")
            return self.serve_file(os.path.join(PROJECTS, slug, "data"), name, private=True)
        if rest == "events":
            if method == "GET":
                usr, p, role = self.need_project(slug)
                corpus = q.get("corpus", [""])[0]
                if corpus not in p["_corpora"]: raise ApiError(400, "Нет такого корпуса")
                try: after = max(0, int(q.get("after", ["0"])[0] or 0))
                except ValueError: raise ApiError(400, "after")
                with db() as c:
                    rows = c.execute("SELECT id, work_type, action, add_idx, remove_idx FROM events "
                                     "WHERE project=? AND corpus=? AND id>? ORDER BY id LIMIT 5000", (slug, corpus, after)).fetchall()
                    ep = c.execute("SELECT v FROM meta WHERE k=?", ("epoch:" + slug,)).fetchone()
                ev = [{"id": r["id"], "workType": r["work_type"], "action": r["action"],
                       "add": json.loads(r["add_idx"]), "remove": json.loads(r["remove_idx"])} for r in rows]
                return self.send_json({"events": ev, "last": ev[-1]["id"] if ev else after, "epoch": ep["v"] if ep else "0",
                                       "more": len(ev) == 5000})
            if method == "POST":
                usr, p, role = self.need_project(slug, edit=True)
                d = self.body()
                corpus, wt, action = d.get("corpus"), d.get("workType"), d.get("action", "paint")
                if corpus not in p["_corpora"] or wt not in WORK_TYPES or action not in ("paint", "clear"):
                    raise ApiError(400, "Неверное событие")
                with _lock, db() as c:
                    cur = c.execute("INSERT INTO events(project,corpus,work_type,action,add_idx,remove_idx,user,ts,created) "
                                    "VALUES(?,?,?,?,?,?,?,?,?)",
                                    (slug, corpus, wt, action, json.dumps(ints(d.get("add", []))),
                                     json.dumps(ints(d.get("remove", []))), usr["login"],
                                     int(time.time() * 1000), int(time.time())))
                return self.send_json({"id": cur.lastrowid})
        if rest == "ks":
            if method == "GET":
                usr, p, role = self.need_project(slug)
                corpus = q.get("corpus", [""])[0]
                with db() as c:
                    rows = c.execute("SELECT id,name,x0,y0,x1,y1 FROM ks_areas WHERE project=? AND corpus=? AND deleted=0 "
                                     "ORDER BY created", (slug, corpus)).fetchall()
                return self.send_json({"areas": [dict(r) for r in rows]})
            if method == "POST":
                usr, p, role = self.need_project(slug, edit=True)
                d = self.body(); corpus = d.get("corpus")
                if corpus not in p["_corpora"]: raise ApiError(400, "Нет такого корпуса")
                aid = str(d.get("id") or ("ks%d" % (time.time() * 1000)))
                if not re.match(r"^[\w-]{1,40}$", aid): raise ApiError(400, "id")
                try: box = [float(d[k]) for k in ("x0", "y0", "x1", "y1")]
                except Exception: raise ApiError(400, "Координаты")
                with _lock, db() as c:
                    c.execute("INSERT OR REPLACE INTO ks_areas(id,project,corpus,name,x0,y0,x1,y1,created) VALUES(?,?,?,?,?,?,?,?,?)",
                              (aid, slug, corpus, str(d.get("name", "Участок"))[:120], *box, int(time.time() * 1000)))
                return self.send_json({"id": aid})
        if rest.startswith("ks/") and method == "DELETE":
            self.need_project(slug, edit=True)
            with _lock, db() as c:
                c.execute("UPDATE ks_areas SET deleted=1 WHERE id=? AND project=?", (rest[3:], slug))
            return self.send_json({"ok": True})
        raise ApiError(405, "Метод не поддерживается")

    def admin_api(self, method, path):
        me = self.need_admin()
        if path == "/api/admin/users" and method == "GET":
            with db() as c:
                users = [dict(r) for r in c.execute("SELECT id, login, name, is_admin, active, created FROM users ORDER BY login")]
                acc = c.execute("SELECT user_id, project, role FROM access").fetchall()
            for usr in users: usr["access"] = {a["project"]: a["role"] for a in acc if a["user_id"] == usr["id"]}
            return self.send_json({"users": users, "projects": [{"slug": p["slug"], "name": p.get("name", p["slug"])} for p in projects().values()]})
        if path == "/api/admin/users" and method == "POST":
            d = self.body()
            login = str(d.get("login", "")).strip()
            if not LOGIN_RE.match(login): raise ApiError(400, "Логин: 3–40 символов, латиница, цифры, . _ - @")
            err = check_new_password(d.get("password"))
            if err: raise ApiError(400, err)
            try:
                with db() as c:
                    cur = c.execute("INSERT INTO users(login,name,pw,is_admin,active,created,pw_changed) VALUES(?,?,?,?,1,?,?)",
                                    (login, str(d.get("name", ""))[:80], hash_password(d["password"]),
                                     1 if d.get("admin") else 0, int(time.time()), int(time.time())))
            except sqlite3.IntegrityError: raise ApiError(400, "Такой логин уже есть")
            print("админ %s создал пользователя %s" % (me["login"], login), flush=True)
            return self.send_json({"id": cur.lastrowid})
        m = re.match(r"^/api/admin/users/(\d{1,9})$", path)
        if m and method == "POST":
            uid = int(m.group(1)); d = self.body()
            with db() as c:
                if not c.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone(): raise ApiError(404, "Нет пользователя")
                if "name" in d: c.execute("UPDATE users SET name=? WHERE id=?", (str(d["name"])[:80], uid))
                if "password" in d:
                    err = check_new_password(d["password"])
                    if err: raise ApiError(400, err)
                    c.execute("UPDATE users SET pw=?, pw_changed=? WHERE id=?", (hash_password(d["password"]), int(time.time()), uid))
                    c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                for f in ("active", "is_admin"):
                    if f in d:
                        if uid == me["id"] and not d[f]: raise ApiError(400, "Нельзя снять права с самого себя")
                        c.execute("UPDATE users SET %s=? WHERE id=?" % f, (1 if d[f] else 0, uid))
                        if f == "active" and not d[f]: c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
                if "access" in d and isinstance(d["access"], dict):
                    for slug, role in d["access"].items():
                        if slug not in projects(): continue
                        if role in ROLES:
                            c.execute("INSERT OR REPLACE INTO access(user_id,project,role) VALUES(?,?,?)", (uid, slug, role))
                        else:
                            c.execute("DELETE FROM access WHERE user_id=? AND project=?", (uid, slug))
            return self.send_json({"ok": True})
        raise ApiError(404, "Не найдено")

    # ---------- файлы ----------
    def static_file(self, name):
        if not FILE_RE.match(name) or name.startswith("."): raise ApiError(404, "Не найдено")
        return self.serve_file(STATIC, name, private=False)

    def serve_file(self, base, name, private):
        fp = os.path.normpath(os.path.join(base, name)); gz = fp + ".gz"
        if not fp.startswith(os.path.normpath(base) + os.sep) or not (os.path.isfile(fp) or os.path.isfile(gz)):
            raise ApiError(404, "Не найдено")
        ext = os.path.splitext(fp)[1]
        accepts = "gzip" in self.headers.get("Accept-Encoding", "")
        use_gz = os.path.isfile(gz) and (accepts or not os.path.isfile(fp))
        src = gz if use_gz else fp
        st = os.stat(src)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304); self.send_header("ETag", etag); self.send_header("Content-Length", "0")
            self.sec_headers(); self.end_headers(); return
        body = None
        if use_gz and not accepts:
            with open(gz, "rb") as f: body = gzip.decompress(f.read())
            use_gz = False
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        if use_gz: self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, no-cache" if private else "no-cache")
        self.sec_headers()
        self.send_header("Content-Length", str(len(body) if body is not None else st.st_size))
        self.end_headers()
        if body is not None: self.wfile.write(body)
        else:
            with open(src, "rb") as f: shutil.copyfileobj(f, self.wfile)

class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

def reload_watch():
    """Обновили server.py (Pull в GitHub Desktop) — выходим, служба launchd сразу запустит новую версию."""
    me = os.path.abspath(__file__)
    t0 = os.stat(me).st_mtime
    while True:
        time.sleep(3)
        try:
            if os.stat(me).st_mtime != t0:
                time.sleep(2)
                print("server.py обновлён — перезапуск", flush=True)
                os._exit(0)
        except FileNotFoundError:
            pass

if __name__ == "__main__":
    os.umask(0o077)
    init_db()
    try: os.chmod(DB_PATH, 0o600)
    except OSError: pass
    threading.Thread(target=housekeeping_loop, daemon=True).start()
    threading.Thread(target=reload_watch, daemon=True).start()
    with db() as c: nusers = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    print("Фасады: http://%s:%d  (база %s, пользователей: %d)" % (HOST, PORT, DB_PATH, nusers), flush=True)
    if not nusers: print("Нет ни одного пользователя — создайте администратора:  python3 manage.py add-admin ЛОГИН", flush=True)
    Server((HOST, PORT), H).serve_forever()
