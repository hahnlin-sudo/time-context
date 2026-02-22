(() => {
  const STORAGE_DEFAULTS = {
    enabled: true,
    lastInjectedContext: "",
    lastInjectedAt: "",
    lastInjectedSite: ""
  };

  const SITE_CONFIGS = {
    chatgpt: {
      hosts: ["chatgpt.com", "chat.openai.com"],
      inputSelectors: [
        "textarea[data-testid='prompt-textarea']",
        "#prompt-textarea",
        "main [contenteditable='true'][role='textbox']",
        "form [contenteditable='true'][translate='no']",
        "div.ProseMirror[contenteditable='true']",
        "form [contenteditable='true']",
        "textarea"
      ],
      sendButtonSelectors: [
        "button[data-testid='send-button']",
        "button[data-testid='fruitjuice-send-button']",
        "button[data-testid*='send' i]",
        "button[aria-label*='Send' i]",
        "button[title*='Send' i]"
      ]
    },
    claude: {
      hosts: ["claude.ai"],
      inputSelectors: [
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true'][data-lexical-editor='true']",
        "div.ProseMirror[contenteditable='true']",
        "form [contenteditable='true']",
        "textarea"
      ],
      sendButtonSelectors: [
        "button[aria-label*='Send' i]",
        "button[title*='Send' i]",
        "button[data-testid*='send' i]",
        "button[data-testid*='submit' i]"
      ]
    },
  };

  const siteKey = detectSiteKey();
  if (!siteKey) {
    return;
  }

  const siteConfig = SITE_CONFIGS[siteKey];
  const LOG_PREFIX = "[TimeContext]";
  const CONTEXT_PREFIX = "[Time Context:";

  let extensionEnabled = true;
  let lastKnownUrl = location.href;
  let trackedInput = null;
  let domObserver = null;
  let urlPollHandle = null;
  let isReinjecting = false; // flag to avoid infinite loop on re-triggered sends

  // Install listeners synchronously
  installNavigationHooks();
  installDocumentObserver();
  installClickHandler();
  installSubmitHandler();
  installStorageWatcher();
  bindToInputIfPresent();

  chrome.storage.sync.get(STORAGE_DEFAULTS, (stored) => {
    extensionEnabled = Boolean(stored.enabled);
    bindToInputIfPresent();
    log(`Initialized on ${siteKey}. Enabled=${extensionEnabled}. Injecting every message.`);
  });

  function detectSiteKey() {
    const host = location.hostname;
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      if (config.hosts.includes(host)) {
        return key;
      }
    }
    return null;
  }

  function installNavigationHooks() {
    const dispatchUrlChange = () => {
      window.dispatchEvent(new CustomEvent("timecontext:urlchange"));
    };

    const wrapHistoryMethod = (methodName) => {
      const original = history[methodName];
      history[methodName] = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        queueMicrotask(dispatchUrlChange);
        return result;
      };
    };

    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    window.addEventListener("popstate", dispatchUrlChange, true);
    window.addEventListener("hashchange", dispatchUrlChange, true);
    window.addEventListener("timecontext:urlchange", handleUrlChange, true);

    urlPollHandle = window.setInterval(() => {
      if (location.href !== lastKnownUrl) {
        dispatchUrlChange();
      }
    }, 800);
  }

  function handleUrlChange() {
    if (location.href === lastKnownUrl) return;
    lastKnownUrl = location.href;
    bindToInputIfPresent();
  }

  function installDocumentObserver() {
    domObserver = new MutationObserver(() => {
      bindToInputIfPresent();
    });
    const root = document.body || document.documentElement;
    if (root) {
      domObserver.observe(root, { childList: true, subtree: true });
    }
  }

  function installClickHandler() {
    document.addEventListener(
      "click",
      (event) => {
        if (!extensionEnabled || isReinjecting) return;
        if (!isSendButton(event.target)) return;

        const input = getInputNearTarget(event.target) || getPreferredInput();
        if (!input) return;

        if (needsInjection(input)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          injectAndResend(input, "click");
        }
      },
      true
    );
  }

  function installSubmitHandler() {
    document.addEventListener(
      "submit",
      (event) => {
        if (!extensionEnabled || isReinjecting) return;
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        const input = getInputFromRoot(form) || getPreferredInput();
        if (!input) return;

        if (needsInjection(input)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          injectAndResend(input, "submit");
        }
      },
      true
    );
  }

  function installStorageWatcher() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
        extensionEnabled = Boolean(changes.enabled.newValue);
        log(`Enabled state changed: ${extensionEnabled}`);
      }
    });

    window.addEventListener(
      "beforeunload",
      () => {
        if (urlPollHandle) {
          window.clearInterval(urlPollHandle);
          urlPollHandle = null;
        }
      },
      { once: true }
    );
  }

  function bindToInputIfPresent() {
    const nextInput = findInputElement();
    if (!nextInput || trackedInput === nextInput) return;

    if (trackedInput) {
      trackedInput.removeEventListener("keydown", onInputKeydown, true);
    }
    trackedInput = nextInput;
    trackedInput.addEventListener("keydown", onInputKeydown, true);
    log("Bound keydown listener to chat input.");
  }

  function onInputKeydown(event) {
    if (!extensionEnabled || isReinjecting) return;
    if (!isSubmitKey(event)) return;

    const input = event.currentTarget;
    if (needsInjection(input)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      injectAndResend(input, "enter");
    }
  }

  // ── Core injection logic ──

  function needsInjection(inputElement) {
    if (!inputElement) return false;
    const currentText = readInputText(inputElement);
    if (!currentText.trim()) return false;
    if (currentText.trimStart().startsWith(CONTEXT_PREFIX)) return false;
    return true;
  }

  function injectAndResend(inputElement, trigger) {
    const currentText = readInputText(inputElement);
    const contextLine = buildTimeContextString(new Date());
    const nextText = `${contextLine}\n${currentText}`;

    log(`Injecting (${trigger}): ${contextLine}`);

    writeInputText(inputElement, nextText, () => {
      // After text is written, re-trigger the send
      isReinjecting = true;

      if (trigger === "enter") {
        // Simulate Enter keypress
        const enterDown = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        inputElement.dispatchEvent(enterDown);
      } else if (trigger === "click") {
        // Click the send button
        const sendBtn = findSendButton();
        if (sendBtn) {
          sendBtn.click();
        }
      }

      // Reset flag after a tick
      setTimeout(() => {
        isReinjecting = false;
      }, 100);

      chrome.storage.sync.set({
        lastInjectedContext: contextLine,
        lastInjectedAt: new Date().toISOString(),
        lastInjectedSite: siteKey
      });
    });
  }

  function findSendButton() {
    for (const selector of siteConfig.sendButtonSelectors) {
      const btn = document.querySelector(selector);
      if (btn && !btn.matches("[disabled], [aria-disabled='true']")) {
        return btn;
      }
    }
    return null;
  }

  // ── Text read/write ──

  function readInputText(element) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value || "";
    }
    return element.innerText || element.textContent || "";
  }

  function writeInputText(element, nextText, callback) {
    // ChatGPT: textarea — direct value set works fine
    if (element instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      descriptor?.set?.call(element, nextText);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
      if (callback) callback();
      return;
    }

    if (element instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      descriptor?.set?.call(element, nextText);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
      if (callback) callback();
      return;
    }

    // Contenteditable (Claude's Lexical editor):
    // Use clipboard API to paste — Lexical processes paste events properly.
    element.focus();

    // Select all existing content
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Try execCommand first (works in some editors)
    const execResult = document.execCommand("insertText", false, nextText);
    if (execResult && readInputText(element).trimStart().startsWith(CONTEXT_PREFIX)) {
      log("Wrote via execCommand insertText");
      placeCursorAtEnd(element);
      // Small delay to let the framework process the change
      if (callback) setTimeout(callback, 50);
      return;
    }

    // Fallback: use clipboard API to write + paste
    // Save current clipboard, write our text, trigger paste, restore clipboard
    writeViaClipboardPaste(element, nextText, callback);
  }

  function writeViaClipboardPaste(element, text, callback) {
    element.focus();

    // Select all
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Use the Clipboard API to write text, then trigger Ctrl+V
    navigator.clipboard.writeText(text).then(() => {
      // Dispatch a paste event with the data
      const dt = new DataTransfer();
      dt.setData("text/plain", text);

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });

      // Lexical listens for paste events
      element.dispatchEvent(pasteEvent);

      log("Wrote via clipboard paste");
      placeCursorAtEnd(element);

      // Give Lexical time to process the paste
      if (callback) setTimeout(callback, 100);
    }).catch((err) => {
      log(`Clipboard write failed: ${err}. Trying beforeinput fallback.`);
      writeViaBeforeInput(element, text, callback);
    });
  }

  function writeViaBeforeInput(element, text, callback) {
    element.focus();

    // Select all
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Lexical processes beforeinput events
    const dt = new DataTransfer();
    dt.setData("text/plain", text);

    try {
      const beforeInputEvent = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: text,
        dataTransfer: dt,
      });
      element.dispatchEvent(beforeInputEvent);

      const inputEvent = new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: text,
        dataTransfer: dt,
      });
      element.dispatchEvent(inputEvent);

      log("Wrote via beforeinput/input insertFromPaste");
    } catch (err) {
      log(`beforeinput fallback failed: ${err}`);
      // Absolute last resort
      element.textContent = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    placeCursorAtEnd(element);
    if (callback) setTimeout(callback, 100);
  }

  // ── Helpers ──

  function placeCursorAtEnd(element) {
    element.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isSubmitKey(event) {
    return event.key === "Enter" && !event.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
  }

  function isSendButton(target) {
    const button = target?.closest?.("button, [role='button']");
    if (!button) return false;
    if (button.matches("[disabled], [aria-disabled='true']")) return false;

    if (siteConfig.sendButtonSelectors.some((s) => button.matches(s))) return true;

    const metadata = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || "",
      button.getAttribute("data-testid") || "",
      button.getAttribute("data-icon") || "",
      button.textContent || ""
    ].join(" ").toLowerCase();

    return metadata.includes("send") || metadata.includes("submit");
  }

  function findInputElement() {
    for (const selector of siteConfig.inputSelectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (isUsableInput(node)) return node;
      }
    }
    const active = document.activeElement;
    if (isUsableInput(active)) return active;

    const fallback = document.querySelectorAll("textarea, div[contenteditable='true'], div.ProseMirror[contenteditable='true']");
    for (const node of fallback) {
      if (isUsableInput(node)) return node;
    }
    return null;
  }

  function getPreferredInput() {
    return isUsableInput(trackedInput) ? trackedInput : findInputElement();
  }

  function getInputNearTarget(target) {
    if (!(target instanceof HTMLElement)) return null;
    const root =
      target.closest("form") ||
      target.closest("[data-testid*='composer' i]") ||
      target.closest("[class*='composer' i]") ||
      target.closest("[class*='input' i]");
    return getInputFromRoot(root);
  }

  function getInputFromRoot(root) {
    if (!(root instanceof HTMLElement || root instanceof HTMLFormElement)) return null;
    for (const selector of siteConfig.inputSelectors) {
      const candidate = root.querySelector(selector);
      if (isUsableInput(candidate)) return candidate;
    }
    const fallback = root.querySelector("textarea, div[contenteditable='true'], div.ProseMirror[contenteditable='true']");
    return isUsableInput(fallback) ? fallback : null;
  }

  function isUsableInput(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!element.isConnected) return false;
    if (element.matches("[disabled], [readonly], [aria-hidden='true']")) return false;
    if (element.matches("input[type='search'], input[type='email'], input[type='password']")) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const computed = window.getComputedStyle(element);
    if (computed.visibility === "hidden" || computed.display === "none") return false;
    if (element.tagName === "TEXTAREA") return true;
    if (element.tagName === "INPUT") return element.type === "text" || element.type === "";
    return element.isContentEditable;
  }

  function buildTimeContextString(now) {
    const day = now.toLocaleDateString(undefined, { weekday: "long" });
    const month = now.toLocaleDateString(undefined, { month: "long" });
    const date = now.toLocaleDateString(undefined, { day: "numeric" });
    const year = now.toLocaleDateString(undefined, { year: "numeric" });
    const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    const zoneAbbreviation = getTimeZoneAbbreviation(now);
    const utcOffset = getUtcOffsetLabel(now);
    return `[Time Context: ${day}, ${month} ${date}, ${year} — ${time} ${zoneAbbreviation} (${utcOffset})]`;
  }

  function getTimeZoneAbbreviation(now) {
    try {
      const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(now);
      const zonePart = parts.find((p) => p.type === "timeZoneName");
      if (zonePart?.value) return zonePart.value;
    } catch (_e) {}
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  }

  function getUtcOffsetLabel(now) {
    const minutesEast = -now.getTimezoneOffset();
    const sign = minutesEast >= 0 ? "+" : "-";
    const absolute = Math.abs(minutesEast);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
  }

  function log(message) {
    console.debug(`${LOG_PREFIX} ${message}`);
  }
})();
