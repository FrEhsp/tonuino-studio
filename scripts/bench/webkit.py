#!/usr/bin/env python3
"""The WebKitGTK half of the speed comparison (scripts/bench/run.mjs starts it).

Opens each built version in a WebKitGTK view, the same engine the Linux
desktop app uses, injects scripts/bench/probe.js before the app's own
scripts and runs the measurements in the page. Prints one line per run:
    RESULT {"label": ..., "run": {...}}

Needs python3-gi with WebKit2 4.1 (as on Linux Mint 22 / Ubuntu 24.04) and a
display (run.mjs uses xvfb-run when there is none).

    python3 webkit.py --target LABEL=URL [--target ...] [--runs 3] [--only start,shelf]
                      [--compositing default|on|off]
"""
import argparse
import json
import os
import shutil
import sys
import threading
import time

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402


TICK = os.sysconf('SC_CLK_TCK')


def cpu_of(pid):
    """CPU seconds a process used so far (all its threads)."""
    try:
        with open(f'/proc/{pid}/stat', encoding='ascii') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / TICK
    except OSError:
        return 0.0


def web_processes():
    """The WebKit helper processes this process started (web content, GPU, network)."""
    me = os.getpid()
    out = []
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open(f'/proc/{name}/stat', encoding='ascii') as f:
                raw = f.read()
        except OSError:
            continue
        comm = raw[raw.index('(') + 1:raw.rindex(')')]
        ppid = int(raw.rsplit(')', 1)[1].split()[1])
        if ppid == me and comm.startswith('WebKit') and 'Network' not in comm:
            out.append(int(name))
    return out


class CpuWatch:
    """Samples the CPU time of this process and its WebKit helpers, to tell what one frame costs (robust against a busy computer)."""

    def __init__(self):
        self.samples = []
        self.on = True
        self.t = threading.Thread(target=self.loop, daemon=True)
        self.t.start()

    def loop(self):
        while self.on:
            pids = web_processes()
            threads = threads_of([os.getpid(), *pids]) if os.environ.get('BENCH_THREADS') else None
            self.samples.append((time.time(), cpu_of(os.getpid()), sum(cpu_of(p) for p in pids), threads))
            time.sleep(0.02)

    def between(self, start, end):
        """CPU seconds (app window, web content) used between two wall-clock times in seconds."""
        def at(t):
            best = None
            for s in self.samples:
                if s[0] <= t:
                    best = s
            return best or (self.samples[0] if self.samples else (t, 0.0, 0.0))
        a, b = at(start), at(end)
        return b[1] - a[1], b[2] - a[2]

    def threads_between(self, start, end):
        """CPU milliseconds per thread name between two wall-clock times (BENCH_THREADS=1)."""
        a = next((x for x in reversed(self.samples) if x[0] <= start), None)
        b = next((x for x in reversed(self.samples) if x[0] <= end), None)
        if not a or not b or a[3] is None or b[3] is None:
            return None
        out = {}
        for k, v in b[3].items():
            d = v - a[3].get(k, 0.0)
            if d > 0.005:
                out[k] = out.get(k, 0) + round(d * 1000)
        return dict(sorted(out.items(), key=lambda kv: -kv[1])[:12])

    def stop(self):
        self.on = False


def threads_of(pids):
    """CPU seconds by process and thread name, e.g. 'WebKitWebProces/SkiaPaint'."""
    out = {}
    for pid in pids:
        try:
            tids = os.listdir(f'/proc/{pid}/task')
        except OSError:
            continue
        pname = 'ui' if pid == os.getpid() else 'web'
        for tid in tids:
            try:
                with open(f'/proc/{pid}/task/{tid}/stat', encoding='ascii') as f:
                    raw = f.read()
            except OSError:
                continue
            comm = raw[raw.index('(') + 1:raw.rindex(')')]
            fields = raw.rsplit(')', 1)[1].split()
            k = f'{pname}/{comm}'
            out[k] = out.get(k, 0.0) + (int(fields[11]) + int(fields[12])) / TICK
    return out


def add_cpu(result, watch):
    """Adds CPU milliseconds per frame to a scroll result that says when it scrolled."""
    wall = result.get('wall') if isinstance(result, dict) else None
    if not wall:
        return result
    ui, web = watch.between(wall[0] / 1000, wall[1] / 1000)
    seconds = (wall[1] - wall[0]) / 1000
    frames = max(1, round(result.get('fps', 0) * seconds))
    result['cpuMs'] = round((ui + web) * 1000)
    result['cpuWebMs'] = round(web * 1000)
    result['cpuPerFrameMs'] = round((ui + web) * 1000 / frames, 1)
    # Busy share of one CPU while scrolling.
    result['cpuLoad'] = round((ui + web) / seconds, 2) if seconds else None
    threads = watch.threads_between(wall[0] / 1000, wall[1] / 1000)
    if threads:
        result['cpuThreadsMs'] = threads
    return result


def pump(until, timeout):
    """Runs the GTK main loop until `until()` is true or `timeout` seconds pass."""
    ctx = GLib.MainContext.default()
    end = time.monotonic() + timeout
    while not until():
        if time.monotonic() > end:
            return False
        ctx.iteration(False) or time.sleep(0.005)
    return True


class Page:
    def __init__(self, data_manager, probe, width, height, compositing):
        self.ctx = WebKit2.WebContext.new_with_website_data_manager(data_manager)
        self.ucm = WebKit2.UserContentManager()
        self.ucm.add_script(WebKit2.UserScript.new(probe, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
        extra = os.environ.get('BENCH_EXTRA_CSS')
        if extra:
            # Experiments only: a style sheet over the app's, to see what a rule costs.
            css = open(extra, encoding='utf-8').read()
            self.ucm.add_style_sheet(WebKit2.UserStyleSheet.new(css, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserStyleLevel.AUTHOR, None, None))
        # Sound may start without a click, as in the app (Tauri/wry asks for that).
        policies = WebKit2.WebsitePolicies(autoplay=WebKit2.AutoplayPolicy.ALLOW)
        self.view = WebKit2.WebView(web_context=self.ctx, user_content_manager=self.ucm, website_policies=policies)
        s = self.view.get_settings()
        s.set_media_playback_requires_user_gesture(False)
        s.set_enable_developer_extras(False)
        if compositing == 'on':
            s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        elif compositing == 'off':
            s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
        self.win = Gtk.Window()
        self.win.set_default_size(width, height)
        self.win.add(self.view)
        self.win.show_all()
        self.loaded = False
        self.view.connect('load-changed', self._on_load)

    def _on_load(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.loaded = True

    def open(self, url):
        self.loaded = False
        self.view.load_uri(url)
        if not pump(lambda: self.loaded, 60):
            raise RuntimeError(f'{url} lädt nicht')

    def js(self, code, timeout=30):
        box = {}

        def done(view, res, _data):
            try:
                v = view.evaluate_javascript_finish(res)
                box['v'] = None if v is None or v.is_undefined() or v.is_null() else v.to_string()
            except Exception as e:  # noqa: BLE001
                box['e'] = str(e)

        self.view.evaluate_javascript(code, -1, None, None, None, done, None)
        if not pump(lambda: 'v' in box or 'e' in box, timeout):
            raise RuntimeError(f'JavaScript antwortet nicht: {code[:60]}')
        if 'e' in box:
            raise RuntimeError(box['e'])
        return box['v']

    def bench(self, call, timeout=600):
        """Starts a __bench call that leaves its result in window.__benchResult and waits for it."""
        self.js(call)
        box = {}

        def poll():
            r = self.js('window.__benchResult || ""')
            if r:
                box['r'] = json.loads(r)
                return True
            return False

        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if poll():
                break
            pump(lambda: False, 0.2)
        if 'r' not in box:
            raise RuntimeError(f'keine Antwort: {call}')
        if 'error' in box['r']:
            raise RuntimeError(box['r']['error'])
        return box['r']['ok']

    def close(self):
        self.win.destroy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', action='append', required=True)
    ap.add_argument('--runs', type=int, default=3)
    ap.add_argument('--only', default='start,shelf,folder,player,import')
    ap.add_argument('--imports', type=int, default=1)
    ap.add_argument('--folder', type=int, default=14)
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=820)
    ap.add_argument('--compositing', default=os.environ.get('BENCH_WEBKIT_COMPOSITING', 'default'))
    a = ap.parse_args()
    probe = open(os.environ.get('BENCH_PROBE') or os.path.join(os.path.dirname(__file__), 'probe.js'), encoding='utf-8').read()
    only = a.only.split(',')
    targets = [t.split('=', 1) for t in a.target]
    managers = {}
    profiles = []
    print(f'WebKitGTK {WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}, Compositing {a.compositing}', flush=True)
    for label, url in targets:
        # One profile per version, in a fresh folder (WebKit keeps no files in IndexedDB of an in-memory profile).
        base = os.path.join(os.environ.get('BENCH_TMP', '/tmp/tonuino-bench'), f'webkit-profile-{label}')
        shutil.rmtree(base, ignore_errors=True)
        managers[label] = WebKit2.WebsiteDataManager(base_data_directory=os.path.join(base, 'data'), base_cache_directory=os.path.join(base, 'cache'))
        profiles.append(base)
        if os.environ.get('BENCH_NOCARD'):
            continue  # the start without a card
        p = Page(managers[label], probe, a.width, a.height, a.compositing)
        p.open(f'{url}__bench/blank.html')
        s = p.bench('window.__bench.setupInto()')
        print(f'{label}: Karte eingerichtet ({s["files"]} Dateien)', flush=True)
        p.close()
    watch = CpuWatch()
    for r in range(a.runs + 1):
        for label, url in targets:
            p = Page(managers[label], probe, a.width, a.height, a.compositing)
            p.open(url)
            one = {'run': r, 'first': r == 0}
            for name in only:
                if name == 'import' and r <= a.runs - a.imports:
                    continue
                try:
                    opts = {'folder': a.folder, **json.loads(os.environ.get('BENCH_OPTS', '{}'))}
                    one[name] = add_cpu(p.bench(f'window.__bench.runInto({json.dumps(name)}, {json.dumps(opts)})'), watch)
                except Exception as e:  # noqa: BLE001
                    one[name] = {'error': str(e).split('\n')[0]}
            # Closed only when the app is done with its background work, as after a while of use.
            try:
                p.bench('window.__bench.runInto("settle", {})')
            except Exception:  # noqa: BLE001
                pass
            p.close()
            print('RESULT ' + json.dumps({'label': label, 'run': one}), flush=True)
    watch.stop()
    for base in profiles:
        shutil.rmtree(base, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
