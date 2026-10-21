"""
Bildschirmfotos der Web-App in WebKitGTK (dem Browser der Linux-App), für
die Klickrunde vor jeder Auslieferung: jede Seite in jeder Fenstergröße,
mit und ohne die erfundene SD-Karte (scripts/bench/card.mjs).

    python3.12 scripts/bench/shots.py URL AUSGABE GRÖSSEN SEITEN [mit|ohne|beide]

URL: die laufende Web-App (scripts/bench/shots.mjs startet sie).
GRÖSSEN: z. B. "1280x800,2000x1250". SEITEN: Adressen nach dem #, durch
Komma getrennt (z. B. "/,/hinzufuegen"); "@" ist die Seite, mit der die
App startet. Braucht ein DISPLAY (Xvfb), das größer ist als das größte
Fenster. SHOT_QUERY="?als=handy" zeigt in einem Bench-Build
(VITE_BENCH_HANDY=1) die Android-App.
"""
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
import webkit as W  # noqa: E402
from gi.repository import WebKit2  # noqa: E402

url, out, sizes, routes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cards = sys.argv[5] if len(sys.argv) > 5 else 'beide'
wait = float(os.environ.get('SHOT_WAIT', '4'))
# SHOT_THEME=dark: the dark look, as if chosen in the settings (the pictures get "-dunkel").
theme = os.environ.get('SHOT_THEME', '')
# SHOT_JS: a script run on each page before the picture, e.g. a click that opens a dialog (the pictures get "-js").
action = os.environ.get('SHOT_JS', '')
# SHOT_QUERY: added to the address of the app, e.g. "?als=handy" for the Android app in a bench build (src/app/asPhone.ts).
query = os.environ.get('SHOT_QUERY', '')
probe = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe.js'), encoding='utf-8').read()
os.makedirs(out, exist_ok=True)
# Errors of the page, shown next to each picture.
CATCH = "\n;window.__shotErrors = [];addEventListener('error', (e) => window.__shotErrors.push(String(e.message)));addEventListener('unhandledrejection', (e) => window.__shotErrors.push(String(e.reason)));"


def grab(page, path):
    gw = page.win.get_window()
    _, ox, oy = gw.get_origin()
    w, h = gw.get_width(), gw.get_height()
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', f'{w}x{h}', '-i', f"{os.environ['DISPLAY']}+{ox},{oy}", '-frames:v', '1', path], check=True)


for with_card in ([True, False] if cards == 'beide' else [cards == 'mit']):
    for size in sizes.split(','):
        w, h = (int(x) for x in size.split('x'))
        base = f'/tmp/tonuino-bench/webkit-profile-shots-{os.getpid()}'
        shutil.rmtree(base, ignore_errors=True)
        dm = WebKit2.WebsiteDataManager(base_data_directory=base + '/data', base_cache_directory=base + '/cache')
        if with_card:
            p = W.Page(dm, probe, w, h, 'default')
            p.open(url + '__bench/blank.html')
            p.bench('window.__bench.setupInto()')
            p.close()
        p = W.Page(dm, probe + CATCH, w, h, 'default')
        p.open(url + query)
        W.pump(lambda: False, wait)
        if theme:
            p.js(f'document.documentElement.dataset.theme = {json.dumps(theme)}, 1')
        for route in routes.split(','):
            # The app keeps its pages: a new address after the # changes the page without loading anew.
            # "@" takes the page the app started on, without going anywhere (picture "gestartet").
            if route != '@':
                p.js(f'location.hash = {json.dumps("#" + route)}, 1')
                W.pump(lambda: False, wait)
            if action:
                p.js(f'({action}), 1')
                W.pump(lambda: False, 1.5)
            name = ('gestartet' if route == '@' else route.strip('/').replace('/', '-') or 'start') + f'-{size}-' + ('karte' if with_card else 'ohne') + ('-dunkel' if theme == 'dark' else '') + ('-js' if action else '')
            path = os.path.join(out, name + '.png')
            grab(p, path)
            errors = p.js('JSON.stringify(window.__shotErrors || [])')
            print(json.dumps({'bild': path, 'fehler': json.loads(errors or '[]')}, ensure_ascii=False), flush=True)
        p.close()
        shutil.rmtree(base, ignore_errors=True)
