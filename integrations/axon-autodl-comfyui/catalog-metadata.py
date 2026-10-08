"""Decorate authenticated relay model listings with software capability notes."""
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

METADATA = Path('/opt/axon/yingce-model-metadata.json')

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] != '/v1/models':
            self.send_error(404)
            return
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('host', 'connection', 'accept-encoding')}
        request = urllib.request.Request('http://127.0.0.1:3002' + self.path, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError:
            self.send_error(502)
            return
        with response:
            body = response.read()
            status = response.status
            if status == 200:
                try:
                    payload = json.loads(body)
                    metadata = json.loads(METADATA.read_text(encoding='utf-8'))
                    for model in payload.get('data', []):
                        item = metadata.get(model.get('id'))
                        if item:
                            model['description'] = item['description']
                            model['yingce'] = {'observed': item['observed']}
                    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                except (ValueError, OSError, AttributeError, TypeError):
                    pass  # Preserve the original listing if metadata is unavailable.
            self.send_response(status)
            for key, value in response.headers.items():
                if key.lower() not in ('content-length', 'transfer-encoding', 'connection', 'content-encoding'):
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, format, *args):
        pass

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 3003), Handler).serve_forever()
