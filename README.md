# LanguageTool Checker — a Google Chrome extension

An open-source replacement for the proprietary LanguageTool browser plugin.
It checks spelling, grammar and style in any editable text on a page: plain
`<textarea>`/`<input>` fields, editable blocks (`contenteditable` —
Confluence, Gmail, Outlook Web, Google Sites, etc.), including editors
inside `<iframe>`.

**Key difference from the official plugin:** the entire source code is
available for audit, the extension contains no telemetry and talks only to
a LanguageTool server whose address you choose (by default, local
`http://localhost:8081`). No data ever goes to third parties.

## Features

| Feature | Description |
|---|---|
| Checks any text field | textarea, input, contenteditable, iframe |
| Colored underlines | red — spelling, orange — grammar, blue — style |
| One-click fix | card with replacement options; the editor's undo stack is preserved |
| Automatic language detection | `language=auto` + `preferredVariants` |
| Mother tongue | `motherTongue` — rules for native speakers of another language |
| Picky mode | `level=picky` — more style suggestions |
| Personal dictionary | local word list, or server-side `/v2/words/add` (with username/apiKey) |
| Disabling rules | globally (settings) and on the current page (button in the card) |
| Disabled sites | list of hosts where checking is not performed |
| Turns off Chrome's built-in spell check | the checked field gets `spellcheck` disabled to avoid double underlines; the original value is restored when checking is disabled for the site or the page is closed |
| Error counter | badge on the extension icon for the active field |

Built on top of the public LanguageTool HTTP API (see `ApiV2.java` in the
`languagetool-server` module of the separate LanguageTool project:
https://github.com/languagetool-org/languagetool):

- `POST /v2/check` — check text (`text`, `language`, `motherTongue`,
  `preferredVariants`, `disabledRules`, `level`, `allowIncompleteResults`,
  `useragent`, `textSessionId`);
- `GET /v2/languages` — list of languages (for the settings picker);
- `GET /v2/maxtextlength` — maximum text length (longer text is trimmed
  from the end — the part you are editing is what gets checked);
- `GET /v2/info` — server availability check;
- `POST /v2/words/add` — server-side personal dictionary (optional).

## Installation

### 1. Start a LanguageTool server

Option A — build from the LanguageTool sources:

```bash
git clone https://github.com/languagetool-org/languagetool
cd languagetool
mvn -pl languagetool-standalone package -DskipTests
java -jar languagetool-standalone/target/languagetool-standalone*.jar --port 8081
```

Option B — ready-made release archive from languagetool.org (tested with
version 6.6):

```bash
wget https://languagetool.org/download/LanguageTool-stable.zip
unzip LanguageTool-stable.zip
java -cp LanguageTool-6.6/languagetool-server.jar org.languagetool.server.HTTPServer --port 8081
```

Option C — Docker:

```bash
docker run --rm -p 8081:8081 erdikoo/languagetool
```

Verify: `curl http://localhost:8081/v2/languages | head -c 200`.

### 2. Install the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the repository root (the directory
   containing `manifest.json`).
4. Open the extension settings, set the server address (if not local),
   click **Test connection** — Chrome will ask for access to the server
   address, allow it — then choose the language and save.
5. On the site you want to check, open the extension popup (toolbar icon)
   and enable **Check on this site** — Chrome will ask for access to the
   site; once confirmed, checking works immediately, without reloading
   the page.

### 3. Try it

Open `test-page.html` in your browser (or any page with a text field) and
start typing — underlines appear about 0.6 s after you pause. Click an
underline to see replacement suggestions.

For internal distribution, pack the extension (`chrome://extensions` →
**Pack extension**) and publish it as unlisted in the Chrome Web Store, or
distribute it via policy through `ExtensionInstallForcelist` with your own
signature (the latter is recommended for corporate environments).

## Architecture

```
┌──────────────┐  input (debounce 600ms)  ┌──────────────────┐
│ content.js   │─────────────────────────▶│ background.js    │
│ (per frame   │   chrome.runtime msg     │ (service worker) │
│  on a page)  │◀─────────────────────────│  POST /v2/check  │
└──────────────┘   JSON with matches      └────────┬─────────┘
      │                                             │ fetch (no CORS)
      │ underline overlay + card                    ▼
      │                                    your LanguageTool server
      └── editor DOM is NOT modified        http://localhost:8081
```

Key design decisions (important for a security audit):

1. **The editor DOM is not modified for highlighting.** Underlines are
   drawn in a separate overlay layer on top of the text (for
   contenteditable — via `Range.getClientRects()`, for textarea — via a
   measuring "mirror" element). This rules out breaking editors like
   Confluence and React applications.
2. **Networking happens only in the background worker**, and only to the
   address from the settings. The content script has no network access.
3. **Settings are stored** in `chrome.storage.local` (server, language,
   dictionary, disabled sites/rules). The username/apiKey credentials are
   optional, needed only for the server-side dictionary, and are stored
   under a separate `credentials` key; they are never passed to content
   scripts (the `getSettings`/`saveSettings` messages return them only to
   extension pages).
4. **Extension permissions:**
   - `storage` — settings;
   - `scripting` + `activeTab` — dynamic content-script registration and
     targeted injection into the active tab right after the permission is
     granted;
   - site access (`optional_host_permissions: http://*/*, https://*/*`)
     is granted **only with explicit user confirmation**: the
     **Check on this site** toggle in the popup asks Chrome for a host
     permission on the current site's origin. Until confirmed, the
     extension does not inject into the site and reads nothing; the access
     can be revoked via a link in the popup or in `chrome://extensions`
     → **Site access**;
   - access to the LanguageTool server address is requested when you
     click **Test connection** / **Save** in the settings — without it,
     the background worker cannot reach the server;
   - the content script is dynamically registered for all http/https
     pages and all frames (mail and wiki editors usually live in
     iframes), but it is actually injected only into origins with a
     granted permission.
5. **Text is sent to the server as is** (POST, form-urlencoded) — same
   as the official plugin; enable TLS on the server if needed
   (`languagetool-HTTPSServer`). A server address without a scheme is
   completed to `https://` (for `localhost`/`127.0.0.1` — to `http://`).
   If a remote server is set with `http://`, **text checking is blocked**
   until the user explicitly confirms plaintext transfer via a button in
   the settings; the confirmation is bound to the specific server address
   and is reset when it changes. The settings page and the popup show a
   warning about unencrypted transfer. Network requests do not follow
   HTTP redirects (`redirect: 'error'`).
6. **Chrome's built-in spell check is disabled** on the elements the
   extension handles (the `spellcheck="false"` attribute) to rule out
   double underlines. The original attribute value is restored when
   checking is disabled for the site or on page unload (`pagehide`). If
   the extension is disabled in `chrome://extensions` on an open tab, the
   attribute returns after the page is reloaded.
7. **"More info" links from the server response** (a rule's `rule.urls`)
   are opened only with `http:`/`https:` schemes — a compromised server
   cannot sneak in a `javascript:`/`data:` URL that would execute in the
   page context.

## Error position mapping

`/v2/check` returns `matches[].offset/length` relative to the submitted
plain text. The content script builds the same text model when walking
the DOM (block elements and `<br>` yield `\n`), so offsets map exactly to
DOM node positions. If the text is longer than `maxTextLength`, its tail
is checked, and the shift is accounted for when drawing.

## Limitations (MVP)

- Google Docs with its canvas editor is not supported (text there is not
  available as DOM/textarea);
- no on-the-fly autocorrection of typos (only on click);
- no paraphrasing/synonyms — those are premium features of the
  LanguageTool cloud, not part of the open server;
- personal statistics/"style guides" are intentionally absent.

## Development

- Syntax of all JS files can be checked with: `node --check src/**/*.js`.
- Icons are generated with: `python3 tools/gen_icons.py icons`.
- `test-page.html` — a page for manual testing of
  textarea/input/contenteditable.

## License

The extension code is distributed under the terms of the GNU Lesser
General Public License 2.1 (same as LanguageTool itself); the license
text is in the `LICENSE` file at the repository root.
