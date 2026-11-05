#!/usr/bin/env python3
"""Управление учётными записями из Терминала на маке (пароли вводятся скрытно и никуда не отправляются).

  python3 manage.py add-admin ЛОГИН      — создать администратора (первый вход на сайт)
  python3 manage.py passwd ЛОГИН         — задать новый пароль (если забыли)
  python3 manage.py list                 — список пользователей и доступов
  python3 manage.py disable ЛОГИН        — отключить пользователя
"""
import getpass, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server as S

def ask_password():
    while True:
        p1 = getpass.getpass("Пароль (не короче 8 символов, при вводе не отображается): ")
        err = S.check_new_password(p1)
        if err: print(err); continue
        if getpass.getpass("Ещё раз: ") != p1: print("Не совпадает, ещё раз."); continue
        return p1

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"): print(__doc__); return
    S.init_db()
    cmd, arg = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
    with S.db() as c:
        if cmd == "add-admin":
            if not S.LOGIN_RE.match(arg): sys.exit("Логин: 3–40 символов, латиница, цифры, . _ - @")
            if c.execute("SELECT 1 FROM users WHERE login=?", (arg,)).fetchone(): sys.exit("Такой логин уже есть. Для смены пароля: passwd " + arg)
            name = input("Имя для отображения (Enter — как логин): ").strip() or arg
            pw = ask_password()
            c.execute("INSERT INTO users(login,name,pw,is_admin,active,created,pw_changed) VALUES(?,?,?,1,1,?,?)",
                      (arg, name[:80], S.hash_password(pw), int(time.time()), int(time.time())))
            print("Администратор %s создан. Входите на сайт с этим логином и паролем." % arg)
        elif cmd == "passwd":
            r = c.execute("SELECT id FROM users WHERE login=?", (arg,)).fetchone()
            if not r: sys.exit("Нет пользователя " + arg)
            c.execute("UPDATE users SET pw=?, pw_changed=?, active=1 WHERE id=?", (S.hash_password(ask_password()), int(time.time()), r["id"]))
            c.execute("DELETE FROM sessions WHERE user_id=?", (r["id"],))
            print("Пароль обновлён, все входы этого пользователя сброшены.")
        elif cmd == "disable":
            n = c.execute("UPDATE users SET active=0 WHERE login=?", (arg,)).rowcount
            c.execute("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE login=?)", (arg,))
            print("Отключён." if n else "Нет пользователя " + arg)
        elif cmd == "list":
            for u in c.execute("SELECT id, login, name, is_admin, active FROM users ORDER BY login"):
                acc = ", ".join("%s:%s" % (a["project"], a["role"]) for a in c.execute("SELECT project, role FROM access WHERE user_id=?", (u["id"],)))
                print("%-20s %-24s %s%s  %s" % (u["login"], u["name"], "админ" if u["is_admin"] else "", "" if u["active"] else " (отключён)", acc))
        else:
            print(__doc__)

if __name__ == "__main__":
    main()
