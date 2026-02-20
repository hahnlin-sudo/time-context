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
    gemini: {
      hosts: ["gemini.google.com"],
      inputSelectors: [
        "rich-textarea textarea",
        "textarea",
        "div[contenteditable='true'][role='textbox']",
        "div[contenteditable='true'][aria-label*='message' i]",
        "form [contenteditable='true']"
      ],
      sendButtonSelectors: [
        "button[aria-label*='Send message' i]",
        "button[aria-label*='Send' i]",
        "button[aria-label*='Submit' i]",
        "button[data-testid*='send' i]"
      ]
    },
    perplexity: {
      hosts: ["www.perplexity.ai", "perplexity.ai"],
      inputSelectors: [
        "textarea[placeholder*='Ask' i]",
        "textarea",
        "div[contenteditable='true'][role='textbox']",
        "div.ProseMirror[contenteditable='true']",
        "form [contenteditable='true']"
      ],
      sendButtonSelectors: [
        "button[aria-label*='Send' i]",
        "button[title*='Send' i]",
        "button[data-testid*='send' i]",
        "button[data-testid*='submit' i]"
      ]
    }
  };

  const siteKey = detectSiteKey();
  if (!siteKey) {
    return;
  }

  const siteConfig = SITE_CONFIGS[siteKey];
  const LOG_PREFIX = "[TimeContext]";
  const CONTEXT_PREFIX = "[Time Context:";

  let extensionEnabled = true;
  let hasInjectedForConversation = shouldAssumeContextAlreadyPresentByRoute();
  let currentConversationKey = buildConversationKey();
  let lastKnownUrl = location.href;
  let trackedInput = null;
  let domObserver = null;
  let urlPollHandle = null;

  initialize();

  function initialize() {
    chrome.storage.sync.get(STORAGE_DEFAULTS, (stored) => {
      extensionEnabled = Boolean(stored.enabled);
      installNavigationHooks();
      installDocumentObserver();
      installClickHandler();
      installSubmitHandler();
      installStorageWatcher();
      bindToInputIfPresent();
      log(`Initialized on ${siteKey}. Enabled=${extensionEnabled}. PreMarked=${hasInjectedForConversation}`);
    });
  }

  function detectSiteKey() {
    const host = location.hostname;
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      if (config.hosts.includes(host)) {
        return key;
      }
    }
    return null;
  }

  function shouldAssumeContextAlreadyPresentByRoute() {
    const path = location.pathname;

    if (siteKey === "chatgpt") {
      return /^\/c\/[a-z0-9-]+/i.test(path);
    }

    if (siteKey === "claude") {
      return /^\/chat\/[a-z0-9-]+/i.test(path);
    }

    return false;
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

    // Fallback for SPA router changes not surfaced through wrapped history.
    urlPollHandle = window.setInterval(() => {
      if (location.href !== lastKnownUrl) {
        dispatchUrlChange();
      }
    }, 800);
  }

  function handleUrlChange() {
    if (location.href === lastKnownUrl) {
      return;
    }

    lastKnownUrl = location.href;
    const nextConversationKey = buildConversationKey();
    if (nextConversationKey !== currentConversationKey) {
      currentConversationKey = nextConversationKey;
      hasInjectedForConversation = shouldAssumeContextAlreadyPresentByRoute();
      if (!hasInjectedForConversation) {
        log("Conversation changed via navigation; injection flag reset.");
      } else {
        log("Conversation changed via navigation; existing-thread heuristic pre-marked injected.");
      }
    }

    bindToInputIfPresent();
  }

  function installDocumentObserver() {
    domObserver = new MutationObserver(() => {
      bindToInputIfPresent();
    });

    const root = document.body || document.documentElement;
    if (root) {
      domObserver.observe(root, {
        childList: true,
        subtree: true
      });
    }
  }

  function installClickHandler() {
    document.addEventListener(
      "click",
      (event) => {
        if (isNewConversationTrigger(event.target)) {
          hasInjectedForConversation = false;
          currentConversationKey = buildConversationKey();
          log("New conversation trigger clicked; injection flag reset.");
          return;
        }

        if (!extensionEnabled || hasInjectedForConversation) {
          return;
        }

        if (!isSendButton(event.target)) {
          return;
        }

        const input = getInputNearTarget(event.target) || getPreferredInput();
        if (!input) {
          return;
        }

        injectContextIfNeeded(input);
      },
      true
    );
  }

  function installSubmitHandler() {
    document.addEventListener(
      "submit",
      (event) => {
        if (!extensionEnabled || hasInjectedForConversation) {
          return;
        }

        const form = event.target instanceof HTMLFormElement ? event.target : null;
        const input = getInputFromRoot(form) || getPreferredInput();
        if (!input) {
          return;
        }

        injectContextIfNeeded(input);
      },
      true
    );
  }

  function installStorageWatcher() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

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
    if (!nextInput) {
      return;
    }

    if (trackedInput === nextInput) {
      return;
    }

    if (trackedInput) {
      trackedInput.removeEventListener("keydown", onInputKeydown, true);
    }

    trackedInput = nextInput;
    trackedInput.addEventListener("keydown", onInputKeydown, true);
    log("Bound keydown listener to chat input.");
  }

  function onInputKeydown(event) {
    if (!extensionEnabled || hasInjectedForConversation) {
      return;
    }

    if (!isSubmitKey(event)) {
      return;
    }

    const input = event.currentTarget;
    injectContextIfNeeded(input);
  }

  function isSubmitKey(event) {
    if (event.key !== "Enter") {
      return false;
    }

    if (event.isComposing) {
      return false;
    }

    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return false;
    }

    return true;
  }

  function isSendButton(target) {
    const button = target?.closest?.("button, [role='button']");
    if (!button) {
      return false;
    }

    if (button.matches("[disabled], [aria-disabled='true']")) {
      return false;
    }

    if (siteConfig.sendButtonSelectors.some((selector) => button.matches(selector))) {
      return true;
    }

    const metadata = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || "",
      button.getAttribute("data-testid") || "",
      button.getAttribute("data-icon") || "",
      button.textContent || ""
    ]
      .join(" ")
      .toLowerCase();

    return metadata.includes("send") || metadata.includes("submit");
  }

  function isNewConversationTrigger(target) {
    const candidate = target?.closest?.("a, button, [role='button']");
    if (!candidate) {
      return false;
    }

    const metadata = [
      candidate.getAttribute("aria-label") || "",
      candidate.getAttribute("title") || "",
      candidate.getAttribute("data-testid") || "",
      candidate.textContent || ""
    ]
      .join(" ")
      .toLowerCase();

    if (
      metadata.includes("new chat") ||
      metadata.includes("start new chat") ||
      metadata.includes("new conversation") ||
      metadata.includes("new thread") ||
      metadata.includes("new topic")
    ) {
      return true;
    }

    if (candidate.tagName === "A") {
      const href = (candidate.getAttribute("href") || "").toLowerCase();
      if (href === "/" || href === "/new" || href.startsWith("/new") || href.includes("new-chat")) {
        return true;
      }
    }

    return false;
  }

  function injectContextIfNeeded(inputElement) {
    if (!inputElement) {
      return false;
    }

    const currentText = readInputText(inputElement);
    if (!currentText.trim()) {
      return false;
    }

    if (currentText.trimStart().startsWith(CONTEXT_PREFIX)) {
      hasInjectedForConversation = true;
      return false;
    }

    const contextLine = buildTimeContextString(new Date());
    const nextText = `${contextLine}\n${currentText}`;
    writeInputText(inputElement, nextText);

    hasInjectedForConversation = true;

    chrome.storage.sync.set({
      lastInjectedContext: contextLine,
      lastInjectedAt: new Date().toISOString(),
      lastInjectedSite: siteKey
    });

    log(`Injected time context for ${currentConversationKey}: ${contextLine}`);
    return true;
  }

  function buildConversationKey() {
    const path = `${location.pathname}${location.search}${location.hash}`;
    return `${siteKey}:${path}`;
  }

  function findInputElement() {
    for (const selector of siteConfig.inputSelectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (isUsableInput(node)) {
          return node;
        }
      }
    }

    const active = document.activeElement;
    if (isUsableInput(active)) {
      return active;
    }

    const fallbackNodes = document.querySelectorAll("textarea, div[contenteditable='true'], div.ProseMirror[contenteditable='true']");
    for (const node of fallbackNodes) {
      if (isUsableInput(node)) {
        return node;
      }
    }

    return null;
  }

  function getPreferredInput() {
    if (isUsableInput(trackedInput)) {
      return trackedInput;
    }

    return findInputElement();
  }

  function getInputNearTarget(target) {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const root =
      target.closest("form") ||
      target.closest("[data-testid*='composer' i]") ||
      target.closest("[class*='composer' i]") ||
      target.closest("[class*='input' i]");

    return getInputFromRoot(root);
  }

  function getInputFromRoot(root) {
    if (!(root instanceof HTMLElement || root instanceof HTMLFormElement)) {
      return null;
    }

    for (const selector of siteConfig.inputSelectors) {
      const candidate = root.querySelector(selector);
      if (isUsableInput(candidate)) {
        return candidate;
      }
    }

    const fallback = root.querySelector("textarea, div[contenteditable='true'], div.ProseMirror[contenteditable='true']");
    return isUsableInput(fallback) ? fallback : null;
  }

  function isUsableInput(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (!element.isConnected) {
      return false;
    }

    if (element.matches("[disabled], [readonly], [aria-hidden='true']")) {
      return false;
    }

    if (element.matches("input[type='search'], input[type='email'], input[type='password']")) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    const computed = window.getComputedStyle(element);
    if (computed.visibility === "hidden" || computed.display === "none") {
      return false;
    }

    if (element.tagName === "TEXTAREA") {
      return true;
    }

    if (element.tagName === "INPUT") {
      const input = element;
      return input.type === "text" || input.type === "";
    }

    return element.isContentEditable;
  }

  function readInputText(element) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value || "";
    }

    return element.innerText || element.textContent || "";
  }

  function writeInputText(element, nextText) {
    if (element instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      descriptor?.set?.call(element, nextText);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
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
      return;
    }

    const nativeTextContentSetter = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "textContent")?.set;
    nativeTextContentSetter?.call(element, nextText);

    try {
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: nextText
        })
      );
    } catch (_error) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
    placeCursorAtEnd(element);
  }

  function placeCursorAtEnd(element) {
    element.focus();

    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
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
      const zonePart = parts.find((part) => part.type === "timeZoneName");
      if (zonePart?.value) {
        return zonePart.value;
      }
    } catch (_error) {
      // Fallback below.
    }

    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  }

  function getUtcOffsetLabel(now) {
    const minutesEast = -now.getTimezoneOffset();
    const sign = minutesEast >= 0 ? "+" : "-";
    const absolute = Math.abs(minutesEast);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;

    if (minutes === 0) {
      return `UTC${sign}${hours}`;
    }

    return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
  }

  function log(message) {
    console.debug(`${LOG_PREFIX} ${message}`);
  }
})();
