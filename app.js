/* ============================================================
   SC2 Timings — calculation engine + UI
   ============================================================ */

(() => {
  'use strict';

  const state = {
    mode: 'forge',
    realTime: false,
    chrono: false,
    explorerTarget: 'colossus',
    explorerOpening: 'standard',
    explorerReference: '', // entityId or empty
    scoutRace: 'protoss',
    scouts: [],          // [{id, eventType: "completed"|"started", time}]
    windowRace: 'protoss',
    windowTime: 6 * 60 + 30, // game seconds
    windowBasis: 'game',
    refRace: 'terran',
    forgeRace: 'protoss',
    forgeOrder: [],       // [{entityId, repeat}]
    forgeResult: null,    // { timeline, log, warnings, eft }
    forgeRecent: { terran: [], protoss: [], zerg: [] }, // race -> [entityId,…] most recent first
    forgeBrowseTab: 'unit', // 'unit' | 'building' | 'addon' | 'upgrade'
    forgePaletteCompact: false, // true = icon-only palette tiles
    forgePaletteCollapsed: false, // true = palette grid hidden, list gets full column
    explorerPickerRace: 'protoss',
    explorerPickerType: 'unit',
    scoutPickerType: 'unit',
    // Resource priority — when two steps could fire at the same instant
    // and contend for minerals/gas, the higher-tier class commits first.
    // Within a tier, gas-heavy actions get first dibs (gas is usually the
    // scarce resource), then user-list order.
    forgePriority: ['worker', 'building', 'tech', 'army'],
  };

  // Drag-and-drop state, shared across the browse tiles, recent chips, and
  // the build-order list. Two modes:
  //   reorder: dragging an existing forge row to a new position.
  //   insert:  dragging a browse tile / recent chip to drop a new entity
  //            into the list at a chosen position.
  let forgeDrag = null;

  const FORGE_RECENT_MAX = 8;
  function recordRecent(entityId) {
    const e = SC2_DATA.entities[entityId];
    if (!e || !state.forgeRecent[e.race]) return;
    const list = state.forgeRecent[e.race];
    const existing = list.indexOf(entityId);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift(entityId);
    if (list.length > FORGE_RECENT_MAX) list.length = FORGE_RECENT_MAX;
  }

  // ============================================================
  // Build Forge presets — common openers per race
  // ============================================================
  const FORGE_PRESETS = {
    terran: {
      'Reaper FE (1 rax expand)': [
        { entityId: 'scv' },
        { entityId: 'supply_depot' },
        { entityId: 'scv' },
        { entityId: 'scv' },
        { entityId: 'scv' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'scv' },
        { entityId: 'scv' },
        { entityId: 'scv' },
        { entityId: 'orbital_command' },
        { entityId: 'reaper' },
        { entityId: 'command_center' },
        { entityId: 'scv' },
        { entityId: 'marine' },
        { entityId: 'scv' },
        { entityId: 'supply_depot' },
      ],
      '3 Rax Marine Marauder': [
        { entityId: 'scv' },
        { entityId: 'supply_depot' },
        { entityId: 'scv' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'scv' },
        { entityId: 'orbital_command' },
        { entityId: 'barracks' },
        { entityId: 'barracks' },
        { entityId: 'barracks_techlab' },
        { entityId: 'barracks_reactor' },
        { entityId: 'marine', repeat: 4 },
        { entityId: 'marauder', repeat: 2 },
        { entityId: 'stimpack' },
      ],
      '1-1-1 (Marine Tank Medivac)': [
        { entityId: 'scv', repeat: 2 },
        { entityId: 'supply_depot' },
        { entityId: 'scv' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'orbital_command' },
        { entityId: 'scv' },
        { entityId: 'factory' },
        { entityId: 'command_center' },
        { entityId: 'starport' },
        { entityId: 'factory_techlab' },
        { entityId: 'siege_tank', repeat: 2 },
        { entityId: 'medivac', repeat: 2 },
        { entityId: 'marine', repeat: 6 },
      ],
      'Banshee Cloak Opener': [
        { entityId: 'scv', repeat: 2 },
        { entityId: 'supply_depot' },
        { entityId: 'scv' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'orbital_command' },
        { entityId: 'factory' },
        { entityId: 'starport' },
        { entityId: 'starport_techlab' },
        { entityId: 'cloaking_field' },
        { entityId: 'banshee', repeat: 2 },
      ],
      'Mech (Hellion Cyclone)': [
        { entityId: 'scv', repeat: 2 },
        { entityId: 'supply_depot' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'scv' },
        { entityId: 'orbital_command' },
        { entityId: 'factory' },
        { entityId: 'factory_techlab' },
        { entityId: 'command_center' },
        { entityId: 'hellion', repeat: 4 },
        { entityId: 'cyclone' },
        { entityId: 'siege_tank' },
      ],
      'Battlecruiser Rush': [
        { entityId: 'scv' },
        { entityId: 'supply_depot' },
        { entityId: 'barracks' },
        { entityId: 'refinery' },
        { entityId: 'factory' },
        { entityId: 'refinery' },
        { entityId: 'starport' },
        { entityId: 'starport_techlab' },
        { entityId: 'fusion_core' },
        { entityId: 'battlecruiser' },
        { entityId: 'weapon_refit' },
      ],
    },
    protoss: {
      '1-Gate Robo Colossus': [
        { entityId: 'probe' },
        { entityId: 'pylon' },
        { entityId: 'probe', repeat: 2 },
        { entityId: 'gateway' },
        { entityId: 'probe' },
        { entityId: 'assimilator' },
        { entityId: 'probe' },
        { entityId: 'cybernetics_core' },
        { entityId: 'probe' },
        { entityId: 'assimilator' },
        { entityId: 'pylon' },
        { entityId: 'stalker' },
        { entityId: 'robotics_facility' },
        { entityId: 'probe', repeat: 2 },
        { entityId: 'observer' },
        { entityId: 'robotics_bay' },
        { entityId: 'colossus' },
      ],
      'Stargate Oracle Harass': [
        { entityId: 'probe' },
        { entityId: 'pylon' },
        { entityId: 'probe', repeat: 2 },
        { entityId: 'gateway' },
        { entityId: 'assimilator' },
        { entityId: 'probe' },
        { entityId: 'cybernetics_core' },
        { entityId: 'assimilator' },
        { entityId: 'probe' },
        { entityId: 'pylon' },
        { entityId: 'stargate' },
        { entityId: 'oracle' },
      ],
      '4-Gate Adept Pressure': [
        { entityId: 'probe', repeat: 2 },
        { entityId: 'pylon' },
        { entityId: 'probe' },
        { entityId: 'gateway' },
        { entityId: 'assimilator' },
        { entityId: 'probe' },
        { entityId: 'cybernetics_core' },
        { entityId: 'pylon' },
        { entityId: 'warpgate_research' },
        { entityId: 'gateway', repeat: 3 },
        { entityId: 'adept', repeat: 4 },
      ],
      'Phoenix Opener': [
        { entityId: 'probe', repeat: 2 },
        { entityId: 'pylon' },
        { entityId: 'probe' },
        { entityId: 'gateway' },
        { entityId: 'assimilator' },
        { entityId: 'cybernetics_core' },
        { entityId: 'assimilator' },
        { entityId: 'nexus' },
        { entityId: 'stargate' },
        { entityId: 'pylon' },
        { entityId: 'phoenix', repeat: 3 },
      ],
      'Dark Templar Rush': [
        { entityId: 'probe' },
        { entityId: 'pylon' },
        { entityId: 'probe', repeat: 2 },
        { entityId: 'gateway' },
        { entityId: 'assimilator' },
        { entityId: 'cybernetics_core' },
        { entityId: 'pylon' },
        { entityId: 'twilight_council' },
        { entityId: 'dark_shrine' },
        { entityId: 'dark_templar', repeat: 2 },
      ],
      'Skytoss (Carriers)': [
        { entityId: 'probe', repeat: 3 },
        { entityId: 'pylon' },
        { entityId: 'probe' },
        { entityId: 'nexus' },
        { entityId: 'gateway' },
        { entityId: 'assimilator', repeat: 2 },
        { entityId: 'cybernetics_core' },
        { entityId: 'stargate' },
        { entityId: 'fleet_beacon' },
        { entityId: 'carrier', repeat: 3 },
        { entityId: 'tempest', repeat: 2 },
      ],
      'Blink Stalker All-In': [
        { entityId: 'probe', repeat: 2 },
        { entityId: 'pylon' },
        { entityId: 'gateway' },
        { entityId: 'assimilator' },
        { entityId: 'probe' },
        { entityId: 'cybernetics_core' },
        { entityId: 'assimilator' },
        { entityId: 'pylon' },
        { entityId: 'twilight_council' },
        { entityId: 'blink' },
        { entityId: 'gateway', repeat: 3 },
        { entityId: 'stalker', repeat: 6 },
      ],
    },
    zerg: {
      'Mutalisk Tech Switch': [
        { entityId: 'drone', repeat: 4 },
        { entityId: 'overlord' },
        { entityId: 'hatchery' },
        { entityId: 'spawning_pool' },
        { entityId: 'extractor', repeat: 2 },
        { entityId: 'queen', repeat: 2 },
        { entityId: 'drone', repeat: 3 },
        { entityId: 'lair' },
        { entityId: 'spire' },
        { entityId: 'mutalisk', repeat: 6 },
      ],
      'Roach Ravager All-In': [
        { entityId: 'drone', repeat: 3 },
        { entityId: 'overlord' },
        { entityId: 'spawning_pool' },
        { entityId: 'extractor' },
        { entityId: 'queen' },
        { entityId: 'roach_warren' },
        { entityId: 'drone', repeat: 3 },
        { entityId: 'roach', repeat: 6 },
        { entityId: 'ravager', repeat: 2 },
      ],
      'Lurker Hydra Defensive': [
        { entityId: 'drone', repeat: 4 },
        { entityId: 'overlord' },
        { entityId: 'hatchery' },
        { entityId: 'spawning_pool' },
        { entityId: 'extractor' },
        { entityId: 'queen', repeat: 2 },
        { entityId: 'lair' },
        { entityId: 'hydralisk_den' },
        { entityId: 'extractor' },
        { entityId: 'hydralisk', repeat: 4 },
        { entityId: 'lurker_den' },
        { entityId: 'lurker', repeat: 3 },
      ],
      'Brood Lord Late Game': [
        { entityId: 'drone', repeat: 6 },
        { entityId: 'overlord', repeat: 2 },
        { entityId: 'hatchery' },
        { entityId: 'spawning_pool' },
        { entityId: 'extractor', repeat: 2 },
        { entityId: 'lair' },
        { entityId: 'queen', repeat: 2 },
        { entityId: 'infestation_pit' },
        { entityId: 'hive' },
        { entityId: 'spire' },
        { entityId: 'greater_spire' },
        { entityId: 'corruptor', repeat: 4 },
        { entityId: 'brood_lord', repeat: 4 },
      ],
      '12 Pool Speedling': [
        { entityId: 'spawning_pool' },
        { entityId: 'overlord' },
        { entityId: 'extractor' },
        { entityId: 'queen' },
        { entityId: 'metabolic_boost' },
        { entityId: 'zergling', repeat: 6 },
      ],
      'Hatch First Roach': [
        { entityId: 'drone', repeat: 4 },
        { entityId: 'overlord' },
        { entityId: 'hatchery' },
        { entityId: 'drone' },
        { entityId: 'spawning_pool' },
        { entityId: 'extractor' },
        { entityId: 'queen', repeat: 2 },
        { entityId: 'roach_warren' },
        { entityId: 'roach', repeat: 4 },
      ],
    },
  };

  // ============================================================
  // Math: time formatting and parsing
  // ============================================================

  function fmtTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    const sign = seconds < 0 ? '-' : '';
    const s = Math.abs(seconds);
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    // Show one decimal for sub-minute precision when fractional
    const secStr = sec < 10 ? '0' + sec.toFixed(sec % 1 ? 1 : 0) : sec.toFixed(sec % 1 ? 1 : 0);
    return `${sign}${m}:${secStr}`;
  }
  function fmtTimeBoth(gameSec) {
    const realSec = gameSec / SC2_DATA.speedMultiplier;
    return state.realTime ? fmtTime(realSec) : fmtTime(gameSec);
  }
  function parseTime(str) {
    if (!str) return null;
    str = str.trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10); // raw seconds
    const m = str.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseFloat('0.' + m[3]) : 0);
  }

  // ============================================================
  // Core engine: compute earliest finish time (eft) for every entity.
  // Returns { eft(id), chain(id), entity(id) }.
  // Options:
  //   - scoutedEfts: { id: timeSec } -> override eft to known value
  //   - chrono: bool -> apply -7.5s to chronoable Protoss entities (buildTime > 15)
  // ============================================================

  const CHRONO_SAVING = 7.5;

  function compileEngine(opts = {}) {
    const scouted = opts.scoutedEfts || {};
    const chrono = !!opts.chrono;
    const memo = {};

    function isChronoable(entity) {
      // Chrono boost only speeds up unit production and research at Protoss buildings.
      // It does NOT affect building construction. Research isn't modeled here, so we
      // only apply chrono to Protoss UNITS (and addons/upgrades that are unit-like).
      return chrono && entity.race === 'protoss' && entity.type === 'unit'
        && entity.buildTime > 15 && !entity.starting;
    }
    function effectiveBuildTime(entity) {
      if (!entity || !entity.buildTime) return entity?.buildTime || 0;
      if (isChronoable(entity)) return entity.buildTime - CHRONO_SAVING;
      return entity.buildTime;
    }

    function compute(id) {
      if (memo[id]) return memo[id];

      const entity = SC2_DATA.entities[id];
      if (!entity) {
        return (memo[id] = { eft: 0, chain: [], entity: null, error: `Unknown: ${id}` });
      }

      // Scouted override: this entity is observed at scouted time. We use the scouted value
      // as eft. We still resolve prerequisites (so the chain shows what they had to have
      // built to get here) but the scouted time is the truth.
      if (scouted[id] != null) {
        const prereqResults = (entity.prerequisites || []).map(compute);
        const merged = mergeChains(prereqResults);
        const eft = scouted[id];
        const buildTime = effectiveBuildTime(entity);
        const startTime = Math.max(0, eft - buildTime);
        const item = {
          id, name: entity.name, race: entity.race, type: entity.type,
          startTime, endTime: eft, buildTime, scouted: true, entity,
          chronoApplied: isChronoable(entity),
        };
        merged.set(id, item);
        memo[id] = { eft, chain: Array.from(merged.values()), entity };
        return memo[id];
      }

      if (entity.starting) {
        const item = {
          id, name: entity.name, race: entity.race, type: entity.type,
          startTime: 0, endTime: 0, buildTime: 0, starting: true, entity,
        };
        memo[id] = { eft: 0, chain: [item], entity };
        return memo[id];
      }

      let maxStart = 0;
      const prereqResults = (entity.prerequisites || []).map(compute);
      let critical = null;
      for (const r of prereqResults) {
        if (r.eft > maxStart) {
          maxStart = r.eft;
          critical = r.entity?.id;
        }
      }
      const merged = mergeChains(prereqResults);

      const buildTime = effectiveBuildTime(entity);
      const eft = maxStart + buildTime;
      const item = {
        id, name: entity.name, race: entity.race, type: entity.type,
        startTime: maxStart, endTime: eft, buildTime, entity,
        chronoApplied: chrono && entity.race === 'protoss' && entity.buildTime > 15,
        criticalPrereq: critical,
      };
      merged.set(id, item);
      memo[id] = { eft, chain: Array.from(merged.values()), entity };
      return memo[id];
    }

    function mergeChains(results) {
      const m = new Map();
      for (const r of results) {
        for (const item of r.chain) {
          if (!m.has(item.id)) m.set(item.id, item);
        }
      }
      return m;
    }

    return {
      compute,
      // Compute eft for every entity (Window Lookup, full sweep)
      computeAll() {
        const out = {};
        for (const id of Object.keys(SC2_DATA.entities)) out[id] = compute(id);
        return out;
      },
    };
  }

  // ============================================================
  // Resource summing (chain-based)
  // ============================================================

  function sumChainCost(chain) {
    let m = 0, g = 0;
    for (const item of chain) {
      if (item.starting) continue;
      const e = item.entity;
      if (!e) continue;
      m += e.minerals || 0;
      g += e.gas || 0;
    }
    return { minerals: m, gas: g };
  }

  // ============================================================
  // Rendering: Tech Explorer
  // ============================================================

  // Shared icon-grid picker — used by Tech Explorer and Scout Translator.
  // Renders tier-grouped browse-tiles into the given grid element, sets the
  // currently-selected one, and wires clicks to onPick(id).
  // tabContainer toggles active class on its [data-type] children.
  function renderEntityPickerGrid(opts) {
    const { gridEl, race, type, currentId, onPick, racesContainer, typesContainer } = opts;
    if (!gridEl) return;
    const list = Object.values(SC2_DATA.entities)
      .filter(e => e.race === race && e.type === type && e.id !== 'larva');
    list.sort((a, b) => {
      const ta = tierOf(a.id), tb = tierOf(b.id);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    if (racesContainer) {
      for (const tab of racesContainer.querySelectorAll('[data-race]')) {
        tab.classList.toggle('active', tab.dataset.race === race);
      }
    }
    if (typesContainer) {
      for (const tab of typesContainer.querySelectorAll('[data-type]')) {
        tab.classList.toggle('active', tab.dataset.type === type);
      }
    }
    if (!list.length) {
      gridEl.innerHTML = `<div class="forge-empty" style="grid-column: 1/-1;">No ${type}s for ${race}.</div>`;
      return;
    }
    const parts = [];
    let lastTier = null;
    for (const e of list) {
      const t = tierOf(e.id);
      if (t !== lastTier) {
        parts.push(`<div class="palette-tier-label">${TIER_LABELS[t] || ('Tier ' + t)}</div>`);
        lastTier = t;
      }
      const cost = `${e.minerals || 0}m${e.gas ? '·' + e.gas + 'g' : ''}`;
      const sel = e.id === currentId ? 'is-selected' : '';
      parts.push(`<button type="button" class="browse-tile ${sel}" data-id="${e.id}" title="${e.name} — ${cost} · ${e.buildTime}s${e.note ? '\n' + e.note : ''}">
        ${iconHtml(e, { size: 36 })}
        <span class="tile-name">${e.name}</span>
        <span class="tile-cost">${cost} · ${e.buildTime}s</span>
      </button>`);
    }
    gridEl.innerHTML = parts.join('');
    for (const tile of gridEl.querySelectorAll('.browse-tile')) {
      tile.addEventListener('click', () => onPick(tile.dataset.id));
    }
  }

  function renderExplorer() {
    const select = document.getElementById('explorer-target');
    if (!select.options.length) populateEntityDropdown(select, { excludeStarting: true });
    select.value = state.explorerTarget;
    document.getElementById('explorer-opening').value = state.explorerOpening;

    renderEntityPickerGrid({
      gridEl: document.getElementById('explorer-grid'),
      racesContainer: document.getElementById('explorer-race-tabs'),
      typesContainer: document.getElementById('explorer-type-tabs'),
      race: state.explorerPickerRace,
      type: state.explorerPickerType,
      currentId: state.explorerTarget,
      onPick: (id) => {
        state.explorerTarget = id;
        state.explorerReference = '';
        renderExplorer();
      },
    });

    const targetId = state.explorerTarget;
    const entity = SC2_DATA.entities[targetId];

    // Run the economy simulation
    const sim = SC2_SIM.simulate(targetId, { opening: state.explorerOpening });

    // Run the static (tech-tree only) calc for comparison
    const engine = compileEngine({ chrono: state.chrono });
    const staticResult = engine.compute(targetId);

    // Update reference point dropdown
    populateReferenceDropdown(sim.timeline);

    // Compute reference offset
    const refOffset = state.explorerReference
      ? (sim.timeline.find(t => t.id === state.explorerReference)?.start ?? 0)
      : 0;

    const totalCost = sim.timeline.reduce((acc, t) => ({ m: acc.m + t.mins, g: acc.g + t.gas }), { m: 0, g: 0 });

    const root = document.getElementById('explorer-result');
    root.innerHTML = `
      <div class="result-card race-${entity.race}">
        <div class="result-headline">
          <span class="target-name">${entity.name}</span>
          <div class="headline-times">
            <div>
              <span class="time-label">Sim ${state.realTime ? 'real' : 'game'}</span>
              <span class="time-big">${sim.eft != null ? fmtTimeBoth(sim.eft - refOffset) : '—'}</span>
            </div>
            <div>
              <span class="time-label">Sim ${state.realTime ? 'game' : 'real'}</span>
              <span class="time-side">${sim.eft != null ? (state.realTime ? fmtTime(sim.eft - refOffset) : fmtTime((sim.eft - refOffset) / SC2_DATA.speedMultiplier)) : '—'}</span>
            </div>
            <div>
              <span class="time-label">Static min</span>
              <span class="time-side" title="Theoretical minimum: tech-tree only, no resource constraints">${fmtTimeBoth(staticResult.eft - refOffset)}</span>
            </div>
          </div>
        </div>
        <div class="cost-row">
          <span class="cost-pill minerals"><span class="label">Total Minerals</span> ${Math.round(totalCost.m)}</span>
          <span class="cost-pill gas"><span class="label">Total Gas</span> ${Math.round(totalCost.g)}</span>
          ${entity.supply != null ? `<span class="cost-pill supply"><span class="label">Target Supply</span> ${entity.supply}</span>` : ''}
          <span class="cost-pill" style="background: var(--bg-3); color: var(--text-2);">
            <span class="label">Opening</span> ${state.explorerOpening}
          </span>
          ${state.explorerReference ? `<span class="cost-pill" style="background: var(--protoss-soft); color: var(--protoss);"><span class="label">Δ from</span> ${SC2_DATA.entities[state.explorerReference]?.name || state.explorerReference}</span>` : ''}
        </div>
        <div class="path-section">
          <h3>Build timeline (simulator)</h3>
          ${renderSimTable(sim.timeline, targetId, refOffset)}
        </div>
        <div class="path-section">
          <h3>Visualization</h3>
          ${renderSimGantt(sim.timeline, sim.eft, targetId, refOffset)}
        </div>
        <div class="path-section">
          <h3>Sim audit log</h3>
          ${renderSimLog(sim.log, refOffset)}
        </div>
        <div class="path-section">
          <h3>Theoretical-minimum derivation (tech-tree only, ignores economy)</h3>
          ${renderMath(targetId, engine, refOffset)}
        </div>
      </div>
    `;
  }

  function populateReferenceDropdown(timeline) {
    const select = document.getElementById('explorer-reference');
    const current = state.explorerReference;
    // Build set of unique entities in timeline (most-recent of each)
    const seen = new Map();
    for (const t of timeline) {
      seen.set(t.id, t);
    }
    select.innerHTML = '<option value="">— absolute times —</option>';
    for (const [id, t] of seen) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${t.name} (started at ${fmtTime(t.start)})`;
      select.appendChild(opt);
    }
    if (current && seen.has(current)) select.value = current;
    else state.explorerReference = '';
  }

  function renderSimTable(timeline, targetId, refOffset) {
    const rows = timeline.map(item => {
      const startAdj = item.start - refOffset;
      const endAdj = item.end - refOffset;
      const isTarget = item.id === targetId;
      const isRef = item.id === state.explorerReference;
      const cls = [isTarget ? 'row-target' : '', isRef ? 'row-scouted' : ''].filter(Boolean).join(' ');
      const cost = `${item.mins}m${item.gas ? ` + ${item.gas}g` : ''}`;
      const buildTime = `${(item.end - item.start).toFixed(1)}s`;
      const kindTag = `<span class="chrono-tag" style="background:var(--bg-3);color:var(--text-2)">${item.kind}</span>`;
      return `
        <tr class="${cls}">
          <td class="col-time">${fmtTimeBoth(startAdj)} → ${fmtTimeBoth(endAdj)}</td>
          <td class="col-build">${buildTime}</td>
          <td class="col-name">${item.name} ${kindTag}</td>
          <td class="col-cost">${cost}</td>
          <td class="col-detail">${describeEntity(SC2_DATA.entities[item.id])}</td>
        </tr>
      `;
    }).join('');
    return `
      <table class="path-table">
        <thead>
          <tr>
            <th>Window</th><th>Build</th><th>Entity</th><th>Cost</th><th>Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderSimGantt(timeline, eft, targetId, refOffset) {
    const minT = refOffset;
    const maxT = Math.max(eft || 0, ...timeline.map(t => t.end));
    const span = Math.max(maxT - minT, 1);
    // Long builds compress badly inside a fixed-width container — when the
    // total span is large, individual bars get so narrow that their text
    // clips to "..." or partial characters. Give the Gantt a sensible
    // minimum inner width (≈3px per game-second, floor 640) and let the
    // outer wrapper scroll horizontally when needed. Same approach as the
    // production-utilization chart so they read consistently.
    const minWidthPx = Math.max(640, Math.round(maxT * 3));
    const rows = timeline.map(item => {
      const startAdj = item.start - refOffset;
      const endAdj = item.end - refOffset;
      const dur = item.end - item.start;
      const startPct = ((item.start - minT) / span) * 100;
      const widthPct = Math.max(((dur) / span) * 100, 0.5);
      const cls = [
        `race-${item.race || 'terran'}`,
        item.id === targetId ? 'is-target' : '',
      ].filter(Boolean).join(' ');
      const durStr = dur < 1 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`;
      const r = item.resBefore;
      const supplyTag = r ? ` · ${r.supply_used}/${r.supply_max} sup` : '';
      const resourceTag = r ? ` · ${Math.round(r.minerals)}m / ${Math.round(r.gas)}g` : '';
      const fullTitle = `${item.name} · ${fmtTime(startAdj)} → ${fmtTime(endAdj)} · ${durStr}${supplyTag}${resourceTag}`;
      const ent = SC2_DATA.entities[item.id];
      const iconMarkup = ent ? iconHtml(ent, { size: 18 }) : '';
      // Bar text is suppressed when there isn't enough room for it. The
      // approximate label width for "12s" / "1.4s" is ~22px; below that
      // the text would clip mid-character, so we just hide it. The full
      // duration is still in the info column on the right and the title
      // tooltip on hover.
      const approxBarPx = (widthPct / 100) * minWidthPx;
      const showBarText = approxBarPx >= 22;
      return `
        <div class="gantt-row">
          <div class="gantt-label" title="${item.name}">
            ${iconMarkup}
            <span class="gantt-label-text">${item.name}</span>
          </div>
          <div class="gantt-track">
            <div class="gantt-bar ${cls}" style="left:${startPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%" title="${fullTitle}">
              ${showBarText ? `<span class="bar-text">${durStr}</span>` : ''}
            </div>
          </div>
          <div class="gantt-info">
            <span class="t-start">${fmtTimeBoth(startAdj)}</span>
            <span class="t-arrow">→</span>
            <span class="t-end">${fmtTimeBoth(endAdj)}</span>
            <span class="t-dur">·&nbsp;${durStr}</span>
            ${r ? `<span class="t-supply">·&nbsp;${r.supply_used}/${r.supply_max}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
    return `
      <div class="gantt-scroll">
        <div class="gantt" style="min-width:${minWidthPx}px">${rows}</div>
      </div>
    `;
  }

  function renderSimLog(log, refOffset) {
    const lines = log.map(l => `<div class="formula-line">${fmtTime(l.t - refOffset).padStart(7)}  ${l.msg}</div>`).join('');
    return `<div class="math-display" style="max-height:280px;overflow-y:auto">${lines}</div>`;
  }

  function renderPathTable(items, targetId) {
    const rows = items.map(item => {
      const entity = item.entity;
      const cost = entity && !item.starting ? `${entity.minerals || 0}m${entity.gas ? ` + ${entity.gas}g` : ''}` : '';
      const detail = item.starting
        ? 'Available at game start'
        : item.scouted
          ? 'Scouted observation'
          : describeEntity(entity);
      const isTarget = item.id === targetId;
      const cls = [
        item.starting ? 'row-starting' : '',
        item.scouted ? 'row-scouted' : '',
        isTarget ? 'row-target' : '',
      ].filter(Boolean).join(' ');
      const buildTimeStr = item.starting ? '—' : `${item.buildTime % 1 ? item.buildTime.toFixed(1) : item.buildTime}s`;
      const tags = [
        item.chronoApplied ? '<span class="chrono-tag">chrono</span>' : '',
        item.scouted ? '<span class="scouted-tag">scouted</span>' : '',
      ].join('');
      return `
        <tr class="${cls}">
          <td class="col-time">${fmtTimeBoth(item.startTime)} → ${fmtTimeBoth(item.endTime)}</td>
          <td class="col-build">${buildTimeStr}</td>
          <td class="col-name">${item.name}${tags}</td>
          <td class="col-cost">${cost}</td>
          <td class="col-detail">${detail}</td>
        </tr>
      `;
    }).join('');
    return `
      <table class="path-table">
        <thead>
          <tr>
            <th>Window</th>
            <th>Build</th>
            <th>Entity</th>
            <th>Cost</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function describeEntity(entity) {
    if (!entity) return '';
    const parts = [];
    if (entity.upgradeFrom) parts.push(`upgrades from ${nameOf(entity.upgradeFrom)}`);
    else if (entity.producedBy && entity.type !== 'building') parts.push(`from ${nameOf(entity.producedBy)}`);
    else if (entity.builtBy) parts.push(`built by ${nameOf(entity.builtBy)}`);
    if (entity.note) parts.push(entity.note);
    return parts.join(' · ');
  }
  function nameOf(id) { return SC2_DATA.entities[id]?.name || id; }

  // ============================================================
  // Icons — bundled local file by entity ID, with remote fallbacks
  // ============================================================
  const TYPE_GLYPHS = { unit: '⏵', building: '◧', addon: '⊞', upgrade: '⚡', worker: '◇' };

  // ap_sc2_icons file slugs that don't match `name.toLowerCase().replace(/\s/g,'')`
  const ICON_SLUG_OVERRIDES = {
    viking: 'vikingfighter',
  };

  function iconSlug(entity) {
    return ICON_SLUG_OVERRIDES[entity.id]
      || entity.name.toLowerCase().replace(/[\s\-]+/g, '');
  }

  // Entries whose primary local file is missing or wrong-content. We
  // bypass the local file and use a curated fallback chain — typically
  // the producer-building's icon, or an inline themed SVG. External
  // CDNs aren't reliable for these specific items, so we prefer
  // in-repo assets that we can verify exist.
  const SKIP_LOCAL_ICON = new Set([
    'orbital_command',
    'sensor_tower',
    'factory_techlab',
    'factory_reactor',
    'starport_techlab',
    'starport_reactor',
  ]);

  // Themed inline-SVG placeholder for sensor_tower — drawn in the same
  // cyan accent palette so it doesn't look out of place. No network
  // round-trip; encoded as a data URI. No '|' characters in the URI so
  // the pipe-separated fallback chain in ICON_ONERROR stays intact.
  const SENSOR_TOWER_SVG =
    "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">' +
      '<rect width="32" height="32" fill="#0a121d"/>' +
      '<path d="M16 6 L20 22 L12 22 Z" fill="none" stroke="#4ec3ff" stroke-width="1.5"/>' +
      '<path d="M16 22 L16 26" stroke="#4ec3ff" stroke-width="1.5"/>' +
      '<path d="M10 26 L22 26" stroke="#4ec3ff" stroke-width="1.5"/>' +
      '<path d="M16 4 A8 8 0 0 1 24 12" fill="none" stroke="#4ec3ff" stroke-width="1" opacity="0.6"/>' +
      '<path d="M16 2 A12 12 0 0 1 28 14" fill="none" stroke="#4ec3ff" stroke-width="1" opacity="0.4"/>' +
      '<circle cx="16" cy="14" r="1.5" fill="#4ec3ff"/>' +
      '</svg>'
    );

  // Curated fallback URL list per-entity. Producer-icon substitutes are
  // visually truthful — a Factory Techlab is "an addon on a Factory" —
  // and avoid showing the wrong building (Barracks) that the original
  // local files do. Variants get a corner badge (see ENTITY_BADGES) so
  // the user can tell them apart from the producer at a glance.
  const ICON_FALLBACK_CHAIN = {
    orbital_command: ['icons/command_center.png'],
    sensor_tower: [SENSOR_TOWER_SVG],
    factory_techlab: ['icons/factory.png'],
    factory_reactor: ['icons/factory.png'],
    starport_techlab: ['icons/starport.png'],
    starport_reactor: ['icons/starport.png'],
  };

  // Variant-disambiguation badges. Drawn as a small colored pill in the
  // bottom-right of the icon so two entities sharing the same base image
  // are still distinguishable at a glance.
  const ENTITY_BADGES = {
    orbital_command:  { text: 'OC',  color: '#ffc84a' },
    factory_techlab:  { text: 'TL',  color: '#4ec3ff' },
    factory_reactor:  { text: 'R',   color: '#4ade80' },
    starport_techlab: { text: 'TL',  color: '#4ec3ff' },
    starport_reactor: { text: 'R',   color: '#4ade80' },
  };

  function iconUrls(entity) {
    if (entity.icon) return [entity.icon];
    const urls = [];
    if (SKIP_LOCAL_ICON.has(entity.id)) {
      const fb = ICON_FALLBACK_CHAIN[entity.id];
      if (fb) urls.push(...fb);
    } else {
      urls.push(`icons/${entity.id}.png`);
    }
    // jsDelivr-mirrored ap_sc2_icons — covers most units/buildings/addons.
    if (entity.race && (entity.type === 'unit' || entity.type === 'building' || entity.type === 'addon')) {
      const kind = entity.type === 'unit' ? 'unit' : 'building';
      urls.push(`https://cdn.jsdelivr.net/gh/MatthewMarinets/ap_sc2_icons@main/icons/blizzard/btn-${kind}-${entity.race}-${iconSlug(entity)}.png`);
    }
    // Liquipedia FilePath — last resort.
    const lpName = encodeURIComponent(entity.name.replace(/\s+/g, '_'));
    urls.push(`https://liquipedia.net/starcraft2/Special:FilePath/${lpName}.png`);
    return urls;
  }

  // Walk a |-separated fallback list, swapping src on each error; if exhausted, reveal the glyph.
  const ICON_ONERROR = "var n=(this.dataset.fb||'').split('|').filter(Boolean);if(n.length){this.dataset.fb=n.slice(1).join('|');this.src=n[0];}else{this.parentElement.classList.add('icon-failed');}";

  function iconHtml(entity, opts = {}) {
    if (!entity) return '';
    const size = opts.size || 24;
    const glyph = TYPE_GLYPHS[entity.role === 'worker' ? 'worker' : entity.type] || '?';
    const urls = iconUrls(entity);
    const cls = `entity-icon race-${entity.race}`;
    const fallback = `<span class="icon-fallback type-${entity.type}">${glyph}</span>`;
    const first = urls[0] || '';
    const rest = urls.slice(1).join('|');
    // Optional variant badge (e.g., "OC" on a Command Center icon for
    // orbital_command). Only attached for entities listed in
    // ENTITY_BADGES; everyone else gets the normal icon.
    const badge = ENTITY_BADGES[entity.id];
    const badgeHtml = badge
      ? `<span class="entity-icon-badge" style="background:${badge.color}">${badge.text}</span>`
      : '';
    return `<span class="${cls}" style="width:${size}px;height:${size}px;">
      <img class="ent-img" src="${first}" alt="" loading="lazy"
        data-fb="${rest}" onerror="${ICON_ONERROR}" />
      ${fallback}
      ${badgeHtml}
    </span>`;
  }

  function renderGantt(items, totalEft, targetId) {
    const max = Math.max(totalEft, 1);
    const rows = items.map(item => {
      const dur = item.endTime - item.startTime;
      const startPct = (item.startTime / max) * 100;
      const widthPct = item.starting ? 1 : Math.max((dur / max) * 100, 0.5);
      const cls = [
        `race-${item.race || 'terran'}`,
        item.starting ? 'starting' : '',
        item.id === targetId ? 'is-target' : '',
      ].filter(Boolean).join(' ');
      const durStr = item.starting ? '0s' : (dur < 1 ? `${dur.toFixed(1)}s` : `${Math.round(dur)}s`);
      const fullTitle = item.starting
        ? `${item.name} · available at game start`
        : `${item.name} · ${fmtTime(item.startTime)} → ${fmtTime(item.endTime)} · ${durStr}`;
      const inner = item.starting ? '◇' : `<span class="bar-text">${durStr}</span>`;
      const infoBlock = item.starting
        ? `<span class="t-start">—</span><span class="t-arrow"></span><span class="t-end">starting</span>`
        : `<span class="t-start">${fmtTimeBoth(item.startTime)}</span><span class="t-arrow">→</span><span class="t-end">${fmtTimeBoth(item.endTime)}</span><span class="t-dur">·&nbsp;${durStr}</span>`;
      return `
        <div class="gantt-row">
          <div class="gantt-label" title="${item.name}">${item.name}</div>
          <div class="gantt-track">
            <div class="gantt-bar ${cls}" style="left:${startPct}%;width:${widthPct}%" title="${fullTitle}">${inner}</div>
          </div>
          <div class="gantt-info">${infoBlock}</div>
        </div>
      `;
    }).join('');
    return `<div class="gantt">${rows}</div>`;
  }

  function renderMath(targetId, engine, refOffset = 0) {
    // Walk the longest path back from target
    const lines = [];
    const seen = new Set();
    let cursor = targetId;
    const stack = [];
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const r = engine.compute(cursor);
      stack.push(r);
      const entity = r.entity;
      if (!entity || entity.starting) break;
      // pick longest prereq
      let nextId = null, nextEft = -1;
      for (const p of (entity.prerequisites || [])) {
        const pr = engine.compute(p);
        if (pr.eft > nextEft) { nextEft = pr.eft; nextId = p; }
      }
      cursor = nextId;
    }
    // stack[0] = target ... stack[N-1] = base (starting or earliest)
    // Build the formula
    const target = stack[0];
    const targetEntity = target.entity;

    // Format: T(target) = T(prereq) + bt
    //                  = T(prereq2) + bt2 + bt1
    //                  = N seconds
    const sumTerms = [];
    let baseTerm = '0';
    for (let i = 0; i < stack.length; i++) {
      const item = stack[i];
      const e = item.entity;
      if (!e) continue;
      if (e.starting) {
        baseTerm = `<span class="num">0</span> <span class="var">[${e.name} starting]</span>`;
        continue;
      }
      // Chrono only applies to Protoss UNITS (research too, but not modeled)
      let bt = e.buildTime;
      if (state.chrono && e.race === 'protoss' && e.type === 'unit' && e.buildTime > 15) bt = e.buildTime - CHRONO_SAVING;
      sumTerms.push({ name: e.name, bt });
    }
    sumTerms.reverse(); // base prereq first

    const formulaLines = [];
    formulaLines.push(`<div class="formula-line">T(<span class="var">${targetEntity.name}</span>) = ${baseTerm}${sumTerms.map(t => ` + <span class="num">${t.bt}</span>`).join('')}</div>`);
    formulaLines.push(`<div class="formula-line">           = <span class="num">${sumTerms.reduce((a, b) => a + b.bt, 0)}</span> game seconds</div>`);
    const adjustedEft = target.eft - refOffset;
    formulaLines.push(`<div class="formula-line final">           = <span class="num">${fmtTime(adjustedEft)}</span> game time · <span class="num">${fmtTime(adjustedEft / SC2_DATA.speedMultiplier)}</span> real time (Faster ÷1.4)${refOffset ? ` <span style="color:var(--text-3);font-size:11px">(Δ from ${SC2_DATA.entities[state.explorerReference]?.name || 'reference'} at ${fmtTime(refOffset)})</span>` : ''}</div>`);
    if (state.chrono) {
      formulaLines.push(`<div class="formula-line" style="color:var(--text-3);font-size:12px;margin-top:8px;">Chrono boost applied to Protoss units only (buildings/addons not eligible). −7.5s per chronoable step.</div>`);
    }
    return `<div class="math-display">${formulaLines.join('')}</div>`;
  }

  // ============================================================
  // Rendering: Build Forge
  // ============================================================

  // Forge auto-run: re-simulate after any edit, debounced. Also persists to localStorage.
  const FORGE_STORAGE_KEY = 'sc2-timings.forge.v1';
  let _forgeRunTimer = null;
  function scheduleForgeRun() {
    if (_forgeRunTimer) clearTimeout(_forgeRunTimer);
    _forgeRunTimer = setTimeout(() => runForge(), 180);
    persistForge();
  }
  function persistForge() {
    try {
      localStorage.setItem(FORGE_STORAGE_KEY, JSON.stringify({
        race: state.forgeRace,
        buildOrder: state.forgeOrder,
        recent: state.forgeRecent,
        priority: state.forgePriority,
        paletteCompact: state.forgePaletteCompact,
        paletteCollapsed: state.forgePaletteCollapsed,
        savedAt: Date.now(),
      }));
    } catch (_) { /* quota/private mode — ignore */ }
  }
  const PRIORITY_TIERS = ['worker', 'building', 'tech', 'army'];
  function sanitizePriority(p) {
    if (!Array.isArray(p)) return PRIORITY_TIERS.slice();
    const seen = new Set();
    const out = [];
    for (const v of p) {
      if (PRIORITY_TIERS.includes(v) && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    for (const v of PRIORITY_TIERS) if (!seen.has(v)) out.push(v);
    return out;
  }
  // ============================================================
  // Collapsible-section persistence — any panel with a data-section-id
  // can be remembered as collapsed/expanded across reloads. Used by the
  // result column's chart/Gantt/roster blocks.
  // ============================================================
  const UI_COLLAPSE_KEY = 'sc2-timings.ui.collapsed.v1';
  function loadCollapseState() {
    try {
      const raw = localStorage.getItem(UI_COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  function saveCollapseState(s) {
    try { localStorage.setItem(UI_COLLAPSE_KEY, JSON.stringify(s)); } catch (_) {}
  }
  function toggleSectionCollapsed(id) {
    const s = loadCollapseState();
    s[id] = !s[id];
    saveCollapseState(s);
    return s[id];
  }
  function applyStoredCollapseStates(root) {
    const s = loadCollapseState();
    const scope = root || document;
    for (const el of scope.querySelectorAll('.collapsible-section[data-section-id]')) {
      const id = el.dataset.sectionId;
      if (s[id]) el.dataset.collapsed = 'true';
      else el.dataset.collapsed = 'false';
    }
  }

  // First-load only: if the Forge has never been persisted, drop in a
  // recognizable preset so the page has something to look at. The instant
  // the user touches anything, scheduleForgeRun → persistForge writes
  // FORGE_STORAGE_KEY, so this never re-fires and saved work is preserved.
  // Clearing the build also writes the key (with an empty array), so a
  // deliberate empty state stays empty across reloads.
  const FORGE_DEFAULT = { race: 'protoss', preset: '1-Gate Robo Colossus' };
  function seedDefaultBuildIfFirstLoad() {
    if (localStorage.getItem(FORGE_STORAGE_KEY) != null) return false;
    const preset = (FORGE_PRESETS[FORGE_DEFAULT.race] || {})[FORGE_DEFAULT.preset];
    if (!preset) return false;
    state.forgeRace = FORGE_DEFAULT.race;
    state.forgeOrder = JSON.parse(JSON.stringify(preset));
    state.forgePriority = sanitizePriority(state.forgePriority);
    return true;
  }

  function restoreForge() {
    try {
      const raw = localStorage.getItem(FORGE_STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !['terran', 'protoss', 'zerg'].includes(data.race)) return false;
      if (!Array.isArray(data.buildOrder)) return false;
      // Re-validate each step against current data (in case data.js changed)
      const cleaned = [];
      for (const step of data.buildOrder) {
        if (step && step.kind === 'swap' && step.from && step.to) {
          cleaned.push({ kind: 'swap', from: step.from, to: step.to });
        } else if (step && step.kind === 'priority') {
          cleaned.push({ kind: 'priority', order: sanitizePriority(step.order) });
        } else if (step && step.entityId && SC2_DATA.entities[step.entityId]) {
          cleaned.push({ entityId: step.entityId, repeat: Math.max(1, Math.min(50, step.repeat || 1)) });
        }
      }
      state.forgeRace = data.race;
      state.forgeOrder = cleaned;
      state.forgePriority = sanitizePriority(data.priority);
      if (typeof data.paletteCompact === 'boolean') {
        state.forgePaletteCompact = data.paletteCompact;
      }
      if (typeof data.paletteCollapsed === 'boolean') {
        state.forgePaletteCollapsed = data.paletteCollapsed;
      }
      // Restore recent items per race (filter unknowns and clamp length)
      if (data.recent && typeof data.recent === 'object') {
        for (const race of ['terran', 'protoss', 'zerg']) {
          const list = Array.isArray(data.recent[race]) ? data.recent[race] : [];
          state.forgeRecent[race] = list
            .filter(id => SC2_DATA.entities[id] && SC2_DATA.entities[id].race === race)
            .slice(0, FORGE_RECENT_MAX);
        }
      }
      return true;
    } catch (_) { return false; }
  }

  // ============================================================
  // Build Library — multiple named saves, persisted to localStorage
  // ============================================================
  // Each entry: { id, name, race, buildOrder, priority, savedAt, source }
  // source: 'user' | 'import' | 'replay' | 'preset'
  const BUILD_LIBRARY_KEY = 'sc2-timings.builds.v1';

  function loadLibrary() {
    try {
      const raw = localStorage.getItem(BUILD_LIBRARY_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;             // legacy bare array
      if (data && Array.isArray(data.builds)) return data.builds;
      return [];
    } catch (_) { return []; }
  }
  function saveLibrary(builds) {
    try {
      localStorage.setItem(BUILD_LIBRARY_KEY, JSON.stringify({
        format: 'sc2-timings-builds',
        version: 1,
        builds,
      }));
    } catch (_) { /* quota / private mode — ignore */ }
  }
  function newBuildId() {
    return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  function saveBuildToLibrary({ id, name, race, buildOrder, priority, source }) {
    const builds = loadLibrary();
    const entry = {
      id: id || newBuildId(),
      name: (name || 'Untitled build').trim().slice(0, 80) || 'Untitled build',
      race,
      buildOrder: Array.isArray(buildOrder) ? buildOrder : [],
      priority: sanitizePriority(priority),
      savedAt: new Date().toISOString(),
      source: source || 'user',
    };
    const idx = builds.findIndex(b => b.id === entry.id);
    if (idx >= 0) builds[idx] = entry; else builds.unshift(entry);
    saveLibrary(builds);
    return entry;
  }
  function deleteBuildFromLibrary(id) {
    const builds = loadLibrary().filter(b => b.id !== id);
    saveLibrary(builds);
  }

  // Validate + clean a build payload (from JSON import, library entry, or replay).
  // Returns { name, race, buildOrder, priority, skipped } or null if invalid.
  function parseBuildPayload(data, fallbackName) {
    if (!data || typeof data !== 'object') {
      alert('Invalid build file: not an object.');
      return null;
    }
    if (data.format && data.format !== 'sc2-timings-build') {
      if (!confirm(`File format is "${data.format}", not sc2-timings-build. Load anyway?`)) return null;
    }
    if (!data.race || !['terran', 'protoss', 'zerg'].includes(data.race)) {
      alert('Invalid build file: missing or unknown race.');
      return null;
    }
    if (!Array.isArray(data.buildOrder)) {
      alert('Invalid build file: missing buildOrder array.');
      return null;
    }
    const cleaned = [];
    let skipped = 0;
    for (const step of data.buildOrder) {
      if (step && step.kind === 'swap' && step.from && step.to) {
        cleaned.push({ kind: 'swap', from: step.from, to: step.to });
      } else if (step && step.kind === 'priority') {
        cleaned.push({ kind: 'priority', order: sanitizePriority(step.order) });
      } else if (step && step.entityId && SC2_DATA.entities[step.entityId]) {
        const repeat = Math.max(1, Math.min(50, parseInt(step.repeat, 10) || 1));
        cleaned.push({ entityId: step.entityId, repeat });
      } else {
        skipped++;
      }
    }
    return {
      name: (data.name || fallbackName || 'Imported build').replace(/\.json$/i, ''),
      race: data.race,
      buildOrder: cleaned,
      priority: sanitizePriority(data.priority),
      skipped,
    };
  }

  function applyBuildToForge({ race, buildOrder, priority }) {
    state.forgeRace = race;
    state.forgeOrder = buildOrder.map(s => ({ ...s }));
    state.forgePriority = sanitizePriority(priority);
    state.forgeResult = null;
    document.getElementById('forge-preset').value = '';
    renderForge();
    scheduleForgeRun();
  }

  function downloadBuildJSON(build) {
    const payload = {
      format: 'sc2-timings-build',
      version: 1,
      name: build.name,
      race: build.race,
      savedAt: build.savedAt || new Date().toISOString(),
      buildOrder: build.buildOrder,
      priority: build.priority,
      source: build.source,
    };
    const safeName = (build.name || 'sc2-build').replace(/[^\w\-. ]+/g, '_');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Build Library modal — list of saves + quick actions, plus a section to save
  // the current Forge build and an Import button. Closes via overlay click,
  // Escape, or the Close button.
  let _libraryFilterRace = 'all';
  function openBuildLibrary() {
    const existing = document.getElementById('build-library-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'build-library-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide build-library">
        <div class="library-head">
          <div>
            <h4>Build Library</h4>
            <p class="library-sub">Saved on this device. Use <em>Save current build</em> to add what's in the Forge right now.</p>
          </div>
          <button type="button" class="ghost icon-btn" data-act="close" title="Close">✕</button>
        </div>

        <div class="library-save">
          <div class="library-save-row">
            <input type="text" id="library-save-name" placeholder="Name (e.g. PvT Stargate Adept Glaive)" />
            <span class="race-chip race-${state.forgeRace}" id="library-save-race">${state.forgeRace}</span>
            <button type="button" data-act="save-current">Save current build</button>
          </div>
          <div class="library-save-meta" id="library-save-meta"></div>
        </div>

        <div class="library-toolbar">
          <div class="library-filter">
            <button type="button" class="library-filter-btn ${_libraryFilterRace === 'all' ? 'active' : ''}" data-race="all">All</button>
            <button type="button" class="library-filter-btn ${_libraryFilterRace === 'terran' ? 'active' : ''}" data-race="terran">Terran</button>
            <button type="button" class="library-filter-btn ${_libraryFilterRace === 'protoss' ? 'active' : ''}" data-race="protoss">Protoss</button>
            <button type="button" class="library-filter-btn ${_libraryFilterRace === 'zerg' ? 'active' : ''}" data-race="zerg">Zerg</button>
          </div>
          <div class="library-actions-right">
            <button type="button" class="ghost" data-act="import-replay" title="Read a .SC2Replay file and extract the first 5 minutes as a build">⛓ Import replay</button>
            <button type="button" class="ghost" data-act="import-json">⤒ Import JSON</button>
            <input type="file" id="library-replay-input" accept=".SC2Replay" style="display:none" />
          </div>
        </div>

        <div id="library-list" class="library-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Save-current section: prefill a name + step-count meta line
    const nameInput = overlay.querySelector('#library-save-name');
    const meta = overlay.querySelector('#library-save-meta');
    const stepCount = state.forgeOrder.length;
    nameInput.value = stepCount
      ? `${state.forgeRace[0].toUpperCase()}${state.forgeRace.slice(1)} build — ${new Date().toLocaleDateString()}`
      : '';
    meta.textContent = stepCount
      ? `Current Forge: ${stepCount} step${stepCount === 1 ? '' : 's'}.`
      : 'Forge is empty — add steps first to save a build.';

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-act="save-current"]').addEventListener('click', () => {
      if (!state.forgeOrder.length) {
        alert('Nothing to save — the Forge build is empty.');
        return;
      }
      const name = (nameInput.value || '').trim();
      if (!name) { nameInput.focus(); return; }
      saveBuildToLibrary({
        name,
        race: state.forgeRace,
        buildOrder: state.forgeOrder,
        priority: state.forgePriority,
        source: 'user',
      });
      nameInput.value = '';
      renderBuildLibraryList();
    });
    overlay.querySelector('[data-act="import-json"]').addEventListener('click', () => {
      const input = document.getElementById('forge-load-input');
      input.dataset.target = 'library';
      input.click();
    });
    const replayInput = overlay.querySelector('#library-replay-input');
    overlay.querySelector('[data-act="import-replay"]').addEventListener('click', () => {
      replayInput.click();
    });
    replayInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      try {
        const ab = await file.arrayBuffer();
        // Stash the buffer so the picker can re-synthesize when the user
        // changes the duration cap.
        openReplayPicker(ab, file.name);
      } catch (err) {
        console.error(err);
        alert(`Couldn't read replay: ${err.message}`);
      }
    });
    overlay.querySelectorAll('[data-race]').forEach(btn => {
      btn.addEventListener('click', () => {
        _libraryFilterRace = btn.dataset.race;
        overlay.querySelectorAll('[data-race]').forEach(b => b.classList.toggle('active', b.dataset.race === _libraryFilterRace));
        renderBuildLibraryList();
      });
    });

    // Esc to close
    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    renderBuildLibraryList();
  }

  function renderBuildLibraryList() {
    const root = document.getElementById('library-list');
    if (!root) return;
    let builds = loadLibrary();
    if (_libraryFilterRace !== 'all') builds = builds.filter(b => b.race === _libraryFilterRace);
    builds.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    if (!builds.length) {
      root.innerHTML = `<div class="library-empty">No builds saved yet for this filter. Save the current Forge build above, or import a JSON file.</div>`;
      return;
    }
    root.innerHTML = builds.map(b => {
      const date = b.savedAt ? new Date(b.savedAt).toLocaleString() : '';
      const stepCount = (b.buildOrder || []).reduce((n, s) => n + (s.entityId ? (s.repeat || 1) : 1), 0);
      const sourceLabel = b.source && b.source !== 'user' ? `<span class="library-source">${b.source}</span>` : '';
      return `
        <div class="library-card" data-id="${b.id}">
          <div class="library-card-main">
            <div class="library-card-title">
              <span class="race-chip race-${b.race}">${b.race}</span>
              <span class="library-name" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</span>
              ${sourceLabel}
            </div>
            <div class="library-card-meta">${stepCount} step${stepCount === 1 ? '' : 's'} · ${date}</div>
          </div>
          <div class="library-card-actions">
            <button type="button" data-act="open">Open</button>
            <button type="button" class="ghost" data-act="rename">Rename</button>
            <button type="button" class="ghost" data-act="duplicate">Duplicate</button>
            <button type="button" class="ghost" data-act="export">Export</button>
            <button type="button" class="ghost danger" data-act="delete">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    root.querySelectorAll('.library-card').forEach(card => {
      const id = card.dataset.id;
      const find = () => loadLibrary().find(b => b.id === id);
      card.querySelector('[data-act="open"]').addEventListener('click', () => {
        const b = find(); if (!b) return;
        applyBuildToForge(b);
        document.getElementById('build-library-overlay')?.remove();
      });
      card.querySelector('[data-act="rename"]').addEventListener('click', () => {
        const b = find(); if (!b) return;
        const next = prompt('Rename build:', b.name);
        if (next == null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        b.name = trimmed.slice(0, 80);
        saveBuildToLibrary(b);
        renderBuildLibraryList();
      });
      card.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
        const b = find(); if (!b) return;
        saveBuildToLibrary({
          name: `${b.name} (copy)`,
          race: b.race,
          buildOrder: b.buildOrder,
          priority: b.priority,
          source: b.source,
        });
        renderBuildLibraryList();
      });
      card.querySelector('[data-act="export"]').addEventListener('click', () => {
        const b = find(); if (!b) return;
        downloadBuildJSON(b);
      });
      card.querySelector('[data-act="delete"]').addEventListener('click', () => {
        const b = find(); if (!b) return;
        if (!confirm(`Delete "${b.name}"? This cannot be undone.`)) return;
        deleteBuildFromLibrary(id);
        renderBuildLibraryList();
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================================================
  // SALT encoding (spawningtool / Veritasimo's SALT.cs)
  // ============================================================
  // Format: $version + "title|author|desc|" + "~" + repeated 5-char step.
  // Each step char is an index into SALT_CHARSET.
  //   step[0] = supply, step[1] = minute, step[2] = second,
  //   step[3] = type (0=Structure, 1=Unit, 2=Morph, 3=Upgrade),
  //   step[4] = item code (per-type lookup table).
  // We use version 4 (matches strings produced by spawningtool.com).
  const SALT_CHARSET =
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  const SALT_VERSION = 4;
  const SALT_TYPE = { STRUCTURE: 0, UNIT: 1, MORPH: 2, UPGRADE: 3 };

  // entity_id -> [salt_type, salt_code]
  // Anything not in this table is unrepresentable in SALT and gets skipped
  // on export with a warning. Newer entities (Disruptor, Adept, Liberator
  // etc.) ARE here because spawningtool added codes for them in later
  // SALT.cs revisions.
  const SALT_ID_TO_CODE = {
    // ---- Terran structures ----
    armory: [0, 0], barracks: [0, 1], bunker: [0, 2], command_center: [0, 3],
    engineering_bay: [0, 4], factory: [0, 5], fusion_core: [0, 6], ghost_academy: [0, 7],
    missile_turret: [0, 8], barracks_reactor: [0, 9], factory_reactor: [0, 10],
    starport_reactor: [0, 11], refinery: [0, 12], sensor_tower: [0, 13],
    starport: [0, 14], supply_depot: [0, 15], barracks_techlab: [0, 16],
    factory_techlab: [0, 17], starport_techlab: [0, 18],
    // ---- Protoss structures ----
    assimilator: [0, 19], cybernetics_core: [0, 20], dark_shrine: [0, 21],
    fleet_beacon: [0, 22], forge: [0, 23], gateway: [0, 24], nexus: [0, 25],
    photon_cannon: [0, 26], pylon: [0, 27], robotics_bay: [0, 28],
    robotics_facility: [0, 29], stargate: [0, 30], templar_archives: [0, 31],
    twilight_council: [0, 32],
    // ---- Zerg structures ----
    baneling_nest: [0, 33], evolution_chamber: [0, 34], extractor: [0, 35],
    hatchery: [0, 36], hydralisk_den: [0, 37], infestation_pit: [0, 38],
    nydus_network: [0, 39], roach_warren: [0, 40], spawning_pool: [0, 41],
    spine_crawler: [0, 42], spire: [0, 43], spore_crawler: [0, 44],
    ultralisk_cavern: [0, 45],

    // ---- Terran units ----
    banshee: [1, 0], battlecruiser: [1, 1], ghost: [1, 2], hellion: [1, 3],
    marauder: [1, 4], marine: [1, 5], medivac: [1, 6], raven: [1, 7],
    reaper: [1, 8], scv: [1, 9], siege_tank: [1, 10], thor: [1, 11],
    viking: [1, 12], hellbat: [1, 40], widow_mine: [1, 42], cyclone: [1, 48],
    liberator: [1, 49],
    // ---- Protoss units ----
    carrier: [1, 14], colossus: [1, 15], dark_templar: [1, 16],
    high_templar: [1, 17], immortal: [1, 18], mothership: [1, 19],
    observer: [1, 20], phoenix: [1, 21], probe: [1, 22], sentry: [1, 23],
    stalker: [1, 24], void_ray: [1, 25], zealot: [1, 26], warp_prism: [1, 39],
    oracle: [1, 44], tempest: [1, 45], disruptor: [1, 50], adept: [1, 51],
    // ---- Zerg units ----
    corruptor: [1, 27], drone: [1, 28], hydralisk: [1, 29], mutalisk: [1, 30],
    overlord: [1, 31], queen: [1, 32], roach: [1, 33], ultralisk: [1, 34],
    zergling: [1, 35], infestor: [1, 38], swarm_host: [1, 46], viper: [1, 47],

    // ---- Morphs (building/unit upgrades) ----
    orbital_command: [2, 0], planetary_fortress: [2, 1],
    lair: [2, 3], hive: [2, 4], greater_spire: [2, 5],
    brood_lord: [2, 6], baneling: [2, 7], overseer: [2, 8],
    ravager: [2, 9], lurker: [2, 10], lurker_den: [2, 12], archon: [2, 13],

    // ---- Upgrades ----
    // Multi-level upgrades collapse to their level-1 SALT slot; level 2/3
    // are imported back as +1 (data loss is unavoidable in SALT v4).
    inf_armor_1: [3, 1], inf_armor_2: [3, 1], inf_armor_3: [3, 1],
    inf_weapons_1: [3, 2], inf_weapons_2: [3, 2], inf_weapons_3: [3, 2],
    cloaking_field: [3, 8], personal_cloaking: [3, 9],
    stimpack: [3, 11], concussive_shells: [3, 15], combat_shield: [3, 16],
    weapon_refit: [3, 52], caduceus_reactor: [3, 54],
    smart_servos: [3, 57], drilling_claws: [3, 66],
    p_ground_armor_1: [3, 18], p_ground_weapons_1: [3, 19],
    p_ground_weapons_2: [3, 19], p_ground_weapons_3: [3, 19],
    p_air_armor_1: [3, 20], p_air_weapons_1: [3, 21], p_shields_1: [3, 22],
    hallucination: [3, 23], psionic_storm: [3, 24], blink: [3, 25],
    warpgate_research: [3, 26], charge: [3, 27],
    extended_thermal_lance: [3, 47], graviton_catapult: [3, 58],
    gravitic_boosters: [3, 59], gravitic_drive: [3, 60],
    anion_pulse_crystals: [3, 67], resonating_glaives: [3, 73],
    z_carapace_1: [3, 28], z_melee_1: [3, 29], z_missile_1: [3, 32],
    grooved_spines: [3, 33], pneumatized_carapace: [3, 34],
    glial_reconstitution: [3, 36], tunneling_claws: [3, 38],
    chitinous_plating: [3, 40], adrenal_glands: [3, 41], metabolic_boost: [3, 42],
    burrow: [3, 44], centrifugal_hooks: [3, 45], neural_parasite: [3, 49],
    muscular_augments: [3, 65], seismic_spines: [3, 69],
  };

  // Inverse lookup: "type:code" -> entity_id (first id wins for upgrades
  // that share a code, preferring the +1 variant).
  const SALT_CODE_TO_ID = (() => {
    const m = {};
    for (const [id, [t, c]] of Object.entries(SALT_ID_TO_CODE)) {
      const key = `${t}:${c}`;
      if (!(key in m)) m[key] = id;
    }
    return m;
  })();

  function saltChar(idx) {
    const i = Math.max(0, Math.min(SALT_CHARSET.length - 1, idx | 0));
    return SALT_CHARSET[i];
  }
  function saltIndex(ch) {
    const i = SALT_CHARSET.indexOf(ch);
    return i < 0 ? 0 : i;
  }

  // Encode timeline → SALT string. Uses the standard SC2 build-order
  // convention: time and supply are taken at CLICK time (when the action
  // is queued), not completion. So `13 Rax` means you clicked Rax at
  // supply 13 — same convention spawningtool builds use. `name` becomes
  // the build's title.
  function encodeSALT(timeline, name) {
    const steps = [];
    const skipped = [];
    for (const t of timeline) {
      // Swaps and other synthetic events have no SALT representation.
      if (!t || !t.id || String(t.id).startsWith('swap_')) continue;
      const map = SALT_ID_TO_CODE[t.id];
      if (!map) {
        skipped.push(t.name || t.id);
        continue;
      }
      const [type, code] = map;
      const sup = t.resBefore ? Math.round(t.resBefore.supply_used || 0) : 0;
      const startSec = Math.max(0, Math.round(t.start || 0));
      const minute = Math.floor(startSec / 60);
      const second = startSec % 60;
      steps.push(saltChar(sup) + saltChar(minute) + saltChar(second) + saltChar(type) + saltChar(code));
    }
    const title = (name || 'sc2-timings build').replace(/[|~]/g, ' ');
    const header = saltChar(SALT_VERSION) + `${title}|sc2-timings||~`;
    return { encoded: header + steps.join(''), skipped };
  }

  // Decode a SALT string into { name, race, buildOrder, skipped }.
  // Race is inferred from the first step that resolves to a race-tagged
  // entity. Throws on malformed input.
  function decodeSALT(input) {
    if (typeof input !== 'string') throw new Error('SALT input must be a string');
    const s = input.trim();
    if (!s.length) throw new Error('SALT input is empty');
    const tildeIdx = s.indexOf('~');
    if (tildeIdx < 1) throw new Error('SALT header missing "~" terminator');
    // s[0] is the version char; s[1..tildeIdx-1] is the meta block.
    const meta = s.slice(1, tildeIdx).split('|');
    const name = (meta[0] || '').trim() || 'Imported SALT build';
    const body = s.slice(tildeIdx + 1);
    if (body.length % 5 !== 0) {
      throw new Error(`SALT body length ${body.length} is not a multiple of 5`);
    }
    const buildOrder = [];
    let race = null;
    let skipped = 0;
    for (let i = 0; i < body.length; i += 5) {
      const sup = saltIndex(body[i]);
      const min = saltIndex(body[i + 1]);
      const sec = saltIndex(body[i + 2]);
      const type = saltIndex(body[i + 3]);
      const code = saltIndex(body[i + 4]);
      const id = SALT_CODE_TO_ID[`${type}:${code}`];
      if (!id) { skipped++; continue; }
      const entity = SC2_DATA.entities[id];
      if (!entity) { skipped++; continue; }
      if (!race) race = entity.race;
      // Suppress meaningless 0-supply/0-time padding entries that sometimes
      // appear at the end of a SALT string.
      if (sup === 0 && min === 0 && sec === 0 && i > 0 && type === 0 && code === 0) continue;
      buildOrder.push({ entityId: id, repeat: 1 });
    }
    if (!race) race = 'terran';
    return { name, race, buildOrder, skipped };
  }

  // ============================================================
  // Plain-text build-order formatter
  // ============================================================
  // Produces a human-readable list with optional filters. We walk the
  // simulator's *timeline* (sorted by start time, ties by end time) so
  // output is in strict chronological order — that may differ from the
  // user's editor order under resource priority.
  //
  // Time semantics: each row's first time is the START time (when the
  // player clicks). For things where the FINISH time matters to a reader
  // (buildings come online; addons attach; upgrades grant their effect),
  // we also append "→ finish" so the export is unambiguous. Units only
  // show the start time — the SC2 build-order convention.
  //   options: { omitWorkers, omitArmy, simplify, includeSupply, includeTime }
  function formatBuildOrderText(buildOrder, race, timeline, options = {}) {
    const opts = {
      omitWorkers: false, omitArmy: false, simplify: false,
      includeSupply: true, includeTime: true,
      ...options,
    };
    // Things where the finish time matters to a reader (the action's
    // effect is at the END, not the START).
    const showsFinish = e => e && (e.type === 'building' || e.type === 'addon' || e.type === 'upgrade');

    // Normalize: timeline entries that begin "swap_<from>_to_<to>" are
    // pseudo-events; turn them into a friendly label and keep them in
    // their chronological slot.
    const events = (timeline || []).slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const rows = [];
    let i = 0;
    while (i < events.length) {
      const t = events[i];
      const id = t.id;
      // --- swap row (always show start → finish; the swap "completes"
      // when the addon lands on the new building) ---
      if (typeof id === 'string' && id.startsWith('swap_')) {
        const m = id.match(/^swap_(.+)_to_(.+)$/);
        const fromN = m ? (SC2_DATA.entities[m[1]]?.name || m[1]) : id;
        const toN = m ? (SC2_DATA.entities[m[2]]?.name || m[2]) : '';
        const time = opts.includeTime ? `${fmtTime(t.start)} → ${fmtTime(t.end)}` : null;
        rows.push({ supply: '', time, action: `Swap addon: ${fromN} → ${toN}` });
        i++; continue;
      }
      const e = SC2_DATA.entities[id];
      if (!e) { i++; continue; }
      const isWorker = e.role === 'worker';
      const isArmy = e.type === 'unit' && !isWorker;
      if (opts.omitWorkers && isWorker) { i++; continue; }
      if (opts.omitArmy && isArmy) { i++; continue; }

      // --- simplify: collapse 3+ consecutive identical unit-production
      // events (workers OR army) into one "Continuously produce …" line.
      // Filtered-out events are skipped as we walk so a run of marines
      // separated by an omitted scv still collapses cleanly. ---
      if (opts.simplify && (isArmy || isWorker)) {
        let runEnd = i;
        let count = 1;
        let lastTime = t.end;
        for (let j = i + 1; j < events.length; j++) {
          const tj = events[j];
          // Skip events that the current filters drop entirely.
          const ej = SC2_DATA.entities[tj.id];
          if (!ej) break;
          const ejWorker = ej.role === 'worker';
          const ejArmy = ej.type === 'unit' && !ejWorker;
          if ((opts.omitWorkers && ejWorker) || (opts.omitArmy && ejArmy)) continue;
          if (tj.id !== id) break;
          runEnd = j;
          count++;
          lastTime = tj.end;
        }
        if (count >= 3) {
          const time = opts.includeTime ? fmtTime(t.start) : null;
          const sup = (opts.includeSupply && t.resBefore) ? Math.round(t.resBefore.supply_used) : '';
          const endLabel = opts.includeTime ? ` until ${fmtTime(lastTime)}` : '';
          rows.push({
            supply: sup,
            time,
            action: `Continuously produce ${e.name} (×${count})${endLabel}`,
          });
          i = runEnd + 1;
          continue;
        }
      }

      // For buildings/addons/upgrades, append the finish time so a reader
      // can tell at a glance when the effect is online. Units stay
      // start-only — that's the SC2 build-order convention.
      const time = opts.includeTime
        ? (showsFinish(e) ? `${fmtTime(t.start)} → ${fmtTime(t.end)}` : fmtTime(t.start))
        : null;
      const sup = (opts.includeSupply && t.resBefore) ? Math.round(t.resBefore.supply_used) : '';
      const tag = e.type === 'upgrade' ? ' (research)' : '';
      rows.push({ supply: sup, time, action: `${e.name}${tag}` });
      i++;
    }

    // --- failed steps: anything in the user's build order that has no
    // corresponding timeline entry (couldn't fire) gets appended at the
    // bottom under a "Did not fire:" header so the user can see what was
    // skipped.
    const stepResults = mapStepsToTimeline(buildOrder || [], events);
    const failed = [];
    for (let k = 0; k < (buildOrder || []).length; k++) {
      const step = buildOrder[k];
      if (step.kind === 'priority') continue; // never appears in timeline
      if (stepResults[k]) continue;
      if (step.kind === 'swap') {
        const fromN = SC2_DATA.entities[step.from]?.name || step.from;
        const toN = SC2_DATA.entities[step.to]?.name || step.to;
        failed.push(`Swap addon: ${fromN} → ${toN}`);
      } else if (step.entityId) {
        const ent = SC2_DATA.entities[step.entityId];
        const isW = ent?.role === 'worker';
        const isA = ent?.type === 'unit' && !isW;
        if (opts.omitWorkers && isW) continue;
        if (opts.omitArmy && isA) continue;
        const repeat = step.repeat || 1;
        failed.push(`${ent?.name || step.entityId}${repeat > 1 ? ' ×' + repeat : ''}`);
      }
    }

    const header = [];
    const racePretty = race ? race[0].toUpperCase() + race.slice(1) : '';
    if (racePretty) header.push(`Race: ${racePretty}`);
    const filters = [];
    if (opts.omitWorkers) filters.push('workers omitted');
    if (opts.omitArmy) filters.push('army omitted');
    if (opts.simplify) filters.push('simplified');
    if (filters.length) header.push(`(${filters.join(', ')})`);
    const headerParts = [];
    if (header.length) headerParts.push(header.join(' '));
    if (opts.includeTime) {
      headerParts.push('Times are GAME seconds (Faster speed). For units: time = when production starts. For buildings/upgrades: start → finish.');
    }
    const headerLine = headerParts.length ? headerParts.join('\n') + '\n' : '';
    const failedBlock = failed.length
      ? `\n\nDid not fire (resource/tech-blocked):\n  - ${failed.join('\n  - ')}`
      : '';
    // Dynamic column widths so "0:00" and "0:00 → 1:30" align in the
    // same column.
    const supplyW = opts.includeSupply
      ? Math.max(3, ...rows.map(r => String(r.supply ?? '').length))
      : 0;
    const timeW = opts.includeTime
      ? Math.max(5, ...rows.map(r => String(r.time ?? '').length))
      : 0;
    const lines = rows.map(r => {
      const cols = [];
      if (opts.includeSupply) cols.push(String(r.supply ?? '').padStart(supplyW, ' '));
      if (opts.includeTime) cols.push(String(r.time ?? '').padStart(timeW, ' '));
      cols.push(r.action);
      return cols.join('  ');
    });
    return headerLine + lines.join('\n') + failedBlock;
  }

  // ============================================================
  // Share / Export modal
  // ============================================================
  function openShareModal() {
    const existing = document.getElementById('forge-share-overlay');
    if (existing) existing.remove();
    if (!state.forgeOrder.length) {
      alert('Build is empty — add steps first.');
      return;
    }
    // Always re-run the simulator so the export reflects the current
    // build, even if a debounced edit hasn't fired yet. runForge() is
    // synchronous and updates state.forgeResult.
    runForge();

    const overlay = document.createElement('div');
    overlay.id = 'forge-share-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide share-modal">
        <div class="library-head">
          <div>
            <h4>Share build order</h4>
            <p class="library-sub">Copy as plain text, export to SALT (spawningtool format), or paste a SALT string to import.</p>
          </div>
          <button type="button" class="ghost icon-btn" data-act="close" title="Close">✕</button>
        </div>

        <div class="share-tabs" role="tablist">
          <button type="button" class="share-tab active" data-tab="text">📋 Copy text</button>
          <button type="button" class="share-tab" data-tab="salt">🧂 SALT</button>
        </div>

        <!-- ----- Text tab ----- -->
        <div class="share-pane share-pane-text active" data-pane="text">
          <div class="share-options">
            <label class="toggle"><input type="checkbox" id="share-omit-workers" /><span>Omit workers</span></label>
            <label class="toggle"><input type="checkbox" id="share-omit-army" /><span>Omit army</span></label>
            <label class="toggle"><input type="checkbox" id="share-simplify" /><span>Simplify (collapse repeats into "continuously produce …")</span></label>
            <label class="toggle"><input type="checkbox" id="share-include-supply" checked /><span>Include supply</span></label>
            <label class="toggle"><input type="checkbox" id="share-include-time" checked /><span>Include time</span></label>
          </div>
          <textarea id="share-text-out" class="share-textarea share-textarea-tall" readonly rows="22"></textarea>
          <div class="share-actions">
            <span class="share-skipped" id="share-text-skipped"></span>
            <button type="button" class="ghost" data-act="copy-text">📋 Copy to clipboard</button>
          </div>
        </div>

        <!-- ----- SALT tab ----- -->
        <div class="share-pane share-pane-salt" data-pane="salt">
          <div class="share-section">
            <div class="share-section-head">Export this build as SALT</div>
            <textarea id="share-salt-out" class="share-textarea share-mono" readonly rows="3"></textarea>
            <div class="share-actions">
              <span class="share-skipped" id="share-salt-skipped"></span>
              <button type="button" class="ghost" data-act="copy-salt">📋 Copy SALT</button>
            </div>
          </div>
          <div class="share-section">
            <div class="share-section-head">Import a SALT string</div>
            <textarea id="share-salt-in" class="share-textarea share-mono" placeholder="Paste a SALT string, e.g. $201006|spawningtool.com||~* 0 /, H !, …" rows="3"></textarea>
            <div class="share-actions">
              <span class="share-skipped" id="share-salt-import-msg"></span>
              <button type="button" class="ghost" data-act="import-salt-library">Save to library</button>
              <button type="button" data-act="import-salt-forge">Open in Forge</button>
            </div>
          </div>
          <p class="share-foot">SALT v4 has no slot for some modern entities (Disruptor add-on patches, multi-level upgrade tiers, etc.). Unmappable steps are listed below the export.</p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Tab switching
    overlay.querySelectorAll('.share-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.share-tab').forEach(b => b.classList.toggle('active', b === btn));
        overlay.querySelectorAll('.share-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
      });
    });

    // Generic close
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => overlay.remove());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    // ----- Text tab live preview -----
    const textOut = overlay.querySelector('#share-text-out');
    const textSkip = overlay.querySelector('#share-text-skipped');
    const refreshText = () => {
      const opts = {
        omitWorkers: overlay.querySelector('#share-omit-workers').checked,
        omitArmy: overlay.querySelector('#share-omit-army').checked,
        simplify: overlay.querySelector('#share-simplify').checked,
        includeSupply: overlay.querySelector('#share-include-supply').checked,
        includeTime: overlay.querySelector('#share-include-time').checked,
      };
      const text = formatBuildOrderText(
        state.forgeOrder, state.forgeRace, state.forgeResult?.timeline || [], opts
      );
      textOut.value = text;
      // Show row count so it's obvious nothing is truncated, even when
      // the textarea has to scroll internally.
      const lines = text.split('\n').filter(l => l.length).length;
      const tlEvents = (state.forgeResult?.timeline || []).filter(t => !(typeof t.id === 'string' && t.id.startsWith('swap_'))).length;
      textSkip.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${tlEvents} timeline event${tlEvents === 1 ? '' : 's'} from sim`;
    };
    overlay.querySelectorAll('.share-options input').forEach(el => {
      el.addEventListener('change', refreshText);
    });
    refreshText();

    overlay.querySelector('[data-act="copy-text"]').addEventListener('click', async (ev) => {
      await copyAndFlash(textOut.value, ev.currentTarget);
    });

    // ----- SALT tab -----
    const saltOut = overlay.querySelector('#share-salt-out');
    const saltSkip = overlay.querySelector('#share-salt-skipped');
    const result = encodeSALT(
      state.forgeResult?.timeline || [],
      `sc2-timings ${state.forgeRace} build`
    );
    saltOut.value = result.encoded;
    if (result.skipped.length) {
      const u = [...new Set(result.skipped)];
      saltSkip.textContent = `Skipped (no SALT slot): ${u.slice(0, 6).join(', ')}${u.length > 6 ? ` +${u.length - 6} more` : ''}`;
    }
    overlay.querySelector('[data-act="copy-salt"]').addEventListener('click', async (ev) => {
      await copyAndFlash(saltOut.value, ev.currentTarget);
    });

    const saltIn = overlay.querySelector('#share-salt-in');
    const saltImportMsg = overlay.querySelector('#share-salt-import-msg');
    const tryImport = (mode) => {
      const raw = (saltIn.value || '').trim();
      if (!raw) { saltImportMsg.textContent = 'Paste a SALT string first.'; return; }
      try {
        const decoded = decodeSALT(raw);
        if (!decoded.buildOrder.length) {
          saltImportMsg.textContent = 'Decoded 0 steps — none of the codes were recognized.';
          return;
        }
        const skipMsg = decoded.skipped ? ` (${decoded.skipped} step${decoded.skipped === 1 ? '' : 's'} skipped)` : '';
        if (mode === 'forge') {
          if (state.forgeOrder.length && !confirm('Replace the current Forge build?')) return;
          applyBuildToForge({ race: decoded.race, buildOrder: decoded.buildOrder, priority: null });
          overlay.remove();
        } else {
          saveBuildToLibrary({
            name: decoded.name,
            race: decoded.race,
            buildOrder: decoded.buildOrder,
            priority: null,
            source: 'import',
          });
          saltImportMsg.textContent = `Saved "${decoded.name}" to library — ${decoded.buildOrder.length} step${decoded.buildOrder.length === 1 ? '' : 's'}${skipMsg}.`;
        }
      } catch (err) {
        saltImportMsg.textContent = `Couldn't decode: ${err.message}`;
      }
    };
    overlay.querySelector('[data-act="import-salt-forge"]').addEventListener('click', () => tryImport('forge'));
    overlay.querySelector('[data-act="import-salt-library"]').addEventListener('click', () => tryImport('library'));
  }

  async function copyAndFlash(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // Fallback for older browsers / insecure contexts: select + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* give up */ }
      ta.remove();
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied ✓';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1100);
    }
  }

  // Replay-import picker — shown after parsing a .SC2Replay. Lets the user
  // pick which player's build to save (or both), and adjust the in-game-time
  // capture window without re-opening the file. Each option previews the
  // first few steps so it's clear which side is which.
  function openReplayPicker(arrayBuffer, filename) {
    const existing = document.getElementById('replay-picker-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'replay-picker-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <div class="library-head">
          <div>
            <h4>Replay imported</h4>
            <p class="library-sub" id="picker-sub">${escapeHtml(filename)} — parsing…</p>
          </div>
          <button type="button" class="ghost icon-btn" data-act="close" title="Close">✕</button>
        </div>
        <div class="picker-toolbar">
          <label class="picker-duration">
            Capture first
            <input type="number" id="picker-mins" min="1" max="30" step="1" value="5" />
            in-game minutes
            <span class="picker-hint">(SC2's clock — extend if you're missing late steps)</span>
          </label>
        </div>
        <div id="picker-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    let currentResult = null;
    const sub = overlay.querySelector('#picker-sub');
    const body = overlay.querySelector('#picker-body');
    const minsInput = overlay.querySelector('#picker-mins');

    async function rerun() {
      body.innerHTML = `<div class="library-empty">Parsing replay…</div>`;
      const mins = Math.max(1, Math.min(30, parseInt(minsInput.value, 10) || 5));
      try {
        currentResult = await synthesizeBuildOrders(arrayBuffer, { maxGameSeconds: mins * 60 });
        sub.textContent = `${filename} — ${currentResult.map || ''}. First ${mins} in-game minute${mins === 1 ? '' : 's'}.`;
        renderPickerBody();
      } catch (err) {
        console.error(err);
        body.innerHTML = `<div class="library-empty">Couldn't parse: ${escapeHtml(err.message)}</div>`;
      }
    }

    function renderPickerBody() {
      const usable = currentResult.players.filter(p => p.race && p.buildOrder.length);
      const empty = currentResult.players.filter(p => p.race && !p.buildOrder.length);
      const cards = usable.map((p, i) => {
        const preview = p.buildOrder.slice(0, 6).map(s => {
          if (s.kind === 'swap') {
            const fromN = SC2_DATA.entities[s.from]?.name || s.from;
            const toN = SC2_DATA.entities[s.to]?.name || s.to;
            return `<span class="replay-step replay-step-swap">⇄ ${escapeHtml(fromN)} → ${escapeHtml(toN)}</span>`;
          }
          const e = SC2_DATA.entities[s.entityId];
          const r = (s.repeat || 1) > 1 ? ` ×${s.repeat}` : '';
          return `<span class="replay-step">${escapeHtml(e?.name || s.entityId)}${r}</span>`;
        }).join('');
        const more = p.buildOrder.length > 6 ? `<span class="replay-more">+${p.buildOrder.length - 6} more</span>` : '';
        const resultLabel = p.result === 1 ? '<span class="replay-result win">Win</span>'
                         : p.result === 2 ? '<span class="replay-result loss">Loss</span>' : '';
        return `
          <div class="replay-player" data-idx="${i}">
            <div class="replay-player-head">
              <span class="race-chip race-${p.race}">${p.race}</span>
              <span class="replay-name">${escapeHtml(p.name || `Player ${p.slot}`)}</span>
              ${resultLabel}
              <span class="replay-stepcount">${p.buildOrder.length} steps</span>
            </div>
            <div class="replay-preview">${preview}${more}</div>
            <div class="replay-player-actions">
              <button type="button" data-act="open">Open in Forge</button>
              <button type="button" class="ghost" data-act="save">Save to library</button>
            </div>
          </div>
        `;
      }).join('');
      const emptyNote = empty.length
        ? `<div class="replay-empty-note">No build extracted for ${empty.map(p => escapeHtml(p.name || `Player ${p.slot}`)).join(', ')} — possibly a Brood War mode or unsupported unit set.</div>`
        : '';
      body.innerHTML = `<div class="replay-players">${cards || '<div class="library-empty">No usable build extracted from this replay.</div>'}</div>${emptyNote}`;

      body.querySelectorAll('.replay-player').forEach(card => {
        const idx = +card.dataset.idx;
        const player = usable[idx];
        const baseName = () => `${player.name || ('Player ' + player.slot)} — ${currentResult.map || 'replay'} (${player.race})`;
        card.querySelector('[data-act="open"]').addEventListener('click', () => {
          applyBuildToForge({ race: player.race, buildOrder: player.buildOrder, priority: null });
          overlay.remove();
          document.getElementById('build-library-overlay')?.remove();
        });
        card.querySelector('[data-act="save"]').addEventListener('click', () => {
          saveBuildToLibrary({
            name: baseName(),
            race: player.race,
            buildOrder: player.buildOrder,
            priority: null,
            source: 'replay',
          });
          renderBuildLibraryList();
          const btn = card.querySelector('[data-act="save"]');
          const original = btn.textContent;
          btn.textContent = 'Saved ✓';
          btn.disabled = true;
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
        });
      });
    }

    // Re-synth on duration change (debounced — slider/typing fires lots of input events)
    let _t = null;
    minsInput.addEventListener('input', () => {
      clearTimeout(_t);
      _t = setTimeout(rerun, 220);
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => overlay.remove());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    rerun();
  }

  // ============================================================
  // Replay → build-order synthesis
  // ============================================================
  // Maps SC2 in-game unit/building/upgrade names (as they appear in
  // replay.tracker.events) to entity IDs used by the SC2 Timings sim.
  // Anything not in this map (or not derivable via PascalCase→snake_case)
  // is silently skipped. Cosmetic upgrades (sprays, dances, decals) are
  // explicitly listed so they don't pollute the order.
  const REPLAY_UNIT_MAP = {
    // Terran buildings + addons
    CommandCenter: 'command_center', OrbitalCommand: 'orbital_command',
    PlanetaryFortress: 'planetary_fortress', SupplyDepot: 'supply_depot',
    SupplyDepotLowered: 'supply_depot', Refinery: 'refinery', Barracks: 'barracks',
    BarracksFlying: 'barracks', EngineeringBay: 'engineering_bay', Bunker: 'bunker',
    MissileTurret: 'missile_turret', SensorTower: 'sensor_tower', Factory: 'factory',
    FactoryFlying: 'factory', GhostAcademy: 'ghost_academy', Starport: 'starport',
    StarportFlying: 'starport', Armory: 'armory', FusionCore: 'fusion_core',
    BarracksTechLab: 'barracks_techlab', BarracksReactor: 'barracks_reactor',
    FactoryTechLab: 'factory_techlab', FactoryReactor: 'factory_reactor',
    StarportTechLab: 'starport_techlab', StarportReactor: 'starport_reactor',
    // Terran units
    SCV: 'scv', MULE: null, Marine: 'marine', Marauder: 'marauder', Reaper: 'reaper',
    Ghost: 'ghost', Hellion: 'hellion', Hellbat: 'hellbat', WidowMine: 'widow_mine',
    Cyclone: 'cyclone', SiegeTank: 'siege_tank', SiegeTankSieged: 'siege_tank',
    Thor: 'thor', ThorAP: 'thor', VikingFighter: 'viking', VikingAssault: 'viking',
    Medivac: 'medivac', Liberator: 'liberator', LiberatorAG: 'liberator',
    Banshee: 'banshee', Raven: 'raven', Battlecruiser: 'battlecruiser',

    // Protoss buildings
    Nexus: 'nexus', Pylon: 'pylon', Assimilator: 'assimilator', Gateway: 'gateway',
    WarpGate: 'gateway', Forge: 'forge', CyberneticsCore: 'cybernetics_core',
    PhotonCannon: 'photon_cannon', ShieldBattery: 'shield_battery',
    TwilightCouncil: 'twilight_council', Stargate: 'stargate',
    RoboticsFacility: 'robotics_facility', RoboticsBay: 'robotics_bay',
    TemplarArchive: 'templar_archives', TemplarArchives: 'templar_archives',
    DarkShrine: 'dark_shrine', FleetBeacon: 'fleet_beacon',
    // Protoss units
    Probe: 'probe', Zealot: 'zealot', Stalker: 'stalker', Sentry: 'sentry',
    Adept: 'adept', HighTemplar: 'high_templar', DarkTemplar: 'dark_templar',
    Archon: 'archon', Immortal: 'immortal', Colossus: 'colossus', Disruptor: 'disruptor',
    Observer: 'observer', WarpPrism: 'warp_prism', WarpPrismPhasing: 'warp_prism',
    Phoenix: 'phoenix', VoidRay: 'void_ray', Oracle: 'oracle', Tempest: 'tempest',
    Carrier: 'carrier', Mothership: 'mothership',

    // Zerg buildings
    Hatchery: 'hatchery', Lair: 'lair', Hive: 'hive', Extractor: 'extractor',
    SpawningPool: 'spawning_pool', EvolutionChamber: 'evolution_chamber',
    RoachWarren: 'roach_warren', BanelingNest: 'baneling_nest',
    SpineCrawler: 'spine_crawler', SpineCrawlerUprooted: 'spine_crawler',
    SporeCrawler: 'spore_crawler', SporeCrawlerUprooted: 'spore_crawler',
    HydraliskDen: 'hydralisk_den', LurkerDen: 'lurker_den',
    LurkerDenMP: 'lurker_den', InfestationPit: 'infestation_pit',
    Spire: 'spire', GreaterSpire: 'greater_spire', NydusNetwork: 'nydus_network',
    UltraliskCavern: 'ultralisk_cavern',
    // Zerg units
    Drone: 'drone', Larva: null, Overlord: 'overlord', Queen: 'queen',
    Zergling: 'zergling', Baneling: 'baneling', Roach: 'roach', Ravager: 'ravager',
    Hydralisk: 'hydralisk', Lurker: 'lurker', LurkerMP: 'lurker',
    Mutalisk: 'mutalisk', Corruptor: 'corruptor', BroodLord: 'brood_lord',
    Overseer: 'overseer', Infestor: 'infestor', SwarmHostMP: 'swarm_host',
    Viper: 'viper', Ultralisk: 'ultralisk', NydusCanal: 'nydus_worm',

    // Skip these entirely (cosmetic, intermediate, or neutral)
    Egg: null, Cocoon: null, BroodLordCocoon: null, RavagerCocoon: null,
    BanelingCocoon: null, OverlordCocoon: null, LurkerMPEgg: null,
    TransportOverlordCocoon: null, OverseerSiegeMode: null,
    AutoTurret: null, PointDefenseDrone: null, KD8Charge: null,
  };

  const REPLAY_UPGRADE_MAP = {
    Stimpack: 'stimpack', stimpack: 'stimpack',
    ShieldWall: 'combat_shield', PunisherGrenades: 'concussive_shells',
    PersonalCloaking: 'personal_cloaking', DrillClaws: 'drilling_claws',
    SmartServos: 'smart_servos', BansheeCloak: 'cloaking_field',
    BansheeSpeed: 'hyperflight_rotors', InterferenceMatrix: 'interference_matrix',
    MedivacIncreaseSpeedBoost: 'caduceus_reactor',
    BattlecruiserEnableSpecializations: 'weapon_refit',
    YamatoCannon: 'yamato_cannon',
    TerranInfantryWeaponsLevel1: 'inf_weapons_1',
    TerranInfantryWeaponsLevel2: 'inf_weapons_2',
    TerranInfantryWeaponsLevel3: 'inf_weapons_3',
    TerranInfantryArmorsLevel1: 'inf_armor_1',
    TerranInfantryArmorsLevel2: 'inf_armor_2',
    TerranInfantryArmorsLevel3: 'inf_armor_3',
    WarpGateResearch: 'warpgate_research',
    HallucinationResearch: 'hallucination', Charge: 'charge', BlinkTech: 'blink',
    AdeptPiercingAttack: 'resonating_glaives', PsiStormTech: 'psionic_storm',
    DarkTemplarBlinkUpgrade: 'shadow_stride',
    ExtendedThermalLance: 'extended_thermal_lance',
    ObserverGraviticBooster: 'gravitic_boosters', GraviticDrive: 'gravitic_drive',
    PhoenixRangeUpgrade: 'anion_pulse_crystals',
    TempestGroundAttackUpgrade: 'tectonic_destabilizers',
    zerglingmovementspeed: 'metabolic_boost', zerglingattackspeed: 'adrenal_glands',
    CentrificalHooks: 'centrifugal_hooks', GlialReconstitution: 'glial_reconstitution',
    TunnelingClaws: 'tunneling_claws', EvolveMuscularAugments: 'muscular_augments',
    EvolveGroovedSpines: 'grooved_spines', LurkerRange: 'seismic_spines',
    overlordspeed: 'pneumatized_carapace', overlordtransport: 'ventral_sacs',
    NeuralParasite: 'neural_parasite', InfestorEnergyUpgrade: 'pathogen_glands',
    DiggingClaws: 'adaptive_talons', ChitinousPlating: 'chitinous_plating',
    AnabolicSynthesis: 'anabolic_synthesis',
    ZergMeleeWeaponsLevel1: 'melee_attack_1', ZergMeleeWeaponsLevel2: 'melee_attack_2', ZergMeleeWeaponsLevel3: 'melee_attack_3',
    ZergMissileWeaponsLevel1: 'missile_attack_1', ZergMissileWeaponsLevel2: 'missile_attack_2', ZergMissileWeaponsLevel3: 'missile_attack_3',
    ZergGroundArmorsLevel1: 'ground_armor_1', ZergGroundArmorsLevel2: 'ground_armor_2', ZergGroundArmorsLevel3: 'ground_armor_3',
  };

  // Decide if a replay event represents an action we want in the build order.
  // Returns { entityId } when matched, or null to skip.
  function mapReplayEvent(eventName, typeName, race) {
    if (eventName === 'Upgrade') {
      if (/^(Spray|RewardDance|Reward[A-Z]|Decal)/.test(typeName)) return null;
      const id = REPLAY_UPGRADE_MAP[typeName];
      if (id && SC2_DATA.entities[id]) return { entityId: id };
      return null;
    }
    if (eventName === 'UnitInit' || eventName === 'UnitBorn' || eventName === 'UnitTypeChange') {
      // Skip neutral / cosmetic / control-group beacons / map decorations
      if (/^(Beacon|MineralField|VespeneGeyser|XelNagaTower|DestructibleRock|Destructible|ForceField|Inhibitor|HealingShrine|RichMineralField|LabMineralField|UnbuildablePlates|UnbuildableBricks|Acceleration|CleaningBot|Debris|Anteplott|Compound|Chimera|Pickup)/.test(typeName)) return null;
      if (typeName in REPLAY_UNIT_MAP) {
        const id = REPLAY_UNIT_MAP[typeName];
        if (id == null) return null;
        return SC2_DATA.entities[id] ? { entityId: id } : null;
      }
      // Fallback: PascalCase → snake_case if it matches an entity of the right race
      const snake = typeName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      if (SC2_DATA.entities[snake] && SC2_DATA.entities[snake].race === race) {
        return { entityId: snake };
      }
      return null;
    }
    return null;
  }

  // SC2 stores clan tags as "<TAG><sp/>Name" with literal angle brackets and
  // a "<sp/>" placeholder for the space. Strip back to a friendly display.
  function cleanPlayerName(s) {
    if (!s) return '';
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<sp\/>/g, ' ')
      .replace(/^<[^>]*>\s*/, '')        // strip leading clan tag
      .trim();
  }

  // Synthesize a build order per player from a replay buffer. Returns:
  //   { map, gameSpeed, players: [{ name, race, slot, result, buildOrder }] }
  // Cap is in *in-game* seconds (5 min default = 4800 tracker gameloops).
  // Initial-state events (gameloop 0: starting workers + main + Zerg's first
  // Overlord) are dropped because the simulator already models them.
  async function synthesizeBuildOrders(arrayBuffer, { maxGameSeconds = 300 } = {}) {
    if (!window.SC2Replay) throw new Error('replay.js not loaded');
    const { openMPQ, parseReplayDetails, parseTrackerEvents, _internal } = window.SC2Replay;
    const utf8 = _internal.utf8;

    const mpq = await openMPQ(arrayBuffer);
    const detailsBytes = await mpq.extract('replay.details');
    const trackerBytes = await mpq.extract('replay.tracker.events');
    if (!detailsBytes || !trackerBytes) {
      throw new Error('Replay is missing required streams');
    }
    const details = parseReplayDetails(detailsBytes);
    const events = parseTrackerEvents(trackerBytes, { maxLoops: maxGameSeconds * 16 });

    const normRace = (r) => {
      if (!r) return null;
      const s = String(r).toLowerCase();
      if (s.includes('terran')) return 'terran';
      if (s.includes('protoss')) return 'protoss';
      if (s.includes('zerg')) return 'zerg';
      return null;
    };

    // Build a tag→ownerSlot map from UnitInit/UnitBorn events. UnitTypeChange
    // events don't carry controlPlayerId, so we need this to attribute lift/
    // land events (used for addon-swap detection) to the right player.
    const unitOwner = new Map();
    for (const e of events) {
      if ((e.eventName === 'UnitInit' || e.eventName === 'UnitBorn') && e.data) {
        unitOwner.set(e.data[0], e.data[3]);
      }
    }

    const players = details.players.map((p, idx) => {
      const race = normRace(p.race);
      const slot = idx + 1;
      const order = [];

      // Swap detection state — Terran-only: which addon is on which
      // production building, plus when each building last lifted off.
      // SC2 addons sit at parent.x + 2.5, same y, so we use that to map an
      // addon UnitInit back to its parent at the moment it was placed.
      const SWAP_FAMILY = { Barracks: 'barracks', Factory: 'factory', Starport: 'starport' };
      const FLYING_TO_GROUND = { BarracksFlying: 'Barracks', FactoryFlying: 'Factory', StarportFlying: 'Starport' };
      const ADDON_FAMILY_RE = /^(Barracks|Factory|Starport)(TechLab|Reactor)$/;
      const SWAP_WINDOW_LOOPS = 5 * 16; // 5 in-game seconds

      // Map<tag, { family, x, y, addonTag|null }>
      const productionBuildings = new Map();
      // Map<tag, addonEntityId>  e.g. 1234 → 'barracks_techlab'
      const addonByTag = new Map();
      // Map<tag, gameloop>  buildings that are currently in flying state
      const liftedAt = new Map();

      function appendStep(step) {
        const last = order[order.length - 1];
        if (last && step.entityId && last.entityId === step.entityId && !step.kind) {
          last.repeat = (last.repeat || 1) + 1;
        } else {
          order.push(step);
        }
      }

      for (const e of events) {
        const typeName = utf8(e.eventName === 'Upgrade' ? e.data[1] : e.data[2]);
        // controlPlayerId for type-changes lives in the unitOwner map, not in
        // the event itself.
        const ctrl = e.eventName === 'Upgrade' ? e.data[0]
                    : e.eventName === 'UnitTypeChange' ? unitOwner.get(e.data && e.data[0])
                    : (e.data && e.data[3]);

        // -- Update swap-detection bookkeeping (Terran only, all gameloops) --
        if (race === 'terran' && ctrl === slot && typeName) {
          if (e.eventName === 'UnitInit' || e.eventName === 'UnitBorn') {
            const tag = e.data[0];
            const x = e.data[5], y = e.data[6];
            if (SWAP_FAMILY[typeName]) {
              productionBuildings.set(tag, { family: SWAP_FAMILY[typeName], x, y, addonTag: null });
            } else if (ADDON_FAMILY_RE.test(typeName)) {
              const addonId = REPLAY_UNIT_MAP[typeName];
              addonByTag.set(tag, addonId);
              // Closest production building of compatible family that has no addon yet
              const fam = typeName.match(ADDON_FAMILY_RE)[1].toLowerCase();
              let parentTag = null, bestDist = Infinity;
              for (const [pTag, p] of productionBuildings) {
                if (p.family !== fam || p.addonTag) continue;
                const dx = (p.x + 2.5) - x;
                const dy = p.y - y;
                const d = dx * dx + dy * dy;
                if (d < bestDist) { bestDist = d; parentTag = pTag; }
              }
              if (parentTag) productionBuildings.get(parentTag).addonTag = tag;
            }
          } else if (e.eventName === 'UnitTypeChange') {
            const tag = e.data[0];
            if (FLYING_TO_GROUND[typeName]) {                       // lifted off
              liftedAt.set(tag, e.gameloop);
            } else if (SWAP_FAMILY[typeName]) {                     // landed
              // Did another production building lift in the same window? If so,
              // call it a swap and emit appropriate swap step(s).
              const myLift = liftedAt.get(tag);
              if (myLift != null) {
                let partnerTag = null;
                let partnerLift = -Infinity;
                for (const [otherTag, otherLift] of liftedAt) {
                  if (otherTag === tag) continue;
                  if (Math.abs(myLift - otherLift) <= SWAP_WINDOW_LOOPS && otherLift > partnerLift) {
                    partnerTag = otherTag; partnerLift = otherLift;
                  }
                }
                if (partnerTag != null) {
                  const A = productionBuildings.get(tag);
                  const B = productionBuildings.get(partnerTag);
                  if (A && B && A.family !== B.family) {
                    // Swap: any addon attached to A goes to B (renamed for B's family) and vice versa.
                    const aAddon = A.addonTag ? addonByTag.get(A.addonTag) : null;
                    const bAddon = B.addonTag ? addonByTag.get(B.addonTag) : null;
                    if (aAddon) {
                      const newId = aAddon.replace(/^[^_]+/, B.family);
                      if (SC2_DATA.entities[newId]) appendStep({ kind: 'swap', from: aAddon, to: newId });
                    }
                    if (bAddon) {
                      const newId = bAddon.replace(/^[^_]+/, A.family);
                      if (SC2_DATA.entities[newId]) appendStep({ kind: 'swap', from: bAddon, to: newId });
                    }
                    // Exchange addon ownership in our model
                    [A.addonTag, B.addonTag] = [B.addonTag, A.addonTag];
                    if (A.addonTag) addonByTag.set(A.addonTag, aAddon ? aAddon.replace(/^[^_]+/, A.family) : addonByTag.get(A.addonTag));
                    if (B.addonTag) addonByTag.set(B.addonTag, bAddon ? bAddon.replace(/^[^_]+/, B.family) : addonByTag.get(B.addonTag));
                    liftedAt.delete(partnerTag);
                  }
                }
                liftedAt.delete(tag);
              }
            }
          }
        }

        // -- Append regular build steps --
        if (e.gameloop === 0) continue;
        if (e.eventName === 'UnitDone') continue;
        if (ctrl !== slot) continue;
        if (!typeName) continue;
        const m = mapReplayEvent(e.eventName, typeName, race);
        if (!m) continue;
        appendStep({ entityId: m.entityId, repeat: 1 });
      }
      return {
        name: cleanPlayerName(p.name),
        rawName: p.name,
        race,
        slot,
        result: p.result,
        buildOrder: order,
      };
    }).filter(p => p.race);

    return {
      map: details.map,
      gameSpeed: details.gameSpeed,
      players,
    };
  }

  function renderForge() {
    document.getElementById('forge-race').value = state.forgeRace;
    populateForgePresets();
    populateForgeAddDropdown();
    renderForgePriority();
    renderForgeQuickAdd();
    renderForgeBrowse();
    renderForgeList();
    renderForgeResult();
  }

  // Resource-priority control: a small reorderable strip of tier chips.
  // Click ◀/▶ on a chip to swap with its neighbor. The simulator uses
  // this order to decide who probes first when steps could fire at the
  // same instant and contend for the same resources.
  function renderForgePriority() {
    const root = document.getElementById('forge-priority');
    if (!root) return;
    state.forgePriority = sanitizePriority(state.forgePriority);
    const labels = { worker: 'Workers', building: 'Buildings', tech: 'Tech', army: 'Army' };
    root.innerHTML = state.forgePriority.map((tier, idx) => `
      <div class="priority-chip" data-tier="${tier}" data-idx="${idx}">
        <button type="button" class="priority-arrow" data-act="up" ${idx === 0 ? 'disabled' : ''} title="Higher priority">◀</button>
        <span class="priority-name">${idx + 1}. ${labels[tier]}</span>
        <button type="button" class="priority-arrow" data-act="down" ${idx === state.forgePriority.length - 1 ? 'disabled' : ''} title="Lower priority">▶</button>
      </div>
    `).join('');
    for (const btn of root.querySelectorAll('button[data-act]')) {
      btn.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.priority-chip');
        const idx = parseInt(chip.dataset.idx, 10);
        const act = btn.dataset.act;
        const order = state.forgePriority.slice();
        if (act === 'up' && idx > 0) {
          [order[idx], order[idx - 1]] = [order[idx - 1], order[idx]];
        } else if (act === 'down' && idx < order.length - 1) {
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        }
        state.forgePriority = order;
        renderForgePriority();
        scheduleForgeRun();
      });
    }
  }

  // Tier of an entity = depth of its prerequisite chain. T1 = no prereqs,
  // T2 = needs T1, etc. Cached because computed on every browse render.
  // Used to group palette items by tech depth instead of alphabetical —
  // a Stalker sits with its Cyber Core friends, Colossus with Robo Bay.
  const TIER_CACHE = new Map();
  function tierOf(id, seen = new Set()) {
    if (TIER_CACHE.has(id)) return TIER_CACHE.get(id);
    if (seen.has(id)) return 1;
    const e = SC2_DATA.entities[id];
    if (!e) return 1;
    const prereqs = (e.prerequisites || []).filter(p => p !== id);
    if (!prereqs.length) {
      TIER_CACHE.set(id, 1);
      return 1;
    }
    seen.add(id);
    let max = 0;
    for (const p of prereqs) max = Math.max(max, tierOf(p, seen));
    seen.delete(id);
    const t = max + 1;
    TIER_CACHE.set(id, t);
    return t;
  }
  const TIER_LABELS = {
    1: 'Tier 1 — base & openers',
    2: 'Tier 2 — first tech',
    3: 'Tier 3 — mid game',
    4: 'Tier 4 — advanced',
    5: 'Tier 5 — endgame',
    6: 'Tier 6+',
  };

  function renderForgeBrowse() {
    const grid = document.getElementById('forge-browse-grid');
    if (!grid) return;
    const race = state.forgeRace;
    const tab = state.forgeBrowseTab;
    const list = Object.values(SC2_DATA.entities)
      .filter(e => e.race === race && e.type === tab && e.id !== 'larva');

    for (const btn of document.querySelectorAll('#forge-browse-tabs .browse-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    grid.classList.toggle('compact', !!state.forgePaletteCompact);
    const browseRoot = document.getElementById('forge-browse');
    if (browseRoot) {
      browseRoot.dataset.collapsed = state.forgePaletteCollapsed ? 'true' : 'false';
    }

    if (!list.length) {
      grid.innerHTML = `<div class="forge-empty" style="grid-column: 1/-1;">No ${tab}s for ${race}.</div>`;
      return;
    }

    list.sort((a, b) => {
      const ta = tierOf(a.id), tb = tierOf(b.id);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });

    const parts = [];
    let lastTier = null;
    for (const e of list) {
      const t = tierOf(e.id);
      if (t !== lastTier) {
        parts.push(`<div class="palette-tier-label">${TIER_LABELS[t] || ('Tier ' + t)}</div>`);
        lastTier = t;
      }
      const cost = `${e.minerals || 0}m${e.gas ? '·' + e.gas + 'g' : ''}`;
      const buildTime = `${e.buildTime}s`;
      parts.push(`
        <button type="button" class="browse-tile" data-id="${e.id}" draggable="true" title="${e.name} — ${cost} · ${buildTime}${e.note ? '\n' + e.note : ''}">
          ${iconHtml(e, { size: 36 })}
          <span class="tile-name">${e.name}</span>
          <span class="tile-cost">${cost} · ${buildTime}</span>
        </button>
      `);
    }
    grid.innerHTML = parts.join('');

    for (const tile of grid.querySelectorAll('.browse-tile')) {
      tile.addEventListener('click', () => {
        const id = tile.dataset.id;
        const countInput = document.getElementById('forge-add-count');
        const count = Math.max(1, parseInt(countInput.value, 10) || 1);
        state.forgeOrder.push({ entityId: id, repeat: count });
        recordRecent(id);
        renderForgeList();
        renderForgeQuickAdd();
        scheduleForgeRun();
      });
      attachInsertDragSource(tile, () => tile.dataset.id);
    }
  }

  // Wire an element as an "insert" drag source: dragging it begins an
  // insert-mode drop into the build-order list. `getEntityId` is called at
  // dragstart time so dynamic data attributes are read fresh.
  function attachInsertDragSource(el, getEntityId) {
    el.addEventListener('dragstart', (ev) => {
      const id = getEntityId();
      if (!id) return;
      forgeDrag = { mode: 'insert', entityId: id };
      el.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'copy';
      try { ev.dataTransfer.setData('text/plain', id); } catch (_) { }
      const list = document.getElementById('forge-list');
      if (list) list.classList.add('drag-target');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearForgeDropIndicators();
      forgeDrag = null;
    });
  }

  function clearForgeDropIndicators() {
    const list = document.getElementById('forge-list');
    if (!list) return;
    list.classList.remove('drag-target', 'drop-end');
    for (const r of list.querySelectorAll('.forge-row')) {
      r.classList.remove('drop-above', 'drop-below');
    }
  }

  // Inline insert popover — opened by clicking a "+ insert" gap between
  // build rows. Lets the user add an entity at that exact index without
  // dragging from the palette. Lists recent items first (most likely to
  // be re-used), then a tier-grouped icon grid for the active race.
  let _insertPopoverEl = null;
  let _insertPopoverCleanup = null;
  function closeInsertPopover() {
    if (_insertPopoverEl) {
      _insertPopoverEl.remove();
      _insertPopoverEl = null;
    }
    if (_insertPopoverCleanup) {
      _insertPopoverCleanup();
      _insertPopoverCleanup = null;
    }
    document.querySelectorAll('.forge-insert.active').forEach(el => el.classList.remove('active'));
  }
  function openInsertPopover(insertIdx, anchorEl) {
    closeInsertPopover();
    if (anchorEl) anchorEl.classList.add('active');

    const race = state.forgeRace;
    const recent = (state.forgeRecent[race] || [])
      .map(id => SC2_DATA.entities[id]).filter(Boolean);
    const all = Object.values(SC2_DATA.entities)
      .filter(e => e.race === race && e.id !== 'larva')
      .sort((a, b) => {
        const ta = tierOf(a.id), tb = tierOf(b.id);
        if (ta !== tb) return ta - tb;
        return a.name.localeCompare(b.name);
      });

    const renderTile = (e) => {
      const cost = `${e.minerals || 0}m${e.gas ? '·' + e.gas + 'g' : ''}`;
      return `<button type="button" class="browse-tile" data-id="${e.id}" title="${e.name} — ${cost} · ${e.buildTime}s">
        ${iconHtml(e, { size: 28 })}
      </button>`;
    };

    const popover = document.createElement('div');
    popover.className = 'forge-insert-popover';
    popover.innerHTML = `
      <button type="button" class="forge-insert-popover-close" title="Close (Esc)">×</button>
      <input type="text" class="forge-insert-popover-search" placeholder="Filter… type to search, Enter to add first match" autocomplete="off" />
      ${recent.length ? `<h5>Recent</h5><div class="forge-insert-popover-grid" data-section="recent">${recent.map(renderTile).join('')}</div>` : ''}
      <h5>All ${capitalize(race)} — by tier</h5>
      <div class="forge-insert-popover-grid" data-section="all">${all.map(renderTile).join('')}</div>
    `;

    // Position the popover next to the anchor, clamped to the viewport.
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popover.style.left = `${Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 396))}px`;
    document.body.appendChild(popover);
    _insertPopoverEl = popover;

    const search = popover.querySelector('.forge-insert-popover-search');
    search.focus();

    const insertEntity = (id) => {
      state.forgeOrder.splice(insertIdx, 0, { entityId: id, repeat: 1 });
      recordRecent(id);
      closeInsertPopover();
      renderForgeList();
      renderForgeQuickAdd();
      scheduleForgeRun();
    };

    for (const tile of popover.querySelectorAll('.browse-tile')) {
      tile.addEventListener('click', (ev) => {
        ev.stopPropagation();
        insertEntity(tile.dataset.id);
      });
    }

    search.addEventListener('input', () => {
      const q = search.value.toLowerCase().trim();
      let firstMatch = null;
      for (const tile of popover.querySelectorAll('.browse-tile')) {
        const e = SC2_DATA.entities[tile.dataset.id];
        const hay = `${e.name} ${e.note || ''}`.toLowerCase();
        const m = !q || hay.includes(q);
        tile.style.display = m ? '' : 'none';
        if (m && !firstMatch) firstMatch = tile.dataset.id;
      }
      popover.dataset.firstMatch = firstMatch || '';
    });
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const id = popover.dataset.firstMatch;
        if (id) insertEntity(id);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closeInsertPopover();
      }
    });

    popover.querySelector('.forge-insert-popover-close').addEventListener('click', closeInsertPopover);

    const onDocClick = (ev) => {
      if (popover.contains(ev.target)) return;
      if (anchorEl && anchorEl.contains(ev.target)) return;
      closeInsertPopover();
    };
    const onDocKey = (ev) => {
      if (ev.key === 'Escape') closeInsertPopover();
    };
    setTimeout(() => {
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onDocKey);
    }, 0);
    _insertPopoverCleanup = () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  }

  function renderForgeQuickAdd() {
    const root = document.getElementById('forge-quick-add');
    if (!root) return;
    const race = state.forgeRace;
    const recent = (state.forgeRecent && state.forgeRecent[race]) || [];

    if (!recent.length) {
      root.innerHTML = `<span class="forge-quick-empty">Items you add will show here as quick "recent" chips.</span>`;
      return;
    }
    root.innerHTML = `
      <span class="forge-quick-label">Recent:</span>
      ${recent.map(id => {
        const e = SC2_DATA.entities[id];
        if (!e) return '';
        return `<button type="button" class="quick-chip" data-id="${id}" draggable="true" title="Click to add — or drag into the list to insert at a specific spot">
          ${iconHtml(e, { size: 18 })}
          <span>${e.name}</span>
        </button>`;
      }).join('')}
    `;
    for (const btn of root.querySelectorAll('.quick-chip')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        state.forgeOrder.push({ entityId: id, repeat: 1 });
        recordRecent(id);
        renderForgeList();
        renderForgeQuickAdd(); // re-order chips so just-clicked is first
        scheduleForgeRun();
      });
      attachInsertDragSource(btn, () => btn.dataset.id);
    }
  }

  function populateForgePresets() {
    const select = document.getElementById('forge-preset');
    const presets = FORGE_PRESETS[state.forgeRace] || {};
    select.innerHTML = '<option value="">— blank —</option>';
    for (const name of Object.keys(presets)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  }

  function populateForgeAddDropdown() {
    const select = document.getElementById('forge-add-entity');
    const race = state.forgeRace;
    const typeLabel = { unit: '⏵', building: '◧', addon: '⊞', upgrade: '⚡' };
    select.innerHTML = '';
    // Include "starting" entities (workers, main bases) — players build more of them.
    // Only exclude synthetic larva.
    const raceEnts = Object.values(SC2_DATA.entities)
      .filter(e => e.race === race && e.id !== 'larva');
    for (const type of ['unit', 'upgrade', 'building', 'addon']) {
      const list = raceEnts.filter(e => e.type === type)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = capitalize(type === 'addon' ? 'add-ons' : type + 's');
      for (const e of list) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = `${typeLabel[type] || ''} ${e.name}`;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
  }

  function renderForgeList() {
    const root = document.getElementById('forge-list');
    // Update the divider's step count: total steps + total expanded actions
    // (a step with repeat:5 contributes 5 actions). Keeps the user oriented
    // even when the list scrolls past the divider.
    const countEl = document.getElementById('forge-list-count');
    if (countEl) {
      const stepCount = state.forgeOrder.filter(s => !s.kind || s.kind !== 'priority').length;
      const actionCount = state.forgeOrder.reduce((a, s) => a + (s.kind ? 1 : (s.repeat || 1)), 0);
      countEl.textContent = stepCount === actionCount
        ? `${stepCount} step${stepCount === 1 ? '' : 's'}`
        : `${stepCount} step${stepCount === 1 ? '' : 's'} · ${actionCount} actions`;
    }
    if (!state.forgeOrder.length) {
      root.innerHTML = '<div class="forge-empty">Empty build. Use the palette above to add steps — click an icon, type / to search, or pick a preset.</div>';
      attachForgeListContainerDrop(root);
      return;
    }
    // Map step index -> timeline entry for resource state
    const timeline = state.forgeResult?.timeline || [];
    const warnings = state.forgeResult?.warnings || [];
    const stepResults = mapStepsToTimeline(state.forgeOrder, timeline);

    const rows = state.forgeOrder.map((step, i) => {
      const stepResult = stepResults[i];
      const queuedAt = stepResult?.start;
      const res = stepResult?.resBefore;
      const warning = warnings.find(w => w.index === i);
      const reasonOnly = warning ? warning.msg.replace(/^[^:]+:\s*/, '') : '';
      // Delay indicator: if this step would have fired noticeably earlier
      // without one specific constraint, flag it. Filtering rules:
      //  - "Producer" delays are mostly natural serial-queue waits (the
      //    previous SCV hadn't finished). They're visible in the
      //    production-efficiency gantt and clutter the list otherwise, so
      //    only flag when the wait is much longer than this entity's own
      //    build time (i.e. several units stacked, not just one).
      //  - "Resources" delays are hidden for the very first action (the
      //    natural startup mine-up looks like a delay) and require a
      //    higher threshold since saving up is normal.
      //  - Supply / tech delays are flagged as soon as they exceed a few
      //    seconds — those are usually actionable.
      let delayLine = '';
      if (stepResult && stepResult.wouldFireAt != null && stepResult.blockedBy) {
        const delay = stepResult.start - stepResult.wouldFireAt;
        const isResources = stepResult.blockedBy === 'resources';
        const isProducer = stepResult.blockedBy === 'producer';
        const ent = SC2_DATA.entities[step.entityId];
        const buildTime = ent?.buildTime || 0;
        let threshold;
        if (isResources) threshold = 15;
        else if (isProducer) threshold = Math.max(20, buildTime * 2 + 3);
        else threshold = 5;
        if (delay > threshold && !(i === 0 && isResources)) {
          const niceWhen = fmtTime(stepResult.wouldFireAt);
          const tip = `Could have fired at ${niceWhen}; blocked by ${stepResult.blockedBy} until ${fmtTime(stepResult.start)}.`;
          const cls = (isResources || isProducer) ? 'forge-delay forge-delay-soft' : 'forge-delay';
          delayLine = `<div class="${cls}" title="${tip}">⏳ Delayed ${delay.toFixed(0)}s by ${stepResult.blockedBy} (would have fired at ${niceWhen})</div>`;
        }
      }
      const stateLine = res
        ? `<span class="forge-state">${fmtTimeBoth(queuedAt)} · ${Math.round(res.minerals)}m / ${Math.round(res.gas)}g · ${res.supply_used}/${res.supply_max} sup · ${res.mineral_rate.toFixed(1)} m/s${res.gas_rate > 0 ? ' · ' + res.gas_rate.toFixed(1) + ' g/s' : ''}</span>${delayLine}`
        : warning
          ? `<span class="forge-state forge-state-warn" title="${reasonOnly}">⚠ ${reasonOnly}</span>`
          : '<span class="forge-state forge-state-pending">— not yet executed —</span>';

      // Priority-shift marker row. Doesn't simulate anything — it tells
      // the solver to switch resource priority for everything that comes
      // after it in the list. Inline 4-chip editor with ◀/▶ arrows lets
      // the user reorder tiers without leaving the row.
      if (step.kind === 'priority') {
        const order = sanitizePriority(step.order);
        const labels = { worker: 'Workers', building: 'Buildings', tech: 'Tech', army: 'Army' };
        const chips = order.map((tier, k) => `
          <div class="priority-chip priority-chip-inline" data-tier="${tier}">
            <button type="button" class="priority-arrow" data-act="prio-up" data-pos="${k}" ${k === 0 ? 'disabled' : ''} title="Higher priority">◀</button>
            <span class="priority-name">${k + 1}. ${labels[tier]}</span>
            <button type="button" class="priority-arrow" data-act="prio-down" data-pos="${k}" ${k === order.length - 1 ? 'disabled' : ''} title="Lower priority">▶</button>
          </div>
        `).join('');
        return `
          <div class="forge-row forge-row-priority" data-idx="${i}" draggable="true">
            <div class="forge-handle" title="Drag to reorder">⋮⋮</div>
            <div class="forge-num">${i + 1}</div>
            <div class="forge-action">
              <div class="forge-action-main">
                <span class="entity-icon" style="width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-3);color:var(--accent);">⚖</span>
                <div class="forge-action-text">
                  <div class="forge-name">Priority shift</div>
                  <div class="forge-priority-inline">${chips}</div>
                </div>
              </div>
              <div class="forge-cost">marker</div>
            </div>
            <div class="forge-controls">
              <button type="button" class="forge-del" data-act="delete" title="Remove">×</button>
            </div>
          </div>
        `;
      }

      // Swap row
      if (step.kind === 'swap') {
        const fromE = SC2_DATA.entities[step.from];
        const toE = SC2_DATA.entities[step.to];
        return `
          <div class="forge-row forge-row-swap" data-idx="${i}" draggable="true">
            <div class="forge-handle" title="Drag to reorder">⋮⋮</div>
            <div class="forge-num">${i + 1}</div>
            <div class="forge-action">
              <div class="forge-action-main">
                <span class="entity-icon" style="width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-3);color:var(--accent);">↔</span>
                <div class="forge-action-text">
                  <div class="forge-name">Swap: ${fromE?.name || step.from} → ${toE?.name || step.to}</div>
                  ${stateLine}
                </div>
              </div>
              <div class="forge-cost">~5s</div>
            </div>
            <div class="forge-controls">
              <button type="button" class="forge-del" data-act="delete" title="Remove">×</button>
            </div>
          </div>
        `;
      }

      // Standard entity row
      const e = SC2_DATA.entities[step.entityId];
      const name = e?.name || step.entityId;
      const repeat = step.repeat || 1;
      const cost = e ? `${e.minerals || 0}m${e.gas ? ' · ' + e.gas + 'g' : ''}` : '';
      return `
        <div class="forge-row" data-idx="${i}" draggable="true">
          <div class="forge-handle" title="Drag to reorder">⋮⋮</div>
          <div class="forge-num">${i + 1}</div>
          <div class="forge-action">
            <div class="forge-action-main">
              ${e ? iconHtml(e, { size: 26 }) : ''}
              <div class="forge-action-text">
                <div class="forge-name">${name}</div>
                ${stateLine}
              </div>
            </div>
            <div class="forge-cost">${cost}</div>
          </div>
          <div class="forge-controls">
            <input class="forge-repeat" type="number" min="1" max="50" value="${repeat}" title="Repeat count" data-act="repeat" />
            <button type="button" class="forge-del" data-act="delete" title="Remove">×</button>
          </div>
        </div>
      `;
    });
    // Interleave inline insert points: a thin div between every row and
    // before the first / after the last. Clicking opens a popover that
    // adds an entity at that index, so users don't have to drag from
    // the palette or scroll back to the top.
    const rowsHtml = rows.map((html, i) =>
      `<div class="forge-insert" data-insert-idx="${i}" title="Insert here"></div>${html}`
    ).join('') + `<div class="forge-insert" data-insert-idx="${rows.length}" title="Insert at end"></div>`;
    root.innerHTML = rowsHtml;

    // Wire insert points
    for (const ip of root.querySelectorAll('.forge-insert')) {
      ip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openInsertPopover(parseInt(ip.dataset.insertIdx, 10), ip);
      });
    }

    // Wire input/button handlers.
    // The repeat input was previously bound to BOTH `click` and `change`
    // via a shared handler — clicking to focus the field would reread
    // the (unchanged) value and call scheduleForgeRun(), which then
    // re-rendered the list 180ms later and destroyed the input
    // mid-edit. Now the number field uses `change` only, and the
    // buttons use `click` only.
    for (const el of root.querySelectorAll('input[data-act="repeat"]')) {
      el.addEventListener('change', (ev) => {
        const row = ev.target.closest('.forge-row');
        const idx = parseInt(row.dataset.idx, 10);
        const v = parseInt(ev.target.value, 10);
        if (v > 0 && v <= 50) {
          state.forgeOrder[idx].repeat = v;
          scheduleForgeRun();
        }
      });
    }
    for (const el of root.querySelectorAll('button[data-act]')) {
      el.addEventListener('click', (ev) => {
        const row = ev.target.closest('.forge-row');
        const idx = parseInt(row.dataset.idx, 10);
        const act = ev.target.dataset.act;
        if (act === 'delete') {
          state.forgeOrder.splice(idx, 1);
          renderForgeList();
          scheduleForgeRun();
        } else if (act === 'prio-up' || act === 'prio-down') {
          const pos = parseInt(ev.target.dataset.pos, 10);
          const step = state.forgeOrder[idx];
          const order = sanitizePriority(step.order);
          if (act === 'prio-up' && pos > 0) {
            [order[pos], order[pos - 1]] = [order[pos - 1], order[pos]];
          } else if (act === 'prio-down' && pos < order.length - 1) {
            [order[pos], order[pos + 1]] = [order[pos + 1], order[pos]];
          }
          state.forgeOrder[idx] = { kind: 'priority', order };
          renderForgeList();
          scheduleForgeRun();
        }
      });
    }

    // Drag-and-drop: reorder existing rows, OR insert from browse/recent.
    // The drag source decides the mode by setting `forgeDrag`. Drop targets
    // here only react when a drag is in progress.
    for (const row of root.querySelectorAll('.forge-row')) {
      row.addEventListener('dragstart', (ev) => {
        forgeDrag = { mode: 'reorder', dragIdx: parseInt(row.dataset.idx, 10) };
        row.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', String(forgeDrag.dragIdx)); } catch (_) { }
        root.classList.add('drag-target');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        clearForgeDropIndicators();
        forgeDrag = null;
      });
      row.addEventListener('dragover', (ev) => {
        if (!forgeDrag) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = forgeDrag.mode === 'insert' ? 'copy' : 'move';
        const rect = row.getBoundingClientRect();
        const above = ev.clientY < rect.top + rect.height / 2;
        for (const r of root.querySelectorAll('.forge-row')) r.classList.remove('drop-above', 'drop-below');
        root.classList.remove('drop-end');
        row.classList.add(above ? 'drop-above' : 'drop-below');
      });
      row.addEventListener('drop', (ev) => {
        if (!forgeDrag) return;
        ev.preventDefault();
        ev.stopPropagation();
        const dst = parseInt(row.dataset.idx, 10);
        const rect = row.getBoundingClientRect();
        const above = ev.clientY < rect.top + rect.height / 2;
        let target = above ? dst : dst + 1;
        if (forgeDrag.mode === 'reorder') {
          if (target > forgeDrag.dragIdx) target -= 1;
          if (target !== forgeDrag.dragIdx) {
            const item = state.forgeOrder.splice(forgeDrag.dragIdx, 1)[0];
            state.forgeOrder.splice(target, 0, item);
            renderForgeList();
            scheduleForgeRun();
          }
        } else if (forgeDrag.mode === 'insert' && forgeDrag.entityId) {
          const countInput = document.getElementById('forge-add-count');
          const count = Math.max(1, parseInt(countInput?.value, 10) || 1);
          state.forgeOrder.splice(target, 0, { entityId: forgeDrag.entityId, repeat: count });
          recordRecent(forgeDrag.entityId);
          renderForgeList();
          renderForgeQuickAdd();
          scheduleForgeRun();
        }
        clearForgeDropIndicators();
        forgeDrag = null;
      });
    }

    attachForgeListContainerDrop(root);
  }

  // Drop handler for the forge-list container itself: catches drops on empty
  // space below the last row (or on the empty-state placeholder). Re-attached
  // every render because renderForgeList replaces innerHTML.
  function attachForgeListContainerDrop(root) {
    root.addEventListener('dragover', (ev) => {
      if (!forgeDrag) return;
      if (ev.target.closest('.forge-row')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = forgeDrag.mode === 'insert' ? 'copy' : 'move';
      for (const r of root.querySelectorAll('.forge-row')) r.classList.remove('drop-above', 'drop-below');
      root.classList.add('drop-end');
    });
    root.addEventListener('drop', (ev) => {
      if (!forgeDrag) return;
      if (ev.target.closest('.forge-row')) return;
      ev.preventDefault();
      if (forgeDrag.mode === 'insert' && forgeDrag.entityId) {
        const countInput = document.getElementById('forge-add-count');
        const count = Math.max(1, parseInt(countInput?.value, 10) || 1);
        state.forgeOrder.push({ entityId: forgeDrag.entityId, repeat: count });
        recordRecent(forgeDrag.entityId);
        renderForgeList();
        renderForgeQuickAdd();
        scheduleForgeRun();
      } else if (forgeDrag.mode === 'reorder' && forgeDrag.dragIdx != null) {
        // Reorder dropped on empty space → move to end.
        const item = state.forgeOrder.splice(forgeDrag.dragIdx, 1)[0];
        state.forgeOrder.push(item);
        renderForgeList();
        scheduleForgeRun();
      }
      clearForgeDropIndicators();
      forgeDrag = null;
    });
  }

  function mapStepsToTimeline(buildOrder, timeline) {
    // Match each build-order step to its earliest-unconsumed timeline entry.
    // Using a consumed-set rather than a sequential cursor so that a step that
    // never executed (no matching entry) doesn't poison the matching for later
    // steps. Also: the timeline is sorted by start time, but build-order
    // sequence may not match that exactly (two events queued at the same time
    // are sorted by end time), so the cursor approach was unreliable.
    const result = [];
    const consumed = new Array(timeline.length).fill(false);

    for (const step of buildOrder) {
      let firstFor = null;
      if (step.kind === 'priority') {
        // Priority markers don't appear in the timeline — push null so
        // the per-row state line is rendered without a queue time.
        result.push(null);
        continue;
      }
      if (step.kind === 'swap') {
        const swapId = `swap_${step.from}_to_${step.to}`;
        for (let j = 0; j < timeline.length; j++) {
          if (!consumed[j] && timeline[j].id === swapId) {
            firstFor = timeline[j];
            consumed[j] = true;
            break;
          }
        }
      } else {
        const repeat = step.repeat || 1;
        let found = 0;
        for (let j = 0; j < timeline.length && found < repeat; j++) {
          if (!consumed[j] && timeline[j].id === step.entityId) {
            if (firstFor == null) firstFor = timeline[j];
            consumed[j] = true;
            found++;
          }
        }
      }
      result.push(firstFor);
    }
    return result;
  }

  function promptSwap() {
    // Find available swap pairs based on current race
    const race = state.forgeRace;
    if (race !== 'terran') {
      alert('Addon swaps only apply to Terran (Reactor / Tech Lab).');
      return;
    }
    const addons = ['barracks_techlab', 'barracks_reactor', 'factory_techlab', 'factory_reactor', 'starport_techlab', 'starport_reactor'];
    const fromOptions = addons.map(id => `<option value="${id}">${SC2_DATA.entities[id].name}</option>`).join('');
    const toOptions = addons.map(id => `<option value="${id}">${SC2_DATA.entities[id].name}</option>`).join('');

    // Render an inline editor as a small dialog (uses native confirm-style flow with overlay)
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h4>Add Addon Swap</h4>
        <p style="color:var(--text-2);font-size:13px;margin:0 0 14px;">Swap an existing addon to a different building (~5s lift &amp; fly). The source addon must already exist; the target structure must already exist.</p>
        <div class="modal-row">
          <label>From <select id="swap-from">${fromOptions}</select></label>
        </div>
        <div class="modal-row">
          <label>To <select id="swap-to">${toOptions}</select></label>
        </div>
        <div class="modal-actions">
          <button type="button" class="ghost" data-act="cancel">Cancel</button>
          <button type="button" data-act="ok">Add Swap</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Default the target to a different building's same-type addon
    document.getElementById('swap-to').value = 'factory_reactor';
    document.getElementById('swap-from').value = 'barracks_reactor';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const from = document.getElementById('swap-from').value;
      const to = document.getElementById('swap-to').value;
      if (from === to) { alert('From and To must differ'); return; }
      state.forgeOrder.push({ kind: 'swap', from, to });
      overlay.remove();
      renderForgeList();
      scheduleForgeRun();
    });
  }

  // Insert worker steps into the build to fill idle production time on the
  // main building (CC/OC/PF for Terran, Nexus for Protoss). Iteratively:
  //   - run the sim,
  //   - find the first main-lane gap that's >= one worker build time,
  //   - insert a worker at the position where the prior step's commit time
  //     is the latest one still <= gap start (so the new worker lands in
  //     the gap without forcing later steps to wait on it),
  //   - repeat until no gap fits or the saturation cap is reached.
  // Zerg drones come from larva rather than a producer slot, so they need
  // a different mechanism — skipped for now.
  function fillWorkers() {
    const race = state.forgeRace;
    if (race === 'zerg') {
      alert('Fill workers is not yet supported for Zerg — drones come from larva, not a producer slot.');
      return;
    }
    const cfg = SC2_SIM.RACE_CFG[race];
    const workerId = cfg.worker;
    const mainId = cfg.main;
    const workerEntity = SC2_DATA.entities[workerId];
    if (!workerEntity) return;
    const workerBuildTime = workerEntity.buildTime;
    const SAFETY_PASSES = 60;

    let inserted = 0;
    for (let pass = 0; pass < SAFETY_PASSES; pass++) {
      // Saturation cap: ~16 workers per base + a few extras for transfers.
      let workersInBuild = cfg.start_workers;
      let basesInBuild = 1;
      for (const step of state.forgeOrder) {
        if (step.entityId === workerId) workersInBuild += step.repeat || 1;
        if (step.entityId === mainId) basesInBuild += step.repeat || 1;
      }
      const cap = basesInBuild * 16 + 4;
      if (workersInBuild >= cap) break;

      const r = SC2_SIM.simulateBuildOrder(state.forgeOrder, { race });
      if (!r || !r.eft) break;

      // Find the first main-lane idle gap that fits a worker build.
      const util = computeProducerUtilization(r.timeline, r.eft, race);
      const main = util.find(u => u.producer.id === mainId);
      if (!main) break;
      let gap = null;
      for (const lane of main.lanes) {
        if (lane.type !== 'main') continue;
        const aliveEnd = lane.tDeath === Infinity ? r.eft : lane.tDeath;
        let cursor = lane.tAvail;
        const ivs = lane.intervals.slice().sort((a, b) => a.start - b.start);
        for (const iv of ivs) {
          if (iv.start - cursor >= workerBuildTime - 1e-6) {
            gap = { start: cursor };
            break;
          }
          if (iv.end > cursor) cursor = iv.end;
        }
        if (!gap && aliveEnd - cursor >= workerBuildTime - 1e-6) {
          gap = { start: cursor };
        }
        if (gap) break;
      }
      if (!gap) break;

      // Insert at the position where the prior step's commit is the
      // latest still <= gap.start. That puts the new worker in the gap
      // without raising later steps' priorNonSwapMax above what it was.
      const stepResults = mapStepsToTimeline(state.forgeOrder, r.timeline);
      let insertPos = state.forgeOrder.length;
      for (let i = 0; i < state.forgeOrder.length; i++) {
        const t = stepResults[i]?.start;
        if (t == null) continue;
        if (t > gap.start + 1e-6) { insertPos = i; break; }
      }

      state.forgeOrder.splice(insertPos, 0, { entityId: workerId, repeat: 1 });
      inserted++;
    }

    if (inserted > 0) {
      renderForgeList();
      renderForgeQuickAdd();
      scheduleForgeRun();
    } else {
      // No gaps found — either saturated, or production is already packed.
      const status = document.getElementById('forge-status');
      if (status) {
        const prev = status.textContent;
        status.textContent = `No fillable worker gaps found.`;
        setTimeout(() => { if (status.textContent.startsWith('No fillable')) status.textContent = prev; }, 2500);
      }
    }
  }

  function runForge() {
    const result = SC2_SIM.simulateBuildOrder(state.forgeOrder, {
      race: state.forgeRace,
      priorityOrder: state.forgePriority,
    });
    state.forgeResult = result;
    renderForgeResult();
    // Defensively skip the list re-render if the user is currently
    // editing a control inside the list (e.g., the repeat number
    // input). renderForgeList replaces innerHTML, which would destroy
    // the focused element and discard any partial input. The list will
    // refresh on the user's next action — no info lost.
    const ae = document.activeElement;
    const listEl = document.getElementById('forge-list');
    if (ae && listEl && listEl.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) {
      return;
    }
    renderForgeList(); // refresh per-row resource state
  }

  function renderForgeResult() {
    const root = document.getElementById('forge-result');
    // Preserve the result column's scroll position across the live re-render.
    // On wide screens .forge-column is overflow-y:auto so it's its own scroll
    // surface; restore its scrollTop after innerHTML wipes the children.
    // On narrow screens there's no custom container — the browser preserves
    // window scroll natively, so this is a no-op.
    let scrollHost = null;
    for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') { scrollHost = el; break; }
    }
    const savedScroll = scrollHost ? scrollHost.scrollTop : 0;
    const restoreScroll = () => { if (scrollHost) scrollHost.scrollTop = savedScroll; };
    if (!state.forgeResult || !state.forgeOrder.length) {
      root.innerHTML = '<div class="forge-empty">Add steps and the build will simulate live as you edit.</div>';
      restoreScroll();
      return;
    }
    const r = state.forgeResult;
    const totalCost = r.timeline.reduce((acc, t) => ({ m: acc.m + t.mins, g: acc.g + t.gas }), { m: 0, g: 0 });
    const finalState = r.sim.history[r.sim.history.length - 1];
    const roster = summarizeRoster(r.timeline, state.forgeRace);
    const producerUtil = computeProducerUtilization(r.timeline, r.eft, state.forgeRace);

    const warningsHtml = r.warnings.length
      ? `<div class="forge-warnings">
          <h4>⚠ Issues (${r.warnings.length})</h4>
          ${r.warnings.map(w => `<div class="forge-warning">Step ${w.index + 1}${w.t != null ? ' @ ' + fmtTime(w.t) : ''}: ${w.msg}</div>`).join('')}
        </div>`
      : '';

    // Float / idle-economy detection — surface stretches where a resource
    // builds up unspent for long enough that the player has spare income
    // they could have committed elsewhere. Flagging the worst stretch per
    // resource keeps it actionable; tooltip shows when.
    const floats = detectResourceFloats(r.sim.history);
    const insightsHtml = floats.length
      ? `<div class="forge-insights">
          <h4>💡 Insights</h4>
          ${floats.map(f => `<div class="forge-insight" title="Floated ${f.peak.toFixed(0)} ${f.label} for ${f.duration.toFixed(0)}s, peaking at ${fmtTime(f.peakAt)}.">📈 Floating ${f.label}: held ${f.peak.toFixed(0)}+ for ${f.duration.toFixed(0)}s starting ${fmtTime(f.start)} — economy outpacing spend.</div>`).join('')}
        </div>`
      : '';

    root.innerHTML = `
      <div class="result-card race-${state.forgeRace}">
        <div class="result-headline">
          <span class="target-name">Build outcome</span>
          <div class="headline-times">
            <div>
              <span class="time-label">Last ${state.realTime ? 'real' : 'game'}</span>
              <span class="time-big">${fmtTimeBoth(r.eft)}</span>
            </div>
            <div>
              <span class="time-label">${state.realTime ? 'Game' : 'Real'}</span>
              <span class="time-side">${state.realTime ? fmtTime(r.eft) : fmtTime(r.eft / SC2_DATA.speedMultiplier)}</span>
            </div>
            <div>
              <span class="time-label">Steps run</span>
              <span class="time-side">${r.timeline.length}/${state.forgeOrder.reduce((a, s) => a + (s.repeat || 1), 0)}</span>
            </div>
            ${renderRosterSummary(roster)}
          </div>
        </div>
        <div class="cost-row">
          <span class="cost-pill minerals"><span class="label">Spent m</span> ${Math.round(totalCost.m)}</span>
          <span class="cost-pill gas"><span class="label">Spent g</span> ${Math.round(totalCost.g)}</span>
          ${finalState ? `
            <span class="cost-pill" style="background: var(--bg-3); color: var(--text-1);"><span class="label">End m/g</span> ${Math.round(finalState.minerals)}m · ${Math.round(finalState.gas)}g</span>
            <span class="cost-pill supply"><span class="label">End sup</span> ${finalState.supply_used}/${finalState.supply_max}</span>
            <span class="cost-pill" style="background: var(--bg-3); color: var(--text-2);"><span class="label">Income</span> ${finalState.mineral_rate.toFixed(1)} m/s · ${finalState.gas_rate.toFixed(1)} g/s</span>
          ` : ''}
        </div>
        ${warningsHtml}
        ${insightsHtml}
        ${renderRosterGrid(roster)}
        ${renderProducerUtilization(producerUtil, r.eft)}
        <div class="path-section collapsible-section" data-section-id="forge-resources">
          <h3>Resources over time</h3>
          ${renderResourceChart(r.sim.history, r.eft)}
        </div>
        <div class="path-section collapsible-section" data-section-id="forge-timeline">
          <h3>Build timeline</h3>
          ${renderSimGantt(r.timeline, r.eft, null, 0)}
        </div>
        <div class="path-section collapsible-section" data-section-id="forge-stepdetail">
          <h3>Step detail</h3>
          ${renderForgeTimeline(r.timeline)}
        </div>
      </div>
    `;
    applyStoredCollapseStates(root);
    // Wire up the chart hover after DOM is in place
    const chartWrap = root.querySelector('[data-chart="resources"]');
    if (chartWrap && r.sim.history && r.sim.history.length > 1) {
      attachChartHover(chartWrap, r.sim.history, r.eft);
    }
    restoreScroll();
  }

  // Bucket completed timeline actions by entity and group (army / tech / upgrades).
  // Workers are pulled out of "army" because counting SCVs alongside marines reads weird.
  //
  // Reflects what you HAVE at the end of the build, not what you BUILT:
  //   - Starting roster (12 workers + main, plus Overlord for Zerg) is
  //     seeded so a fresh sim with no morphs still shows them.
  //   - In-place morphs (CC→OC/PF, Hatch→Lair→Hive, Spire→Greater Spire,
  //     Hydra→Lurker, Roach→Ravager, Corruptor→Brood Lord, Overlord→
  //     Overseer, Templar→Archon, etc.) decrement the source so we don't
  //     double-count. Without the morph decrement, "1 CC built + 2 OC
  //     morphs" looked like 3 base buildings instead of 2, suggesting a
  //     phantom CC for the OC to morph from.
  function summarizeRoster(timeline, race) {
    const groups = { workers: new Map(), army: new Map(), tech: new Map(), upgrades: new Map() };
    const bucketFor = (e) => {
      if (!e) return null;
      if (e.type === 'upgrade') return groups.upgrades;
      if (e.type === 'building' || e.type === 'addon') return groups.tech;
      if (e.role === 'worker') return groups.workers;
      if (e.type === 'unit') return groups.army;
      return null;
    };
    for (const seed of (RACE_STARTING_ROSTER[race] || [])) {
      const b = bucketFor(SC2_DATA.entities[seed.id]);
      if (b) b.set(seed.id, (b.get(seed.id) || 0) + seed.count);
    }
    // Unit morphs (Baneling←Zergling, Ravager←Roach, Lurker←Hydra,
    // Brood Lord←Corruptor, Overseer←Overlord, Archon←Templar) are
    // encoded as producedBy=<source-unit-id> rather than upgradeFrom.
    // Archon is the only one that consumes 2 sources per morph.
    const consumesSourcePerMorph = (e) => {
      if (e.upgradeFrom) return { srcId: e.upgradeFrom, count: 1 };
      const prodBy = e.producedBy && SC2_DATA.entities[e.producedBy];
      if (prodBy && prodBy.type === 'unit') {
        return { srcId: e.producedBy, count: e.id === 'archon' ? 2 : 1 };
      }
      return null;
    };
    for (const item of timeline) {
      const e = SC2_DATA.entities[item.id];
      const bucket = bucketFor(e);
      if (!bucket) continue;
      bucket.set(item.id, (bucket.get(item.id) || 0) + 1);
      const morph = consumesSourcePerMorph(e);
      if (morph) {
        const src = SC2_DATA.entities[morph.srcId];
        const srcBucket = bucketFor(src);
        if (srcBucket) {
          const cur = srcBucket.get(morph.srcId) || 0;
          const next = cur - morph.count;
          if (next <= 0) srcBucket.delete(morph.srcId);
          else srcBucket.set(morph.srcId, next);
        }
      }
    }
    const toList = (m) => [...m.entries()]
      .filter(([_, count]) => count > 0)
      .map(([id, count]) => ({ entity: SC2_DATA.entities[id], count }))
      .sort((a, b) => b.count - a.count || a.entity.name.localeCompare(b.entity.name));
    return {
      workers: toList(groups.workers),
      army: toList(groups.army),
      tech: toList(groups.tech),
      upgrades: toList(groups.upgrades),
    };
  }
  const RACE_STARTING_ROSTER = {
    terran:  [{ id: 'command_center', count: 1, group: 'tech' }, { id: 'scv',   count: 12, group: 'workers' }],
    protoss: [{ id: 'nexus',          count: 1, group: 'tech' }, { id: 'probe', count: 12, group: 'workers' }],
    zerg:    [{ id: 'hatchery',       count: 1, group: 'tech' }, { id: 'drone', count: 12, group: 'workers' },
              { id: 'overlord',       count: 1, group: 'army' }],
  };

  function rosterTotal(list) { return list.reduce((a, x) => a + x.count, 0); }

  function renderRosterSummary(roster) {
    const totals = [
      { label: 'workers', n: rosterTotal(roster.workers), glyph: TYPE_GLYPHS.worker },
      { label: 'army',    n: rosterTotal(roster.army),    glyph: TYPE_GLYPHS.unit },
      { label: 'tech',    n: rosterTotal(roster.tech),    glyph: TYPE_GLYPHS.building },
      { label: 'upgrades',n: rosterTotal(roster.upgrades),glyph: TYPE_GLYPHS.upgrade },
    ].filter(t => t.n > 0);
    if (!totals.length) return '';
    return `<div class="headline-roster">
      ${totals.map(t => `<span class="roster-chip" title="${t.n} ${t.label}"><span class="roster-chip-glyph">${t.glyph}</span>${t.n}</span>`).join('')}
    </div>`;
  }

  function renderRosterGrid(roster) {
    const sections = [
      { key: 'workers', label: 'Workers' },
      { key: 'army',    label: 'Army' },
      { key: 'tech',    label: 'Tech (buildings & add-ons)' },
      { key: 'upgrades',label: 'Upgrades' },
    ].filter(s => roster[s.key].length);
    if (!sections.length) return '';
    return `<div class="path-section collapsible-section" data-section-id="forge-roster">
      <h3>Roster</h3>
      <div class="roster-grid">
        ${sections.map(s => `
          <div class="roster-group">
            <div class="roster-group-head">
              <span class="roster-group-name">${s.label}</span>
              <span class="roster-group-total">${rosterTotal(roster[s.key])}</span>
            </div>
            <div class="roster-items">
              ${roster[s.key].map(({ entity, count }) => `
                <div class="roster-item" title="${entity.name} ×${count}">
                  <div class="roster-item-icon">
                    ${iconHtml(entity, { size: 36 })}
                    ${count > 1 ? `<span class="roster-count">×${count}</span>` : ''}
                  </div>
                  <div class="roster-item-name">${entity.name}</div>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  // For each production building, compute how much of its available time was
  // spent producing — and where the idle gaps fall on the timeline. Catches
  // the "I built a Factory and forgot to use it" case.
  // Zerg unit production from Hatchery/Lair/Hive uses larvae in the sim (no slot
  // accounting), so those mains are skipped — their busy% would be misleading.
  const RACE_MAIN_ID = { terran: 'command_center', protoss: 'nexus', zerg: 'hatchery' };
  const ZERG_LARVA_PRODUCERS = new Set(['hatchery', 'lair', 'hive']);

  // A "chain root" is the entity ID we use to represent a single physical
  // building that may go through upgrade phases (CC → OC → SCVs continue;
  // Hatch → Lair → Hive). We attribute any production from a phase to the
  // root, so the building's lane stays alive across upgrades and shows
  // post-upgrade work like SCVs queued from the OC.
  const UPGRADE_CHAIN_ROOT = new Map();
  ['command_center', 'orbital_command', 'planetary_fortress'].forEach(id => UPGRADE_CHAIN_ROOT.set(id, 'command_center'));
  ['hatchery', 'lair', 'hive'].forEach(id => UPGRADE_CHAIN_ROOT.set(id, 'hatchery'));
  ['spire', 'greater_spire'].forEach(id => UPGRADE_CHAIN_ROOT.set(id, 'spire'));
  const rootOf = (id) => UPGRADE_CHAIN_ROOT.get(id) || id;

  function computeProducerUtilization(timeline, eft, race) {
    if (!timeline.length || !eft) return [];
    const main = RACE_MAIN_ID[race];
    const producerIds = new Set();
    if (main) producerIds.add(rootOf(main));
    for (const item of timeline) {
      // Addon swap (Terran lift-and-swap): both source and target structures
      // participate; the swap entry's id isn't a real entity.
      if (item.kind === 'swap' && item.swapFrom && item.swapTo) {
        const fs = SC2_DATA.entities[item.swapFrom]?.producedBy;
        const ts = SC2_DATA.entities[item.swapTo]?.producedBy;
        if (fs) producerIds.add(rootOf(fs));
        if (ts) producerIds.add(rootOf(ts));
        continue;
      }
      const e = SC2_DATA.entities[item.id];
      if (!e) continue;
      const p = e.upgradeFrom || e.producedBy;
      if (p) producerIds.add(rootOf(p));
    }

    const out = [];
    for (const producerId of producerIds) {
      if (race === 'zerg' && ZERG_LARVA_PRODUCERS.has(producerId)) continue;
      const pe = SC2_DATA.entities[producerId];
      if (!pe || pe.type !== 'building') continue;

      // Each main building and each reactor is its own "lane" with a birth
      // (tAvail) and a death (tDeath = upgrade-out / reactor-swap-away / ∞).
      // Modeling instances directly — instead of pooled capacity — means a
      // 2nd Command Center built after the 1st upgrades to OC still gets
      // its own row (capacity might oscillate 1→0→1, but that's two real
      // buildings).
      // Chain upgrades (CC→OC, Hatch→Lair) keep the same lane alive — the
      // building is renamed, not removed; only the upgrade itself is busy.
      const changes = [];
      if (producerId === main) changes.push({ t: 0, op: 'add', type: 'main' });
      for (const item of timeline) {
        if (item.id === producerId) changes.push({ t: item.end, op: 'add', type: 'main' });
        if (item.id === `${producerId}_reactor`) changes.push({ t: item.end, op: 'add', type: 'reactor' });
        const ie = SC2_DATA.entities[item.id];
        // Only remove a lane on upgrade-out if the upgraded form leaves the
        // chain (rare/none in current data). In-chain upgrades stay alive.
        if (ie && ie.upgradeFrom === producerId && rootOf(item.id) !== producerId) {
          changes.push({ t: item.end, op: 'remove', type: 'main' });
        }
        if (item.kind === 'swap' && item.swapFrom && item.swapTo) {
          const fs = SC2_DATA.entities[item.swapFrom]?.producedBy;
          const ts = SC2_DATA.entities[item.swapTo]?.producedBy;
          if (item.swapFrom.endsWith('_reactor') && rootOf(fs) === producerId) {
            changes.push({ t: item.end, op: 'remove', type: 'reactor' });
          }
          if (item.swapTo.endsWith('_reactor') && rootOf(ts) === producerId) {
            changes.push({ t: item.end, op: 'add', type: 'reactor' });
          }
        }
      }
      if (!changes.length) continue;
      // Adds before removes at the same timestamp so a fresh-built instance
      // is alive before any same-time removal could pick it.
      changes.sort((a, b) => a.t - b.t || (a.op === 'add' ? -1 : 1));

      const lanes = [];
      for (const ch of changes) {
        if (ch.op === 'add') {
          // Track the lane's "form" — initial entity ID, mutated by in-chain
          // upgrades as they land. Used to ensure a 2nd Orbital upgrade
          // doesn't get placed on a lane that's already an Orbital.
          // addonChanges tracks the addon attached to a main lane over
          // time (sorted by t): null at start, becomes the addon id when
          // an addon build lands, becomes null again when a swap takes
          // it away, becomes the swap target id when a swap brings one in.
          // Used so a Tech Lab build won't visually land on a Barracks
          // that already has a Reactor.
          lanes.push({
            tAvail: ch.t, tDeath: Infinity, type: ch.type,
            form: ch.type === 'main' ? producerId : null,
            addonChanges: [],
            intervals: [],
          });
        } else {
          // Remove: kill the oldest still-alive lane of matching type.
          let oldestIdx = -1;
          for (let i = 0; i < lanes.length; i++) {
            if (lanes[i].type === ch.type && lanes[i].tDeath === Infinity) {
              if (oldestIdx === -1 || lanes[i].tAvail < lanes[oldestIdx].tAvail) oldestIdx = i;
            }
          }
          if (oldestIdx >= 0) lanes[oldestIdx].tDeath = ch.t;
        }
      }
      if (!lanes.length) continue;

      const firstAvail = Math.min(...lanes.map(l => l.tAvail));
      if (firstAvail >= eft - 0.5) continue;

      // Each lane's contribution: alive time clipped to eft.
      let availSec = 0;
      for (const l of lanes) {
        const aliveEnd = Math.min(l.tDeath === Infinity ? eft : l.tDeath, eft);
        availSec += Math.max(0, aliveEnd - l.tAvail);
      }
      if (availSec <= 0.5) continue;

      // Busy intervals — skip zerg units (larvae prod isn't slot-tracked).
      const busyIntervals = [];
      for (const item of timeline) {
        // Addon swap occupies one slot on both source and target structures
        // for the full swap duration.
        if (item.kind === 'swap' && item.swapFrom && item.swapTo) {
          const fs = SC2_DATA.entities[item.swapFrom]?.producedBy;
          const ts = SC2_DATA.entities[item.swapTo]?.producedBy;
          if (rootOf(fs) === producerId || rootOf(ts) === producerId) {
            busyIntervals.push({
              start: item.start, end: item.end,
              name: item.name, kind: 'swap', id: item.id,
              swapFrom: item.swapFrom, swapTo: item.swapTo,
            });
          }
          continue;
        }
        const ie = SC2_DATA.entities[item.id];
        if (!ie) continue;
        if (ie.race === 'zerg' && ie.type === 'unit') continue;
        const ip = ie.upgradeFrom || ie.producedBy;
        if (!ip || rootOf(ip) !== producerId) continue;
        busyIntervals.push({
          start: item.start, end: item.end,
          name: ie.name, kind: item.kind, id: item.id,
        });
      }
      // Sort by start time, then prefer upgrades (so an OC at the same
      // instant as an SCV gets first pick of the oldest lane — i.e., the
      // starting CC, matching real-game intuition that you upgrade the
      // existing CC rather than the freshly-built one). Tie-break by end.
      busyIntervals.sort((a, b) => {
        if (Math.abs(a.start - b.start) > 1e-6) return a.start - b.start;
        const aUpg = SC2_DATA.entities[a.id]?.upgradeFrom ? 0 : 1;
        const bUpg = SC2_DATA.entities[b.id]?.upgradeFrom ? 0 : 1;
        if (aUpg !== bUpg) return aUpg - bUpg;
        return a.end - b.end;
      });

      let busySec = 0;
      for (const iv of busyIntervals) busySec += Math.max(0, iv.end - iv.start);
      busySec = Math.min(busySec, availSec);

      // Greedy: place each interval in the earliest lane that's alive and
      // free, with extra constraints:
      //   - Upgrade items (OC, Lair) must land on a main lane whose current
      //     "form" matches the upgrade's source.
      //   - Addon builds (Reactor, Tech Lab) must land on a main lane whose
      //     current addonForm is null. A Barracks that already has a
      //     Reactor can't visually accept a Tech Lab build.
      //   - Swap source side must land on a main lane whose addonForm
      //     matches the swap's swapFrom; the swap mutates that lane's
      //     addonForm to null at iv.end.
      //   - Swap target side must land on a main lane with no current
      //     addon; the swap mutates that lane's addonForm to swapTo.
      function laneAddonAt(lane, t) {
        // Sort defensively: addonChanges entries are pushed as intervals
        // are placed (sorted by start time), but the entries' t values
        // are END times — not necessarily monotonic when intervals overlap.
        const sorted = lane.addonChanges.slice().sort((a, b) => a.t - b.t);
        let form = null;
        for (const ev of sorted) {
          if (ev.t > t + 1e-9) break;
          form = ev.form;
        }
        return form;
      }
      const laneFreeAt = lanes.map(l => l.tAvail);
      for (const iv of busyIntervals) {
        const ie = SC2_DATA.entities[iv.id];
        const upgradeSource = ie && ie.upgradeFrom;
        const isAddonBuild = ie && ie.type === 'addon';
        const isSwap = iv.kind === 'swap';
        const swapFromProd = isSwap ? rootOf(SC2_DATA.entities[iv.swapFrom]?.producedBy) : null;
        const swapToProd = isSwap ? rootOf(SC2_DATA.entities[iv.swapTo]?.producedBy) : null;
        const isSwapSource = isSwap && swapFromProd === producerId;
        const isSwapTarget = isSwap && swapToProd === producerId;
        let placed = false;
        for (let k = 0; k < lanes.length; k++) {
          const lane = lanes[k];
          if (laneFreeAt[k] > iv.start + 1e-6) continue;
          if (iv.start >= lane.tDeath - 1e-9) continue;
          if (upgradeSource && (lane.type !== 'main' || lane.form !== upgradeSource)) continue;
          if (isAddonBuild) {
            if (lane.type !== 'main') continue;
            if (laneAddonAt(lane, iv.start) != null) continue;
          }
          if (isSwap) {
            if (lane.type !== 'main') continue;
            const cur = laneAddonAt(lane, iv.start);
            // Pick the right side: source needs the swapFrom addon; target needs no addon.
            if (isSwapSource && isSwapTarget) {
              // Same producer is both source & target — implausible but if
              // it happens, treat as source.
              if (cur !== iv.swapFrom) continue;
            } else if (isSwapSource) {
              if (cur !== iv.swapFrom) continue;
            } else if (isSwapTarget) {
              if (cur != null) continue;
            }
          }
          lane.intervals.push(iv);
          laneFreeAt[k] = iv.end;
          if (upgradeSource && lane.type === 'main') lane.form = iv.id;
          if (isAddonBuild && lane.type === 'main') {
            lane.addonChanges.push({ t: iv.end, form: iv.id });
          }
          if (isSwap && lane.type === 'main') {
            if (isSwapSource) lane.addonChanges.push({ t: iv.end, form: null });
            if (isSwapTarget) lane.addonChanges.push({ t: iv.end, form: iv.swapTo });
          }
          placed = true;
          break;
        }
        if (!placed) {
          // Fallback: if no lane satisfied all the constraints we still
          // have to put the interval somewhere so the visualization
          // matches what the simulator scheduled. lanes[0] is used as
          // an "approximate" host. This isn't pixel-perfect (a 2nd OC
          // can visually land on a CC that's already been upgraded if
          // form/timing constraints don't line up), but flagging every
          // such case with a warning lane was over-eager — it fired
          // even on builds that were actually valid. Revisit with a
          // more precise diagnosis when needed.
          lanes[0].intervals.push(iv);
          laneFreeAt[0] = Math.max(laneFreeAt[0], iv.end);
        }
      }

      const idleSec = Math.max(0, availSec - busySec);
      const idlePct = availSec > 0 ? idleSec / availSec : 0;

      const buildingCount = lanes.filter(l => l.type === 'main').length;
      const reactorCount = lanes.filter(l => l.type === 'reactor').length;
      out.push({
        producer: pe,
        slots: lanes.length,
        buildingCount,
        reactorCount,
        busySec, idleSec, availSec, idlePct, firstAvail, lanes,
      });
    }

    out.sort((a, b) => b.idleSec - a.idleSec || a.producer.name.localeCompare(b.producer.name));
    return out;
  }

  function isProducerFlagged(u) { return u.idlePct > 0.20 && u.idleSec > 10; }

  function renderProducerUtilization(util, eft) {
    if (!util.length || !eft) return '';
    const flaggedCount = util.filter(isProducerFlagged).length;
    const heading = flaggedCount
      ? `<h3>Production efficiency <span class="prod-util-flag-pill">${flaggedCount} idle</span></h3>`
      : `<h3>Production efficiency</h3>`;

    const tStep = eft > 360 ? 60 : eft > 60 ? 30 : 15;
    const ticks = [];
    for (let t = 0; t <= eft + 1e-6; t += tStep) ticks.push(t);

    const pct = (t) => Math.max(0, Math.min(100, (t / eft) * 100));

    const rows = util.map(u => {
      const flagged = isProducerFlagged(u);
      const labelParts = [];
      if (u.buildingCount > 1) labelParts.push(`×${u.buildingCount}`);
      if (u.reactorCount > 0) labelParts.push(u.reactorCount > 1 ? `+${u.reactorCount} reactors` : '+reactor');
      const slotsLabel = labelParts.join(' ');
      const tracks = u.lanes.map(lane => {
        const isOrphan = lane.type === 'orphan';
        const aliveEnd = Math.min(lane.tDeath === Infinity ? eft : lane.tDeath, eft);
        const availLeft = pct(lane.tAvail);
        const availWidth = Math.max(0, pct(aliveEnd) - availLeft);
        const segs = lane.intervals.map(iv => {
          const left = pct(iv.start);
          const width = Math.max(0.4, pct(iv.end) - left);
          const tipNote = isOrphan ? ' · ⚠ no eligible producer was free at this time' : '';
          const t = `${iv.name} · ${fmtTime(iv.start)} → ${fmtTime(iv.end)} (${fmtTime(iv.end - iv.start)})${tipNote}`;
          return `<div class="prod-util-seg${isOrphan ? ' prod-util-seg-orphan' : ''}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${t}"></div>`;
        }).join('');
        return `
          <div class="prod-util-track${isOrphan ? ' prod-util-track-orphan' : ''}"${isOrphan ? ' title="These actions had no eligible producer ready at their start time — usually a missing or not-yet-built upgrade source"' : ''}>
            ${isOrphan ? '<span class="prod-util-orphan-label">⚠ unassigned</span>' : ''}
            ${availWidth > 0 && !isOrphan ? `<div class="prod-util-avail" style="left:${availLeft.toFixed(2)}%;width:${availWidth.toFixed(2)}%"></div>` : ''}
            ${segs}
          </div>
        `;
      }).join('');
      const tooltip = `Available: ${fmtTime(u.availSec)} (from ${fmtTime(u.firstAvail)}) · Busy: ${fmtTime(u.busySec)} · Idle: ${fmtTime(u.idleSec)}`;
      return `
        <div class="prod-util-row${flagged ? ' flagged' : ''}" title="${tooltip}">
          <div class="prod-util-icon">${iconHtml(u.producer, { size: 22 })}</div>
          <div class="prod-util-body">
            <div class="prod-util-head">
              <span class="prod-util-name">${u.producer.name}${slotsLabel ? ` <span class="prod-util-slots">${slotsLabel}</span>` : ''}</span>
              <span class="prod-util-pct${flagged ? ' flagged' : ''}">${Math.round(u.idlePct * 100)}% idle · ${fmtTime(u.idleSec)}</span>
            </div>
            <div class="prod-util-track-stack">${tracks}</div>
          </div>
        </div>
      `;
    }).join('');

    const axis = `
      <div class="prod-util-axis-row">
        <div class="prod-util-icon" aria-hidden="true"></div>
        <div class="prod-util-axis">
          ${ticks.map(t => `<span class="prod-util-tick" style="left:${pct(t).toFixed(2)}%">${fmtTime(t)}</span>`).join('')}
        </div>
      </div>
    `;

    const legend = `
      <div class="prod-util-legend">
        <span><i class="prod-util-key busy"></i>producing</span>
        <span><i class="prod-util-key idle"></i>idle (slot available, nothing queued)</span>
        <span><i class="prod-util-key offline"></i>not built yet</span>
      </div>
    `;

    // Long builds compress badly inside a fixed-width container — give the
    // inner block a min-width so each second gets at least ~2.5px, then let
    // the section scroll horizontally.
    const minWidthPx = Math.max(640, Math.round(eft * 2.5));

    return `
      <div class="path-section collapsible-section" data-section-id="forge-producer-util">
        ${heading}
        <div class="prod-util-scroll">
          <div class="prod-util" style="min-width:${minWidthPx}px">${rows}${axis}</div>
        </div>
        ${legend}
      </div>
    `;
  }

  // Find sustained intervals where a resource pile is excessively high —
  // a heuristic for "floating", i.e. the player isn't spending fast enough.
  // Thresholds are chosen to flag clearly-actionable cases without firing
  // on the unavoidable warmup minute or on the brief stockpile before a
  // pricey unit (e.g. a Battlecruiser's 400m). Returns the worst stretch
  // per resource (minerals, gas), or [] if nothing meaningful is found.
  const FLOAT_THRESHOLDS = {
    minerals: { amount: 600, minDuration: 20 },
    gas: { amount: 300, minDuration: 20 },
  };
  function detectResourceFloats(history) {
    if (!Array.isArray(history) || history.length < 4) return [];
    const out = [];
    const checks = [
      { key: 'minerals', label: 'minerals', cfg: FLOAT_THRESHOLDS.minerals },
      { key: 'gas', label: 'gas', cfg: FLOAT_THRESHOLDS.gas },
    ];
    for (const c of checks) {
      let bStart = null, bPeak = 0, bPeakAt = 0, best = null;
      for (let i = 0; i < history.length; i++) {
        const h = history[i];
        const v = h[c.key] || 0;
        if (v >= c.cfg.amount) {
          if (bStart == null) { bStart = h.t; bPeak = v; bPeakAt = h.t; }
          if (v > bPeak) { bPeak = v; bPeakAt = h.t; }
        } else if (bStart != null) {
          const dur = h.t - bStart;
          if (dur >= c.cfg.minDuration && (!best || dur > best.duration)) {
            best = { label: c.label, start: bStart, duration: dur, peak: bPeak, peakAt: bPeakAt };
          }
          bStart = null; bPeak = 0; bPeakAt = 0;
        }
      }
      if (bStart != null) {
        const dur = history[history.length - 1].t - bStart;
        if (dur >= c.cfg.minDuration && (!best || dur > best.duration)) {
          best = { label: c.label, start: bStart, duration: dur, peak: bPeak, peakAt: bPeakAt };
        }
      }
      if (best) out.push(best);
    }
    return out;
  }

  function renderResourceChart(history, eft) {
    if (!history || history.length < 2) return '<div class="forge-empty">Not enough data to chart.</div>';
    const W = 720, H = 220;
    const PAD = { top: 16, right: 56, bottom: 28, left: 48 };
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const tMax = Math.max(eft || 0, history[history.length - 1].t, 1);
    const resMax = Math.max(50, ...history.map(h => Math.max(h.minerals, h.gas)));
    // Right-side axis covers both supply cap AND total worker count, since
    // they're both small integer counts and tend to stay within ~200. The
    // ticks are computed from this combined max so both lines are readable.
    const workerCounts = history.map(h => (h.mineral_workers || 0) + (h.gas_workers || 0));
    const supMax = Math.max(15, ...history.map(h => h.supply_max), ...workerCounts);

    const xS = t => PAD.left + (t / tMax) * innerW;
    const yR = v => PAD.top + innerH - (v / resMax) * innerH;
    const yS = v => PAD.top + innerH - (v / supMax) * innerH;

    function path(points) {
      return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    }
    const minPts = history.map(h => ({ x: xS(h.t), y: yR(h.minerals) }));
    const gasPts = history.map(h => ({ x: xS(h.t), y: yR(h.gas) }));
    const supUsedPts = history.map(h => ({ x: xS(h.t), y: yS(h.supply_used) }));
    const supMaxPts = history.map(h => ({ x: xS(h.t), y: yS(h.supply_max) }));
    const workerPts = history.map((h, i) => ({ x: xS(h.t), y: yS(workerCounts[i]) }));

    // Y-axis ticks (left = resources, right = supply)
    const resTicks = [0, 0.5, 1].map(f => Math.round(resMax * f));
    const supTicks = [0, 0.5, 1].map(f => Math.round(supMax * f));
    const tStep = tMax > 240 ? 60 : tMax > 60 ? 30 : 10;
    const tTicks = [];
    for (let t = 0; t <= tMax; t += tStep) tTicks.push(t);

    // Mark each timeline event with a vertical hint
    const events = (state.forgeResult?.timeline || []).map(item => ({
      x: xS(item.start), name: item.name, t: item.start, race: item.race
    }));

    // Detect supply-blocked intervals: stretches where supply_used has hit
    // supply_max. Drawn as a red band along the bottom so the gap-causing
    // periods stand out without obscuring the line plots.
    const blockedIvs = [];
    let bStart = null;
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const blocked = h.supply_max > 0 && h.supply_used >= h.supply_max;
      if (blocked && bStart == null) bStart = h.t;
      if (!blocked && bStart != null) {
        if (h.t - bStart > 0.5) blockedIvs.push({ start: bStart, end: h.t });
        bStart = null;
      }
    }
    if (bStart != null && tMax - bStart > 0.5) blockedIvs.push({ start: bStart, end: tMax });
    const blockedBandY = H - PAD.bottom - 6;
    const blockedSvg = blockedIvs.map(iv => {
      const x = xS(iv.start);
      const w = Math.max(2, xS(iv.end) - x);
      return `<rect x="${x.toFixed(1)}" y="${blockedBandY}" width="${w.toFixed(1)}" height="4" class="supply-blocked-band">
        <title>Supply blocked ${fmtTime(iv.start)} → ${fmtTime(iv.end)} (${(iv.end - iv.start).toFixed(0)}s)</title>
      </rect>`;
    }).join('');

    return `
      <div class="res-chart-wrap" data-chart="resources">
        <svg viewBox="0 0 ${W} ${H}" class="res-chart" preserveAspectRatio="xMidYMid meet">
          <!-- axis grid -->
          ${resTicks.map(v => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yR(v)}" y2="${yR(v)}" class="grid" />
            <text x="${PAD.left - 6}" y="${yR(v) + 4}" class="axis-label" text-anchor="end">${v}</text>`).join('')}
          ${supTicks.map(v => `<text x="${W - PAD.right + 6}" y="${yS(v) + 4}" class="axis-label sup" text-anchor="start">${v}</text>`).join('')}
          ${tTicks.map(t => `<text x="${xS(t)}" y="${H - 8}" class="axis-label" text-anchor="middle">${fmtTime(t)}</text>`).join('')}
          <!-- step markers -->
          ${events.map(ev => `<line x1="${ev.x}" x2="${ev.x}" y1="${PAD.top}" y2="${H - PAD.bottom}" class="event-mark race-${ev.race}" />`).join('')}
          <!-- supply max (dashed) -->
          <path d="${path(supMaxPts)}" class="line line-sup-max" />
          <!-- supply used -->
          <path d="${path(supUsedPts)}" class="line line-sup" />
          <!-- workers (total, right axis — same scale as supply) -->
          <path d="${path(workerPts)}" class="line line-workers" />
          <!-- gas -->
          <path d="${path(gasPts)}" class="line line-gas" />
          <!-- minerals -->
          <path d="${path(minPts)}" class="line line-min" />
          <!-- supply-blocked band (red strip along bottom) -->
          ${blockedSvg}
          <!-- hover indicators (toggled on mousemove) -->
          <g class="hover-group" style="display:none">
            <line class="hover-cursor" y1="${PAD.top}" y2="${H - PAD.bottom}" />
            <circle class="hover-dot dot-min" r="3" />
            <circle class="hover-dot dot-gas" r="3" />
            <circle class="hover-dot dot-sup" r="3" />
            <circle class="hover-dot dot-workers" r="3" />
          </g>
        </svg>
        <div class="chart-tooltip" style="display:none"></div>
        <div class="chart-legend">
          <span><span class="swatch swatch-min"></span> Minerals</span>
          <span><span class="swatch swatch-gas"></span> Gas</span>
          <span><span class="swatch swatch-workers"></span> Workers</span>
          <span><span class="swatch swatch-sup"></span> Supply used</span>
          <span><span class="swatch swatch-sup-max"></span> Supply cap</span>
          ${blockedIvs.length ? `<span><span class="swatch swatch-blocked"></span> Supply blocked</span>` : ''}
          <span class="chart-legend-hint">Hover the chart for live values</span>
        </div>
      </div>
    `;
  }

  function attachChartHover(wrap, history, eft) {
    if (!wrap) return;
    const svg = wrap.querySelector('svg');
    const tooltip = wrap.querySelector('.chart-tooltip');
    const hoverGroup = wrap.querySelector('.hover-group');
    const cursor = wrap.querySelector('.hover-cursor');
    const dotMin = wrap.querySelector('.dot-min');
    const dotGas = wrap.querySelector('.dot-gas');
    const dotSup = wrap.querySelector('.dot-sup');
    const dotWorkers = wrap.querySelector('.dot-workers');

    // Same constants as renderResourceChart — keep in sync if you change one
    const W = 720, H = 220;
    const PAD = { top: 16, right: 56, bottom: 28, left: 48 };
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const tMax = Math.max(eft || 0, history[history.length - 1].t, 1);
    const resMax = Math.max(50, ...history.map(h => Math.max(h.minerals, h.gas)));
    const workerCounts = history.map(h => (h.mineral_workers || 0) + (h.gas_workers || 0));
    const supMax = Math.max(15, ...history.map(h => h.supply_max), ...workerCounts);
    const xS = t => PAD.left + (t / tMax) * innerW;
    const yR = v => PAD.top + innerH - (v / resMax) * innerH;
    const yS = v => PAD.top + innerH - (v / supMax) * innerH;

    function svgPointFromMouse(ev) {
      const rect = svg.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (W / rect.width);
      const y = (ev.clientY - rect.top) * (H / rect.height);
      return { x, y, rect };
    }

    function findNearest(t) {
      // Linear scan; history is small (50-200 entries). Pick nearest by absolute time diff.
      let best = history[0];
      let bestDiff = Math.abs(history[0].t - t);
      for (let i = 1; i < history.length; i++) {
        const d = Math.abs(history[i].t - t);
        if (d < bestDiff) { best = history[i]; bestDiff = d; }
      }
      return best;
    }

    svg.addEventListener('mousemove', (ev) => {
      const { x, rect } = svgPointFromMouse(ev);
      if (x < PAD.left - 2 || x > W - PAD.right + 2) {
        hoverGroup.style.display = 'none';
        tooltip.style.display = 'none';
        return;
      }
      const t = ((x - PAD.left) / innerW) * tMax;
      const h = findNearest(t);

      hoverGroup.style.display = '';
      cursor.setAttribute('x1', xS(h.t));
      cursor.setAttribute('x2', xS(h.t));
      dotMin.setAttribute('cx', xS(h.t)); dotMin.setAttribute('cy', yR(h.minerals));
      dotGas.setAttribute('cx', xS(h.t)); dotGas.setAttribute('cy', yR(h.gas));
      dotSup.setAttribute('cx', xS(h.t)); dotSup.setAttribute('cy', yS(h.supply_used));
      const wCount = (h.mineral_workers || 0) + (h.gas_workers || 0);
      dotWorkers.setAttribute('cx', xS(h.t)); dotWorkers.setAttribute('cy', yS(wCount));

      const supplyBlocked = h.supply_max > 0 && h.supply_used >= h.supply_max;
      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <div class="tt-time">${fmtTime(h.t)} game · ${fmtTime(h.t / SC2_DATA.speedMultiplier)} real</div>
        <div class="tt-row"><span class="sw sw-min"></span>Minerals: <strong>${Math.round(h.minerals)}</strong> <span class="tt-rate">@ ${h.mineral_rate.toFixed(1)} m/s</span></div>
        <div class="tt-row"><span class="sw sw-gas"></span>Gas: <strong>${Math.round(h.gas)}</strong> <span class="tt-rate">@ ${h.gas_rate.toFixed(1)} g/s</span></div>
        <div class="tt-row"><span class="sw sw-sup"></span>Supply: <strong>${h.supply_used}/${h.supply_max}</strong>${supplyBlocked ? ' <span class="tt-blocked">⚠ BLOCKED</span>' : ''}</div>
        <div class="tt-row tt-meta">Workers: ${h.mineral_workers + h.gas_workers} (${h.mineral_workers}m + ${h.gas_workers}g)</div>
      `;
      // Position tooltip in pixel coords
      const tipX = ev.clientX - rect.left + 14;
      const tipY = ev.clientY - rect.top + 14;
      tooltip.style.left = Math.min(tipX, rect.width - 220) + 'px';
      tooltip.style.top = Math.min(tipY, rect.height - 110) + 'px';
    });
    svg.addEventListener('mouseleave', () => {
      hoverGroup.style.display = 'none';
      tooltip.style.display = 'none';
    });
  }

  function renderForgeTimeline(timeline) {
    if (!timeline.length) return '<div class="forge-empty">No actions completed.</div>';
    const typeLabel = { unit: '⏵', building: '◧', addon: '⊞', upgrade: '⚡' };
    const rows = timeline.map(item => {
      const cost = `${item.mins}m${item.gas ? ' + ' + item.gas + 'g' : ''}`;
      const buildTime = `${(item.end - item.start).toFixed(1)}s`;
      const e = SC2_DATA.entities[item.id];
      const type = e?.type || 'unit';
      return `
        <tr>
          <td class="col-time">${fmtTimeBoth(item.start)} → ${fmtTimeBoth(item.end)}</td>
          <td class="col-build">${buildTime}</td>
          <td class="col-name">
            <span class="type-glyph ${type}">${typeLabel[type] || '?'}</span>
            ${item.name}
          </td>
          <td class="col-cost">${cost}</td>
          <td class="col-detail">${describeEntity(e)}</td>
        </tr>
      `;
    }).join('');
    return `
      <table class="path-table">
        <thead><tr><th>Window</th><th>Build</th><th>Action</th><th>Cost</th><th>Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ============================================================
  // Rendering: Scout Translator
  // ============================================================

  function renderScoutPanel() {
    populateScoutDropdowns();
    const sel = document.getElementById('scout-entity');
    renderEntityPickerGrid({
      gridEl: document.getElementById('scout-grid'),
      typesContainer: document.getElementById('scout-type-tabs'),
      race: state.scoutRace,
      type: state.scoutPickerType,
      currentId: sel ? sel.value : null,
      onPick: (id) => {
        if (sel) sel.value = id;
        renderScoutPanel();
      },
    });
    renderScoutList();
    renderScoutResult();
  }

  function populateScoutDropdowns() {
    const entitySel = document.getElementById('scout-entity');
    const race = state.scoutRace;
    entitySel.innerHTML = '';
    const grouped = groupByType(race);
    for (const [type, list] of Object.entries(grouped)) {
      const og = document.createElement('optgroup');
      og.label = capitalize(type);
      for (const e of list) {
        if (e.starting && type !== 'unit') continue; // skip starting buildings as scout target
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        og.appendChild(opt);
      }
      entitySel.appendChild(og);
    }
  }

  function renderScoutList() {
    const root = document.getElementById('scout-list');
    if (!state.scouts.length) {
      root.innerHTML = '<span class="scout-empty">No observations yet — add one above.</span>';
      return;
    }
    root.innerHTML = state.scouts.map((s, i) => {
      const e = SC2_DATA.entities[s.id];
      return `
        <span class="scout-pill">
          <strong>${e?.name || s.id}</strong>
          ${s.eventType} ${fmtTime(s.time)}
          <span class="x" data-idx="${i}" title="Remove">×</span>
        </span>
      `;
    }).join('');
    root.querySelectorAll('.x').forEach(x => {
      x.addEventListener('click', e => {
        state.scouts.splice(parseInt(e.target.dataset.idx, 10), 1);
        renderScoutPanel();
      });
    });
  }

  function renderScoutResult() {
    const root = document.getElementById('scout-result');
    const race = state.scoutRace;

    // Compute eft from each scout (completed = scouted_time; started = scouted_time + buildTime)
    const scoutedEfts = {};
    for (const s of state.scouts) {
      const e = SC2_DATA.entities[s.id];
      if (!e) continue;
      const eft = s.eventType === 'completed' ? s.time : s.time + e.buildTime;
      // If this entity already has a scouted eft, use the stricter (earlier) one
      if (scoutedEfts[s.id] == null || eft < scoutedEfts[s.id]) {
        scoutedEfts[s.id] = eft;
      }
    }

    const engine = compileEngine({ scoutedEfts, chrono: state.chrono });
    const all = engine.computeAll();

    if (!state.scouts.length) {
      // Show pure scratch timings
      root.innerHTML = renderThreatGrid(all, race, 'All possible threats from a fresh start (no scouting)', null);
      return;
    }

    // Build downstream sets per scouted entity
    const scoutedIds = new Set(state.scouts.map(s => s.id));
    const downstream = computeDownstream(scoutedIds, race);
    const upstream = computeUpstream(scoutedIds); // implied prereqs of scouted

    // Sort entities of the observed race by eft, exclude starting + scouted themselves
    const entries = Object.values(all)
      .filter(r => r.entity && r.entity.race === race && !r.entity.starting)
      .filter(r => !scoutedIds.has(r.entity.id))
      .sort((a, b) => a.eft - b.eft);

    const directThreats = entries.filter(r => downstream.has(r.entity.id));
    const otherPossible = entries.filter(r => !downstream.has(r.entity.id) && !upstream.has(r.entity.id));

    let html = '';
    html += `
      <div class="threat-section">
        <h3>Direct downstream threats from observed tech</h3>
        ${directThreats.length
          ? `<div class="threat-grid">${directThreats.map(r => renderThreatCard(r)).join('')}</div>`
          : '<p style="color:var(--text-3);font-size:13px;font-style:italic;">No downstream threats from these observations alone.</p>'}
      </div>
    `;
    html += `
      <div class="threat-section">
        <h3>Other tech they could also have (independent paths)</h3>
        <p style="color:var(--text-2);font-size:13px;margin:0 0 12px;">These are unconfirmed by your scouting but reachable from a fresh start by their earliest possible time.</p>
        <div class="threat-grid">${otherPossible.map(r => renderThreatCard(r)).join('')}</div>
      </div>
    `;
    root.innerHTML = html;
  }

  function renderThreatCard(r) {
    const e = r.entity;
    const meta = describeEntity(e);
    return `
      <div class="threat-card race-${e.race}">
        <div class="threat-name">${e.name}</div>
        <div class="threat-time">${fmtTimeBoth(r.eft)}</div>
        <div class="threat-meta">${state.realTime ? fmtTime(r.eft) + ' game' : fmtTime(r.eft / SC2_DATA.speedMultiplier) + ' real'}${meta ? ' · ' + meta : ''}</div>
      </div>
    `;
  }

  function renderThreatGrid(all, race, headline, _) {
    const entries = Object.values(all)
      .filter(r => r.entity && r.entity.race === race && !r.entity.starting)
      .sort((a, b) => a.eft - b.eft);
    return `
      <div class="threat-section">
        <h3>${headline}</h3>
        <div class="threat-grid">${entries.map(r => renderThreatCard(r)).join('')}</div>
      </div>
    `;
  }

  function computeUpstream(scoutedIds) {
    const out = new Set();
    function walk(id) {
      if (out.has(id)) return;
      out.add(id);
      const e = SC2_DATA.entities[id];
      if (!e) return;
      for (const p of (e.prerequisites || [])) walk(p);
    }
    for (const id of scoutedIds) walk(id);
    return out;
  }

  function computeDownstream(scoutedIds, race) {
    // BFS: anything whose prerequisite chain transitively touches a scouted entity
    const out = new Set();
    for (const id of Object.keys(SC2_DATA.entities)) {
      const e = SC2_DATA.entities[id];
      if (!e || e.race !== race) continue;
      if (touchesScouted(id, scoutedIds, new Set())) out.add(id);
    }
    return out;
  }
  function touchesScouted(id, scoutedIds, seen) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (scoutedIds.has(id)) return true;
    const e = SC2_DATA.entities[id];
    if (!e) return false;
    for (const p of (e.prerequisites || [])) {
      if (touchesScouted(p, scoutedIds, seen)) return true;
    }
    return false;
  }

  // ============================================================
  // Rendering: Window Lookup
  // ============================================================

  function renderWindow() {
    const root = document.getElementById('window-result');
    const race = state.windowRace;
    const limitGame = state.windowBasis === 'real'
      ? state.windowTime * SC2_DATA.speedMultiplier
      : state.windowTime;

    // For each entity of this race, run a quick simulation. Cache to avoid duplicate work.
    // We use the static calc as a fast first pass; then run full sim for entities whose
    // static eft is within a reasonable bound of the limit (so we don't sim units that are
    // clearly out of reach).
    const engine = compileEngine({ chrono: state.chrono });
    const all = engine.computeAll();
    const raceEntries = Object.values(all).filter(r => r.entity && r.entity.race === race);

    // Run full sim for each non-starting entity; this gives realistic eft.
    const simResults = new Map();
    for (const r of raceEntries) {
      if (r.entity.starting) {
        simResults.set(r.entity.id, { eft: 0, static: 0 });
        continue;
      }
      // Skip "synthetic" entities (larva)
      if (r.entity.id === 'larva') continue;
      const simResult = SC2_SIM.simulate(r.entity.id, { opening: 'standard' });
      simResults.set(r.entity.id, { eft: simResult.eft, static: r.eft });
    }

    const entries = raceEntries
      .filter(r => simResults.has(r.entity.id))
      .map(r => ({
        entity: r.entity,
        eft: simResults.get(r.entity.id).eft != null ? simResults.get(r.entity.id).eft : Infinity,
        staticEft: simResults.get(r.entity.id).static,
      }))
      .sort((a, b) => a.eft - b.eft);

    const reachable = entries.filter(r => r.eft <= limitGame);
    const unreachable = entries.filter(r => r.eft > limitGame);

    const groups = {
      Buildings: reachable.filter(r => r.entity.type === 'building'),
      'Add-ons': reachable.filter(r => r.entity.type === 'addon'),
      Units: reachable.filter(r => r.entity.type === 'unit'),
      Upgrades: reachable.filter(r => r.entity.type === 'upgrade'),
    };

    let html = `
      <div class="window-summary">
        <h3>By ${fmtTime(state.windowTime)} ${state.windowBasis === 'real' ? 'real time' : 'game time'} (${fmtTime(limitGame)} game)</h3>
        <span class="stat"><span class="stat-num">${reachable.length}</span> reachable</span>
        <span class="stat"><span class="stat-num">${unreachable.length}</span> still unreachable</span>
        <div style="font-size:12px;color:var(--text-3);margin-top:6px;">Each entity simulated independently with the standard opening. Numbers reflect realistic earliest with full economy.</div>
      </div>
    `;
    const renderItem = (r, extraCls = '') => `
      <div class="window-item ${extraCls}" title="${r.entity.name} — ready by ${fmtTime(r.eft)}">
        ${iconHtml(r.entity, { size: 32 })}
        <div class="window-item-text">
          <div class="window-item-name">${r.entity.name}</div>
          <div class="window-item-time">${fmtTimeBoth(r.eft)}</div>
        </div>
      </div>
    `;
    for (const [label, list] of Object.entries(groups)) {
      if (!list.length) continue;
      html += `
        <div class="window-group">
          <h4>${label} <span class="window-group-count">${list.length}</span></h4>
          <div class="window-list">
            ${list.map(r => renderItem(r)).join('')}
          </div>
        </div>
      `;
    }
    if (unreachable.length) {
      html += `
        <div class="window-group">
          <h4>Not yet reachable <span class="window-group-count">${unreachable.length}</span></h4>
          <div class="window-list">
            ${unreachable.slice(0, 30).map(r => renderItem(r, 'unreachable')).join('')}
          </div>
        </div>
      `;
    }
    root.innerHTML = html;
  }

  // ============================================================
  // Rendering: Reference
  // ============================================================

  function renderReference() {
    const root = document.getElementById('reference-content');
    const race = state.refRace;
    const grouped = groupByType(race);
    const order = ['building', 'addon', 'unit', 'upgrade'];

    let html = '';
    for (const type of order) {
      const list = grouped[type];
      if (!list || !list.length) continue;
      html += `
        <div class="ref-table-wrap">
          <h3>${capitalize(type)}s</h3>
          <table class="ref-table">
            <thead>
              <tr>
                <th>Name</th>
                <th class="num">Build (s)</th>
                <th class="num">Min</th>
                <th class="num">Gas</th>
                <th class="num">Sup</th>
                <th>Producer / Source</th>
                <th>Prerequisites</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(e => `
                <tr>
                  <td class="col-name-with-icon">
                    <span class="ref-row-icon">${iconHtml(e, { size: 24 })}</span>
                    <strong>${e.name}</strong>
                  </td>
                  <td class="num">${e.buildTime}</td>
                  <td class="num">${e.minerals ?? ''}</td>
                  <td class="num">${e.gas || ''}</td>
                  <td class="num">${e.supply ?? (e.provides ? '+' + e.provides : '')}</td>
                  <td>${e.upgradeFrom ? '↑ ' + nameOf(e.upgradeFrom) : (e.producedBy ? nameOf(e.producedBy) : (e.builtBy ? nameOf(e.builtBy) : ''))}</td>
                  <td class="deps">${(e.prerequisites || []).map(nameOf).join(', ') || '—'}</td>
                  <td style="font-size:12px;color:var(--text-2);">${e.note || ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    root.innerHTML = html;
  }

  function groupByType(race) {
    const grouped = { building: [], addon: [], unit: [], upgrade: [] };
    for (const e of Object.values(SC2_DATA.entities)) {
      if (e.race !== race) continue;
      if (!grouped[e.type]) grouped[e.type] = [];
      grouped[e.type].push(e);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => a.buildTime - b.buildTime || a.name.localeCompare(b.name));
    }
    return grouped;
  }

  // ============================================================
  // UI helpers
  // ============================================================

  function populateEntityDropdown(select, opts = {}) {
    const races = ['terran', 'protoss', 'zerg'];
    const typeOrder = { unit: 0, upgrade: 1, building: 2, addon: 3 };
    const typeLabel = { unit: '⏵', building: '◧', addon: '⊞', upgrade: '⚡' };
    select.innerHTML = '';
    for (const race of races) {
      const raceEnts = Object.values(SC2_DATA.entities)
        .filter(e => e.race === race)
        .filter(e => !(opts.excludeStarting && e.starting));
      // Sub-group by type within race
      for (const type of ['unit', 'upgrade', 'building', 'addon']) {
        const list = raceEnts.filter(e => e.type === type);
        if (!list.length) continue;
        list.sort((a, b) => a.name.localeCompare(b.name));
        const og = document.createElement('optgroup');
        og.label = `${capitalize(race)} — ${capitalize(type === 'addon' ? 'add-ons' : type + 's')}`;
        for (const e of list) {
          const opt = document.createElement('option');
          opt.value = e.id;
          opt.textContent = `${typeLabel[type] || ''} ${e.name}`;
          og.appendChild(opt);
        }
        select.appendChild(og);
      }
    }
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ============================================================
  // Mode switching + wiring
  // ============================================================

  function switchMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById(`mode-${mode}`).classList.add('active');
    renderActive();
  }

  function renderActive() {
    if (state.mode === 'explorer') renderExplorer();
    else if (state.mode === 'forge') renderForge();
    else if (state.mode === 'scout') renderScoutPanel();
    else if (state.mode === 'window') renderWindow();
    else if (state.mode === 'reference') renderReference();
  }

  function renderAll() {
    renderExplorer();
    renderForge();
    renderScoutPanel();
    renderWindow();
    renderReference();
  }

  function init() {
    // Mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });

    // Reference race tabs
    document.querySelectorAll('.ref-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ref-tab').forEach(t => t.classList.toggle('active', t === tab));
        state.refRace = tab.dataset.race;
        renderReference();
      });
    });

    // The old global "Real time" / "Apply chrono boost" toggles were
    // removed from the header — they were ambient settings that didn't
    // belong as global. Real-time is now per-tab where it matters
    // (Window Lookup has a basis select; Forge result shows both side-by-
    // side). Chrono is per-step in the Forge (see chrono toggle on rows)
    // and has its own control on Window Lookup. state.chrono and
    // state.realTime stay as defaults but no longer wired to a UI toggle.

    // Explorer
    document.getElementById('explorer-target').addEventListener('change', e => {
      state.explorerTarget = e.target.value;
      state.explorerReference = ''; // changing target invalidates reference
      renderExplorer();
    });
    document.getElementById('explorer-opening').addEventListener('change', e => {
      state.explorerOpening = e.target.value;
      state.explorerReference = '';
      renderExplorer();
    });
    document.getElementById('explorer-reference').addEventListener('change', e => {
      state.explorerReference = e.target.value;
      renderExplorer();
    });

    // ---------- Build Forge ----------
    document.getElementById('forge-race').addEventListener('change', e => {
      if (state.forgeOrder.length && !confirm('Switching race will clear the current build. Continue?')) {
        e.target.value = state.forgeRace;
        return;
      }
      state.forgeRace = e.target.value;
      state.forgeOrder = [];
      state.forgeResult = null;
      renderForge();
      persistForge();
    });
    document.getElementById('forge-preset').addEventListener('change', e => {
      const preset = (FORGE_PRESETS[state.forgeRace] || {})[e.target.value];
      if (preset) {
        state.forgeOrder = JSON.parse(JSON.stringify(preset));
        state.forgeResult = null;
        renderForge();
        scheduleForgeRun();
      }
    });
    document.getElementById('forge-clear').addEventListener('click', () => {
      if (state.forgeOrder.length && !confirm('Clear the entire build order?')) return;
      state.forgeOrder = [];
      state.forgeResult = null;
      document.getElementById('forge-preset').value = '';
      renderForge();
      persistForge();
    });

    // Build Library button — opens the manager modal
    document.getElementById('forge-library').addEventListener('click', openBuildLibrary);

    // Share button — opens text/SALT export + SALT import modal
    document.getElementById('forge-share').addEventListener('click', openShareModal);

    // JSON file input is shared between the library modal's "Import JSON"
    // button and any drag-drop affordances we add later. The modal sets
    // dataset.target to control where the parsed build goes.
    document.getElementById('forge-load-input').addEventListener('change', (ev) => {
      const input = ev.target;
      const file = input.files && input.files[0];
      const target = input.dataset.target || 'forge'; // 'forge' | 'library'
      input.dataset.target = '';
      input.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => alert('Could not read file.');
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          const parsed = parseBuildPayload(data, file.name);
          if (!parsed) return;
          if (target === 'library') {
            saveBuildToLibrary({
              name: parsed.name,
              race: parsed.race,
              buildOrder: parsed.buildOrder,
              priority: parsed.priority,
              source: 'import',
            });
            renderBuildLibraryList();
            if (parsed.skipped) alert(`Imported "${parsed.name}" into the library — ${parsed.skipped} step(s) skipped (unknown entities).`);
          } else {
            applyBuildToForge(parsed);
            if (parsed.skipped) alert(`Loaded "${parsed.name}" — ${parsed.skipped} step(s) skipped (unknown entities).`);
          }
        } catch (err) {
          alert('Failed to parse file: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    document.getElementById('forge-add-btn').addEventListener('click', () => {
      const id = document.getElementById('forge-add-entity').value;
      const count = Math.max(1, parseInt(document.getElementById('forge-add-count').value, 10) || 1);
      if (!id) return;
      state.forgeOrder.push({ entityId: id, repeat: count });
      recordRecent(id);
      document.getElementById('forge-add-search').value = '';
      const sel = document.getElementById('forge-add-entity');
      sel.size = 1;
      for (const opt of sel.querySelectorAll('option')) opt.hidden = false;
      for (const og of sel.querySelectorAll('optgroup')) og.hidden = false;
      renderForgeList();
      renderForgeQuickAdd();
      scheduleForgeRun();
    });
    const swapBtn = document.getElementById('forge-add-swap');
    if (swapBtn) {
      swapBtn.addEventListener('click', () => promptSwap());
    }
    const fillBtn = document.getElementById('forge-fill-workers');
    if (fillBtn) {
      fillBtn.addEventListener('click', () => fillWorkers());
    }
    const prioBtn = document.getElementById('forge-add-priority');
    if (prioBtn) {
      prioBtn.addEventListener('click', () => {
        // Default the new marker to the most recent prior priority order
        // (or the build's starting order). User can reorder via the chip
        // arrows on the row.
        let seed = state.forgePriority.slice();
        for (let i = state.forgeOrder.length - 1; i >= 0; i--) {
          if (state.forgeOrder[i] && state.forgeOrder[i].kind === 'priority') {
            seed = sanitizePriority(state.forgeOrder[i].order);
            break;
          }
        }
        state.forgeOrder.push({ kind: 'priority', order: seed });
        renderForgeList();
        scheduleForgeRun();
      });
    }

    // Browse-grid tab switching
    for (const btn of document.querySelectorAll('#forge-browse-tabs .browse-tab')) {
      btn.addEventListener('click', () => {
        state.forgeBrowseTab = btn.dataset.tab;
        renderForgeBrowse();
      });
    }
    // Compact palette toggle — icons-only mode for users with long builds
    const compactToggle = document.getElementById('forge-palette-compact');
    if (compactToggle) {
      compactToggle.checked = !!state.forgePaletteCompact;
      compactToggle.addEventListener('change', () => {
        state.forgePaletteCompact = compactToggle.checked;
        renderForgeBrowse();
        persistForge();
      });
    }
    // Palette collapse — chevron at the right of the palette head. Hides
    // the icon grid entirely so the build list takes the full column.
    const collapseToggle = document.getElementById('forge-palette-collapse');
    if (collapseToggle) {
      collapseToggle.addEventListener('click', () => {
        state.forgePaletteCollapsed = !state.forgePaletteCollapsed;
        renderForgeBrowse();
        persistForge();
      });
    }
    // Global "/" hotkey: focus the Forge search bar from anywhere in the
    // Forge tab, so adding a unit is always one keystroke away.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== '/') return;
      if (state.mode !== 'forge') return;
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      ev.preventDefault();
      const s = document.getElementById('forge-add-search');
      if (s) { s.focus(); s.select(); }
    });
    // Forge add-search filter (mirrors explorer search)
    const forgeSearch = document.getElementById('forge-add-search');
    const forgeAddSel = document.getElementById('forge-add-entity');
    forgeSearch.addEventListener('input', () => {
      const q = forgeSearch.value.toLowerCase().trim();
      let firstMatch = null;
      for (const og of forgeAddSel.querySelectorAll('optgroup')) {
        let visible = 0;
        for (const opt of og.querySelectorAll('option')) {
          const e = SC2_DATA.entities[opt.value];
          const haystack = `${opt.textContent} ${e?.note || ''}`.toLowerCase();
          const m = !q || haystack.includes(q);
          opt.hidden = !m;
          if (m) { visible++; if (!firstMatch) firstMatch = opt.value; }
        }
        og.hidden = visible === 0;
      }
      forgeAddSel.size = q ? Math.min(10, Math.max(4, [...forgeAddSel.querySelectorAll('option:not([hidden])')].length)) : 1;
      if (q && firstMatch) forgeAddSel.value = firstMatch;
    });
    forgeSearch.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && forgeAddSel.value) {
        document.getElementById('forge-add-btn').click();
      } else if (ev.key === 'Escape') {
        forgeSearch.value = '';
        forgeSearch.dispatchEvent(new Event('input'));
        forgeSearch.blur();
      }
    });

    // Search filter for the target dropdown
    const searchInput = document.getElementById('explorer-search');
    const targetSelect = document.getElementById('explorer-target');
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      let firstMatch = null;
      for (const og of targetSelect.querySelectorAll('optgroup')) {
        let visibleInGroup = 0;
        for (const opt of og.querySelectorAll('option')) {
          const e = SC2_DATA.entities[opt.value];
          const haystack = `${opt.textContent} ${e?.note || ''}`.toLowerCase();
          const match = !q || haystack.includes(q);
          opt.hidden = !match;
          if (match) {
            visibleInGroup++;
            if (!firstMatch) firstMatch = opt.value;
          }
        }
        og.hidden = visibleInGroup === 0;
      }
      // Expand the select while filtering so matches are visible
      targetSelect.size = q ? Math.min(12, Math.max(4, [...targetSelect.querySelectorAll('option:not([hidden])')].length)) : 1;
      if (q && firstMatch) targetSelect.value = firstMatch;
    });
    searchInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && targetSelect.value) {
        state.explorerTarget = targetSelect.value;
        searchInput.value = '';
        // restore size
        targetSelect.size = 1;
        for (const opt of targetSelect.querySelectorAll('option')) opt.hidden = false;
        for (const og of targetSelect.querySelectorAll('optgroup')) og.hidden = false;
        renderExplorer();
      }
    });

    // Tech Explorer entity-picker tabs (race + type)
    for (const tab of document.querySelectorAll('#explorer-race-tabs [data-race]')) {
      tab.addEventListener('click', () => {
        state.explorerPickerRace = tab.dataset.race;
        renderExplorer();
      });
    }
    for (const tab of document.querySelectorAll('#explorer-type-tabs [data-type]')) {
      tab.addEventListener('click', () => {
        state.explorerPickerType = tab.dataset.type;
        renderExplorer();
      });
    }

    // Scout
    document.getElementById('scout-race').addEventListener('change', e => {
      state.scoutRace = e.target.value;
      state.scouts = []; // race change clears scouts
      renderScoutPanel();
    });
    for (const tab of document.querySelectorAll('#scout-type-tabs [data-type]')) {
      tab.addEventListener('click', () => {
        state.scoutPickerType = tab.dataset.type;
        renderScoutPanel();
      });
    }
    document.getElementById('scout-add-btn').addEventListener('click', () => {
      const id = document.getElementById('scout-entity').value;
      const eventType = document.getElementById('scout-event').value;
      const timeStr = document.getElementById('scout-time').value;
      const time = parseTime(timeStr);
      if (time == null) { alert('Time must be in m:ss format (e.g., 3:00)'); return; }
      state.scouts.push({ id, eventType, time });
      document.getElementById('scout-time').value = '';
      renderScoutPanel();
    });
    document.getElementById('scout-time').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('scout-add-btn').click();
    });

    // Window
    document.getElementById('window-race').addEventListener('change', e => {
      state.windowRace = e.target.value;
      renderWindow();
    });
    document.getElementById('window-time').addEventListener('input', e => {
      const t = parseTime(e.target.value);
      if (t != null) { state.windowTime = t; renderWindow(); }
    });
    document.getElementById('window-basis').addEventListener('change', e => {
      state.windowBasis = e.target.value;
      renderWindow();
    });
    // Window-Lookup-only chrono toggle (replaces the old global toggle).
    // Drives state.chrono so the existing engine compile path picks it up.
    const windowChrono = document.getElementById('window-chrono');
    if (windowChrono) {
      windowChrono.checked = !!state.chrono;
      windowChrono.addEventListener('change', () => {
        state.chrono = windowChrono.checked;
        renderWindow();
      });
    }

    // Notes block
    document.getElementById('notes-list').innerHTML = SC2_DATA.notes.map(n => `<li>${n}</li>`).join('');
    document.getElementById('patch-info').textContent = `Patch: ${SC2_DATA.patch}`;

    // Restore Forge state from localStorage (if any). If nothing is saved
    // yet, seed a default build so the new-visitor view isn't empty —
    // see seedDefaultBuildIfFirstLoad() for why this can't clobber saves.
    const restored = restoreForge();
    if (!restored) seedDefaultBuildIfFirstLoad();

    renderAll();

    // Trigger initial sim if we have a build (restored OR seeded default)
    if (state.forgeOrder.length) {
      runForge();
    }

    // Delegated click handler for collapsible sections — any h3 inside a
    // .collapsible-section toggles its parent's data-collapsed attribute
    // and persists the choice. Using delegation so panels rendered on
    // demand (live forge result re-renders) still respond without being
    // re-wired each time.
    document.addEventListener('click', (ev) => {
      const h3 = ev.target.closest('.collapsible-section > h3');
      if (!h3) return;
      const section = h3.parentElement;
      const id = section.dataset.sectionId;
      if (!id) return;
      const nowCollapsed = toggleSectionCollapsed(id);
      section.dataset.collapsed = nowCollapsed ? 'true' : 'false';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
