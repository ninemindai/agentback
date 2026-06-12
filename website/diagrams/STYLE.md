# Docs diagram style spec (agentback.dev)

Standalone `.svg` files embedded via `<img>` in the generated docs pages.
Derived from each doc's mermaid source (kept inline in the markdown as the
source of truth — regenerate the SVG when the mermaid changes).

## Hard constraints

- **Raw SVG only** — no external CSS, no `<foreignObject>`, no scripts.
- **System fonts only**: `font-family="ui-monospace, SFMono-Regular, Menlo, monospace"`
  for every `<text>`. SVG-in-`<img>` cannot load web fonts.
- Transparent background (the page supplies the paper card behind it).
- `viewBox` sized to content + 8px margin; set `width`/`height` attributes to
  the viewBox size so pages can scale it down responsively.

## Palette (site tokens)

| Use                            | Value                                               |
| ------------------------------ | --------------------------------------------------- |
| ink (labels)                   | `#17201b`                                           |
| muted (sublabels, edge labels) | `#5a645e`                                           |
| node fill                      | `#ffffff`                                           |
| node border (neutral)          | `#d9ded6`                                           |
| group/container border         | `#c5ccc4` dashed `6,4`, fill `rgba(15,107,79,0.03)` |
| green (DI/core, primary flow)  | `#0f6b4f`, fill tint `rgba(15,107,79,0.08)`         |
| cyan (REST/HTTP)               | `#087b8c`, fill tint `rgba(8,123,140,0.08)`         |
| violet (MCP)                   | `#6d4ca8`, fill tint `rgba(109,76,168,0.08)`        |
| amber (schemas/contracts)      | `#9b6b16`, fill tint `rgba(155,107,22,0.10)`        |
| rose (policy/auth/payments)    | `#b43b55`, fill tint `rgba(180,59,85,0.08)`         |
| edge stroke                    | `#8a948d`                                           |

## Shapes

- Node: `<rect rx="8">` stroke-width 1.5, colored stroke per category, white
  fill with a 4px-wide colored accent bar on the left edge
  (`<rect width="4" rx="2">` in the category color) OR tinted fill — pick one
  per diagram and stay consistent.
- Node label: 13px, weight 600, ink. Sublabel: 10.5px, muted.
- Group container: dashed rect rx 12 with an 11px uppercase mono label at
  top-left inside, letter-spacing 1, muted color.
- Edge: 1.4px `#8a948d`, marker-end arrowhead
  (`<marker><path d="M0,0 L8,3.5 L0,7 z" fill="#8a948d"/></marker>`).
  Dashed `4,4` for `@inject` / "carry" / settle relations.
- Edge label: 10px muted, on white `<rect>` chip behind it (fill `#f7f8f5`)
  so lines don't strike through.
- Min 36px vertical gap between node rows; no overlapping edges through nodes
  where avoidable (route with elbow paths `M.. L.. L..`).

## Sequence diagrams

Lifelines: 1px dashed `#c5ccc4` vertical lines under participant boxes.
Messages: horizontal arrows with 10.5px labels above the line. `alt` frames:
dashed neutral container with label chip ("alt invalid / else valid").
Return messages: dashed.
