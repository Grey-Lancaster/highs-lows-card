// Created by Papa Lanc and his buddy Claude
//
// Temperature History Card
// Custom Lovelace card: min/max/mean history bars for today/yesterday/week/month/year,
// with a dropdown to switch between sensors.
// Runs natively inside Home Assistant (no CORS, no long-lived token — uses the
// frontend's own authenticated connection via hass.callWS / hass.callApi).
//
// If 'entities' is omitted, the card auto-discovers every sensor with
// device_class: temperature and lists them all, trying to auto-pair a
// humidity sensor from the same device for the "feels like" reading.
//
// Example card config (manual list):
// type: custom:temp-history-card
// title: Shop & sensors
// entities:
//   - entity: sensor.shop_temperature
//     name: Shop
//     humidity_entity: sensor.shop_humidity
//   - entity: sensor.big_room_temperature
//     name: Big room
// default_entity: sensor.shop_temperature   # optional, defaults to first in list
//
// Example card config (auto-discover all temperature sensors):
// type: custom:temp-history-card
// title: Temperature Sensors

const PERIODS = [
  { key: "today",     label: "today",     granularity: "hour" },
  { key: "yesterday", label: "yesterday", granularity: "hour" },
  { key: "week",      label: "week",      granularity: "hour" },
  { key: "month",     label: "month",     granularity: "day"  },
  { key: "year",      label: "year",      granularity: "day"  },
];

function periodRange(key) {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  switch (key) {
    case "today":
      return [startOfToday, now];
    case "yesterday": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 1);
      return [start, startOfToday];
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return [start, now];
    }
    case "month": {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return [start, now];
    }
    case "year": {
      const start = new Date(now);
      start.setFullYear(start.getFullYear() - 1);
      return [start, now];
    }
  }
}

function heatIndexF(tempF, rh) {
  if (tempF < 80) return tempF;
  const T = tempF, R = rh;
  let hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
    - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
    + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
  if (R < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (R > 85 && T >= 80 && T <= 87) {
    hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return hi;
}

const STYLE = `
  ha-card { padding: 16px 16px 8px; }
  .picker-row { margin-bottom: 12px; }
  .picker-row select {
    width: 100%;
    font-size: 15px;
    font-family: inherit;
    color: var(--primary-text-color);
    background: var(--card-background-color);
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .sensor-label { font-size: 14px; color: var(--secondary-text-color); margin: 0 0 8px; }
  .header-row { display: flex; align-items: flex-start; justify-content: center; gap: 28px; padding-bottom: 16px; margin-bottom: 18px; border-bottom: 1px solid var(--divider-color); }
  .header-stat { text-align: center; }
  .header-current { font-size: 28px; font-weight: 500; color: var(--primary-color); }
  .header-delta { font-size: 20px; font-weight: 500; color: var(--primary-color); display: flex; align-items: center; gap: 4px; justify-content: center; }
  .header-mean { font-size: 20px; font-weight: 500; color: var(--primary-color); }
  .header-label { font-size: 12px; color: var(--secondary-text-color); margin-top: 4px; }
  .period-row { display: flex; align-items: center; gap: 16px; padding: 10px 0; }
  .period-label { font-size: 14px; color: var(--secondary-text-color); width: 64px; flex-shrink: 0; }
  .slider-wrap { position: relative; flex: 1; height: 34px; }
  .slider-track { position: absolute; top: 15px; left: 0; right: 0; height: 4px; background: var(--divider-color); border-radius: 2px; }
  .slider-fill { position: absolute; top: 15px; height: 4px; background: var(--primary-color); border-radius: 2px; }
  .slider-dot { position: absolute; top: 10px; width: 14px; height: 14px; border-radius: 50%; background: var(--card-background-color); border: 2px solid var(--primary-color); transform: translateX(-50%); }
  .slider-mean-dot { position: absolute; top: 15px; width: 6px; height: 6px; border-radius: 50%; background: var(--warning-color, #ba7517); transform: translate(-50%, -1px); }
  .slider-min-label, .slider-max-label { position: absolute; top: 24px; font-size: 12px; color: var(--primary-text-color); white-space: nowrap; transform: translateX(-50%); }
  .slider-mean-label { position: absolute; top: -14px; font-size: 10px; color: var(--secondary-text-color); transform: translateX(-50%); }
  .status-line { font-size: 12px; color: var(--secondary-text-color); padding: 0 0 8px; }
  .status-line.error { color: var(--error-color, #d85a30); }
`;

class TempHistoryCard extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._autoMode = !config.entities || !config.entities.length;
    this._built = false;
    this._lastRefresh = 0;
    this._selected = config.default_entity || (config.entities && config.entities[0] && config.entities[0].entity) || null;
  }

  // Eligibility filter used everywhere we auto-discover: a real temperature
  // sensor, not a disabled/hidden entity, and not a diagnostic/config entity
  // (that's how internal chip-temperature sensors get excluded).
  _isEligibleTempSensor(eid) {
    const hass = this._hass;
    const st = hass.states[eid];
    if (!st || st.attributes.device_class !== "temperature") return false;
    const reg = hass.entities && hass.entities[eid];
    if (reg && (reg.disabled_by || reg.hidden_by || reg.entity_category)) return false;
    return true;
  }

  // Try to find a humidity sensor on the same device (via the entity
  // registry) so the "feels like" reading works without manual config.
  _findHumidityPair(eid) {
    const hass = this._hass;
    const reg = hass.entities && hass.entities[eid];
    if (!reg || !reg.device_id) return null;
    return Object.keys(hass.entities).find((other) => {
      const oreg = hass.entities[other];
      return oreg.device_id === reg.device_id
        && hass.states[other]
        && hass.states[other].attributes.device_class === "humidity";
    }) || null;
  }

  // Fallback list builder, only used if ha-entity-picker isn't available in
  // this HA frontend build (older versions) — same filter, plain <select>.
  _discoverEntitiesList() {
    const hass = this._hass;
    return Object.keys(hass.states)
      .filter((eid) => eid.startsWith("sensor.") && this._isEligibleTempSensor(eid))
      .map((eid) => ({ entity: eid, name: hass.states[eid].attributes.friendly_name || eid }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._buildCard();
      this._built = true;
    } else if (this._picker) {
      this._picker.hass = hass;
    }
    const intervalMs = (this._config.refresh_interval || 300) * 1000;
    const now = Date.now();
    if (now - this._lastRefresh > intervalMs) {
      this._lastRefresh = now;
      this._refresh();
    } else {
      this._updateCurrentOnly();
    }
  }

  getCardSize() {
    return 5;
  }

  _cfgFor(entity) {
    if (this._config.entities) {
      const found = this._config.entities.find((e) => e.entity === entity);
      if (found) return found;
    }
    const st = this._hass && this._hass.states[entity];
    return {
      entity,
      name: (st && st.attributes.friendly_name) || entity,
      humidity_entity: this._findHumidityPair(entity),
    };
  }

  _buildCard() {
    const root = document.createElement("ha-card");
    if (this._config.title) root.header = this._config.title;

    const style = document.createElement("style");
    style.textContent = STYLE;

    const content = document.createElement("div");
    content.className = "card-content";

    if (!this._autoMode && this._config.entities.length === 1) {
      // Single curated sensor: just show its name, no picker needed.
      const label = document.createElement("p");
      label.className = "sensor-label";
      label.textContent = this._cfgFor(this._selected).name || this._selected;
      content.appendChild(label);
    } else if (!this._autoMode) {
      // Curated list of entities: plain dropdown over that list.
      const pickerRow = document.createElement("div");
      pickerRow.className = "picker-row";
      const select = document.createElement("select");
      select.id = "picker";
      this._config.entities.forEach((cfg) => {
        const opt = document.createElement("option");
        opt.value = cfg.entity;
        opt.textContent = cfg.name || cfg.entity;
        if (cfg.entity === this._selected) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", (e) => {
        this._selected = e.target.value;
        this._lastRefresh = 0;
        this._refresh();
      });
      pickerRow.appendChild(select);
      content.appendChild(pickerRow);
    } else {
      // Auto mode: use HA's own entity picker (search box, icons, area/device
      // context) filtered to temperature sensors, same widget used elsewhere
      // in the HA UI. Falls back to a plain filtered <select> on older
      // frontends that don't have ha-entity-picker registered yet.
      const HaEntityPicker = customElements.get("ha-entity-picker");
      const pickerRow = document.createElement("div");
      pickerRow.className = "picker-row";
      if (HaEntityPicker) {
        const picker = document.createElement("ha-entity-picker");
        picker.hass = this._hass;
        picker.includeDomains = ["sensor"];
        picker.includeDeviceClasses = ["temperature"];
        picker.entityFilter = (stateObj) => this._isEligibleTempSensor(stateObj.entity_id);
        picker.label = "Temperature sensor";
        if (this._selected) picker.value = this._selected;
        picker.addEventListener("value-changed", (e) => {
          this._selected = e.detail.value || null;
          this._lastRefresh = 0;
          if (this._selected) this._refresh();
          else this._updateCurrentOnly();
        });
        pickerRow.appendChild(picker);
        this._picker = picker;
      } else {
        const list = this._discoverEntitiesList();
        if (!list.length) {
          content.insertAdjacentHTML("beforeend", `<div class="status-line error">No temperature sensors found (looking for device_class: temperature).</div>`);
        } else {
          if (!this._selected) this._selected = list[0].entity;
          const select = document.createElement("select");
          select.id = "picker";
          list.forEach((cfg) => {
            const opt = document.createElement("option");
            opt.value = cfg.entity;
            opt.textContent = cfg.name;
            if (cfg.entity === this._selected) opt.selected = true;
            select.appendChild(opt);
          });
          select.addEventListener("change", (e) => {
            this._selected = e.target.value;
            this._lastRefresh = 0;
            this._refresh();
          });
          pickerRow.appendChild(select);
        }
      }
      content.appendChild(pickerRow);
    }

    const status = document.createElement("div");
    status.className = "status-line";
    status.id = "status";
    status.textContent = this._selected ? "Loading…" : "Select a sensor above to view its history.";
    content.appendChild(status);

    const rows = PERIODS.map((p) => `
      <div class="period-row">
        <span class="period-label">${p.label}</span>
        <div class="slider-wrap">
          <div class="slider-track"></div>
          <div class="slider-fill" id="fill-${p.key}"></div>
          <div class="slider-mean-dot" id="mean-${p.key}"></div>
          <span class="slider-mean-label" id="meanlabel-${p.key}"></span>
          <div class="slider-dot" id="dotmin-${p.key}"></div>
          <div class="slider-dot" id="dotmax-${p.key}"></div>
          <span class="slider-min-label" id="minlabel-${p.key}"></span>
          <span class="slider-max-label" id="maxlabel-${p.key}"></span>
        </div>
      </div>
    `).join("");

    content.insertAdjacentHTML("beforeend", `
      <div class="header-row">
        <div class="header-stat">
          <div class="header-current" id="cur">--</div>
          <div class="header-label">Current</div>
        </div>
        <div class="header-stat">
          <div class="header-delta" id="delta">--</div>
          <div class="header-label">vs 24h ago</div>
        </div>
        <div class="header-stat" id="feelslike-wrap" style="display:none">
          <div class="header-mean" id="feelslike">--</div>
          <div class="header-label">Feels like</div>
        </div>
      </div>
      ${rows}
    `);

    root.appendChild(style);
    root.appendChild(content);

    this.innerHTML = "";
    this.appendChild(root);
    this._root = root;
  }

  _q(id) {
    return this._root.querySelector(`#${CSS.escape(id)}`);
  }

  _updateCurrentOnly() {
    if (!this._hass || !this._selected) return;
    const cfg = this._cfgFor(this._selected);
    const state = this._hass.states[cfg.entity];
    if (!state) return;
    const current = parseFloat(state.state);
    if (isNaN(current)) return;
    const unit = state.attributes.unit_of_measurement || "";
    this._q("cur").textContent = `${current.toFixed(1)}${unit}`;

    const feelsWrap = this._q("feelslike-wrap");
    if (cfg.humidity_entity) {
      const humState = this._hass.states[cfg.humidity_entity];
      feelsWrap.style.display = "";
      if (humState) {
        const rh = parseFloat(humState.state);
        if (!isNaN(rh)) this._q("feelslike").textContent = `${heatIndexF(current, rh).toFixed(1)}${unit}`;
      }
    } else {
      feelsWrap.style.display = "none";
    }
  }

  async _getStats(entity, period) {
    const [start, end] = periodRange(period.key);
    const result = await this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entity],
      period: period.granularity,
      types: ["min", "max", "mean"],
    });
    const rows = result[entity] || [];
    if (!rows.length) return null;
    const mins = rows.map((r) => r.min).filter((v) => v !== null && v !== undefined);
    const maxs = rows.map((r) => r.max).filter((v) => v !== null && v !== undefined);
    const means = rows.map((r) => r.mean).filter((v) => v !== null && v !== undefined);
    if (!mins.length || !maxs.length) return null;
    return {
      min: Math.min(...mins),
      max: Math.max(...maxs),
      mean: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null,
    };
  }

  async _getStateAt(entity, targetDate) {
    const start = new Date(targetDate.getTime() - 4 * 60 * 60 * 1000);
    try {
      const data = await this._hass.callApi(
        "GET",
        `history/period/${encodeURIComponent(start.toISOString())}` +
          `?end_time=${encodeURIComponent(targetDate.toISOString())}&filter_entity_id=${entity}&minimal_response`
      );
      const rows = data[0] || [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const v = parseFloat(rows[i].state);
        if (!isNaN(v)) return v;
      }
      return null;
    } catch (err) {
      console.error(`temp-history-card: getStateAt failed for ${entity}`, err);
      return null;
    }
  }

  _renderRow(periodKey, stats, scaleMin, scaleMax) {
    const { min, max, mean } = stats;
    const scaleSpan = scaleMax - scaleMin || 1;
    const minPct = ((min - scaleMin) / scaleSpan) * 100;
    const maxPct = ((max - scaleMin) / scaleSpan) * 100;
    const meanPct = mean !== null ? ((mean - scaleMin) / scaleSpan) * 100 : null;

    this._q(`fill-${periodKey}`).style.left = `${minPct}%`;
    this._q(`fill-${periodKey}`).style.width = `${maxPct - minPct}%`;
    this._q(`dotmin-${periodKey}`).style.left = `${minPct}%`;
    this._q(`dotmax-${periodKey}`).style.left = `${maxPct}%`;
    this._q(`minlabel-${periodKey}`).style.left = `${minPct}%`;
    this._q(`minlabel-${periodKey}`).textContent = min.toFixed(1);
    this._q(`maxlabel-${periodKey}`).style.left = `${maxPct}%`;
    this._q(`maxlabel-${periodKey}`).textContent = max.toFixed(1);

    if (meanPct !== null) {
      this._q(`mean-${periodKey}`).style.left = `${meanPct}%`;
      const ml = this._q(`meanlabel-${periodKey}`);
      ml.style.left = `${meanPct}%`;
      ml.textContent = mean.toFixed(1);
    }
  }

  async _refresh() {
    if (!this._hass || !this._selected) return;
    const cfg = this._cfgFor(this._selected);
    const statusEl = this._q("status");
    this._updateCurrentOnly();
    statusEl.textContent = "Loading…";
    statusEl.classList.remove("error");
    try {
      const results = {};
      for (const p of PERIODS) {
        results[p.key] = await this._getStats(cfg.entity, p);
      }

      const state = this._hass.states[cfg.entity];
      const current = state ? parseFloat(state.state) : NaN;

      const yesterdaySameTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const priorValue = await this._getStateAt(cfg.entity, yesterdaySameTime);
      const deltaEl = this._q("delta");
      if (priorValue !== null && !isNaN(current)) {
        const diff = current - priorValue;
        const arrow = diff >= 0 ? "↑" : "↓";
        deltaEl.textContent = `${arrow} ${Math.abs(diff).toFixed(1)}`;
      } else {
        deltaEl.textContent = "--";
      }

      const allMins = Object.values(results).filter(Boolean).map((r) => r.min);
      const allMaxs = Object.values(results).filter(Boolean).map((r) => r.max);
      const scaleMin = allMins.length ? Math.floor(Math.min(...allMins, current || 0) / 10) * 10 : 0;
      const scaleMax = allMaxs.length ? Math.ceil(Math.max(...allMaxs, current || 0) / 10) * 10 : 100;

      PERIODS.forEach((p) => {
        const stats = results[p.key];
        if (stats) this._renderRow(p.key, stats, scaleMin, scaleMax);
      });

      statusEl.textContent = `Last updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      statusEl.textContent = `Error loading history: ${err.message}`;
      statusEl.classList.add("error");
    }
  }
}

customElements.define("temp-history-card", TempHistoryCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "temp-history-card",
  name: "Temperature History Card",
  description: "Min/max/mean temperature bars for today/yesterday/week/month/year, with a sensor picker.",
});
