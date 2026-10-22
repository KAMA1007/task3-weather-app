"use strict";

/* ========== 1. SETTINGS ========== */
// Open-Meteo is free and needs no API key: https://open-meteo.com/en/docs
const API = {
  geocode: "https://geocoding-api.open-meteo.com/v1/search",
  forecast: "https://api.open-meteo.com/v1/forecast",
};
const DEFAULT_PLACE = { name: "Colombo", admin1: "Western Province", country: "Sri Lanka", latitude: 6.9319, longitude: 79.8478 };
const REQUEST_TIMEOUT_MS = 10000;
const SUGGEST_DELAY_MS = 300;
const MAX_RECENT = 5;

/* ========== 2. WEATHER CODES (WMO) -> text + icon ========== */
const WMO = {
  0: ["Clear sky", "clear"], 1: ["Mainly clear", "clear"], 2: ["Partly cloudy", "partly"], 3: ["Overcast", "cloud"],
  45: ["Fog", "fog"], 48: ["Rime fog", "fog"],
  51: ["Light drizzle", "rain"], 53: ["Drizzle", "rain"], 55: ["Heavy drizzle", "rain"],
  56: ["Freezing drizzle", "rain"], 57: ["Freezing drizzle", "rain"],
  61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "rain"], 67: ["Freezing rain", "rain"],
  71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"], 77: ["Snow grains", "snow"],
  80: ["Light showers", "rain"], 81: ["Showers", "rain"], 82: ["Violent showers", "rain"],
  85: ["Snow showers", "snow"], 86: ["Heavy snow showers", "snow"],
  95: ["Thunderstorm", "storm"], 96: ["Thunderstorm with hail", "storm"], 99: ["Thunderstorm with heavy hail", "storm"],
};

function describe(code, isDay) {
  const [label, kind] = WMO[code] || ["Unknown", "cloud"];
  let icon = "i-" + kind;
  if (kind === "clear") icon = isDay ? "i-sun" : "i-moon";
  if (kind === "partly") icon = isDay ? "i-partly-day" : "i-partly-night";
  return { label, kind, icon };
}

function backgroundFor(kind, isDay) {
  if (kind === "clear") return isDay ? "clear-day" : "clear-night";
  if (kind === "partly" || kind === "cloud") return "cloudy";
  return kind; // rain, snow, storm, fog
}

/* ========== 3. SMALL HELPERS ========== */
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function iconEl(id, className = "wx-icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#" + id);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: API text can never inject HTML
  return node;
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("skycast:" + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("skycast:" + key, JSON.stringify(value)); } catch (e) { /* storage blocked: ignore */ }
  },
};

function placeLabel(p) {
  return [p.name, p.admin1, p.country].filter((v, i, all) => v && all.indexOf(v) === i).join(", ");
}

function isValidPlace(p) {
  return p && typeof p.name === "string" && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
}

// Times from Open-Meteo look like "2026-10-19T14:15" in the city's own time zone, so we read them as text.
function fmtHour(iso) { const h = Number(iso.slice(11, 13)); return `${h % 12 || 12} ${h >= 12 ? "PM" : "AM"}`; }
function fmtTime(iso) { const h = Number(iso.slice(11, 13)); return `${h % 12 || 12}:${iso.slice(14, 16)} ${h >= 12 ? "PM" : "AM"}`; }
function fmtDate(iso) {
  return new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
function fmtDay(dateStr, index) {
  if (index === 0) return "Today";
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en", { weekday: "short", timeZone: "UTC" });
}
function uvLabel(v) { return v < 3 ? "Low" : v < 6 ? "Moderate" : v < 8 ? "High" : v < 11 ? "Very high" : "Extreme"; }
const deg = (n) => (n === null || n === undefined ? "-" : Math.round(n) + "°");
const timeOrDash = (iso) => (iso ? fmtTime(iso) : "-");

/* ========== 4. NETWORK (timeout + friendly errors) ========== */
class AppError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const controllers = {}; // one controller per kind of request, so a new request cancels the old one

async function getJSON(url, key) {
  if (controllers[key]) controllers[key].abort();
  const mine = new AbortController();
  controllers[key] = mine;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; mine.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: mine.signal });
    if (!response.ok) throw new AppError("http", `The weather service had a problem (error ${response.status}). Please try again in a moment.`);
    return await response.json();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err && err.name === "AbortError") {
      if (timedOut) throw new AppError("timeout", "The request took too long. Please check your connection and try again.");
      throw new AppError("aborted", ""); // replaced by a newer request: ignore
    }
    throw new AppError("network", "Could not reach the weather service. Check your internet connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(name, count, key) {
  const query = new URLSearchParams({ name, count, language: "en", format: "json" });
  const data = await getJSON(`${API.geocode}?${query}`, key);
  if (!data || !Array.isArray(data.results)) return []; // the API omits "results" when nothing matches
  return data.results.map((r) => ({
    name: r.name, admin1: r.admin1 || "", country: r.country || "", latitude: r.latitude, longitude: r.longitude,
  }));
}

function forecastURL(place, unit) {
  const query = new URLSearchParams({
    latitude: place.latitude, longitude: place.longitude, timezone: "auto", forecast_days: "7",
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,surface_pressure,wind_speed_10m",
    hourly: "temperature_2m,weather_code,is_day,precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max",
  });
  if (unit === "imperial") {
    query.set("temperature_unit", "fahrenheit");
    query.set("wind_speed_unit", "mph");
    query.set("precipitation_unit", "inch");
  }
  return `${API.forecast}?${query}`;
}

/* ========== 5. SCREEN STATES (loading / error / weather) ========== */
const state = { place: null, unit: store.get("unit", "metric") === "imperial" ? "imperial" : "metric", retry: null };

function setView(view) {
  $("loading").hidden = view !== "loading";
  $("error").hidden = view !== "error";
  $("weather").hidden = view !== "weather";
  $("main").setAttribute("aria-busy", String(view === "loading"));
}

function announce(text) { $("announcer").textContent = text; }

function showError(message, retryFn) {
  state.retry = retryFn || null;
  $("error-text").textContent = message;
  $("retry-btn").hidden = !retryFn;
  setView("error");
  announce(message);
}

$("retry-btn").addEventListener("click", () => { if (state.retry) state.retry(); });

/* ========== 6. LOAD + SHOW WEATHER ========== */
async function loadWeather(place, { remember = true } = {}) {
  state.place = place;
  setView("loading");
  try {
    const data = await getJSON(forecastURL(place, state.unit), "forecast");
    if (!data || !data.current || !data.hourly || !data.daily || !Array.isArray(data.daily.time)) {
      throw new AppError("data", "The weather service sent unexpected data. Please try again.");
    }
    renderWeather(place, data);
    setView("weather");
    if (remember) {
      store.set("last", place);
      if (!place.isGeo) addRecent(place);
    }
    announce(`Weather loaded for ${placeLabel(place)}`);
  } catch (err) {
    if (err instanceof AppError && err.kind === "aborted") return;
    if (!(err instanceof AppError)) console.error(err);
    const message = err instanceof AppError ? err.message : "Something went wrong while showing the weather. Please try again.";
    showError(message, () => loadWeather(place, { remember }));
  }
}

function renderWeather(place, data) {
  const c = data.current, cu = data.current_units, d = data.daily, du = data.daily_units, h = data.hourly;
  const isDay = c.is_day === 1;
  const info = describe(c.weather_code, isDay);

  document.body.className = "wx-" + backgroundFor(info.kind, isDay);

  // Headline
  const heading = place.isGeo ? "Your location" : placeLabel(place);
  $("place").textContent = heading;
  $("place-sub").textContent = `${fmtDate(c.time)} · ${fmtTime(c.time)}` + (place.isGeo ? ` · ${data.timezone}` : "");
  $("current-icon").replaceChildren(iconEl(info.icon, "wx-icon wx-icon-xl"));
  $("temp").textContent = Math.round(c.temperature_2m);
  $("temp-unit").textContent = cu.temperature_2m;
  $("condition").textContent = info.label;
  $("hi-lo").textContent = `High ${deg(d.temperature_2m_max[0])} · Low ${deg(d.temperature_2m_min[0])}`;
  document.title = `${Math.round(c.temperature_2m)}${cu.temperature_2m} ${heading} - SkyCast`;

  // Detail tiles
  $("t-feels").textContent = deg(c.apparent_temperature);
  $("t-humidity").textContent = `${Math.round(c.relative_humidity_2m)}%`;
  $("t-wind").textContent = `${Math.round(c.wind_speed_10m)} ${cu.wind_speed_10m}`;
  $("t-pressure").textContent = `${Math.round(c.surface_pressure)} ${cu.surface_pressure}`;
  $("t-sunrise").textContent = timeOrDash(d.sunrise[0]);
  $("t-sunset").textContent = timeOrDash(d.sunset[0]);
  const uv = d.uv_index_max[0];
  $("t-uv").textContent = typeof uv === "number" ? `${uv.toFixed(1)} · ${uvLabel(uv)}` : "-";
  const chance = d.precipitation_probability_max ? d.precipitation_probability_max[0] : null;
  $("t-rain").textContent = `${d.precipitation_sum[0]} ${du.precipitation_sum}` + (chance === null ? "" : ` · ${chance}%`);

  // Next 24 hours (start from the current hour)
  const nowKey = c.time.slice(0, 13);
  let start = h.time.findIndex((t) => t.slice(0, 13) >= nowKey);
  if (start < 0) start = 0;
  const hourly = $("hourly");
  hourly.replaceChildren();
  for (let i = start; i < Math.min(start + 24, h.time.length); i++) {
    const li = el("li");
    const hourInfo = describe(h.weather_code[i], h.is_day[i] === 1);
    const rain = h.precipitation_probability[i];
    li.append(
      el("span", "h-time", i === start ? "Now" : fmtHour(h.time[i])),
      iconEl(hourInfo.icon),
      el("span", "h-temp", deg(h.temperature_2m[i])),
      el("span", "h-rain", rain >= 10 ? `${rain}%` : "")
    );
    hourly.append(li);
  }

  // 7-day forecast with a min/max bar scaled to the whole week
  const weekMin = Math.min(...d.temperature_2m_min), weekMax = Math.max(...d.temperature_2m_max);
  const span = weekMax - weekMin || 1;
  const daily = $("daily");
  daily.replaceChildren();
  d.time.forEach((date, i) => {
    const dayInfo = describe(d.weather_code[i], true);
    const range = el("span", "range");
    const fill = el("span", "range-fill");
    fill.style.left = `${((d.temperature_2m_min[i] - weekMin) / span) * 100}%`;
    fill.style.width = `${Math.max(((d.temperature_2m_max[i] - d.temperature_2m_min[i]) / span) * 100, 6)}%`;
    range.append(fill);
    const rain = d.precipitation_probability_max ? d.precipitation_probability_max[i] : 0;
    const li = el("li");
    li.append(
      el("span", "d-day", fmtDay(date, i)),
      iconEl(dayInfo.icon),
      el("span", "d-desc", dayInfo.label),
      el("span", "d-rain", rain >= 10 ? `${rain}%` : ""),
      el("span", "d-min", deg(d.temperature_2m_min[i])),
      range,
      el("span", "d-max", deg(d.temperature_2m_max[i]))
    );
    daily.append(li);
  });
}

/* ========== 7. RECENT SEARCHES ========== */
function addRecent(place) {
  const key = (p) => `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`;
  const items = store.get("recent", []).filter(isValidPlace).filter((p) => key(p) !== key(place));
  items.unshift({ name: place.name, admin1: place.admin1 || "", country: place.country || "", latitude: place.latitude, longitude: place.longitude });
  store.set("recent", items.slice(0, MAX_RECENT));
  renderRecent();
}

function renderRecent() {
  const items = store.get("recent", []).filter(isValidPlace);
  $("recent").hidden = items.length === 0;
  const holder = $("recent-list");
  holder.replaceChildren();
  items.forEach((p) => {
    const chip = el("button", "chip", p.name);
    chip.type = "button";
    chip.title = placeLabel(p);
    chip.addEventListener("click", () => { $("city-input").value = p.name; loadWeather(p); });
    holder.append(chip);
  });
}

$("clear-recent").addEventListener("click", () => { store.set("recent", []); renderRecent(); });

/* ========== 8. SEARCH BOX WITH SUGGESTIONS ========== */
const input = $("city-input");
const list = $("suggestions");
let suggestions = [];
let activeIndex = -1;
let suggestTimer = null;

function renderSuggestions(items) {
  suggestions = items;
  activeIndex = -1;
  list.replaceChildren();
  items.forEach((p, i) => {
    const li = el("li", "", placeLabel(p));
    li.id = "sg-" + i;
    li.setAttribute("role", "option");
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p); }); // mousedown fires before the input loses focus
    list.append(li);
  });
  list.hidden = items.length === 0;
  input.setAttribute("aria-expanded", String(items.length > 0));
  input.removeAttribute("aria-activedescendant");
}

function setActive(index) {
  activeIndex = index;
  [...list.children].forEach((li, i) => {
    const on = i === index;
    li.classList.toggle("active", on);
    li.setAttribute("aria-selected", String(on));
  });
  if (index >= 0) input.setAttribute("aria-activedescendant", "sg-" + index);
  else input.removeAttribute("aria-activedescendant");
}

function choose(place) {
  input.value = place.name;
  renderSuggestions([]);
  loadWeather(place);
}

input.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = input.value.trim();
  if (q.length < 2) { renderSuggestions([]); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const results = await geocode(q, 5, "suggest");
      if (input.value.trim() === q) renderSuggestions(results); // ignore answers for old text
    } catch (err) {
      if (!(err instanceof AppError && err.kind === "aborted")) renderSuggestions([]); // suggestions are optional: fail quietly
    }
  }, SUGGEST_DELAY_MS);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setActive((activeIndex + 1) % suggestions.length); }
  else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setActive((activeIndex - 1 + suggestions.length) % suggestions.length); }
  else if (e.key === "Escape") renderSuggestions([]);
});

input.addEventListener("blur", () => setTimeout(() => renderSuggestions([]), 120));

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(suggestTimer);
  if (activeIndex >= 0 && suggestions[activeIndex]) { choose(suggestions[activeIndex]); return; }

  const q = input.value.trim();
  if (q.length < 2) { showError("Please type at least 2 letters of a city name.", null); input.focus(); return; }

  renderSuggestions([]);
  setView("loading");
  try {
    const results = await geocode(q, 1, "search");
    if (!results.length) { showError(`We couldn't find "${q}". Check the spelling or try a nearby city.`, null); return; }
    input.value = results[0].name;
    loadWeather(results[0]);
  } catch (err) {
    if (err instanceof AppError && err.kind === "aborted") return;
    showError(err instanceof AppError ? err.message : "Something went wrong. Please try again.", () => $("search-form").requestSubmit());
  }
});

/* ========== 9. USE MY LOCATION ========== */
$("locate-btn").addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    showError("Your browser does not support location. Please search for a city instead.", null);
    return;
  }
  setView("loading");
  navigator.geolocation.getCurrentPosition(
    (pos) => loadWeather({
      name: "Your location", admin1: "", country: "", isGeo: true,
      latitude: Number(pos.coords.latitude.toFixed(4)), longitude: Number(pos.coords.longitude.toFixed(4)),
    }),
    (err) => {
      if (err.code === 1) showError("Location permission was denied. You can still search for a city.", null);
      else if (err.code === 3) showError("Finding your location took too long. Please try again or search for a city.", () => $("locate-btn").click());
      else showError("Your location is not available right now. Please search for a city.", null);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

/* ========== 10. UNITS (°C / °F) ========== */
function syncUnitButtons() {
  document.querySelectorAll(".unit-toggle button").forEach((b) => {
    const on = b.dataset.unit === state.unit;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

document.querySelectorAll(".unit-toggle button").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.unit === state.unit) return;
    state.unit = b.dataset.unit;
    store.set("unit", state.unit);
    syncUnitButtons();
    if (state.place) loadWeather(state.place, { remember: false });
  });
});

/* ========== 11. START ========== */
syncUnitButtons();
renderRecent();
const saved = store.get("last", null);
loadWeather(isValidPlace(saved) ? saved : DEFAULT_PLACE, { remember: false });
