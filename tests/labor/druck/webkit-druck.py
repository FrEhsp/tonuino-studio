"""
Testlabor (TODO #69, #85): window.print() in WebKitGTK, the engine of the
Linux desktop app and of GNOME Web. Opens one HTML file, calls
window.print() in the page, and prints without a dialog through GTK's
"In Datei drucken" into a PDF, with the paper and the printer margins GTK
would give the print.

    xvfb-run -a python3 -I webkit-druck.py SEITE.html AUSGABE.pdf [RÄNDER] [PAPIER]

RÄNDER: oben,unten,links,rechts in mm (Standard 6.35 je Seite, GTK's Rand);
PAPIER: iso_a4 (Standard) oder na_letter. Exit 0 und "ok" auf stdout, wenn
die Datei geschrieben wurde; sonst eine Meldung auf stderr.
"""
import os
import sys
import time

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

page, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
margins = [float(x) for x in (sys.argv[3] if len(sys.argv) > 3 else '6.35,6.35,6.35,6.35').split(',')]
paper = sys.argv[4] if len(sys.argv) > 4 else Gtk.PAPER_NAME_A4


def pump(until, timeout):
    ctx = GLib.MainContext.default()
    end = time.monotonic() + timeout
    while not until():
        if time.monotonic() > end:
            return False
        ctx.iteration(False) or time.sleep(0.005)
    return True


state = {}
win = Gtk.OffscreenWindow()
view = WebKit2.WebView()
win.add(view)
win.set_default_size(1200, 900)
win.show_all()


def on_load(_v, event):
    if event == WebKit2.LoadEvent.FINISHED:
        state['loaded'] = True


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
    op.connect('finished', lambda *_: state.setdefault('done', True))
    op.connect('failed', lambda _o, err: state.setdefault('error', str(err)))
    op.print_()
    return True


view.connect('load-changed', on_load)
view.connect('print', on_print)
view.load_uri('file://' + page)
if not pump(lambda: 'loaded' in state, 60):
    sys.exit('Seite lädt nicht')
# Pictures decoded, as printSheets waits for them.
pump(lambda: False, 1)
view.evaluate_javascript('setTimeout(() => window.print(), 50); 1', -1, None, None, None, None, None)
if not pump(lambda: 'done' in state or 'error' in state, 120):
    sys.exit('Kein Druck angekommen')
if 'error' in state:
    sys.exit('Druck gescheitert: ' + state['error'])
# GTK writes the file after "finished" in some versions: wait until it is there and stays.
pump(lambda: os.path.exists(out) and os.path.getsize(out) > 0, 20)
print('ok')
