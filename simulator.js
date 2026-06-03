/* ============================================================
   SC2 economy simulator.
   Models minerals, gas, supply, workers, Pylon power, and gas extractors
   to produce realistic earliest-possible timings for any target.

   Algorithm: at each "decision point" the planner checks candidate
   actions (target, chain prereq, supply, gas extractor, worker) and
   queues whichever is the highest-priority action that is queueable
   right now. If none is queueable, time advances to the earliest
   moment some candidate becomes queueable (resources or completion event).
   ============================================================ */

const SC2_SIM = (() => {
  'use strict';

  const ECONOMY = {
    // Mineral mining is modeled per-patch. Each base has ~8 patches; the
    // first SCV on a patch mines at full speed, a second SCV shares the
    // patch and contributes about 60% of a full SCV, beyond 2 per patch
    // there is no benefit. These rates are tuned to reproduce real-game
    // 1-base Reaper FE timings (refinery ~0:45, OC ~1:27, expand ~1:45).
    mineral_rate_first: 1.0,   // m/s for the first SCV on a patch
    mineral_rate_second: 0.6,  // m/s for the second SCV sharing a patch
    patches_per_base: 8,
    gas_rate: 1.0,             // g/s per gas worker
    startup_delay: 2,          // seconds before workers reach mineral patches
    sat_gas_per_geyser: 3,
    builder_walk: 2,           // seconds Terran/Protoss worker is unavailable for placement
    worker_cap: 22,            // total worker cap for the auto-planner
    geyser_cap: 2,             // max gas extractors the planner will build
    // MULE economy. An Orbital Command starts with 50 energy (enough for
    // one MULE the moment it's built) and regenerates 0.5625 energy/s, so
    // the next MULE is ready ~88.9s later. A MULE mines for 64s and
    // gathers ~270 minerals (≈4.22 m/s while alive). Assumes optimal play
    // — a MULE is dropped the instant energy hits 50.
    mule_first_delay: 0,       // seconds after OC complete before first MULE drops
    mule_regen_time: 50 / 0.5625,  // seconds to regen enough energy for the next MULE
    mule_duration: 64,         // seconds the MULE actively mines
    mule_income_total: 270,    // minerals gathered per MULE drop
    // Queen / Spawn Larva economy (LotV). A Queen spawns with 25 energy
    // (can inject immediately), regenerates 0.5625 energy/s, and each inject
    // costs 25 energy and yields 3 larvae — so a queen injects roughly every
    // 25/0.5625 ≈ 44.4s. Creep Tumours draw from the same 25-energy pool, so
    // making one delays the next inject. Inject larva are produced by discrete
    // inject events (NOT the flat larvaRate) so they only exist once a Queen does.
    queen_start_energy: 25,
    queen_energy_regen: 0.5625,
    queen_inject_energy: 25,
    queen_inject_larvae: 3,
    creep_tumour_energy: 25,
    // Chrono Boost (Protoss). A Nexus regenerates 0.5625 energy/s; Chrono
    // Boost costs 50 energy and runs a building in an accelerated (+50%) state
    // for 20s, so it does 30s of work in 20s — i.e. a chrono'd task finishes
    // up to ~10s sooner (or buildTime/3 for short tasks). Nexus starts at 0
    // energy (LotV), so the first chrono lands ~89s in.
    nexus_start_energy: 0,
    nexus_energy_regen: 0.5625,
    chrono_energy: 50,
    chrono_duration: 20,   // a cast accelerates the building (+50%) for 20s
    // Warp Gate (Protoss). Once researched, Gateway unit production speeds up
    // (PTR 5.0.16: −35%). Live warp-in is modeled with the same speedup knob.
    warpgate_speedup: 0.35,
  };

  const RACE_CFG = {
    terran: {
      worker: 'scv', main: 'command_center',
      supply: 'supply_depot', gas: 'refinery',
      start_supply: 15, start_workers: 12,
      starting_overlord: false,
    },
    protoss: {
      worker: 'probe', main: 'nexus',
      supply: 'pylon', gas: 'assimilator',
      start_supply: 15, start_workers: 12,
      starting_overlord: false,
    },
    zerg: {
      worker: 'drone', main: 'hatchery',
      supply: 'overlord', gas: 'extractor',
      start_supply: 14, start_workers: 12,
      starting_overlord: true,
    },
  };

  // ============================================================
  // Sim — game state + advance time + queue actions
  // ============================================================
  class Sim {
    constructor(race, opts = {}) {
      const cfg = RACE_CFG[race];
      this.race = race;
      this.cfg = cfg;
      this.opts = Object.assign({}, ECONOMY, opts);

      // Starting worker count is normally per-race (RACE_CFG) but can be
      // overridden via opts.start_workers — e.g. the PTR 5.0.16 ruleset,
      // which drops every race from 12 to 8. (The PTR's mineral-patch and
      // geyser total changes are NOT modeled: this sim has no patch-depletion
      // curve, so those values have no effect on early/mid-game timings.)
      const startWorkers = (opts.start_workers != null) ? opts.start_workers : cfg.start_workers;
      // Starting supply (the pre-placed main's provided supply) can likewise
      // be overridden — PTR drops CC/Nexus 15→13 and Zerg's hatch+overlord
      // 14→12.
      const startSupply = (opts.start_supply != null) ? opts.start_supply : cfg.start_supply;

      this.t = 0;
      this.minerals = 50;
      this.gas = 0;
      this.supply_used = startWorkers; // workers count toward supply
      this.supply_max = startSupply;

      this.mineral_workers = startWorkers; // mining from t=0 (startup_delay handled separately)
      this.gas_workers = 0;
      this.gas_capacity = 0;
      this.live_workers = startWorkers; // alive count (mining or temporarily busy)

      this.completed = new Map();
      this.completed.set(cfg.main, 1);
      this.completed.set(cfg.worker, startWorkers);
      if (cfg.starting_overlord) this.completed.set('overlord', 1);

      this.producer_slots = new Map();   // structureId -> array of {end, strict}
      this.in_progress = new Map();      // entityId -> count
      this.active_mules = 0;             // count of MULEs currently mining
      // Zerg queen energy economy (Spawn Larva injects + Creep Tumours).
      this.queen_count = 0;              // completed queens
      this.queen_energy = 0;             // shared energy pool across queens
      this.injecting = 0;                // queens actively injecting (capped at base count)
      // Protoss energy / production mode.
      this.nexus_energy = this.opts.nexus_start_energy; // Chrono Boost pool
      this.chrono_until = new Map();     // producerId -> time its chrono window ends
      this.warpgate_researched = false;  // set when Warp Gate research completes

      // Larvae (Zerg only): a continuous pool that accumulates at
      //   bases × (1/11 natural + 3/29 from a perfect inject queue) per game
      // second, capped at 19 × bases. Larva-consuming production (drone,
      // overlord, zergling, roach, hydra, mutalisk, corruptor, infestor,
      // swarm host, viper, ultralisk) consumes 1 larva at queue time
      // INSTEAD of taking a hatchery producer slot — that's the parallelism
      // mechanism for Zerg. Queens still use the hatchery slot (no larva).
      // Unit morphs (Baneling, Ravager, Lurker, Brood Lord, Overseer)
      // consume their source unit, not larva.
      this.larvae = race === 'zerg' ? 3 : 0;

      this.timeline = [];                // {id, name, type, race, start, end, mins, gas, kind}
      this.events = [];                  // {t, type, ...}
      this.log = [];                     // {t, msg}
      this.history = [];                 // resource snapshots over time

      // Initial snapshot
      this._recordHistory();
      // Mark the end of startup delay so advanceTo correctly transitions income rate
      this._schedule(this.opts.startup_delay, { type: 'startup_done' });
    }

    _recordHistory() {
      this.history.push(this.snapshot());
    }

    _schedule(t, evt) {
      this.events.push({ t, ...evt });
      this.events.sort((a, b) => a.t - b.t);
    }
    _addLog(msg) { this.log.push({ t: this.t, msg }); }

    nextEventTime() { return this.events.length ? this.events[0].t : Infinity; }

    mineralIncomeRate() {
      if (this.t < this.opts.startup_delay) return 0;
      const slots = Math.max(1, this._numBases()) * this.opts.patches_per_base;
      const m = this.mineral_workers;
      const tier1 = Math.min(m, slots);                       // 1 SCV per patch
      const tier2 = Math.max(0, Math.min(m - slots, slots));  // 2nd SCV per patch
      const muleRate = this.active_mules
        ? this.active_mules * (this.opts.mule_income_total / this.opts.mule_duration)
        : 0;
      return tier1 * this.opts.mineral_rate_first + tier2 * this.opts.mineral_rate_second + muleRate;
    }

    _numBases() {
      // Main + in-place upgrades (Terran CC/OC/PF, Zerg Hatch/Lair/Hive,
      // Protoss Nexus) — each is one base for the mining model.
      return this._countOf(this.cfg.main);
    }
    gasIncomeRate() {
      return Math.min(this.gas_workers, this.gas_capacity) * this.opts.gas_rate;
    }

    // NATURAL larva accumulation per game-second: each base (Hatch/Lair/Hive)
    // regenerates 1 larva every 11s up to 3. Inject larva are NOT included here
    // — they come from discrete Queen inject events, so they only exist once a
    // Queen has been built (previously this assumed a free perfect-inject queen
    // from t=0, which over-produced larva in queenless openings like 8-pool).
    larvaRate() {
      if (this.race !== 'zerg') return 0;
      return this._numBases() * (1 / 11);
    }
    larvaCapacity() {
      if (this.race !== 'zerg') return 0;
      return this._numBases() * 19;
    }

    advanceTo(targetT) {
      while (this.t < targetT - 1e-9) {
        const nextEvt = this.nextEventTime();
        const stepTo = Math.min(targetT, nextEvt);
        const dt = stepTo - this.t;
        if (dt > 0) {
          this.minerals += this.mineralIncomeRate() * dt;
          this.gas += this.gasIncomeRate() * dt;
          if (this.race === 'zerg') {
            // Natural regen only tops up to 3 larva per base; inject events can
            // push above that (up to larvaCapacity). Don't let natural regen
            // reduce an inject-boosted pool — only add when below the natural cap.
            const naturalCap = this._numBases() * 3;
            if (this.larvae < naturalCap) {
              this.larvae = Math.min(naturalCap, this.larvae + this.larvaRate() * dt);
            }
            if (this.queen_count > 0) {
              this.queen_energy = Math.min(this.queen_count * 200,
                this.queen_energy + this.opts.queen_energy_regen * this.queen_count * dt);
            }
          } else if (this.race === 'protoss') {
            const nexuses = Math.max(1, this._numBases());
            this.nexus_energy = Math.min(nexuses * 200,
              this.nexus_energy + this.opts.nexus_energy_regen * nexuses * dt);
          }
          this.t = stepTo;
        }
        while (this.events.length && this.events[0].t <= this.t + 1e-9) {
          const evt = this.events.shift();
          this._handle(evt);
        }
      }
    }

    _handle(evt) {
      if (evt.type === 'startup_done') {
        // No-op; income rate now uses full mining
      } else if (evt.type === 'worker_returns') {
        this.mineral_workers += 1;
        // Builder-walk events only return mineral_workers — the worker
        // was always alive. Idle-marker events use restore:true to fully
        // re-add the worker (supply, live, completed count) since the
        // worker was pulled from all of those when sent idle.
        if (evt.restore) {
          this.live_workers += 1;
          this.supply_used += 1;
          this.completed.set(this.cfg.worker, (this.completed.get(this.cfg.worker) || 0) + 1);
        }
      } else if (evt.type === 'swap_complete') {
        const toE = SC2_DATA.entities[evt.to];
        this.completed.set(evt.to, (this.completed.get(evt.to) || 0) + 1);
        this._addLog(`Addon swap complete: ${toE?.name || evt.to} attached`);
      } else if (evt.type === 'mule_drop') {
        // A MULE arrives and starts mining. Each OC's drop cycle is its
        // own chain of events; multiple OCs each contribute one MULE per
        // cycle, accumulating in active_mules.
        this.active_mules += 1;
        this._schedule(this.t + this.opts.mule_duration, { type: 'mule_end' });
        this._schedule(this.t + this.opts.mule_regen_time, { type: 'mule_drop' });
      } else if (evt.type === 'mule_end') {
        this.active_mules = Math.max(0, this.active_mules - 1);
      } else if (evt.type === 'complete') {
        const e = SC2_DATA.entities[evt.entityId];
        const id = evt.entityId;
        this.completed.set(id, (this.completed.get(id) || 0) + 1);
        // In-place upgrades (Orbital ← CC, Lair ← Hatch, etc.) consume the
        // source — without this decrement, _numBases would double-count.
        if (e.upgradeFrom) {
          const fromCount = this.completed.get(e.upgradeFrom) || 0;
          if (fromCount > 0) this.completed.set(e.upgradeFrom, fromCount - 1);
        }
        const ip = this.in_progress.get(id) || 0;
        if (ip > 0) this.in_progress.set(id, ip - 1);
        if (e.provides) this.supply_max += e.provides;
        if (e.role === 'worker') {
          this.mineral_workers += 1;
          this.live_workers += 1;
        }
        if (evt.producer) {
          // Drop expired slot entries
          const slots = (this.producer_slots.get(evt.producer) || []).filter(r => r.end > this.t + 1e-9);
          if (slots.length) this.producer_slots.set(evt.producer, slots);
          else this.producer_slots.delete(evt.producer);
        }
        if (id === this.cfg.gas) {
          this.gas_capacity += this.opts.sat_gas_per_geyser;
          const move = Math.min(3, this.mineral_workers);
          this.mineral_workers -= move;
          this.gas_workers += move;
          this._addLog(`Gas extractor online; moved ${move} workers to gas`);
        }
        // An Orbital Command starts with 50 energy when it finishes the
        // upgrade — enough for a MULE immediately. Schedule the first
        // drop; mule_drop chains onward to keep dropping at saturation.
        if (id === 'orbital_command') {
          this._schedule(this.t + this.opts.mule_first_delay, { type: 'mule_drop' });
        }
        // A Queen finishes with 25 energy — enough to inject right away. Add
        // her to the energy pool and, if a hatchery still needs an injecting
        // queen (one per base), start an inject chain.
        if (id === 'queen') {
          this.queen_count += 1;
          this.queen_energy += this.opts.queen_start_energy;
          if (this.injecting < this._numBases()) {
            this.injecting += 1;
            this._schedule(this.t, { type: 'inject' });
          }
        }
        // Warp Gate research: from here on, Gateway units come out faster.
        if (id === 'warpgate_research') this.warpgate_researched = true;
        this._addLog(`Completed: ${e.name}`);
      } else if (evt.type === 'inject') {
        // One injecting queen casts Spawn Larva: spend 25 energy → 3 larvae,
        // then re-arm ~44s later. If energy is short (a Creep Tumour drained
        // the pool), wait until it regenerates instead of injecting.
        if (this.queen_energy >= this.opts.queen_inject_energy - 1e-9) {
          this.queen_energy -= this.opts.queen_inject_energy;
          this.larvae = Math.min(this.larvaCapacity(), this.larvae + this.opts.queen_inject_larvae);
          this._schedule(this.t + this.opts.queen_inject_energy / this.opts.queen_energy_regen, { type: 'inject' });
        } else {
          const deficit = this.opts.queen_inject_energy - this.queen_energy;
          const wait = deficit / (this.opts.queen_energy_regen * Math.max(1, this.queen_count));
          this._schedule(this.t + Math.max(0.1, wait), { type: 'inject' });
        }
      }
      this._recordHistory();
    }

    // True if `e` is a Zerg unit that consumes 1 larva when queued.
    // Excludes Queen (trained from Hatchery slot) and unit morphs
    // (Baneling/Ravager/Lurker/Brood Lord/Overseer — those consume their
    // source unit). Detection: zerg unit whose producedBy is a building.
    consumesLarva(e) {
      if (!e || e.race !== 'zerg' || e.type !== 'unit') return false;
      if (e.id === 'queen') return false;
      const prod = SC2_DATA.entities[e.producedBy];
      return !!(prod && prod.type === 'building');
    }

    canAfford(e) {
      if (this.minerals + 1e-9 < e.minerals) return false;
      if (this.gas + 1e-9 < (e.gas || 0)) return false;
      if (this.consumesLarva(e) && this.larvae + 1e-9 < 1) return false;
      return true;
    }

    canSatisfyTech(e) {
      for (const p of (e.prerequisites || [])) {
        if (!(this._countOf(p) > 0)) return false;
      }
      return true;
    }

    // Count completed instances of `id` PLUS in-place upgrades derived from
    // it. An Orbital Command counts as a Command Center for tech, producer
    // slots, and base count — it IS the same building, just upgraded.
    _countOf(id) {
      let count = this.completed.get(id) || 0;
      for (const otherId in SC2_DATA.entities) {
        const e = SC2_DATA.entities[otherId];
        if (e && e.upgradeFrom === id) {
          count += this.completed.get(otherId) || 0;
        }
      }
      return count;
    }

    canSatisfySupply(e) {
      const cost = (e.type === 'unit') ? (e.supply || 0) : 0;
      if (cost <= 0) return true;
      return this.supply_used + cost <= this.supply_max;
    }

    // ============================================================
    // Addon-class routing
    // ============================================================
    // The producer-slot pool isn't homogeneous — a Barracks with Tech Lab,
    // a Barracks with Reactor, and a bare Barracks all count toward the
    // "barracks" pool, but they're not interchangeable:
    //   - Marauder needs a Tech Lab–attached Barracks slot.
    //   - Marine can use any, but should prefer the Reactor (2 slots) so
    //     the Tech Lab stays free for the Marauder.
    //   - A new Tech Lab/Reactor must build on a no-addon Barracks.
    // We tag each slot reservation with its addon class and route through
    // the right sub-pool. classes:
    //   'none'              — Barracks with no addon
    //   'barracks_techlab'  — Barracks with Tech Lab (similarly factory/starport)
    //   'barracks_reactor'  — Barracks with Reactor (capacity ×2 since Reactor doubles)

    // Detect the addon a unit/upgrade requires for routing. Returns the
    // addon entity id (e.g., 'barracks_techlab') or null.
    _requiredAddon(e) {
      for (const prereq of e.prerequisites || []) {
        const pe = SC2_DATA.entities[prereq];
        if (pe && pe.type === 'addon' && pe.producedBy === e.producedBy) return prereq;
      }
      return null;
    }

    // Capacity of (producer, addonClass). Reactor-class capacity doubles
    // because a Reactor lets the host produce two light units at once.
    _classCapacity(producer, addonClass) {
      const total = this._countOf(producer);
      if (addonClass === 'none') {
        let attached = 0;
        for (const id in SC2_DATA.entities) {
          const ae = SC2_DATA.entities[id];
          if (ae && ae.type === 'addon' && ae.producedBy === producer) {
            attached += this.completed.get(id) || 0;
          }
        }
        return total - attached;
      }
      const count = this.completed.get(addonClass) || 0;
      if (/reactor/i.test(addonClass)) return count * 2;
      return count;
    }

    // Active (non-expired) reservations on a given (producer, addonClass).
    _classBusy(producer, addonClass) {
      const slots = this.producer_slots.get(producer) || [];
      let count = 0;
      for (const r of slots) {
        if (r.end <= this.t + 1e-9) continue;
        if ((r.addonClass || 'none') === addonClass) count++;
      }
      return count;
    }

    // Pick the addon class to route this entity's slot through. Returns
    // null if no class has free capacity (the entity can't queue here).
    _pickAddonClass(e, producer) {
      // Addon construction itself: must take a no-addon Barracks slot.
      if (e.type === 'addon') {
        return this._classCapacity(producer, 'none') > this._classBusy(producer, 'none')
          ? 'none' : null;
      }
      const required = this._requiredAddon(e);
      if (required) {
        return this._classCapacity(producer, required) > this._classBusy(producer, required)
          ? required : null;
      }
      // No specific addon needed. Prefer Reactor (most parallel slots),
      // then no-addon, then Tech Lab — Tech Lab is the scarce resource
      // for Marauder/Ghost/Cyclone/Tank/Banshee/Raven, so don't burn
      // its slot on a Marine when other options exist.
      const candidates = [];
      for (const id in SC2_DATA.entities) {
        const ae = SC2_DATA.entities[id];
        if (ae && ae.type === 'addon' && ae.producedBy === producer) candidates.push(id);
      }
      const reactor = candidates.find(c => /reactor/i.test(c));
      const techlab = candidates.find(c => /techlab/i.test(c));
      const order = [reactor, 'none', techlab].filter(Boolean);
      for (const cls of order) {
        if (this._classCapacity(producer, cls) > this._classBusy(producer, cls)) return cls;
      }
      return null;
    }

    canQueueProducer(e) {
      if (e.type === 'building' && !e.upgradeFrom) {
        return this.live_workers > 0; // need a worker to build
      }
      // Larva-consuming Zerg units: just need the producer building to
      // exist; larva availability is checked in canAfford so it joins the
      // resource-wait branch in findEarliestForEntity (continuous, like
      // minerals) instead of the producer-wait branch (state-event-driven).
      if (this.consumesLarva(e)) {
        return this._countOf(e.producedBy) > 0;
      }
      if (e.upgradeFrom) {
        // Upgrades need the strict source — an Orbital Command can't be
        // upgraded to another Orbital, even though it counts as a CC for
        // SCV production and tech.
        return this.producerSlotsAvailable(e.upgradeFrom, true) > 0;
      }
      if (e.type === 'addon') {
        // A producer can hold at most one addon at a time. If every
        // instance of the producer already has (or is in the process of
        // getting) an addon, this addon can't be built. We must include
        // in-progress addons because they've already "claimed" their
        // host producer — without that, two simultaneous Tech Lab + Reactor
        // commits on a 2-barracks economy would both look feasible at the
        // same instant, and the renderer would have to stack one on top
        // of the existing addon.
        const producer = e.producedBy;
        if (!producer) return true;
        const producerCount = this._countOf(producer);
        if (producerCount <= 0) return false;
        let existingAddons = 0;
        for (const id in SC2_DATA.entities) {
          const ae = SC2_DATA.entities[id];
          if (ae && ae.type === 'addon' && ae.producedBy === producer) {
            existingAddons += this.completed.get(id) || 0;
            existingAddons += this.in_progress.get(id) || 0;
          }
        }
        if (existingAddons >= producerCount) return false;
        return this._pickAddonClass(e, producer) !== null;
      }
      const producer = e.producedBy;
      if (!producer) return true;
      // _countOf so an Orbital Command answers "yes" to "is there a CC?".
      if (!(this._countOf(producer) > 0)) return false;
      // Route via addon class so a Marauder requires a Tech Lab Barracks
      // and a Marine prefers a Reactor (then no-addon, then Tech Lab).
      return this._pickAddonClass(e, producer) !== null;
    }

    producerSlotsAvailable(producer, strict = false) {
      // Two questions the same data answers:
      //
      // strict=false (default): "is any slot at all free?" — used for unit
      // production. In-place upgrades and reactors all add slots; any
      // reservation consumes one.
      //
      // strict=true: "is a CC-form (not an OC, not a PF) slot free?" — used
      // for upgrade-source checks. A unit-train reservation doesn't count
      // against strict UNLESS it's already overflowed past the non-strict
      // capacity. With 1 CC + 1 OC and one SCV training, the SCV is using
      // the OC's slot (no overflow), so the CC is still free for an OC
      // upgrade. With just 1 CC and one SCV training, the SCV is using
      // the CC itself (overflow into strict), so OC must wait.
      const live = (this.producer_slots.get(producer) || []).filter(r => r.end > this.t + 1e-9);
      const reactor = this.completed.get(`${producer}_reactor`) || 0;

      if (!strict) {
        const total = this._countOf(producer) + reactor;
        return Math.max(0, total - live.length);
      }

      const strictMain = this.completed.get(producer) || 0;
      const flexCapacity = (this._countOf(producer) - strictMain) + reactor;
      const strictReservations = live.filter(r => r.strict).length;
      const flexReservations = live.length - strictReservations;
      const flexOverflow = Math.max(0, flexReservations - flexCapacity);
      return Math.max(0, strictMain - strictReservations - flexOverflow);
    }

    canQueue(e) {
      return this.canAfford(e) && this.canSatisfyTech(e)
        && this.canSatisfySupply(e) && this.canQueueProducer(e);
    }

    snapshot() {
      return {
        t: this.t,
        minerals: this.minerals,
        gas: this.gas,
        supply_used: this.supply_used,
        supply_max: this.supply_max,
        mineral_workers: this.mineral_workers,
        gas_workers: this.gas_workers,
        live_workers: this.live_workers,
        mineral_rate: this.mineralIncomeRate(),
        gas_rate: this.gasIncomeRate(),
        larvae: this.larvae,
      };
    }

    // Shallow-copy of all mutable sim state. Used by simulateBuildOrder to
    // "peek" each candidate's fire time without committing — we clone, walk
    // the clone, and read off its sim.t. Plain numbers are copied by value;
    // Maps and arrays are duplicated one level deep (event/timeline entries
    // are copied since advanceTo mutates them via splice/shift).
    clone() {
      const c = Object.create(Sim.prototype);
      c.race = this.race;
      c.cfg = this.cfg;
      c.opts = this.opts;
      c.t = this.t;
      c.minerals = this.minerals;
      c.gas = this.gas;
      c.supply_used = this.supply_used;
      c.supply_max = this.supply_max;
      c.mineral_workers = this.mineral_workers;
      c.gas_workers = this.gas_workers;
      c.gas_capacity = this.gas_capacity;
      c.live_workers = this.live_workers;
      c.completed = new Map(this.completed);
      c.producer_slots = new Map();
      for (const [k, v] of this.producer_slots) {
        c.producer_slots.set(k, v.map(s => ({ ...s })));
      }
      c.in_progress = new Map(this.in_progress);
      c.active_mules = this.active_mules;
      c.queen_count = this.queen_count;
      c.queen_energy = this.queen_energy;
      c.injecting = this.injecting;
      c.nexus_energy = this.nexus_energy;
      c.chrono_until = new Map(this.chrono_until);
      c.warpgate_researched = this.warpgate_researched;
      c.larvae = this.larvae;
      c.timeline = this.timeline.slice();
      c.events = this.events.map(e => ({ ...e }));
      c.log = [];
      c.history = [];
      return c;
    }

    queue(entityId, queueOpts = {}) {
      const e = SC2_DATA.entities[entityId];
      if (!this.canQueue(e)) return { success: false };

      // Capture pre-pay snapshot for the timeline
      const resBefore = this.snapshot();

      // Effective build time, after Protoss production modifiers:
      //   • Warp Gate research speeds up Gateway unit production.
      //   • Chrono Boost spends 50 Nexus energy to accelerate this one step.
      let buildTime = e.buildTime;
      if (this.warpgate_researched && e.type === 'unit' && e.producedBy === 'gateway') {
        buildTime *= (1 - this.opts.warpgate_speedup);
      }
      // Chrono Boost is cast on a BUILDING and lasts 20s, accelerating whatever
      // it produces during that window (+50% speed). So a cast on one step can
      // spill its leftover window onto the NEXT unit from the same building.
      const chronoProducer = e.upgradeFrom || e.producedBy;
      const chronoable = (e.type === 'unit' || e.type === 'upgrade' || e.type === 'addon') && chronoProducer;
      // 1) A step with the chrono flag casts (or extends) the window on its
      //    producer, spending 50 Nexus energy.
      if (queueOpts.chrono && this.race === 'protoss' && chronoable
          && this.nexus_energy >= this.opts.chrono_energy - 1e-9) {
        this.nexus_energy -= this.opts.chrono_energy;
        const prev = this.chrono_until.get(chronoProducer) || 0;
        this.chrono_until.set(chronoProducer, Math.max(prev, this.t) + this.opts.chrono_duration);
      }
      // 2) Any step (the caster OR a later spillover) is accelerated for the
      //    real-time portion of its build that overlaps the window. With +50%
      //    speed, the time saved is min(0.5 × boost-seconds-remaining, B/3).
      let chronoed = false;
      if (chronoable) {
        const boostReal = Math.max(0, (this.chrono_until.get(chronoProducer) || 0) - this.t);
        if (boostReal > 1e-9) {
          const saving = Math.min(0.5 * boostReal, buildTime / 3);
          if (saving > 0.05) { buildTime = Math.max(1, buildTime - saving); chronoed = true; }
        }
      }

      this.minerals -= e.minerals;
      this.gas -= (e.gas || 0);
      if (e.type === 'unit' && (e.supply || 0) > 0) this.supply_used += e.supply;
      if (this.consumesLarva(e)) this.larvae = Math.max(0, this.larvae - 1);

      // Worker handling for building construction
      if (e.type === 'building' && !e.upgradeFrom) {
        if (this.race === 'zerg') {
          this.mineral_workers = Math.max(0, this.mineral_workers - 1);
          this.live_workers = Math.max(0, this.live_workers - 1);
          this.supply_used = Math.max(0, this.supply_used - 1);
          this.completed.set('drone', Math.max(0, (this.completed.get('drone') || 0) - 1));
        } else {
          this.mineral_workers = Math.max(0, this.mineral_workers - 1);
          this._schedule(this.t + this.opts.builder_walk, { type: 'worker_returns' });
        }
      }

      // Larva-consuming Zerg units don't tie up the hatchery (they pop out
      // of a larva slot, freeing the hatchery to morph more units in
      // parallel). All other production paths still reserve a slot.
      let producer = null;
      if (e.upgradeFrom) producer = e.upgradeFrom;
      else if (e.type === 'unit' || e.type === 'addon' || e.type === 'upgrade') producer = e.producedBy;
      let addonClass = null;
      if (producer && !this.consumesLarva(e)) {
        // Tag the reservation with the addon class it's consuming so
        // canQueueProducer for later steps can correctly tell whether a
        // Tech Lab Barracks vs a Reactor Barracks vs a no-addon Barracks
        // is free. Falls back to 'none' for producers that don't have
        // addon variants (CC/Nexus/Hatch and addons-as-producers like
        // barracks_techlab itself).
        addonClass = this._pickAddonClass(e, producer) || 'none';
        const slots = this.producer_slots.get(producer) || [];
        slots.push({ end: this.t + buildTime, strict: !!e.upgradeFrom, addonClass });
        this.producer_slots.set(producer, slots);
      }

      this.in_progress.set(entityId, (this.in_progress.get(entityId) || 0) + 1);

      const start = this.t;
      const end = this.t + buildTime;
      // Don't tie the complete event to a producer slot for larva-consumers —
      // we never reserved one above.
      const completeProducer = this.consumesLarva(e) ? null : producer;
      this._schedule(end, { type: 'complete', entityId, producer: completeProducer });
      this.timeline.push({
        id: entityId, name: e.name, type: e.type, race: e.race,
        start, end, mins: e.minerals, gas: e.gas || 0,
        kind: classifyAction(e),
        resBefore,
        chronoed,
        // The exact addon-class slot the sim chose. The Gantt renderer
        // uses this to place each interval on the right physical lane —
        // so a Marauder that the sim routed to the Tech Lab Barracks
        // shows up there, and a Reactor build doesn't visually land on
        // a Barracks that already has a Tech Lab.
        addonClass,
      });
      this._recordHistory();
      this._addLog(`Started: ${e.name} (${e.minerals}m${e.gas ? '+' + e.gas + 'g' : ''})`);
      return { success: true, end };
    }

    // Time at which entity e first becomes affordable, given current state
    timeAffordable(e) {
      const minNeed = Math.max(0, e.minerals - this.minerals);
      const gasNeed = Math.max(0, (e.gas || 0) - this.gas);
      let waitMin = 0, waitGas = 0, waitLarva = 0;
      if (minNeed > 0) {
        const r = this.mineralIncomeRate();
        waitMin = r > 0 ? minNeed / r : Infinity;
      }
      if (gasNeed > 0) {
        const r = this.gasIncomeRate();
        waitGas = r > 0 ? gasNeed / r : Infinity;
      }
      if (this.consumesLarva(e)) {
        const need = Math.max(0, 1 - this.larvae);
        if (need > 0) {
          const r = this.larvaRate();
          waitLarva = r > 0 ? need / r : Infinity;
        }
      }
      return Math.max(waitMin, waitGas, waitLarva);
    }
  }

  function classifyAction(e) {
    if (e.role === 'worker') return 'worker';
    if (['supply_depot', 'pylon', 'overlord'].includes(e.id)) return 'supply';
    if (['refinery', 'assimilator', 'extractor'].includes(e.id)) return 'gas';
    if (e.type === 'unit') return 'unit';
    if (e.type === 'addon') return 'addon';
    if (e.type === 'upgrade') return 'upgrade';
    return 'tech';
  }

  // ============================================================
  // Tech-chain analysis
  // ============================================================
  function topoChain(targetId) {
    const seen = new Set();
    const order = [];
    function visit(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const e = SC2_DATA.entities[id];
      if (!e) return;
      for (const p of (e.prerequisites || [])) visit(p);
      if (!e.starting && id !== targetId) order.push(id);
    }
    visit(targetId);
    return order;
  }

  function chainNeedsGas(ids) {
    return ids.some(id => (SC2_DATA.entities[id]?.gas || 0) > 0);
  }

  // ============================================================
  // Greedy planner
  // ============================================================
  function simulate(targetId, opts = {}) {
    const target = SC2_DATA.entities[targetId];
    if (!target) return null;

    const sim = new Sim(target.race, opts);
    const chain = topoChain(targetId);
    const needsGasOverall = chainNeedsGas([...chain, targetId]);

    const opening = opts.opening || 'standard';
    const workerCap = opening === 'all-in' ? sim.cfg.start_workers
      : (opts.workerCap != null ? opts.workerCap : sim.opts.worker_cap);

    if (opening === 'all-in') {
      sim._addLog('Opening: all-in (skip first worker, no extra workers beyond start)');
    } else {
      sim._addLog('Opening: standard (build worker first, ramp economy)');
    }

    let chainIdx = 0;
    let safety = 0;
    let firstWorkerDone = (opening !== 'standard');

    while (!sim.completed.get(targetId)) {
      if (++safety > 5000) { sim._addLog('Safety break'); break; }

      // Skip already-done/in-progress chain items
      while (chainIdx < chain.length) {
        const id = chain[chainIdx];
        if ((sim.completed.get(id) || 0) + (sim.in_progress.get(id) || 0) > 0) chainIdx++;
        else break;
      }

      const supplyE = SC2_DATA.entities[sim.cfg.supply];
      const gasE = SC2_DATA.entities[sim.cfg.gas];
      const workerE = SC2_DATA.entities[sim.cfg.worker];
      const nextChainE = chainIdx < chain.length ? SC2_DATA.entities[chain[chainIdx]] : null;

      // 1. Standard opening: first worker before anything else
      if (!firstWorkerDone) {
        if (sim.canQueue(workerE)) {
          sim.queue(sim.cfg.worker);
          firstWorkerDone = true;
          continue;
        }
        if (sim.canAfford(workerE)) {
          firstWorkerDone = true; // can't queue for non-resource reason — abandon
        } else {
          advanceToNextDecision(sim, target, chain, chainIdx, workerCap, needsGasOverall);
          continue;
        }
      }

      // 2. Supply blocked
      if (wantSupplyNow(sim, target, chain, chainIdx, workerCap) && sim.canQueue(supplyE)) {
        sim.queue(sim.cfg.supply); continue;
      }

      // 3. Next chain prereq (BEFORE gas — chain item is the critical path)
      if (nextChainE && sim.canQueue(nextChainE)) {
        sim.queue(chain[chainIdx]); chainIdx++; continue;
      }

      // 4. Target if chain complete
      if (chainIdx >= chain.length && sim.canQueue(target)) {
        sim.queue(targetId); continue;
      }

      // 5. Gas extractor for upcoming gas needs (only when it doesn't preempt the chain)
      if (needsGasOverall && wantGasNow(sim, chain, chainIdx, target) && sim.canQueue(gasE)) {
        sim.queue(sim.cfg.gas); continue;
      }

      // 6. Worker (only if it doesn't delay the next chain item / target)
      if (wantWorkerNow(sim, workerCap, target, chain, chainIdx) && sim.canQueue(workerE)) {
        sim.queue(sim.cfg.worker); continue;
      }

      // 7. Preemptive supply (approaching cap)
      if (wantSupplyPreemptively(sim, workerCap) && sim.canQueue(supplyE)) {
        sim.queue(sim.cfg.supply); continue;
      }

      // Nothing immediately queueable — advance time
      const t0 = sim.t;
      advanceToNextDecision(sim, target, chain, chainIdx, workerCap, needsGasOverall);
      if (sim.t - t0 < 1e-6) sim.advanceTo(sim.t + 0.5);
    }

    const tEntry = sim.timeline.find(t => t.id === targetId);
    return {
      sim,
      eft: tEntry ? tEntry.end : null,
      timeline: sim.timeline.slice().sort((a, b) => a.start - b.start || a.end - b.end),
      log: sim.log,
      chain,
      needsGasOverall,
    };
  }

  function wantSupplyNow(sim, target, chain, chainIdx, workerCap) {
    if ((sim.in_progress.get(sim.cfg.supply) || 0) > 0) return false;
    // Would the next desired action fail due to supply?
    const candidates = [];
    if (chainIdx < chain.length) candidates.push(chain[chainIdx]);
    else candidates.push(target.id);
    if (wantWorkerNow(sim, workerCap, target, chain, chainIdx)) candidates.push(sim.cfg.worker);
    for (const id of candidates) {
      const e = SC2_DATA.entities[id];
      if (!e) continue;
      const cost = (e.type === 'unit') ? (e.supply || 0) : 0;
      if (cost > 0 && sim.supply_used + cost > sim.supply_max) return true;
    }
    return false;
  }

  function wantSupplyPreemptively(sim, workerCap) {
    if ((sim.in_progress.get(sim.cfg.supply) || 0) > 0) return false;
    // Approaching cap and still under worker cap
    const total = sim.live_workers + (sim.in_progress.get(sim.cfg.worker) || 0);
    return sim.supply_used >= sim.supply_max - 4 && total < workerCap;
  }

  function wantGasNow(sim, chain, chainIdx, target) {
    const completed = sim.completed.get(sim.cfg.gas) || 0;
    const inProg = sim.in_progress.get(sim.cfg.gas) || 0;
    if (completed + inProg >= sim.opts.geyser_cap) return false;

    // Don't preempt the next chain item / target by spending on gas if it's blocked only by resources.
    // (Chain item is on the critical path; gas can be built in parallel later.)
    const nextE = chainIdx < chain.length ? SC2_DATA.entities[chain[chainIdx]] : target;
    if (nextE) {
      const techOk = sim.canSatisfyTech(nextE);
      const supplyOk = sim.canSatisfySupply(nextE);
      const producerOk = sim.canQueueProducer(nextE);
      if (techOk && supplyOk && producerOk && !sim.canAfford(nextE)) return false;
    }

    // Look at next few items in chain plus the target
    const upcoming = chain.slice(chainIdx, chainIdx + 5).concat([target.id]);
    let gasUpcoming = 0;
    let heavyGas = false;
    for (const id of upcoming) {
      const e = SC2_DATA.entities[id];
      if (!e) continue;
      gasUpcoming += (e.gas || 0);
      if ((e.gas || 0) >= 100) heavyGas = true;
    }
    if (gasUpcoming === 0) return false;
    if (completed + inProg === 0) return true;
    return heavyGas;
  }

  function wantWorkerNow(sim, cap, target, chain, chainIdx) {
    const total = sim.live_workers + (sim.in_progress.get(sim.cfg.worker) || 0);
    if (total >= cap) return false;
    // Don't build a worker if the next chain item / target is blocked ONLY by resources.
    const nextE = chainIdx < chain.length ? SC2_DATA.entities[chain[chainIdx]] : target;
    if (nextE) {
      const techOk = sim.canSatisfyTech(nextE);
      const supplyOk = sim.canSatisfySupply(nextE);
      const producerOk = sim.canQueueProducer(nextE);
      if (techOk && supplyOk && producerOk && !sim.canAfford(nextE)) return false;

      // Also: a worker pays for itself in ~70s. If the next chain item / target is
      // close (≤ 30s of combined tech + resource wait), an extra worker delays it
      // more than it helps. Skip.
      const techWait = techOk ? 0 : Math.max(0, sim.nextEventTime() - sim.t);
      const resWait = sim.canAfford(nextE) ? 0 : sim.timeAffordable(nextE);
      const totalWait = Math.max(techWait, isFinite(resWait) ? resWait : 0);
      if (totalWait < 30) return false;
    }
    return true;
  }

  function advanceToNextDecision(sim, target, chain, chainIdx, workerCap, needsGasOverall) {
    let next = sim.nextEventTime();

    const consider = (e, condition) => {
      if (!condition || !e) return;
      if (!sim.canSatisfyTech(e)) return;
      if (!sim.canQueueProducer(e)) return;
      if (!sim.canSatisfySupply(e)) return;
      const wait = sim.timeAffordable(e);
      if (isFinite(wait)) next = Math.min(next, sim.t + wait + 0.001);
    };

    // Same gates as the priority loop, so we only advance when something we'd actually queue becomes possible
    const supplyE = SC2_DATA.entities[sim.cfg.supply];
    const gasE = SC2_DATA.entities[sim.cfg.gas];
    const workerE = SC2_DATA.entities[sim.cfg.worker];
    const wantSupply = wantSupplyNow(sim, target, chain, chainIdx, workerCap)
                    || wantSupplyPreemptively(sim, workerCap);
    const wantGas = needsGasOverall && wantGasNow(sim, chain, chainIdx, target);
    const wantWorker = wantWorkerNow(sim, workerCap, target, chain, chainIdx);

    consider(supplyE, wantSupply);
    consider(gasE, wantGas);
    if (chainIdx >= chain.length) consider(target, true);
    if (chainIdx < chain.length) consider(SC2_DATA.entities[chain[chainIdx]], true);
    consider(workerE, wantWorker);

    if (!isFinite(next)) next = sim.t + 1;
    sim.advanceTo(next);
  }

  // ============================================================
  // Build-order driven simulation (chronological, per-pool ordering)
  // ============================================================
  // Each step is assigned a "producer pool":
  //   - Units (workers, combat units): pool = the structure that builds them
  //     (CC for SCV, Barracks for Marine/Reaper, Hatchery for any larva-unit,
  //      etc.). List order is preserved WITHIN a pool only — listing 6
  //     Marines after your last SCV doesn't push later SCVs back, because
  //     SCVs come from a different pool.
  //   - Buildings, addons, morphs, upgrades, swaps: no pool. They keep
  //     STRICT list order against everything before them. This protects
  //     the user's intent for timing-sensitive actions like depots — a
  //     depot listed at supply 17 still waits for the SCVs before it.
  //
  // Algorithm: at each iteration, find every unplaced step whose
  // predecessors are all placed; clone the live sim and peek the
  // earliest fire time for each candidate; commit the candidate with
  // the smallest peek time (ties broken by original list index). This
  // produces a chronologically-correct timeline where independent
  // pools fire in parallel.
  // Shallow-merge PTR field overrides over the live entity table, producing a
  // fresh map (the originals are never mutated).
  function mergePtrEntities(base, overrides) {
    const merged = {};
    for (const id in base) merged[id] = base[id];
    for (const id in overrides) merged[id] = Object.assign({}, base[id], overrides[id]);
    return merged;
  }

  function simulateBuildOrder(buildOrder, opts = {}) {
    const race = opts.race || 'terran';

    // PTR mode: temporarily swap in the overridden entity table and start
    // config, then run the normal path via a single re-entry. The swap is
    // restored in `finally` even if the run throws, so it can never leak into
    // other tabs' simulations. simulateBuildOrder is fully synchronous, so the
    // global swap is safe (no interleaving).
    if (opts.ptr && SC2_DATA.ptr) {
      const savedEntities = SC2_DATA.entities;
      SC2_DATA.entities = mergePtrEntities(savedEntities, SC2_DATA.ptr.entities);
      const ptrOpts = Object.assign({}, opts, {
        ptr: false,  // prevent infinite re-entry
        start_workers: SC2_DATA.ptr.startWorkers,
        start_supply: SC2_DATA.ptr.startSupply[race],
      });
      try {
        return simulateBuildOrder(buildOrder, ptrOpts);
      } finally {
        SC2_DATA.entities = savedEntities;
      }
    }

    const warnings = [];
    // Strict order: when set, every step waits for the immediately preceding
    // step (i-1) instead of only its same-pool predecessor. This collapses the
    // parallel-lane model into a literal top-to-bottom sequence — less true to
    // the game (a worker and a building really do build at once), but matches
    // how some players read a written build order.
    const strictOrder = !!opts.strictOrder;

    // Flatten the build order, expanding repeats into individual steps.
    // Priority markers are skipped (kept for forward compatibility).
    const steps = [];
    for (let i = 0; i < buildOrder.length; i++) {
      const action = buildOrder[i];
      if (!action) continue;
      if (action.kind === 'priority') continue;
      if (action.kind === 'swap') {
        steps.push({ kind: 'swap', from: action.from, to: action.to, originalIndex: i, weight: action.weight || 1 });
        continue;
      }
      // Worker assignment: shift N workers between minerals and gas at this
      // point in the build. Positive delta = move ONTO gas, negative = OFF.
      if (action.kind === 'worker_assign') {
        steps.push({ kind: 'worker_assign', delta: action.delta || 0, originalIndex: i, weight: action.weight || 1 });
        continue;
      }
      // Worker idle: pull N workers off mining for D seconds (scouting,
      // proxy walks, harass denial). duration=0 means permanent loss.
      if (action.kind === 'worker_idle') {
        steps.push({
          kind: 'worker_idle',
          count: Math.max(1, action.count || 1),
          duration: Math.max(0, action.duration || 0),
          originalIndex: i,
          weight: action.weight || 1,
        });
        continue;
      }
      // Creep tumour: a Queen spends 25 energy laying a tumour at this point,
      // draining the inject pool (may delay the next inject).
      if (action.kind === 'creep_tumour') {
        steps.push({ kind: 'creep_tumour', originalIndex: i, weight: action.weight || 1 });
        continue;
      }
      const entity = SC2_DATA.entities[action.entityId];
      if (!entity) {
        warnings.push({ index: i, msg: `Unknown entity: ${action.entityId}` });
        continue;
      }
      if (entity.race !== race && !entity.starting) {
        warnings.push({ index: i, msg: `${entity.name} is not ${race}` });
        continue;
      }
      const repeat = Math.max(1, Math.min(50, action.repeat || 1));
      const weight = action.weight || 1;
      // Optional timing pin: fire no earlier than a supply count OR a clock
      // time (floor semantics). When a step has repeat>1, every copy inherits
      // the same floor — they still fire in sequence, just not before it.
      const pinSupply = action.pinSupply;
      const pinTime = action.pinTime;
      const chrono = !!action.chrono;
      for (let r = 0; r < repeat; r++) {
        steps.push({ entityId: action.entityId, originalIndex: i, weight, pinSupply, pinTime, chrono });
      }
    }

    // Pool key: the producing structure that this step ties up.
    //   - Units: producedBy (CC for SCV, Barracks for Marine, Hatchery
    //     for any larva-unit, etc.).
    //   - Addons (Tech Lab, Reactor): producedBy = host structure. Tech
    //     Lab competes with Marines for the Barracks slot.
    //   - Upgrades (Stim, +1, Conc Shells): producedBy = research building.
    //   - Morphs (Orbital Command, Lair, Hive, Planetary Fortress): the
    //     upgradeFrom structure. Morphing CC→OC ties up the CC like an SCV.
    //   - Plain worker-built buildings (Depot, Barracks, Refinery, Pylon):
    //     no pool. They keep strict list order via the i-1 fallback below.
    // Pool ordering means listing [Marine, Tech Lab, Marine] preserves the
    // sequence — Tech Lab fires after Marine #1 and before Marine #2,
    // matching the player's actual click sequence into one Barracks slot.
    function poolKeyOf(step) {
      if (step.kind === 'swap') return null;
      // Worker markers don't tie up any producer pool; they just mutate
      // worker counts at their list position.
      if (step.kind === 'worker_assign' || step.kind === 'worker_idle' || step.kind === 'creep_tumour') return null;
      const e = SC2_DATA.entities[step.entityId];
      if (!e) return null;
      if (e.upgradeFrom) return e.upgradeFrom;
      if (e.producedBy) {
        // Sub-pool by required addon when one is needed. A Marauder
        // needs Tech Lab, so it competes only with other Tech-Lab-only
        // entries (Ghost, Cyclone, Tank, Banshee, Raven, etc.) — NOT
        // with regular Marines that can use any Barracks. This stops
        // Marines from being pred-chained behind Marauders in list
        // order, which was forcing serialization between two units
        // that target physically different lanes.
        for (const p of e.prerequisites || []) {
          const pe = SC2_DATA.entities[p];
          if (pe && pe.type === 'addon' && pe.producedBy === e.producedBy) return p;
        }
        return e.producedBy;
      }
      return null;
    }

    // Predecessors: indices of steps that must be placed before this one.
    //   - Unit steps: the previous step (if any) sharing the same pool.
    //     Cross-pool units (e.g. SCVs vs Marines) are independent — the
    //     player effectively presses both hotkeys in parallel, so each
    //     pool advances at its own production cadence.
    //   - Non-unit steps: the immediate prior step (i-1), regardless of
    //     type. This preserves the user's intent for timing-sensitive
    //     actions: a Depot listed at position N fires only after step
    //     N-1 has fired, so moving a Depot down the list pushes its
    //     fire time later (e.g. supply 22 instead of supply 14).
    //
    // Tech/supply/resource constraints are enforced by walkUntilQueueable.
    for (let i = 0; i < steps.length; i++) {
      steps[i].pool = poolKeyOf(steps[i]);
      const preds = new Set();
      if (strictOrder) {
        // Literal sequence: depend on the previous step regardless of pool.
        if (i > 0) preds.add(i - 1);
      } else if (steps[i].pool != null) {
        for (let j = i - 1; j >= 0; j--) {
          if (steps[j].pool === steps[i].pool) { preds.add(j); break; }
        }
      } else if (i > 0) {
        preds.add(i - 1);
      }
      steps[i].preds = preds;
    }

    const sim = new Sim(race, opts);
    const placed = new Array(steps.length).fill(false);
    const failed = new Array(steps.length).fill(false);

    // Chronological placement loop. Each iteration: find every candidate
    // whose preds are placed, peek each candidate's fire time on a clone
    // of the live sim, commit the earliest one.
    let safety = 0;
    while (safety++ < steps.length * 10 + 50) {
      const candidates = [];
      for (let i = 0; i < steps.length; i++) {
        if (placed[i] || failed[i]) continue;
        let predsOk = true;
        for (const p of steps[i].preds) {
          if (failed[p]) { failed[i] = true; predsOk = false; break; }
          if (!placed[p]) { predsOk = false; break; }
        }
        if (predsOk) candidates.push(i);
      }
      if (candidates.length === 0) break;

      // Pick the best candidate. Sort key: weight DESC (higher priority
      // wins outright), peek time ASC, originalIndex ASC. The default
      // weight is 1, so an all-default build sorts purely by peek time —
      // identical to the prior behavior. A step with weight=2 will always
      // fire before any weight=1 candidate that's also queueable, even if
      // the weight=1 candidate could fire earlier. Use this when you want
      // a specific decision (Orbital, Stargate, Lair) to "hold the bank"
      // ahead of routine production.
      function isBetter(idx, peeked, curIdx, curTime) {
        if (curIdx < 0) return true;
        const a = steps[idx].weight || 1;
        const b = steps[curIdx].weight || 1;
        if (a !== b) return a > b;
        if (peeked.time !== curTime) return peeked.time < curTime;
        return steps[idx].originalIndex < steps[curIdx].originalIndex;
      }
      let bestIdx = -1;
      let bestTime = Infinity;
      let bestResult = null;
      for (const i of candidates) {
        const peeked = peekStep(sim, steps[i]);
        if (!peeked.ok) continue;
        if (isBetter(i, peeked, bestIdx, bestTime)) {
          bestIdx = i;
          bestTime = peeked.time;
          bestResult = peeked;
        }
      }

      if (bestIdx === -1) {
        // Deadlock: no pred-satisfied candidate is solvable. Common cases:
        //   - Supply blocked but a Depot is listed later (its pred is the
        //     blocked step → it's not a normal candidate)
        //   - A unit was listed before its tech building (Marine before
        //     Barracks), so the unit's tech check fails forever
        // Fall back to ANY unplaced step that can fire, bypassing strict
        // list-order so the build keeps progressing. Weight still matters.
        for (let i = 0; i < steps.length; i++) {
          if (placed[i] || failed[i]) continue;
          const peeked = peekStep(sim, steps[i]);
          if (!peeked.ok) continue;
          if (isBetter(i, peeked, bestIdx, bestTime)) {
            bestIdx = i;
            bestTime = peeked.time;
            bestResult = peeked;
          }
        }
      }

      if (bestIdx === -1) {
        // Truly unsolvable — every unplaced step fails. Mark candidates
        // failed with their reasons; non-candidate unplaced steps will
        // cascade-fail via the predsOk loop next iteration.
        for (const i of candidates) {
          const peeked = peekStep(sim, steps[i]);
          const step = steps[i];
          const name = step.kind === 'swap'
            ? `swap ${step.from} → ${step.to}`
            : (SC2_DATA.entities[step.entityId]?.name || step.entityId);
          warnings.push({ index: step.originalIndex, msg: `${name}: ${peeked.reason || 'unsolvable'}` });
          failed[i] = true;
        }
        continue;
      }

      // Commit on the live sim. advanceTo never goes backward (sim.t is
      // monotonic across the loop), but bestTime is necessarily ≥ sim.t
      // because peekStep starts from the live sim's current time.
      const step = steps[bestIdx];
      if (sim.t < bestTime) sim.advanceTo(bestTime);
      if (step.kind === 'swap') {
        applySwap(sim, step.from, step.to);
      } else if (step.kind === 'worker_assign') {
        applyWorkerAssign(sim, step.delta);
      } else if (step.kind === 'worker_idle') {
        applyWorkerIdle(sim, step.count, step.duration);
      } else if (step.kind === 'creep_tumour') {
        applyCreepTumour(sim);
      } else {
        const before = sim.timeline.length;
        sim.queue(step.entityId, { chrono: step.chrono });
        if (sim.timeline.length > before) {
          const entry = sim.timeline[sim.timeline.length - 1];
          // Stamp the step's weight onto the timeline entry so the UI
          // can show priority info on hover (e.g., "competing for bank"
          // lists weight per row to clarify which step the sim picked).
          entry.weight = step.weight || 1;
          if (bestResult.blockedBy || bestResult.wouldFireAt != null) {
            entry.blockedBy = bestResult.blockedBy;
            entry.wouldFireAt = bestResult.wouldFireAt;
          }
        }
      }
      placed[bestIdx] = true;
    }

    // Drain remaining events so completion times land in history/log,
    // but ONLY up to the latest action's end time. MULE drop events keep
    // chaining themselves into the future, so without a cap the drain
    // loop would walk for hours of game time.
    const drainUntil = sim.timeline.length
      ? Math.max(...sim.timeline.map(t => t.end))
      : sim.t;
    let drainSafety = 0;
    while (sim.events.length && drainSafety++ < 5000) {
      const t = sim.nextEventTime();
      if (t === Infinity || t > drainUntil + 0.5) break;
      sim.advanceTo(t + 0.001);
    }

    const timeline = sim.timeline.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    const eft = timeline.length ? Math.max(...timeline.map(t => t.end)) : 0;

    return { sim, timeline, log: sim.log, warnings, eft };
  }

  // Peek the earliest fire time of a step against a clone of the live
  // sim. Returns { ok, time, blockedBy, wouldFireAt, reason } so we can
  // pick the chronologically-earliest candidate without mutating live
  // sim state.
  function peekStep(liveSim, step) {
    const clone = liveSim.clone();
    if (step.kind === 'swap') {
      const r = walkUntilSwap(clone, step.from, step.to);
      return r.ok ? { ok: true, time: clone.t } : { ok: false, reason: r.reason };
    }
    // Worker markers fire instantly at their list position — they don't
    // wait on producer slots, supply, tech, or resources. Just commit at
    // the current sim time once predecessors are placed.
    if (step.kind === 'worker_assign' || step.kind === 'worker_idle' || step.kind === 'creep_tumour') {
      return { ok: true, time: clone.t };
    }
    const r = walkUntilQueueable(clone, step.entityId, { pinSupply: step.pinSupply, pinTime: step.pinTime });
    return r.ok
      ? { ok: true, time: clone.t, blockedBy: r.blockedBy, wouldFireAt: r.wouldFireAt }
      : { ok: false, reason: r.reason };
  }

  // Advance sim.t until canQueue(entity) is true, then return ok=true.
  // If a constraint is permanently unsatisfiable (no future event can
  // fix it), return ok=false with a reason. Records the moment the
  // constraint LAST became blocked, so the UI can show "delayed by
  // resources / supply / tech / producer".
  function walkUntilQueueable(sim, entityId, pin = {}) {
    const entity = SC2_DATA.entities[entityId];
    if (!entity) return { ok: false, reason: 'unknown entity' };
    const startT = sim.t;
    let lastBlockReason = null;
    let safety = 0;
    while (safety++ < 5000) {
      const techOk = sim.canSatisfyTech(entity);
      const supplyOk = sim.canSatisfySupply(entity);
      const producerOk = sim.canQueueProducer(entity);
      const affordOk = sim.canAfford(entity);
      // Optional timing pin (floor): the step may not fire before a clock
      // time OR a supply count. Only one anchor is ever set per step.
      const pinOk =
        (pin.pinTime == null || sim.t >= pin.pinTime - 1e-9) &&
        (pin.pinSupply == null || sim.supply_used >= pin.pinSupply);

      if (techOk && supplyOk && producerOk && affordOk && pinOk) {
        // Step fires at sim.t. Compute "would have fired at" as the time
        // the last blocking constraint cleared (= startT if nothing ever
        // blocked, or the time we last advanced for a tech/supply/producer
        // event if resources were the final blocker).
        const wouldFireAt = lastBlockReason ? startT : sim.t;
        return { ok: true, blockedBy: lastBlockReason, wouldFireAt };
      }

      // Everything else is ready but the timing pin hasn't cleared — advance
      // toward the floor. A time pin clears deterministically; a supply pin
      // only rises via already-scheduled completion events (no new steps are
      // queued in this clone walk), so if none remain it is unreachable.
      if (techOk && supplyOk && producerOk && affordOk && !pinOk) {
        lastBlockReason = 'timing';
        if (pin.pinTime != null && sim.t < pin.pinTime) {
          sim.advanceTo(pin.pinTime + 0.001);
          continue;
        }
        if (pin.pinSupply != null) {
          const nextEvt = nextStateChangingEvent(sim);
          if (!isFinite(nextEvt)) {
            return { ok: false, reason: `timing pin unreachable — supply never reaches ${pin.pinSupply} in this build` };
          }
          sim.advanceTo(nextEvt + 0.001);
          continue;
        }
        // Defensive: pin flagged but neither anchor advanceable — bail out
        // rather than spin.
        return { ok: false, reason: 'timing pin could not be satisfied' };
      }

      // Tech / supply / producer can only change when a build event
      // fires (something completes). MULE drops & worker returns affect
      // resources only — when those are the only events available and
      // the block isn't a resource one, we're stuck.
      if (!techOk || !supplyOk || !producerOk) {
        if (!techOk) lastBlockReason = 'tech';
        else if (!supplyOk) lastBlockReason = 'supply';
        else lastBlockReason = 'producer';
        const nextEvt = nextStateChangingEvent(sim);
        if (!isFinite(nextEvt)) {
          if (!techOk) {
            const need = (entity.prerequisites || [])
              .map(p => SC2_DATA.entities[p]?.name || p).join(', ');
            return { ok: false, reason: `tech prereq not satisfied (need ${need})` };
          }
          if (!supplyOk) return { ok: false, reason: `blocked by supply (${sim.supply_used}/${sim.supply_max}); add a ${SC2_DATA.entities[sim.cfg.supply].name}` };
          const producerId = entity.upgradeFrom || entity.producedBy;
          return { ok: false, reason: `no producer available (need ${SC2_DATA.entities[producerId]?.name || producerId})` };
        }
        sim.advanceTo(nextEvt + 0.001);
        continue;
      }

      // Tech/supply/producer all OK — only resources block. Walk to the
      // earlier of (a) when current income rate would accumulate enough
      // and (b) the next sim event (which might change the rate, e.g.
      // startup_done firing at t=2 when mining begins, or a refinery
      // completing and shifting workers to gas).
      lastBlockReason = 'resources';
      const wait = sim.timeAffordable(entity);
      const target = isFinite(wait) ? sim.t + wait + 0.001 : Infinity;
      const nextEvt = sim.nextEventTime();
      const candidates = [target, isFinite(nextEvt) ? nextEvt + 0.001 : Infinity];
      const stop = Math.min(...candidates.filter(isFinite));
      if (!isFinite(stop)) {
        return { ok: false, reason: `cannot afford (need ${entity.minerals}m${entity.gas ? '+' + entity.gas + 'g' : ''}); no income source` };
      }
      if (stop <= sim.t) {
        sim.advanceTo(sim.t + 0.001);
      } else {
        sim.advanceTo(stop);
      }
    }
    return { ok: false, reason: 'timeout' };
  }

  // Advance sim.t until both swap targets are valid (source addon
  // exists, target structure exists, both have free producer slots).
  function walkUntilSwap(sim, fromId, toId) {
    const fromEntity = SC2_DATA.entities[fromId];
    const toEntity = SC2_DATA.entities[toId];
    if (!fromEntity || !toEntity) return { ok: false, reason: 'unknown addon ids' };
    if (fromEntity.type !== 'addon' || toEntity.type !== 'addon') return { ok: false, reason: 'must swap addons' };
    const fromStruct = fromEntity.producedBy;
    const toStruct = toEntity.producedBy;
    let safety = 0;
    while (safety++ < 5000) {
      const fromCount = sim.completed.get(fromId) || 0;
      const toStructCount = sim.completed.get(toStruct) || 0;
      const fromFree = sim.producerSlotsAvailable(fromStruct) > 0;
      const toFree = sim.producerSlotsAvailable(toStruct) > 0;
      if (fromCount > 0 && toStructCount > 0 && fromFree && toFree) {
        return { ok: true };
      }
      const nextEvt = nextStateChangingEvent(sim);
      if (!isFinite(nextEvt)) {
        if (fromCount === 0) return { ok: false, reason: `source addon (${fromEntity.name}) not built` };
        if (toStructCount === 0) return { ok: false, reason: `target structure (${SC2_DATA.entities[toStruct]?.name}) not built` };
        return { ok: false, reason: 'structures perpetually busy' };
      }
      sim.advanceTo(nextEvt + 0.001);
    }
    return { ok: false, reason: 'timeout' };
  }

  // Apply a Terran lift-and-swap at sim.t. Reserves a producer slot on both
  // structures for SWAP_TIME, detaches the from-addon now, and schedules the
  // to-addon to attach when the swap completes. Does NOT advance sim.t.
  function applySwap(sim, from, to) {
    const SWAP_TIME = 5;
    const fromEntity = SC2_DATA.entities[from];
    const toEntity = SC2_DATA.entities[to];
    const fromStruct = fromEntity.producedBy;
    const toStruct = toEntity.producedBy;
    const start = sim.t;
    const end = sim.t + SWAP_TIME;

    // Both reservations are strict — the building lifts off the ground
    // entirely during the swap, so neither units nor upgrades can use it.
    const fromSlots = sim.producer_slots.get(fromStruct) || [];
    fromSlots.push({ end, strict: true });
    sim.producer_slots.set(fromStruct, fromSlots);
    const toSlots = sim.producer_slots.get(toStruct) || [];
    toSlots.push({ end, strict: true });
    sim.producer_slots.set(toStruct, toSlots);

    const fromCount = sim.completed.get(from) || 0;
    sim.completed.set(from, Math.max(0, fromCount - 1));
    sim._schedule(end, { type: 'swap_complete', from, to });

    sim.timeline.push({
      id: `swap_${from}_to_${to}`,
      name: `Swap: ${fromEntity.name} → ${toEntity.name}`,
      type: 'addon', race: fromEntity.race, kind: 'swap',
      start, end, mins: 0, gas: 0,
      swapFrom: from, swapTo: to,
      resBefore: sim.snapshot(),
    });
    sim._addLog(`Addon swap: ${fromEntity.name} → ${toEntity.name}`);
  }

  // Apply a worker assignment marker at sim.t. Positive delta moves N
  // workers from minerals to gas (capped by gas_capacity and available
  // mineral workers); negative delta moves N off gas back to minerals.
  // Pushes a 0-duration timeline entry so the UI can show "applied at
  // T:TT" on the build-list row instead of "not yet executed".
  // Lay a Creep Tumour: a Queen spends 25 energy from the shared inject pool.
  // Draining it can push the next inject later (the energy/inject tradeoff).
  function applyCreepTumour(sim) {
    const resBefore = sim.snapshot();
    const cost = sim.opts.creep_tumour_energy;
    const had = sim.queen_energy >= cost - 1e-9;
    if (had) sim.queen_energy = Math.max(0, sim.queen_energy - cost);
    const label = sim.queen_count === 0
      ? 'Creep tumour (no Queen yet — no energy spent)'
      : had ? 'Creep tumour (−25 Queen energy)'
            : 'Creep tumour (not enough Queen energy)';
    sim._addLog(label);
    sim._recordHistory();
    sim.timeline.push({
      id: '_creep_tumour',
      name: label,
      type: 'marker',
      kind: 'creep_tumour',
      race: sim.race,
      start: sim.t, end: sim.t,
      mins: 0, gas: 0,
      resBefore,
    });
  }

  function applyWorkerAssign(sim, delta) {
    if (!delta) return;
    const resBefore = sim.snapshot();
    let move = 0;
    let label = '';
    if (delta > 0) {
      const room = Math.max(0, sim.gas_capacity - sim.gas_workers);
      move = Math.min(delta, room, sim.mineral_workers);
      if (move > 0) {
        sim.mineral_workers -= move;
        sim.gas_workers += move;
      }
      label = `Move ${move || delta} ${move === 1 ? 'worker' : 'workers'} onto gas`;
    } else {
      move = Math.min(-delta, sim.gas_workers);
      if (move > 0) {
        sim.gas_workers -= move;
        sim.mineral_workers += move;
      }
      label = `Move ${move || -delta} ${move === 1 ? 'worker' : 'workers'} off gas`;
    }
    sim._addLog(label);
    sim._recordHistory();
    sim.timeline.push({
      id: '_worker_assign',
      name: label,
      type: 'marker',
      kind: 'worker_assign',
      race: sim.race,
      start: sim.t, end: sim.t,
      mins: 0, gas: 0,
      resBefore,
      delta,
    });
  }

  // Apply a worker-idle marker at sim.t. Pulls N workers from mineral
  // mining; if duration > 0, schedules them to return after that many
  // seconds. duration === 0 means permanent loss.
  function applyWorkerIdle(sim, count, duration) {
    const resBefore = sim.snapshot();
    const pull = Math.min(count, sim.mineral_workers);
    let label = '';
    if (pull > 0) {
      sim.mineral_workers -= pull;
      sim.live_workers -= pull;
      sim.supply_used = Math.max(0, sim.supply_used - pull);
      sim.completed.set(sim.cfg.worker, Math.max(0, (sim.completed.get(sim.cfg.worker) || 0) - pull));
      if (duration > 0) {
        // Schedule N return events at t + duration. The existing
        // worker_returns handler bumps mineral_workers / live_workers / supply
        // by 1, so N events restore N workers.
        for (let k = 0; k < pull; k++) {
          sim._schedule(sim.t + duration, { type: 'worker_returns', restore: true });
        }
        label = `${pull} ${pull === 1 ? 'worker' : 'workers'} idle for ${duration.toFixed(0)}s`;
      } else {
        label = `${pull} ${pull === 1 ? 'worker' : 'workers'} permanently lost`;
      }
    } else {
      label = `${count} idle ${count === 1 ? 'worker' : 'workers'} (none available)`;
    }
    sim._addLog(label);
    sim._recordHistory();
    sim.timeline.push({
      id: '_worker_idle',
      name: label,
      type: 'marker',
      kind: 'worker_idle',
      race: sim.race,
      start: sim.t, end: sim.t + duration,
      mins: 0, gas: 0,
      resBefore,
      count: pull,
      duration,
    });
  }

  // Time of the next event that could affect tech / producer / supply
  // checks. Skips resource-only events (MULE drop/end, worker_returns)
  // because they keep firing indefinitely once an Orbital is built.
  function nextStateChangingEvent(sim) {
    for (const evt of sim.events) {
      // 'inject' adds larva, which can unblock a larva-gated Zerg step.
      if (evt.type === 'complete' || evt.type === 'swap_complete'
          || evt.type === 'startup_done' || evt.type === 'inject') {
        return evt.t;
      }
    }
    return Infinity;
  }

  return {
    simulate,
    simulateBuildOrder,
    Sim,
    ECONOMY,
    RACE_CFG,
    topoChain,
  };
})();
