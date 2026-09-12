#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""context-web behavior-level walkthrough (#5).

Why this exists: the two real regressions of 2026-09-12 (a blank white screen and
a client bundle that still required the removed `dsh-client-runtime`) both passed
every unit test and only broke inside a real browser. This script drives a real
Chromium against a *running* `dsh web` and checks what unit tests cannot:

  E1  the top view switch opens the session-map overlay and its iframe loads
  E2  the map renders its shell, its cards, and the Markdown export entry
  E3  the conversation header exposes the registered `Agent 画布` view tab, and
      clicking it selects it (exactly the path the map -> canvas jump uses)
  E4  `POST /context-web/api/threads/lookup` answers the slim lookup payload
  E5  `POST /context-web/api/sessions/sync` answers the trimmed acknowledgement
  E6  no browser console errors while doing the above

Usage:
  python test/e2e/walkthrough.py --api-only        # endpoints only, no token
  python test/e2e/walkthrough.py --token=<launch token from the URL dsh web printed>
  CONTEXT_WEB_URL=http://127.0.0.1:3099 python test/e2e/walkthrough.py --headed

Exit code 0 = every check passed; 1 = at least one [FAIL].
It attaches to an already-running server on purpose: booting a second `dsh web`
shares the same profile, and context-web explicitly warns that two writers
clobber each other's canvas data.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = os.environ.get('CONTEXT_WEB_URL', 'http://127.0.0.1:3080').rstrip('/')
# `dsh web` gates the shell behind a per-process launch token that it prints as
# `http://host:port/?token=...`; pass it to let the walkthrough mint the browser
# cookie. The plugin's own /context-web/api routes sit outside that fence, so
# --api-only needs no token.
TOKEN = os.environ.get('CONTEXT_WEB_TOKEN', '')
for argument in sys.argv:
    if argument.startswith('--token='):
        TOKEN = argument.split('=', 1)[1]
HEADED = '--headed' in sys.argv
API_ONLY = '--api-only' in sys.argv
ARTIFACTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'artifacts')
CANVAS_TAB_LABELS = ('Agent 画布', 'Agent Canvas')

# Windows consoles default to GBK, which cannot encode the tab labels below.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print('[%s] %s%s' % ('PASS' if ok else 'FAIL', name, '' if detail == '' else ' -- ' + detail), flush=True)
    return bool(ok)


def http_post(path, payload, timeout=20):
    request = urllib.request.Request(
        URL + path,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode('utf-8'))


def run_api_checks():
    """E4/E5: the two slimmed endpoints the map now depends on."""
    try:
        status, body = http_post('/context-web/api/threads/lookup', {'sessionIds': []})
        check('E4a threads/lookup accepts an empty list', status == 200 and body.get('threads') == [], json.dumps(body)[:120])
    except urllib.error.HTTPError as error:
        check('E4a threads/lookup accepts an empty list', False,
              'HTTP %s%s' % (error.code, ' -- the running dsh web predates this change; restart it' if error.code == 404 else ''))
    except Exception as error:
        check('E4a threads/lookup accepts an empty list', False, str(error))

    try:
        http_post('/context-web/api/threads/lookup', {'sessionIds': 'not-a-list'})
        check('E4b threads/lookup rejects a malformed argument', False, 'expected HTTP 400')
    except urllib.error.HTTPError as error:
        check('E4b threads/lookup rejects a malformed argument', error.code == 400, 'HTTP %s' % error.code)
    except Exception as error:
        check('E4b threads/lookup rejects a malformed argument', False, str(error))

    try:
        status, body = http_post('/context-web/api/sessions/sync', {'sessions': [], 'removedSessionIds': []})
        ok = status == 200 and body.get('synced') is True and 'workspaces' not in body
        hint = '' if ok else ' -- still the pre-change shape; restart the running dsh web'
        check('E5 sessions/sync answers a trimmed acknowledgement', ok, json.dumps(body)[:120] + hint)
    except Exception as error:
        check('E5 sessions/sync answers a trimmed acknowledgement', False, str(error))


def run_browser_checks(play):
    browser = None
    attempts = [{'headless': True, 'channel': 'chromium'}, {'headless': True}, {'headless': False}]
    if HEADED:
        attempts = [{'headless': False}, {'headless': True, 'channel': 'chromium'}, {'headless': True}]
    last_error = None
    for options in attempts:
        try:
            browser = play.chromium.launch(**options)
            print('[INFO] chromium launched with %s' % options, flush=True)
            break
        except Exception as error:  # missing binary for this channel/mode
            last_error = error
    if browser is None:
        check('E0 chromium launch', False, '%s -- fix with: python -m playwright install chromium' % last_error)
        return

    os.makedirs(ARTIFACTS, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

    entry = '%s/?token=%s' % (URL, TOKEN) if TOKEN != '' else URL
    try:
        page.goto(entry, wait_until='domcontentloaded', timeout=30_000)
    except Exception as error:
        check('E0 open %s' % URL, False, '%s -- start the GUI (dsh web) or set CONTEXT_WEB_URL' % error)
        browser.close()
        return

    if 'authentication required' in page.content():
        detail = 'pass --token=<token from the URL dsh web printed> (or CONTEXT_WEB_TOKEN)'
        check('E0 the web shell is authenticated', False, detail)
        page.screenshot(path=os.path.join(ARTIFACTS, 'unauthorized-%s.png' % stamp))
        browser.close()
        return

    map_button = page.locator('.context-web-switch button[data-view="map"]')
    check('E1a view switch is mounted', map_button.count() == 1, 'button[data-view="map"]')
    if map_button.count() == 1:
        map_button.click()
        page.locator('.context-web-overlay iframe').wait_for(state='attached', timeout=10_000)
        page.wait_for_timeout(1_500)
        check('E1b map overlay becomes visible', page.locator('.context-web-overlay').is_visible())

        frame = page.frame_locator('.context-web-overlay iframe')
        shell = frame.locator('.context-web-shell')
        try:
            shell.wait_for(state='attached', timeout=15_000)
            check('E2a map shell rendered inside the iframe', True)
        except Exception as error:
            check('E2a map shell rendered inside the iframe', False, str(error).splitlines()[0])

        if shell.count() > 0:
            threads = frame.locator('.thread-card')
            controls = frame.locator('.canvas-controls button[data-action="export-markdown"]')
            if threads.count() > 0:
                check('E2b cards render for a non-empty workspace', True, '%d card(s)' % threads.count())
                check('E2c Markdown export entry is offered', controls.count() == 1,
                      'app.js is served from disk, so this one needs only a page reload')
            else:
                check('E2b cards render for a non-empty workspace', True, 'workspace empty -- card assertions skipped')

            tabs = page.locator('.tabs [role="tab"]')
            labels = [tabs.nth(index).inner_text().strip() for index in range(tabs.count())]
            canvas_tab = None
            for index in range(tabs.count()):
                if tabs.nth(index).inner_text().strip() in CANVAS_TAB_LABELS:
                    canvas_tab = tabs.nth(index)
                    break
            check('E3a Agent 画布 tab is registered', canvas_tab is not None, 'tabs seen: %s' % labels)
            if canvas_tab is not None:
                canvas_tab.click()
                page.wait_for_timeout(600)
                check('E3b clicking the tab selects it', canvas_tab.get_attribute('aria-selected') == 'true')

        page.screenshot(path=os.path.join(ARTIFACTS, 'map-%s.png' % stamp))

    check('E6 no browser console errors', not console_errors, ' | '.join(console_errors[:3]))
    page.screenshot(path=os.path.join(ARTIFACTS, 'final-%s.png' % stamp))
    browser.close()


def main():
    if API_ONLY:
        run_api_checks()
    else:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            check('E0 playwright import', False,
                  'python -m pip install playwright && python -m playwright install chromium')
        else:
            with sync_playwright() as play:
                run_browser_checks(play)
        run_api_checks()

    failed = [name for name, ok, _ in results if not ok]
    print('\n%d checks, %d failed%s' % (len(results), len(failed), '' if not failed else ': ' + ', '.join(failed)), flush=True)
    if failed:
        print('note: E2c/E4/E5 need a dsh web started after this change (host code loads at boot).', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
