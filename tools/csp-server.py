"""Serves the app locally with the exact headers vercel.json declares.

A plain static server has no Content-Security-Policy, so a page that is broken
on the live site works perfectly on localhost. That has already cost this
project twice: an inline script that the CSP blocked left every button on the
lab page dead, and it only showed up after deploying.

Testing against this instead of `npx serve` is the fix. Dev tooling only —
never served, never imported by the app.

    python3 tools/csp-server.py     # http://127.0.0.1:4399
"""
import http.server
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, 'vercel.json')) as f:
    HEADERS = [(h['key'], h['value']) for h in json.load(f)['headers'][0]['headers']]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        for key, value in HEADERS:
            # HSTS over plain http would pin localhost to https in the browser
            # for two years. Skipped here and only here.
            if key != 'Strict-Transport-Security':
                self.send_header(key, value)
        # ES modules are cached aggressively, and a stale one does not fail
        # quietly: if js/scroll.js is served from cache without an export that
        # js/app.js now imports, the whole module graph throws and the entire
        # app silently does nothing. That has already cost this project a
        # debugging session where a correct fix looked broken. No caching in dev.
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f'{self.address_string()} {fmt % args}')


if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4399
    print(f'serving {ROOT} with vercel.json headers on http://127.0.0.1:{port}')
    http.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()
