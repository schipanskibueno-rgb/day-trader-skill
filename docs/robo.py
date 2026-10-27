#!/usr/bin/env python3
"""Opens the Robo Trader page on this device. Standard library only.

    python3 docs/robo.py

Serves this folder at http://localhost:8765 (only this device can reach it)
and opens the browser: termux-open-url in Termux on Android, the default
browser anywhere else. Leave it running; Ctrl+C stops it.
"""

import functools
import http.server
import os
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORTS = range(8765, 8785)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")   # a git pull shows up on the next reload
        super().end_headers()


def make_server():
    handler = functools.partial(Quiet, directory=HERE)
    for port in PORTS:
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
        except OSError:
            continue
    raise SystemExit("Nenhuma porta livre entre %d e %d." % (PORTS[0], PORTS[-1]))


def open_browser(url):
    if shutil.which("termux-open-url"):
        subprocess.call(["termux-open-url", url])
    else:
        webbrowser.open(url)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    server = make_server()
    url = "http://localhost:%d/" % server.server_address[1]
    print("Robo Trader ligado: %s" % url)
    print("Deixe esta tela aberta (pode ir para o navegador). Para desligar: Ctrl+C.")
    if "--no-browser" not in argv:
        threading.Timer(0.5, open_browser, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRobo desligado.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    socket.setdefaulttimeout(30)
    sys.exit(main())
