// Yad2 Watcher — popup script

const $ = (sel) => document.querySelector(sel);

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: "get-state" });
  const { state, settings } = resp;
  render(state, settings);
}

function render(state, settings) {
  const statusEl = $("#status");
  const listingsEl = $("#listings");

  if (!settings.searchUrl) {
    statusEl.textContent = "לא הוגדר חיפוש. לחץ על הגדרות כדי להזין קישור.";
    statusEl.className = "status warn";
    listingsEl.innerHTML = "";
    return;
  }

  if (state.captchaStreak >= 5) {
    statusEl.textContent = "בעיה בטעינת Yad2 (קאפצ'ה?). פתח את Yad2 בדפדפן.";
    statusEl.className = "status err";
  } else if (state.lastCheck) {
    const d = new Date(state.lastCheck);
    const time = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    statusEl.textContent = `בדיקה אחרונה: ${time} · ${state.listings?.length || 0} מודעות`;
    statusEl.className = "status ok";
  } else {
    statusEl.textContent = "טרם נבדק. לחץ על רענן.";
    statusEl.className = "status";
  }

  const listings = state.listings || [];
  if (listings.length === 0) {
    listingsEl.innerHTML = '<div class="empty">אין עדיין מודעות.<br>לחץ על כפתור הרענן לבדיקה ידנית.</div>';
    return;
  }

  // Show the 10 most recent listings (already sorted by recency in background).
  const recent = listings.slice(0, 10);

  listingsEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "listings-header";
  header.textContent = `10 המודעות האחרונות (מתוך ${listings.length})`;
  listingsEl.appendChild(header);

  for (const l of recent) {
    const a = document.createElement("a");
    a.className = "listing";
    a.href = l.url;
    a.target = "_blank";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: l.url });
    });

    const price = typeof l.price === "number" ? `₪${l.price.toLocaleString()}` : "₪?";
    const km = typeof l.km === "number" ? `${l.km.toLocaleString()} km` : "";
    const where = l.city ? `${l.city} (${l.area})` : l.area;

    a.innerHTML = `
      <div class="listing-top">
        <span class="listing-price">${price}</span>
        <span class="listing-year">${l.year || "?"} · ${l.hand}</span>
      </div>
      <span class="listing-model">${l.model} ${l.submodel}</span>
      <span class="listing-meta">${[km, l.engine, where].filter(Boolean).join(" · ")}</span>
    `;
    listingsEl.appendChild(a);
  }
}

$("#refresh").addEventListener("click", async () => {
  const btn = $("#refresh");
  btn.classList.add("spinning");
  $("#status").textContent = "בודק עכשיו…";
  $("#status").className = "status";
  try {
    await chrome.runtime.sendMessage({ type: "manual-poll" });
    await load();
  } catch (e) {
    $("#status").textContent = "שגיאה: " + e.message;
    $("#status").className = "status err";
  } finally {
    btn.classList.remove("spinning");
  }
});

$("#options").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: "options.html" });
  }
});

$("#reset").addEventListener("click", async () => {
  if (!confirm("אפס את רשימת המודעות שנראו? הבדיקה הבאה תסמן את כל המודעות כחדשות.")) return;
  await chrome.runtime.sendMessage({ type: "reset-state" });
  await load();
});

load();
