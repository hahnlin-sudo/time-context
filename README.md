# TimeContext Chrome Extension

TimeContext is a Manifest V3 Chrome extension that injects a fresh time context line into the first message of each new conversation on supported AI chat sites.

## 1) Load as an unpacked extension

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the folder: `timecontext-extension/`.
5. Confirm the extension appears as **TimeContext** and is enabled.

## 2) Test on each supported site

Supported sites:
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`
- `https://www.perplexity.ai/*`
- `https://perplexity.ai/*`

Testing flow for each site:
1. Open a supported site and start a **new conversation**.
2. Type a normal first message (for example: `Help me schedule my week`).
3. Send the message.
4. Verify the first sent message starts with a line like:
   - `[Time Context: Tuesday, February 18, 2026 — 4:06 PM EST (UTC-5)]`
5. Send a second message in the same conversation.
6. Verify the second message does **not** get an additional time context prefix.

## 3) Console checks to confirm injection

On a supported site, open DevTools Console and look for debug logs from the content script:

- `[TimeContext] Initialized on ...`
- `[TimeContext] Bound keydown listener to chat input.`
- `[TimeContext] Injected time context for ...`
- `[TimeContext] Conversation changed via navigation; injection flag reset.`

If you do not see logs, refresh the page after loading/reloading the extension in `chrome://extensions`.

## 4) Known edge cases and limitations

- AI sites frequently change their DOM structure; selector updates may be needed over time.
- On some UI variants, send-button detection can differ from keyboard submit behavior.
- If a site uses a highly custom editor surface, the fallback contenteditable logic may need site-specific tuning.
- The extension tracks "first message" using URL/navigation + new-conversation triggers. If a site starts a new thread without a detectable navigation or trigger, the reset may not happen until the next navigation event.
- Timezone abbreviation formatting is browser/locale dependent (for example `EST`, `GMT-5`, or regional variants).
