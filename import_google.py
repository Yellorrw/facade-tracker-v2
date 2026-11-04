#!/usr/bin/env python3
"""Перенос уже накрашенного из старой синхронизации (Google Apps Script / Google Таблица) в базу сервера.

Запуск на сервере:  python3 import_google.py           — импорт (повторный запуск ничего не дублирует)
                    python3 import_google.py --force   — удалить ранее импортированное из Google и загрузить заново
"""
import json, os, re, sqlite3, sys, time, urllib.request
from datetime import datetime, timezone

GOOGLE_URL = os.environ.get("GOOGLE_SYNC_URL",
    "https://script.google.com/macros/s/AKfycbxuHDozzemVt7iQ8-kc22lClGpaYk2c8osaNaFKUPXdjfSfJzBIVr4QSO7Iuot88Nq4yw/exec")
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "data"))
DB_PATH = os.path.join(DATA_DIR, "tracker.db")
CORPORA = ["corpus1", "corpus2", "corpus3", "corpus4", "corpus5"]

def parse_ts(v):
    """Время мазка: число мс, строка с числом или дата ISO из Google Таблицы ('2026-07-20T05:56:48.152Z')."""
    if v is None or v == "": return 0
    if isinstance(v, (int, float)): return int(v)
    s = str(v).strip()
    try: return int(float(s))
    except ValueError: pass
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None: d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    except ValueError: pass
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)", s)   # старый Python: дробные секунды любой длины
    if m:
        d = datetime(*map(int, m.groups()), tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    return 0

def as_list(v):
    if v is None or v == "": return []
    if isinstance(v, (int, float)): return [int(v)]
    if isinstance(v, str):
        try: v = json.loads(v)
        except Exception: v = [x for x in v.replace("[", "").replace("]", "").split(",") if x.strip()]
    return [int(float(x)) for x in v]

def main():
    sys.path.insert(0, ROOT)
    import server; server.init_db()
    force = "--force" in sys.argv
    c = sqlite3.connect(DB_PATH)
    if force: c.execute("DELETE FROM events WHERE source='google'"); c.commit()
    total = 0
    for corpus in CORPORA:
        have = c.execute("SELECT COUNT(*) FROM events WHERE source='google' AND corpus=?", (corpus,)).fetchone()[0]
        if have and not force:
            print(f"{corpus}: уже импортировано ({have} событий), пропускаю"); continue
        url = GOOGLE_URL + "?corpus=" + corpus
        with urllib.request.urlopen(url, timeout=120) as r:
            data = json.loads(r.read().decode("utf-8"))
        evs = data.get("events") or []
        # порядок строк таблицы сохраняем как есть — старый сайт переигрывал события именно в нём
        evs = [e for e in evs if isinstance(e, dict)]
        rows = []
        for e in evs:
            wt, act = e.get("workType"), e.get("action") or "paint"
            if not wt: continue
            rows.append((corpus, wt, act, json.dumps(as_list(e.get("add"))), json.dumps(as_list(e.get("remove"))),
                         str(e.get("user") or "")[:64], parse_ts(e.get("ts")), "google", int(time.time())))
        # события из Google идут ПЕРЕД событиями, нарисованными уже на новом сервере
        web = c.execute("SELECT corpus,work_type,action,add_idx,remove_idx,user,ts,source,created FROM events "
                        "WHERE corpus=? ORDER BY id", (corpus,)).fetchall()
        c.execute("DELETE FROM events WHERE corpus=?", (corpus,))
        c.executemany("INSERT INTO events(corpus,work_type,action,add_idx,remove_idx,user,ts,source,created) "
                      "VALUES(?,?,?,?,?,?,?,?,?)", rows + list(web))
        c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('epoch',?)", (str(int(time.time() * 1000)),))
        c.commit()
        total += len(rows)
        print(f"{corpus}: импортировано {len(rows)} событий из Google")
    c.close()
    print(f"Готово, всего {total}. Обновите страницу сайта.")

if __name__ == "__main__":
    main()
