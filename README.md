# Utility Risk Profile

An interactive frontend prototype for exploring utility infrastructure risk across a service territory. The app centers on a map-based workflow for reviewing substations, transmission lines, counties, simulated hazard signals, and operator notes in one place.

## Project Context

This project began as a product-design and frontend challenge: take a minimal utility map prototype and turn it into something more useful for operational visibility and decision-making.

The core goals were to:
- improve how risk is interpreted on the map
- add at least one meaningful new data layer
- introduce an interaction tool that helps a user act on the information

## How I Approached It

I focused on making the prototype easier to scan, filter, and share:
- redesigned the map styling and info panel structure so key context is easier to find
- added simulated hazard and driver overlays to give the map more operational signal
- introduced search, filtering, annotations, and snapshot export so the UI supports actual workflows instead of just display
- improved selected asset and county details to better connect map features to decisions

## Development Approach

This was executed as a 0-to-1 product engineering exercise with significant LLM assistance for ideation, implementation speed, and iteration.

The starting point was a forked prototype from the original challenge repository, and this version represents my independent extension and productization pass on top of that base.

## Features

- Interactive Mapbox map with utility infrastructure and county layers
- Risk-aware substation styling based on criticality
- Simulated hazard-zone and criticality-driver overlays
- County and substation selection with detail cards
- Search for counties and substations
- Filter controls for criticality, driver type, and hazard severity
- Annotation workflow for placing and clearing field notes
- Snapshot HTML export for sharing the current map state
- Theme switching and collapsible legends/panel sections

## Running Locally

1. Change into the app folder with `cd wb-builder-exercise`
2. Install dependencies with `npm install`
3. Create `.env.local` and add your Mapbox token:
   `VITE_MAPBOX_TOKEN=pk.XXXXXXXX`
4. Start the app with `npm run dev`

<p><sub><span style="color:#6b7280;">attribution: this work builds on an earlier utility-risk prototype challenge and extends it with independent product and engineering iterations.</span></sub></p>
