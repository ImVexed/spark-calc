Spark Simulator (Path of Exile – Spark DPS Sandbox)
===================================================

Client-side, zero-backend web app to visualize and approximate Path of Exile's Spark projectile behavior and DPS. Runs entirely in the browser using a single HTML page, CSS, and vanilla JavaScript.

Quick start
-----------

- Option A: Open `index.html` directly in a modern browser.
- Option B: Serve locally (recommended):
  - Python 3: `python3 -m http.server 5173 --directory .`
  - Open `http://localhost:5173/`.

Repository layout
-----------------

- `index.html` — App shell and UI
  - Side panel with grouped controls (Arena, Skill & Projectiles, Casting, Behaviors, Enemy, Simulation, Charts)
  - Canvas stage for the 2D simulation
- `style.css` — Visual styling
  - Dark theme, card layout for the side panel
  - Responsive grid for form fields and sparkline chart styling
- `main.js` — Simulation and UI logic
  - World-units model with dynamic pixel scaling
  - Arenas: Circle, Square, and corrected hollow T‑Junction
  - Entities: caster (draggable), boss/enemy (draggable)
  - Event‑driven “wander” steering to mimic Spark’s observed wiggle
  - Projectile lifecycle, continuous collision detection against the boss, and terrain reflection
  - Enemy‑only behaviors with correct priority and single-operation per hit
  - Metrics capture and sparkline charts with configurable time window
- `coordinates.csv` (optional/dev) — Sample tracked coordinates data
- `track.py` (optional/dev) — Helper used to process tracked data (not required to run the app)
- `video.mp4` (optional/dev) — Reference video used for motion/heading tuning

Controls (side panel)
---------------------

- Arena
  - Arena Layout: Circle, Square, T‑Junction
- Skill & Projectiles
  - Average Hit (damage per successful hit)
  - Projectile Speed (units/s), Duration (s)
  - Projectiles per Cast, Cast Speed (casts/s)
- Casting
  - Cast Shape: Circular or Cone
  - Caster Facing (degrees) and Cone Angle (0–360°). Initial spawn angles only
- Behaviors (enemy collisions only; one operation per hit)
  - Pierce Count
  - Max Forks
  - Chain Count
  - Fork: % chance to add center projectile (when forking)
  - Split: projectiles created on hit (emits evenly around 360°). Each projectile can split once
- Enemy
  - Enemy Radius (units). Default 3 units (boss-sized)
- Simulation
  - Start / Stop / Reset
- Charts
  - Chart Timescale: 5s, 10s, 30s, 60s, 120s
  - Sparklines: Hits (total), Hit Rate (/s), DPS, Total Damage, Projectiles Alive

Mechanics modeled
-----------------

- Spark projectiles wander with an event‑driven heading change model (micro jitter + ~3 Hz direction events with small/large turns and occasional bursts)
- Per‑cast per‑target hit cooldown: 0.66 s. Other projectiles from the same cast pass through during the cooldown
- Behaviors on enemy hit (one per hit; priority): Split → Pierce → Fork → Chain
- Projectiles bounce off walls/arena boundaries and ignore the caster
- Duration ends a projectile. Leash mechanic is disabled by design
- Continuous collision detection (CCD) against the boss prevents tunneling between frames

Arenas
------

- Circle: radius = 160 units (world units mapped to pixels dynamically)
- Square: size matches the circle’s diameter for consistent scale
- T‑Junction: hollow T corridor with top margin; stem connects into the bar without a blocking wall

Developer notes
---------------

- World units and scaling: inputs are in world units; a scale factor maps world units to pixels based on canvas size
- Timing: fixed‑timestep physics at 120 Hz; UI charts sampled every 200 ms and trimmed to the selected window
- CCD: enemy collisions use swept circle tests; terrain reflection is discrete but robust

Roadmap ideas
-------------

- Multiple enemies and true chain targeting radius (~6 m ≈ 60 units)
- Presets for arenas and Spark setups
- Export/import of configurations
- Optional logging/export of hit timelines

License
-------

MIT. If a `LICENSE` file is added, it supersedes this note.


