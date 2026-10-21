"""
Was der Druck der WebView in WebKitGTK (wie die Linux-App bis 0.4.1) aus dem
Stickerbogen macht (TODO #85): die Web-App mit der erfundenen Karte, alle
Ordner gewählt, „Drucken“. window.print() geht an das print-Signal der
WebView; hier druckt es ohne Dialog in eine PDF-Datei („In Datei drucken“
von GTK), mit dem Papier und den Druckerrändern, die GTK dem Druck geben
würde. Danach misst pdftoppm jede Seite: Papier und wo Farbe ist (mm).

    xvfb-run python3.12 -I scripts/bench/druck.py URL AUSGABE.pdf [RÄNDER] [PAPIER]

URL: die laufende Web-App mit Messkarte (server.mjs, wie shots.mjs).
RÄNDER: oben,unten,links,rechts in mm (Standard 6.35,6.35,6.35,6.35, der
Rand von GTK); PAPIER: iso_a4 (Standard) oder na_letter.

Ergebnis 0.4.1 (WebKitGTK 2.52, HERMA 5028, 5 Bögen): 10 Seiten, nach jedem
Bogen eine leere; der Bogen auf die bedruckbare Breite verkleinert
(6,35 mm: 94 %, um den Rand verschoben); auf Letter über zwei Seiten
verteilt. Auch mit Rand 0 eine leere Seite nach jedem Bogen. Darum druckt
die Desktop-App seit 0.5 das PDF über CUPS (src-tauri/src/print.rs).
"""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
import webkit as W  # noqa: E402
from gi.repository import Gtk, WebKit2  # noqa: E402

url, out = sys.argv[1], os.path.abspath(sys.argv[2])
margins = [float(x) for x in (sys.argv[3] if len(sys.argv) > 3 else '6.35,6.35,6.35,6.35').split(',')]
paper = sys.argv[4] if len(sys.argv) > 4 else Gtk.PAPER_NAME_A4
probe = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe.js'), encoding='utf-8').read()


def measure(pdf, dpi=100):
    """Papier und Farbe jeder Seite in mm, aus einem Graubild von pdftoppm."""
    d = tempfile.mkdtemp()
    try:
        subprocess.run(['pdftoppm', '-r', str(dpi), '-gray', pdf, os.path.join(d, 'p')], check=True)
        for name in sorted(os.listdir(d)):
            data = open(os.path.join(d, name), 'rb').read()
            parts = data.split(maxsplit=4)
            w, h = int(parts[1]), int(parts[2])
            pixels = parts[4][-w * h:]
            xs, ys = [], []
            for y in range(h):
                row = pixels[y * w:(y + 1) * w]
                dark = [x for x, v in enumerate(row) if v < 245]
                if dark:
                    xs += [dark[0], dark[-1] + 1]
                    ys.append(y)
            mm = lambda px: round(px * 25.4 / dpi, 1)  # noqa: E731
            ink = [mm(min(xs)), mm(ys[0]), mm(max(xs)), mm(ys[-1] + 1)] if xs else None
            yield {'papier': [mm(w), mm(h)], 'farbe': ink}
    finally:
        shutil.rmtree(d, ignore_errors=True)


base = f'/tmp/tonuino-bench/webkit-druck-{os.getpid()}'
shutil.rmtree(base, ignore_errors=True)
dm = WebKit2.WebsiteDataManager(base_data_directory=base + '/data', base_cache_directory=base + '/cache')
p = W.Page(dm, probe, 2000, 1250, 'default')
p.open(url + '__bench/blank.html')
p.bench('window.__bench.setupInto()')
p.close()
p = W.Page(dm, probe, 2000, 1250, 'default')
done = {}


def on_print(_view, op):
    setup = Gtk.PageSetup()
    setup.set_paper_size(Gtk.PaperSize.new(paper))
    setup.set_top_margin(margins[0], Gtk.Unit.MM)
    setup.set_bottom_margin(margins[1], Gtk.Unit.MM)
    setup.set_left_margin(margins[2], Gtk.Unit.MM)
    setup.set_right_margin(margins[3], Gtk.Unit.MM)
    st = Gtk.PrintSettings()
    st.set_printer('Print to File')
    st.set(Gtk.PRINT_SETTINGS_OUTPUT_FILE_FORMAT, 'pdf')
    st.set(Gtk.PRINT_SETTINGS_OUTPUT_URI, 'file://' + out)
    op.set_page_setup(setup)
    op.set_print_settings(st)
    op.connect('finished', lambda *_: done.setdefault('ok', True))
    op.connect('failed', lambda _o, err: done.setdefault('fehler', str(err)))
    op.print_()
    return True


p.view.connect('print', on_print)
p.open(url)
W.pump(lambda: False, 4)
p.js('location.hash = "#/sticker", 1')
W.pump(lambda: False, 5)
p.js('[...document.querySelectorAll("button")].find(b => /^Alle \\d+ Ordner nehmen$/.test(b.textContent.trim())).click(), 1')
W.pump(lambda: False, 8)
p.js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Drucken").click(), 1')
W.pump(lambda: bool(done), 3)
if not done:
    # Ordner ohne Cover: erst die Frage, dann „So drucken“.
    p.js('[...document.querySelectorAll("[role=dialog] button")].find(b => b.textContent.trim() === "So drucken").click(), 1')
if not W.pump(lambda: bool(done), 180):
    sys.exit('Kein Druck angekommen')
p.close()
shutil.rmtree(base, ignore_errors=True)
print({'druck': done, 'ränder_mm': margins, 'papier': paper})
for i, page in enumerate(measure(out), 1):
    print(i, page)
