const ALARM_NAME = "yad2-poll";
const DEFAULT_URL = "https://www.yad2.co.il/vehicles/cars";
const STATE_KEY = "watcherState";
const SETTINGS_KEY = "watcherSettings";
const DEFAULT_SETTINGS = { searchUrl: DEFAULT_URL, pollMinutes: 15, enableNotifications: true, enableSound: false };

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || { tokens: [], listings: [], lastCheck: null, captchaStreak: 0, _seeded: false };
}
async function saveState(state) { await chrome.storage.local.set({ [STATE_KEY]: state }); }
async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}
async function saveSettings(settings) { await chrome.storage.local.set({ [SETTINGS_KEY]: settings }); }

async function fetchPage(url) {
  let win;
  try {
    win = await chrome.windows.create({
      url,
      type: "popup",
      state: "minimized",
      focused: false,
      left: -10000,
      top: -10000,
      width: 1024,
      height: 768,
    });
    const tabId = win?.tabs?.[0]?.id;
    if (!tabId) throw new Error("hidden window has no tab");
    try { return await pollTabForListings(tabId); }
    finally { try { await chrome.windows.remove(win.id); } catch {} }
  } catch (error) {
    if (win?.id) { try { await chrome.windows.remove(win.id); } catch {} }
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      return await pollTabForListings(tab.id);
    } finally {
      if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch {} }
    }
  }
}

async function pollTabForListings(tabId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await waitForTabComplete(tabId, 20000); } catch {}
    await sleep(attempt === 0 ? 4000 : 2500);
    try {
      const [response] = await chrome.scripting.executeScript({ target: { tabId }, func: extractFromPage });
      const result = response?.result;
      if (result?.ok) return result;
      if (["challenge-page", "no-listings-found", "no-listings-parsed"].includes(result?.reason)) continue;
      if (result) return result;
    } catch {}
  }
  return { ok: false, reason: "timeout" };
}

function extractFromPage() {
  const pageUrl = location.href;
  const pageTitle = document.title || "";
  const bodyText = document.body?.textContent || "";
  const debug = {
    pageUrl,
    pageTitle,
    hasNextData: !!document.getElementById("__NEXT_DATA__"),
    itemLinks: document.querySelectorAll('a[href*="item/"]').length,
    bodyLength: bodyText.length,
  };
  if (/Radware|ShieldSquare|Access Denied/i.test(`${pageTitle} ${bodyText.slice(0, 2000)}`)) {
    return { ok: false, reason: "challenge-page", debug };
  }

  const links = Array.from(document.querySelectorAll('a[href*="item/"]'));
  const listings = [];
  const seen = new Set();

  for (const link of links) {
    const href = link.getAttribute("href") || "";
    const match = href.match(/(?:^|\/)item\/([A-Za-z0-9_-]+)/i);
    if (!match) continue;
    const token = match[1];
    if (seen.has(token)) continue;
    seen.add(token);

    const card = link;
    const text = (card.textContent || "").replace(/\s+/g, " ").trim();
    const heading = card.querySelector("h1,h2,h3,[class*='title'],[class*='model']");

    // Extract year and hand from the pattern "2020   •   יד 2"
    const yearHandMatch = text.match(/\b(20\d{2})\s*[•·]\s*יד\s*(\d+)/);
    const year = yearHandMatch ? Number(yearHandMatch[1]) : null;
    const hand = yearHandMatch ? `יד ${yearHandMatch[2]}` : "?";

    // Extract price: look for the LAST occurrence (the actual price, not the discount)
    // Pattern: "יד X" followed by price
    let price = null;
    const allPrices = text.matchAll(/([\d,]+)\s*₪/g);
    for (const match of allPrices) {
      price = Number(match[1].replace(/,/g, ""));
    }

    // Extract km - look for number followed by km/ק״מ indicators
    const kmMatch = text.match(/([\d,]+)\s*(?:ק״מ|ק\"מ|קמ|km)\b/i);
    const km = kmMatch ? Number(kmMatch[1].replace(/,/g, "")) : null;

    // Extract engine info - look for pattern like "2.0" or "1.5" followed by כ"ס (horsepower)
    const engineMatch = text.match(/(\d+\.\d+|\d+)\s*\(\s*(\d+)\s*כ״ס/);
    const engine = engineMatch ? `${engineMatch[1]} (${engineMatch[2]} כ״ס)` : "?";

    const area = card.querySelector("[class*='area'],[class*='city'],[class*='location']");
    const image = card.querySelector("img");

    listings.push({
      token,
      price,
      year,
      hand,
      km,
      engine,
      submodel: "",
      model: heading?.textContent?.replace(/\s+/g, " ").trim() || "",
      area: area?.textContent?.replace(/\s+/g, " ").trim() || "?",
      city: "",
      createdAt: "",
      url: new URL(href, location.origin).href,
      image: image?.src || "",
    });
  }

  if (!listings.length) return { ok: false, reason: "no-listings-found", debug };
  return { ok: true, method: "dom", listings };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, tab) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve(tab);
    };
    const timer = setTimeout(() => finish(new Error("tab load timeout")), timeoutMs);
    const listener = (id, info, tab) => { if (id === tabId && info.status === "complete") finish(null, tab); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === "complete") finish(null, tab); }).catch(error => finish(error));
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sortByRecent(items) { return [...items]; }

async function pollOnce() {
  const settings = await getSettings();
  const state = await getState();
  let result;
  try { result = await fetchPage(settings.searchUrl || DEFAULT_URL); }
  catch (error) {
    state.lastCheck = Date.now();
    state.captchaStreak = (state.captchaStreak || 0) + 1;
    await saveState(state);
    await setBadgeError();
    return { ok: false, reason: "fetch-error", error: String(error) };
  }

  if (!result.ok || !result.listings?.length) {
    state.lastCheck = Date.now();
    state.captchaStreak = (state.captchaStreak || 0) + 1;
    await saveState(state);
    if (state.captchaStreak >= 5) await notify("Yad2 Watcher — בעיה", "לא הצלחתי לטעון מודעות במשך 5 בדיקות רצופות.");
    return { ok: false, reason: result.reason || "parse-error", captchaStreak: state.captchaStreak };
  }

  const listings = sortByRecent(result.listings);
  const known = new Set(state.tokens || []);
  const fresh = listings.filter(item => !known.has(item.token));
  state.tokens = listings.map(item => item.token);
  state.listings = listings;
  state.lastCheck = Date.now();
  state.captchaStreak = 0;

  if (!state._seeded) {
    state._seeded = true;
    await saveState(state);
    await setBadge(0);
    return { ok: true, seeded: true, count: listings.length, fresh: 0, method: result.method };
  }
  await saveState(state);
  await setBadge(fresh.length);
  if (fresh.length) await notifyNew(fresh, settings);
  return { ok: true, count: listings.length, fresh: fresh.length, method: result.method };
}

async function notifyNew(items, settings) {
  if (settings.enableNotifications === false) return;
  const title = items.length === 1 ? "מודעה חדשה ב-Yad2!" : `${items.length} מודעות חדשות ב-Yad2!`;
  const message = items.slice(0, 5).map(item => {
    const price = typeof item.price === "number" ? `₪${item.price.toLocaleString()}` : "₪?";
    return `• ${price} | ${item.year || "?"} | ${item.model || "רכב חדש"}`;
  }).join("\n") + (items.length > 5 ? `\n…ועוד ${items.length - 5}` : "");
  await notify(title, message);
}
function notify(title, message) {
  return chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2, requireInteraction: true });
}
async function setBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
}
async function setBadgeError() {
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
}
async function setupAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(1, Number(settings.pollMinutes) || 15) });
}

chrome.runtime.onInstalled.addListener(async () => { await setupAlarm(); if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });
chrome.runtime.onStartup.addListener(setupAlarm);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM_NAME) pollOnce().catch(console.error); });
chrome.notifications.onClicked.addListener(async () => { const state = await getState(); if (state.listings?.[0]?.url) chrome.tabs.create({ url: state.listings[0].url }); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "manual-poll") { pollOnce().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: String(error) })); return true; }
  if (message?.type === "get-state") { Promise.all([getState(), getSettings()]).then(([state, settings]) => sendResponse({ state, settings })); return true; }
  if (message?.type === "save-settings" || message?.type === "save-and-poll") {
    (async () => { await saveSettings(message.settings); await setupAlarm(); const result = message.type === "save-and-poll" ? await pollOnce() : null; sendResponse({ ok: true, result }); })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "reset-state") { saveState({ tokens: [], listings: [], lastCheck: null, captchaStreak: 0, _seeded: false }).then(() => setBadge(0)).then(() => sendResponse({ ok: true })); return true; }
});
setupAlarm();
