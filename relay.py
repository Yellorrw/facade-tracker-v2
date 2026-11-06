#!/usr/bin/env python3
"""Входная точка сайта из интернета при включённом VPN.

Слушает порты 80 и 443 на адресе мака в домашней сети и привязывает сокеты к домашнему интерфейсу
(IP_BOUND_IF). Поэтому ответы посетителям всегда уходят через домашний роутер, даже когда весь
остальной трафик мака идёт через VPN. Соединения передаются в Caddy на 127.0.0.1 тех же портов
с заголовком PROXY — так Caddy и сайт видят настоящий адрес посетителя.

Запуск (служба ru.fasady.relay):  python3 relay.py 192.168.1.223 en1
"""
import asyncio, socket, struct, sys

IP_BOUND_IF = 25          # macOS: <netinet/in.h>
PORTS = (80, 443)
MAX_CONN = 512

def bound_listener(ip, port, ifindex):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, struct.pack("I", ifindex))
    s.bind((ip, port))
    s.listen(256)
    s.setblocking(False)
    return s

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data: break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try: writer.close()
        except Exception: pass

def make_handler(port, ifindex, sem):
    async def handle(cr, cw):
        if sem.locked():
            cw.close(); return
        async with sem:
            sock = cw.get_extra_info("socket")
            try: sock.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, struct.pack("I", ifindex))
            except Exception: pass
            peer = cw.get_extra_info("peername") or ("0.0.0.0", 0)
            local = cw.get_extra_info("sockname") or ("0.0.0.0", port)
            try:
                ur, uw = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 5)
            except Exception:
                cw.close(); return
            uw.write(("PROXY TCP4 %s %s %d %d\r\n" % (peer[0], local[0], peer[1], local[1])).encode())
            await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    return handle

async def main(ip, ifname):
    ifindex = socket.if_nametoindex(ifname)
    sem = asyncio.Semaphore(MAX_CONN)
    servers = []
    for p in PORTS:
        servers.append(await asyncio.start_server(make_handler(p, ifindex, sem), sock=bound_listener(ip, p, ifindex)))
    print("relay: %s (%s) порты %s → 127.0.0.1" % (ip, ifname, ", ".join(map(str, PORTS))), flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))

if __name__ == "__main__":
    if len(sys.argv) != 3: sys.exit("usage: relay.py LAN_IP IFACE")
    asyncio.run(main(sys.argv[1], sys.argv[2]))
