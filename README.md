# utility risk profile

an interactive frontend prototype for exploring utility infrastructure risk across a service territory. the app centers on a map-based workflow for reviewing substations, transmission lines, counties, simulated hazard signals, and operator notes in one place.

## demo

<video src="./map_gif.mov" controls muted loop playsinline width="100%"></video>

<p><sub><span style="color:#6b7280;">if this does not render on github for your viewer, convert this file to <code>.gif</code> or <code>.mp4</code> and keep the same path in this block.</span></sub></p>

## project context

this project began as a product-design and frontend challenge: take a minimal utility map prototype and turn it into something more useful for operational visibility and decision-making.

the core goals were to:
- improve how risk is interpreted on the map
- add at least one meaningful new data layer
- introduce an interaction tool that helps a user act on the information

## how i approached it

i focused on making the prototype easier to scan, filter, and share:
- redesigned the map styling and info panel structure so key context is easier to find
- added simulated hazard and driver overlays to give the map more operational signal
- introduced search, filtering, annotations, and snapshot export so the UI supports actual workflows instead of just display
- improved selected asset and county details to better connect map features to decisions

## development approach

this was executed as a 0-to-1 product engineering exercise with significant LLM assistance for ideation, implementation speed, and iteration.

the starting point was a forked prototype from the original challenge repository, and this version represents my independent extension and productization pass on top of that base.

## features

- interactive Mapbox map with utility infrastructure and county layers
- risk-aware substation styling based on criticality
- simulated hazard-zone and criticality-driver overlays
- county and substation selection with detail cards
- search for counties and substations
- filter controls for criticality, driver type, and hazard severity
- annotation workflow for placing and clearing field notes
- snapshot HTML export for sharing the current map state
- theme switching and collapsible legends/panel sections

## running locally

1. change into the app folder with `cd wb-builder-exercise`
2. install dependencies with `npm install`
3. create `.env.local` and add your Mapbox token:
   `VITE_MAPBOX_TOKEN=pk.XXXXXXXX`
4. start the app with `npm run dev`

<p><sub><span style="color:#6b7280;">attribution: this work builds on an earlier utility-risk prototype challenge and extends it with independent product and engineering iterations.</span></sub></p>
