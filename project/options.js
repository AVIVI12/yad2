// Yad2 Watcher — options page

const $ = (sel) => document.querySelector(sel);

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: "get-state" });
  const s = resp.settings;
  const state = resp.state;
  $("#searchUrl").value = s.searchUrl || "";
  $("#pollMinutes").value = s.pollMinutes || 15;
  $("#enableNotifications").checked = s.enableNotifications !== false;
  $("#enableSound").checked = s.enableSound !== false;
  $("#intervalLabel").textContent = s.pollMinutes || 15;
  renderPreview(state);
}

function renderPreview(state) {
  const el = $("#preview");
  const statusEl = $("#previewStatus");
  const listings = state.listings || [];

  if (state.captchaStreak >= 5) {
    statusEl.textContent = "בעיה בטעינת Yad2 — ייתכן קאפצ'ה. פתח את Yad2 בדפדפן פעם אחת.";
    statusEl.className = "preview-status err";
  } else if (state.lastCheck) {
    const d = new Date(state.lastCheck);
    const time = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    statusEl.textContent = `בדיקה אחרונה: ${time} · ${listings.length} מודעות נאספו`;
    statusEl.className = "preview-status ok";
  } else {
    statusEl.textContent = "טרם נבדק.";
    statusEl.className = "preview-status";
  }

  if (listings.length === 0) {
    el.innerHTML = '<div class="preview-empty">אין עדיין מודעות. שמור את ההגדרות כדי לבצע בדיקה ראשונה.</div>';
    return;
  }

  const recent = listings.slice(0, 10);
  el.innerHTML = "";
  for (const l of recent) {
    const row = document.createElement("a");
    row.className = "preview-listing";
    row.href = l.url;
    row.target = "_blank";
    const price = typeof l.price === "number" ? `₪${l.price.toLocaleString()}` : "₪?";
    const km = typeof l.km === "number" ? `${l.km.toLocaleString()} km` : "";
    const where = l.city ? `${l.city} (${l.area})` : l.area;
    row.innerHTML = `
      <div class="preview-top">
        <span class="preview-price">${price}</span>
        <span class="preview-year">${l.year || "?"} · ${l.hand}</span>
      </div>
      <span class="preview-model">${l.model} ${l.submodel}</span>
      <span class="preview-meta">${[km, l.engine, where].filter(Boolean).join(" · ")}</span>
    `;
    el.appendChild(row);
  }
}

$("#save").addEventListener("click", async () => {
  const url = $("#searchUrl").value.trim();
  if (url && !url.startsWith("https://www.yad2.co.il/")) {
    alert("הקישור חייב להתחיל ב: https://www.yad2.co.il/");
    return;
  }
  const settings = {
    searchUrl: url,
    pollMinutes: Math.max(1, Math.min(120, parseInt($("#pollMinutes").value, 10) || 15)),
    enableNotifications: $("#enableNotifications").checked,
    enableSound: $("#enableSound").checked,
  };

  const btn = $("#save");
  btn.disabled = true;
  btn.textContent = "שומר ובודק…";
  $("#previewStatus").textContent = "פותח כרטיסייה נסתרת ובודק את Yad2…";
  $("#previewStatus").className = "preview-status";

  try {
    const resp = await chrome.runtime.sendMessage({ type: "save-and-poll", settings });
    if (resp?.ok && resp.result?.ok) {
      $("#intervalLabel").textContent = settings.pollMinutes;
      const msg = $("#saved");
      msg.classList.add("show");
      setTimeout(() => msg.classList.remove("show"), 2500);

      const method = resp.result.method === "nextdata" ? "JSON" : "DOM";
      $("#previewStatus").textContent = `בוצע! נמצאו ${resp.result.count} מודעות (שיטה: ${method})`;
      $("#previewStatus").className = "preview-status ok";

      const stateResp = await chrome.runtime.sendMessage({ type: "get-state" });
      renderPreview(stateResp.state);
    } else if (resp?.ok && resp.result && !resp.result.ok) {
      const reason = resp.result.reason || "לא ידוע";
      let hint = "";
      if (reason === "challenge-page" || reason === "captcha") {
        hint = " — פתח את Yad2 בדפדפן פעם אחת כדי לעבור את האתגר.";
      } else if (reason === "no-listings-found" || reason === "no-listings-parsed") {
        hint = " — הדף נטען אך לא נמצאו מודעות. בדוק שהקישור נכון.";
      } else if (reason === "timeout") {
        hint = " — עבר הזמן המוקצב. אולי הדף נטען לאט.";
      }
      $("#previewStatus").textContent = "שגיאה: " + reason + hint;
      $("#previewStatus").className = "preview-status err";

      // Show debug info if available.
      const debug = resp.result.debug;
      if (debug) {
        const debugEl = $("#debugInfo");
        if (debugEl) {
          debugEl.style.display = "block";
          debugEl.textContent = JSON.stringify(debug, null, 2);
        }
      }
    } else {
      $("#previewStatus").textContent = "שגיאה בבדיקה: " + (resp?.error || resp?.result?.error || "לא ידוע");
      $("#previewStatus").className = "preview-status err";
    }
  } catch (e) {
    $("#previewStatus").textContent = "שגיאה: " + e.message;
    $("#previewStatus").className = "preview-status err";
  } finally {
    btn.disabled = false;
    btn.textContent = "שמור";
  }
});

load();
