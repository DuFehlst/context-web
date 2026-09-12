#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""context-web behavior-level walkthrough (#5).

Why this exists: the two real regressions of 2026-09-12 (a blank white screen and
a client bundle that still required the removed `dsh-client-runtime`) both passed
every unit test and only broke inside a real browser. This script drives a real
Chromium against a *running* `dsh web` and checks what unit tests cannot:

  E1  the top view switch opens the session-map overlay and its iframe loads
  E2  the map renders its shell, its cards, and the Markdown export entry
  E3  the conversation header exposes the registered `Agent 画布` view tab
  E4  `POST /context-web/api/threads/lookup` answers the slim lookup payload
  E5  `POST /context-web/api/sessions/sync` answers the trimmed acknowledgement
  E6  no context-web console errors while doing the above
  E7  the real map -> canvas jump: a card detail's「在 Agent 画布中打开」closes
      the map, switches the session, and leaves the Agent 画布 tab selected --
      driven from a card whose DSH session is NOT the one currently open, so a
      same-session no-op cannot pass it (E7a picks it, E7e polls the tab)

Notes that matter for interpreting the result:

* `app.js` / `styles.css` are read from disk per request, so front-end changes
  show up on reload; **host code (`index.js`) loads at `dsh web` boot**, so the
  E4/E5 shapes only appear after a restart. Both are reported explicitly.
* The shell is gated by a per-process launch token (`dsh web` prints it as
  `http://host:port/?token=...`); `--api-only` needs no token, the browser half
  does. The token is random per process and is not recoverable afterwards.
* E5 posts empty session metadata, which the store treats as a no-op state and
  saves unchanged -- it is the only endpoint check that touches the live server
  state, and it does not change any task/canvas data.

Usage:
  python test/e2e/walkthrough.py --api-only
  python test/e2e/walkthrough.py --token=<token from the URL dsh web printed>
  CONTEXT_WEB_URL=http://127.0.0.1:3099 python test/e2e/walkthrough.py --headed

Exit code 0 = every check passed (skips allowed); 1 = at least one [FAIL].
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


def skip(name, detail=''):
    print('[SKIP] %s%s' % (name, '' if detail == '' else ' -- ' + detail), flush=True)


def info(message):
    print('[INFO] %s' % message, flush=True)


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


def launch(play):
    attempts = [{'headless': True, 'channel': 'chromium'}, {'headless': True}, {'headless': False}]
    if HEADED:
        attempts = [{'headless': False}, {'headless': True, 'channel': 'chromium'}, {'headless': True}]
    last_error = None
    for options in attempts:
        try:
            browser = play.chromium.launch(**options)
            info('chromium launched with %s' % options)
            return browser
        except Exception as error:  # missing binary for this channel/mode
            last_error = error
    check('E0 chromium launch', False, '%s -- fix with: python -m playwright install chromium' % last_error)
    return None


def canvas_tab_locator(page):
    """The conversation header's tablist carries a hashed CSS-module class
    (`wSkVaW_tabs`), so locate the tab by role + label text, never by class."""
    tabs = page.locator('[role="tab"]')
    for index in range(tabs.count()):
        candidate = tabs.nth(index)
        if candidate.inner_text().strip() in CANVAS_TAB_LABELS:
            return candidate
    return None


def tab_labels(page):
    tabs = page.locator('[role="tab"]')
    return [tabs.nth(index).inner_text().strip() for index in range(tabs.count())]


def run_browser_checks(play):
    browser = launch(play)
    if browser is None:
        return
    os.makedirs(ARTIFACTS, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    context = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

    try:
        entry = '%s/?token=%s' % (URL, TOKEN) if TOKEN != '' else URL
        try:
            page.goto(entry, wait_until='domcontentloaded', timeout=30_000)
        except Exception as error:
            check('E0 open %s' % URL, False, '%s -- start the GUI (dsh web) or set CONTEXT_WEB_URL' % error)
            return

        if 'authentication required' in page.content():
            page.screenshot(path=os.path.join(ARTIFACTS, 'unauthorized-%s.png' % stamp))
            check('E0 the web shell is authenticated', False,
                  'pass --token=<token from the URL dsh web printed> (or CONTEXT_WEB_TOKEN)')
            return

        # E1 -- wait for the client plugin to boot, then open the map overlay.
        booted = True
        try:
            page.locator('.context-web-switch button[data-view="map"]').wait_for(state='visible', timeout=20_000)
        except Exception as error:
            booted = False
            check('E1a view switch is mounted', False, str(error).splitlines()[0])
        if booted:
            check('E1a view switch is mounted', True)
            page.locator('.context-web-switch button[data-view="map"]').click()
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
                cards = frame.locator('.thread-card')
                if cards.count() > 0:
                    check('E2b cards render for a non-empty workspace', True, '%d card(s)' % cards.count())
                    check('E2c Markdown export entry is offered',
                          frame.locator('.canvas-controls button[data-action="export-markdown"]').count() == 1)
                else:
                    skip('E2b cards render for a non-empty workspace', 'selected workspace has no cards')

                page.screenshot(path=os.path.join(ARTIFACTS, 'map-%s.png' % stamp))

                # E3/E7 -- the map -> canvas jump. The tablist sits under the
                # full-viewport overlay, so close the map first (which the jump
                # itself does) and then look at the conversation header.
                if cards.count() > 0:
                    # Pick a card that belongs to a DIFFERENT DSH session than the
                    # one currently open: a same-session jump would pass trivially
                    # and is exactly the case the map -> canvas fix must handle.
                    # FrameLocator only resolves locators; JS evaluation needs the
                    # real Frame, taken from the iframe element handle.
                    frame_obj = page.locator('.context-web-overlay iframe').element_handle().content_frame()
                    current_session = frame_obj.evaluate('() => (typeof state === "undefined" ? null : (state.currentDsh?.id ?? null))')
                    other = frame_obj.evaluate(
                        '() => { if (typeof state === "undefined" || state.workspace === null) return null;'
                        ' const current = state.currentDsh?.id ?? null;'
                        ' const thread = (state.workspace.threads ?? []).find(t => t.dshSessionId !== null && t.dshSessionId !== current && (t.messages ?? []).length > 0);'
                        ' return thread === undefined ? null : { threadId: thread.id, sessionId: thread.dshSessionId }; }')
                    if other is None:
                        skip('E7 map -> canvas jump', 'no card outside the currently open session')
                    else:
                        check('E7a the jump targets a different session than the open one',
                              other['sessionId'] != current_session, 'open=%s target=%s' % (current_session, other['sessionId']))
                        card = frame.locator('.thread-card[data-thread="%s"]' % other['threadId'])
                        if card.count() == 0:
                            check('E7b the target card is rendered', False, other['threadId'])
                        else:
                            # The card sits inside the full-viewport overlay iframe;
                            # Playwright's hit-testing can call it "outside of the
                            # viewport", so dispatch the click from inside the frame.
                            card.locator('[data-action="show-thread"]').first.evaluate('el => el.click()')
                            page.wait_for_timeout(400)
                            jump = frame.locator('[data-action="open-canvas"]').first
                            check('E7c the detail offers 在 Agent 画布中打开', jump.count() > 0)
                            if jump.count() > 0:
                                jump.evaluate('el => el.click()')
                                page.wait_for_timeout(3_000)
                                # 契约（2026-09-12 起）：跳转**绝不允许把用户丢在空态**。
                                # 成功时地图收起；失败时必须留在地图（旧写法先 close() 再验证，
                                # 切换没生效就把人留在「选择工作区开始」空页）。
                                closed = not page.locator('.context-web-overlay').is_visible()
                                stranded = closed and (
                                    page.locator('[role="tab"]').count() == 0
                                    and '选择工作区' in page.inner_text('body')
                                )
                                check('E7d the jump never strands the user', not stranded,
                                      'map closed with no session open' if stranded else ('closed' if closed else 'map kept open'))
                                # Poll instead of a fixed wait: the bridge itself
                                # converges within ~2 s (40 rounds of 50 ms).
                                selected = False
                                for _ in range(30):
                                    tab = canvas_tab_locator(page)
                                    if tab is not None and tab.get_attribute('aria-selected') == 'true':
                                        selected = True
                                        break
                                    page.wait_for_timeout(250)
                                check('E7e the Agent 画布 tab ends up selected', selected, 'tabs: %s' % tab_labels(page))
                else:
                    skip('E7 map -> canvas jump', 'no card to open')
                    page.locator('.context-web-switch button[data-view="dialog"]').click()
                    page.wait_for_timeout(400)
                    check('E3a Agent 画布 tab is registered', canvas_tab_locator(page) is not None,
                          'tabs: %s' % tab_labels(page))
    except Exception as error:  # never surface a traceback where a [FAIL] belongs
        check('E-browser walkthrough completed', False, '%s: %s' % (type(error).__name__, error))
    finally:
        plugin_errors = [text for text in console_errors if 'context-web' in text.lower()]
        if plugin_errors:
            check('E6 no context-web console errors', False, ' | '.join(plugin_errors[:3]))
        else:
            check('E6 no context-web console errors', True,
                  ('%d unrelated console error(s) ignored' % len(console_errors)) if console_errors else '')
        try:
            page.screenshot(path=os.path.join(ARTIFACTS, 'final-%s.png' % stamp))
        except Exception:
            pass
        context.close()
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
