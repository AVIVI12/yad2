// Yad2 Watcher — background service worker (MV3)
// Polls a saved Yad2 car search every 15 minutes, diffs listing tokens against
// what we've already seen, and pops a notification + badge for new ads.
//
// Yad2 fronts its pages with a Radware/ShieldSquare JS challenge. A raw fetch()
// from the service worker gets blocked because the challenge needs a real
// browser to run its JavaScript. Instead, we open a hidden tab, let the browser
// solve the challenge naturally, and inject a content script that extracts
// listings from the rendered page — first trying __NEXT_DATA__ JSON, then
// falling back to parsing the DOM cards directly.

const ALARM_NAME = "yad2-poll";
const POLL_MINUTES = 15;
const STATE_KEY = "watcherState";
const SETTINGS_KEY = "watcherSettings";

// Feed buckets that are recommendations, not results of the user's search.
const IGNORE_FEED_KEYS = new Set(["lookalike"]);

// ---------- defaults ----------

const DEFAULT_SETTINGS = {
  searchUrl: "",
  pollMinutes: 15,
  enableNotifications: true,
  enableSound: true,
};

// ---------- state ----------

async function getState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || { tokens: [], listings: [], lastCheck: null, captchaStreak: 0, _seeded: false };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---------- fetch via hidden window ----------

/**
 * Open a minimized (truly hidden) browser window, let Yad2's JS challenge
 * resolve naturally, then poll the page content until listings appear.
 * Tries __NEXT_DATA__ first, falls back to DOM card parsing.
 */
async function fetchPage(url) {
  let win;
  try {
    // Create the window off-screen so it never flashes on the user's display.
    // Using state: "minimized" still briefly shows the window before minimizing.
    win = await chrome.windows.create({
      url: "about:blank",
      type: "popup",
      state: "minimized",
      focused: false,
      width: 1,
      height: 1,
      left: -2000,
      top: -2000,
    });
    // Now navigate the tab to the real URL — the window is already hidden.
    const tabId = win.tabs[0].id;
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    // Fallback: try a plain inactive tab.
    let fallbackTab;
    try {
      fallbackTab = await chrome.tabs.create({ url, active: false });
      return await pollTabForListings(fallbackTab.id);
    } catch (e2) {
      throw new Error("cannot open tab or window: " + e2.message);
    } finally {
      if (fallbackTab?.id) {
        try {
          await chrome.tabs.remove(fallbackTab.id);
        } catch (e3) {
          // already closed
        }
      }
    }
  }

  const tabId = win?.tabs?.[0]?.id;
  const winId = win?.id;
  if (!tabId || !winId) {
    throw new Error("browser created no background window");
  }
  // Re-read tab to confirm it got the URL.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url === "about:blank") {
      await chrome.tabs.update(tabId, { url });
    }
  } catch (e) {
    // tab read failed — proceed anyway
    }

  try {
    return await pollTabForListings(tabId);
  } finally {
    try {
      await chrome.windows.remove(winId);
    } catch (e) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e2) {
        // already gone
      }
    }
  }
}

/**
 * Poll a tab's content repeatedly until listings are found or timeout.
 * The Radware challenge page redirects after a few seconds, and then
 * React needs time to render the listing cards.
 */
async function pollTabForListings(tabId) {
  const MAX_ATTEMPTS = 8;
  const POLL_INTERVAL = 2500;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Wait for the page to reach "complete" first (handles redirect).
    try {
      await waitForTabComplete(tabId, 20000);
    } catch (e) {
 // timeout — try extraction anyway
    }

    // Give the page time to render after load.
    await sleep(attempt === 0 ? 3000 : POLL_INTERVAL);

    let result;
    try {
      [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractFromPage,
      });
    } catch (e) {
      // Tab may have navigated during injection — try again next loop.
      console.warn(`[yad2-watcher] script injection attempt ${attempt + 1} failed:`, e.message);
      continue;
    }

    if (!result || !result.result) {
      continue;
    }

    const r = result.result;
    if (r.ok) {
      return r;
    }

    // If it's a challenge page, keep waiting — the redirect hasn't happened yet.
    if (r.reason === "challenge-page") {
      console.log(`[yad2-watcher] attempt ${attempt + 1}: still on challenge page, waiting…`);
      continue;
    }

    // If no listings found yet, keep polling — React may still be rendering.
    if (r.reason === "no-listings-found" || r.reason === "no-listings-parsed") {
      console.log(`[yad2-watcher] attempt ${attempt + 1}: no listings yet, waiting…`);
      continue;
    }

    // Any other error — return it.
    return r;
  }

  return { ok: false, reason: "timeout" };
}

/**
 * Runs in the page context. Tries __NEXT_DATA__ first, then DOM parsing.
 */
function extractFromPage() {
  const pageUrl = location.href;
  const pageTitle = document.title;

  // Check if we're still on a Radware challenge page.
  if (pageTitle.includes("Radware") || document.body?.textContent?.includes("ShieldSquare")) {
    return { ok: false, reason: "challenge-page", debug: { pageUrl, pageTitle } };
  }

  // Debug info for diagnostics.
  const debug = {
    pageUrl,
    pageTitle,
    linkCount: document.querySelectorAll("a").length,
    bodyLength: document.body?.textContent?.length || 0,
    hasNextData: !!document.getElementById("__NEXT_DATA__"),
  bodySnippet: (document.body?.textContent || "").slice(0, 300),
  itemLinks: document.querySelectorAll('a[href*="vehicles/item"]').length,
    itemLinks2: document.querySelectorAll('a[href*="/vehicles/item/"]').length,
  allHrefs: Array.from(document.querySelectorAll("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && h.includes("item"))
      .slice(0, 5),
  };

  // --- Approach 1: __NEXT_DATA__ JSON ---
  const nextDataEl = document.getElementById("__NEXT_DATA__");
  if (nextDataEl) {
    try {
      const json = nextDataEl.textContent;
      const data = JSON.parse(json);
      // Yad2 stores listings in dehydratedState.queries[].state.data.ads[]
      const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
      for (const q of queries) {
        const d = q?.state?.data;
        if (d && typeof d === "object" && Array.isArray(d.ads) && d.pagination) {
          return { ok: true, method: "nextdata", json };
        }
      }
    } catch (e) {
      // JSON parse failed, fall through to DOM
    }
  }

  // --- Approach 2: Parse rendered DOM cards ---
  // Yad2 renders each listing as a card with a link to /vehicles/item/{token}.
  // We find all such links and extract data from the surrounding card element.
  // Try multiple selectors — Yad2 may use different href formats.
  let links = document.querySelectorAll('a[href*="/vehicles/item/"]');
  if (links.length === 0) {
    links = document.querySelectorAll('a[href*="vehicles/item"]');
  }
  if (links.length === 0) {
    // Yad2 uses relative hrefs like "item/0tupynvy?..."
    links = document.querySelectorAll('a[href*="item/"]');
  }
  if (links.length === 0) {
    // Maybe the page uses onclick or data attributes instead of href.
    // Look for any element with a data-token or data-id attribute.
    const dataEls = document.querySelectorAll('[data-token], [data-id], [data-listing-id]');
    if (dataEls.length > 0) {
      links = dataEls;
    }
  }
  if (links.length === 0) {
    // Last resort: check if the page has any car-related content at all.
    const bodyText = document.body?.textContent || "";
    const hasPrice = /₪/.test(bodyText);
    const hasCarInfo = /יד\s*\d|שנתון|ק״מ|km/i.test(bodyText);
    if (!hasPrice && !hasCarInfo) {
      return { ok: false, reason: "no-listings-found", debug };
    }
    // Page has car content but no clickable links — return empty.
    return { ok: false, reason: "no-listings-found", debug };
  }

  const listings = [];
  const seen = new Set();

  for (const link of links) {
    try {
      const href = link.getAttribute("href") || "";
      // Match both full (/vehicles/item/xxx) and relative (item/xxx) hrefs.
      const match = href.match(/(?:\/vehicles\/)?item\/([a-z0-9]+)/);
      if (!match) continue;
      const token = match[1];
      if (seen.has(token)) continue;
      seen.add(token);

      // Walk up to find the card container.
      let card = link;
      for (let i = 0; i < 8; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        // Yad2 card containers typically have a class with "card" or "feed" or data attributes.
        const cls = card.className || "";
        if (cls.includes("card") || cls.includes("feedItem") || cls.includes("listing")) {
          break;
        }
      }

      const cardText = (card.textContent || "").trim();
      const cardHtml = card.innerHTML || "";

      // Extract image URL.
      const imgEl = card.querySelector("img");
      const image = imgEl ? imgEl.src || imgEl.getAttribute("data-src") || "" : "";

      // Extract title from the heading (## in markdown = h2 in DOM).
      const headingEl = card.querySelector("h2, h3, [class*='title'], [class*='model']");
      const title = headingEl ? headingEl.textContent.trim() : "";

      // Parse price: look for a number followed by ₪.
      const priceMatch = cardText.match(/([\d,]+)\s*₪/);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ""), 10) : null;

      // Parse year: the production year appears right before "•" (e.g. "2019 • יד 2").
      // Some cards include a model range like [2012-2016] — the actual year is
      // the one immediately before the • separator.
      const yearBeforeDot = cardText.match(/(19[5-9]\d|20[0-4]\d)\s*•/);
      const yearMatch = yearBeforeDot || cardText.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

      // Parse hand (יד): "יד 1", "יד 2", etc.
      const handMatch = cardText.match(/יד\s*(\d+)/);
      const hand = handMatch ? `יד ${handMatch[1]}` : "?";

      // Parse km: look for "km" or "ק״מ" followed by/preceding a number.
      const kmMatch = cardText.match(/([\d,]+)\s*(km|ק״מ|ק"מ)/i);
      const km = kmMatch ? parseInt(kmMatch[1].replace(/,/g, ""), 10) : null;

      // Extract model from the title (manufacturer + model).
      const model = title || "";

      // Extract area/city from the card text.
      // Yad2 cards often show the city name near the end.
      const areaEl = card.querySelector("[class*='area'], [class*='city'], [class*='location']");
      const area = areaEl ? areaEl.textContent.trim() : "";

      // Check for price drop indicator.
      const priceDropped = cardText.includes("ירד ב");

      listings.push({
        token,
        price,
        year,
        hand,
        km,
        engine: "?",
        submodel: "",
        model,
        area: area || "?",
        city: "",
        createdAt: "",
        url: `https://www.yad2.co.il/vehicles/item/${token}`,
        image,
        priceDropped,
      });
    } catch (e) {
      // skip this listing on any error
    }
  }

  if (listings.length === 0) {
    return { ok: false, reason: "no-listings-parsed", debug };
  }

  return { ok: true, method: "dom", listings };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("tab load timeout"));
    }, timeoutMs);

    function listener(id, info, tab) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- parse __NEXT_DATA__ ----------

function parseNextDataJson(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

/**
 * Extract listing dicts from __NEXT_DATA__.
 */
function parseListingsFromNextData(data) {
  if (!data) return null;

  const queries =
    data?.props?.pageProps?.dehydratedState?.queries || [];
  let feed = null;
  for (const q of queries) {
    const d = q?.state?.data;
    if (d && typeof d === "object" && Array.isArray(d.ads) && d.pagination) {
      feed = d;
      break;
    }
  }
  if (!feed) return null;

  const listings = [];
  const seen = new Set();
  for (const it of feed.ads) {
    if (!it || typeof it !== "object") continue;
    const token = it.token;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    listings.push(extractCarFromNextData(it));
  }
  return listings;
}

function extractCarFromNextData(it) {
  const token = it.token;
  return {
    token,
    price: it.price ?? null,
    year: it.vehicleDates?.yearOfProduction ?? null,
    hand: it.hand?.text ?? "?",
    km: it.km ?? null,
    engine: it.engineType?.text ?? "?",
    submodel: it.subModel?.text ?? "",
    model: `${it.manufacturer?.text ?? ""} ${it.model?.text ?? ""}`.trim(),
    area: it.address?.area?.text ?? "?",
    city: it.address?.city?.text ?? "",
    createdAt: it.createdAt ?? "",
    url: `https://www.yad2.co.il/vehicles/item/${token}`,
  };
}

/**
 * Sort listings by createdAt descending (most recent first).
 * Listings without createdAt keep their original order (stable sort).
 */
function sortByRecent(listings) {
  return [...listings].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
}

// ---------- diff + notify ----------

async function pollOnce() {
  const settings = await getSettings();
  if (!settings.searchUrl) {
    console.log("[yad2-watcher] no search URL configured");
    return { ok: false, reason: "no-url" };
  }

  let fetchResult;
  try {
    fetchResult = await fetchPage(settings.searchUrl);
  } catch (e) {
    console.error("[yad2-watcher] fetch failed", e);
    await setBadgeError();
    return { ok: false, reason: "fetch-error", error: String(e) };
  }

  if (!fetchResult.ok) {
    console.warn("[yad2-watcher] extraction failed:", fetchResult.reason);
    const state = await getState();
    state.captchaStreak = (state.captchaStreak || 0) + 1;
    state.lastCheck = Date.now();
    await saveState(state);
    if (state.captchaStreak >= 5) {
      await notify({
        title: "Yad2 Watcher — בעיה",
        message: "לא הצלחתי לטעון את החיפוש 5 פעמים ברצף. אולי יש קאפצ'ה. פתח את Yad2 בדפדפן פעם אחת.",
      });
    }
    return { ok: false, reason: fetchResult.reason, captchaStreak: state.captchaStreak };
  }

  let listings;
  if (fetchResult.method === "nextdata" && fetchResult.json) {
    const data = parseNextDataJson(fetchResult.json);
    listings = parseListingsFromNextData(data);
  } else if (fetchResult.method === "dom" && fetchResult.listings) {
    listings = fetchResult.listings;
  }

  if (!listings || listings.length === 0) {
    console.warn("[yad2-watcher] could not parse listings");
    return { ok: false, reason: "parse-error" };
  }

  console.log(`[yad2-watcher] parsed ${listings.length} listings via ${fetchResult.method}`);

  const sorted = sortByRecent(listings);

  const state = await getState();
  const known = new Set(state.tokens || []);
  const fresh = sorted.filter((l) => !known.has(l.token));

  state.tokens = sorted.map((l) => l.token);
  state.listings = sorted;
  state.lastCheck = Date.now();
  state.captchaStreak = 0;

  // Keep the first run quiet — seed state without a flood of notifications.
  if (!state._seeded) {
    state._seeded = true;
    await saveState(state);
    await setBadge(0);
    console.log(`[yad2-watcher] seeded with ${sorted.length} listings (no notifications)`);
    return { ok: true, seeded: true, count: sorted.length, fresh: 0, method: fetchResult.method };
  }

  await saveState(state);
  await setBadge(fresh.length);

  if (fresh.length > 0) {
    console.log(`[yad2-watcher] ${fresh.length} new listing(s)`);
    await notifyNew(fresh, settings);
  } else {
    console.log(`[yad2-watcher] no new listings (${sorted.length} total)`);
  }

  return { ok: true, count: sorted.length, fresh: fresh.length, method: fetchResult.method };
}

async function notifyNew(fresh, settings) {
  if (!settings.enableNotifications) return;

  const count = fresh.length;
  const title = count === 1 ? "מודעה חדשה ב-Yad2!" : `${count} מודעות חדשות ב-Yad2!`;
  const body = fresh
    .slice(0, 5)
    .map((l) => {
      const price = typeof l.price === "number" ? `₪${l.price.toLocaleString()}` : "₪?";
      return `• ${price} | ${l.year || "?"} | ${l.model}`.trim();
    })
    .join("\n");
  const more = count > 5 ? `\n…ועוד ${count - 5}` : "";

  await notify({ title, message: body + more });

  if (settings.enableSound) {
    try {
      await self.registration.showNotification(title, {
        body: body + more,
        icon: "icons/icon128.png",
        badge: "icons/icon48.png",
        tag: "yad2-new",
        renotify: true,
        requireInteraction: true,
      });
    } catch (e) {
      // showNotification may not be available in all contexts
    }
  }
}

function notify({ title, message }) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message,
        priority: 2,
        requireInteraction: true,
      }, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

async function setBadge(count) {
  const text = count > 0 ? String(count) : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
}

async function setBadgeError() {
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
}

// ---------- alarm scheduling ----------

async function setupAlarm() {
  const settings = await getSettings();
  const minutes = Math.max(1, settings.pollMinutes || POLL_MINUTES);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  console.log(`[yad2-watcher] alarm set every ${minutes} min`);
}

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarm();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollOnce().catch((e) => console.error("[yad2-watcher] poll error", e));
  }
});

chrome.notifications.onClicked.addListener(async (_id) => {
  const state = await getState();
  const fresh = state.listings || [];
  if (fresh.length > 0) {
    chrome.tabs.create({ url: fresh[0].url });
  }
});

// ---------- messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "manual-poll") {
    pollOnce()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "get-state") {
    (async () => {
      const [state, settings] = await Promise.all([getState(), getSettings()]);
      sendResponse({ state, settings });
    })();
    return true;
  }
  if (msg?.type === "save-settings") {
    (async () => {
      await saveSettings(msg.settings);
      await setupAlarm();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "save-and-poll") {
    (async () => {
      await saveSettings(msg.settings);
      await setupAlarm();
      const result = await pollOnce().catch((e) => ({ ok: false, error: String(e) }));
      sendResponse({ ok: true, result });
    })();
    return true;
  }
  if (msg?.type === "reset-state") {
    (async () => {
      await saveState({ tokens: [], listings: [], lastCheck: null, captchaStreak: 0, _seeded: false });
      await setBadge(0);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

setupAlarm();
