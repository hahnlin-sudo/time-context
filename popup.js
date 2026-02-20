const DEFAULTS = {
  enabled: true,
  lastInjectedContext: "",
  lastInjectedAt: "",
  lastInjectedSite: ""
};

const toggle = document.getElementById("enabledToggle");
const previewText = document.getElementById("previewText");

initializePopup();

function initializePopup() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    const settings = {
      ...DEFAULTS,
      ...stored
    };

    toggle.checked = Boolean(settings.enabled);
    renderPreview(settings.enabled, settings.lastInjectedContext);
  });

  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    chrome.storage.sync.set({ enabled }, () => {
      renderPreview(enabled, "");
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
      const enabled = Boolean(changes.enabled.newValue);
      toggle.checked = enabled;
      renderPreview(enabled, "");
    }

    if (Object.prototype.hasOwnProperty.call(changes, "lastInjectedContext")) {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        const enabled = Boolean(stored.enabled);
        renderPreview(enabled, stored.lastInjectedContext || "");
      });
    }
  });

  window.setInterval(() => {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      renderPreview(Boolean(stored.enabled), stored.lastInjectedContext || "");
    });
  }, 30000);
}

function renderPreview(enabled, lastInjectedContext) {
  if (!enabled) {
    previewText.textContent = "Injection is disabled.";
    return;
  }

  const preview = buildTimeContextString(new Date());

  if (lastInjectedContext && lastInjectedContext.startsWith("[Time Context:")) {
    previewText.textContent = preview;
    return;
  }

  previewText.textContent = preview;
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
