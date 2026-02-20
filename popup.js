const DEFAULTS = {
  enabled: true,
  lastInjectedContext: "",
  lastInjectedAt: "",
  lastInjectedSite: ""
};

const SUPPORTED_SITES = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "www.perplexity.ai": "Perplexity",
  "perplexity.ai": "Perplexity"
};

const toggle = document.getElementById("enabledToggle");
const previewText = document.getElementById("previewText");
const statusDot = document.getElementById("statusDot");
const siteStatus = document.getElementById("siteStatus");

let currentEnabled = true;
let liveInterval = null;

initializePopup();

function initializePopup() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    const settings = { ...DEFAULTS, ...stored };
    currentEnabled = Boolean(settings.enabled);
    toggle.checked = currentEnabled;
    updateUI();
  });

  toggle.addEventListener("change", () => {
    currentEnabled = toggle.checked;
    chrome.storage.sync.set({ enabled: currentEnabled });
    updateUI();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
      currentEnabled = Boolean(changes.enabled.newValue);
      toggle.checked = currentEnabled;
      updateUI();
    }
  });

  detectCurrentSite();
  startLivePreview();
}

function updateUI() {
  if (currentEnabled) {
    statusDot.classList.add("active");
  } else {
    statusDot.classList.remove("active");
  }
  renderPreview();
}

function renderPreview() {
  if (!currentEnabled) {
    previewText.textContent = "Injection paused";
    return;
  }
  previewText.textContent = buildTimeContextString(new Date());
}

function startLivePreview() {
  if (liveInterval) clearInterval(liveInterval);
  liveInterval = setInterval(() => {
    if (currentEnabled) {
      renderPreview();
    }
  }, 1000);
}

function detectCurrentSite() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].url) {
        setSiteStatus(null);
        return;
      }
      try {
        const url = new URL(tabs[0].url);
        const siteName = SUPPORTED_SITES[url.hostname] || null;
        setSiteStatus(siteName);
      } catch {
        setSiteStatus(null);
      }
    });
  } catch {
    setSiteStatus(null);
  }
}

function setSiteStatus(siteName) {
  const el = siteStatus.querySelector(".site-status-text");
  if (siteName) {
    el.textContent = `✓ Connected to ${siteName}`;
    el.classList.add("connected");
  } else {
    el.textContent = "— Not on a supported site";
    el.classList.remove("connected");
  }
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
    if (zonePart?.value) return zonePart.value;
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
}

function getUtcOffsetLabel(now) {
  const minutesEast = -now.getTimezoneOffset();
  const sign = minutesEast >= 0 ? "+" : "-";
  const absolute = Math.abs(minutesEast);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  if (minutes === 0) return `UTC${sign}${hours}`;
  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}
