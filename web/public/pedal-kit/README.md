# Pedal parts

Shared parts for drawing pedals in the browser. `buildPedal()` in `src/app/pedal-kit.ts`
assembles a pedal from a name, a colour and a list of knobs, so a new pedal needs
no new artwork. `web/pedal-kit.html` previews two examples, and the Micro Plus
editor builds its board and close-ups from the same parts.

The images were generated with Codex image generation in October 2026, from
written descriptions of generic hardware with no brand, logo or commercial pedal
as a reference. `surface.jpg` is a neutral grey that gets tinted by the pedal's
colour. When tinting, use a colour about 18% brighter than the one you want,
because the grey darkens it.

The amp coverings, grille cloths and pedal finishes (`tolex-*`, `tweed`, `grille-*`, `enamel-*`,
`brushed-metal` and `sparkle-metal`) came the same way. Only the Micro Plus board uses them, through
`src/app/micro-plus-looks.css`. The neutral ones are tinted with a multiply blend, so one image gives many colours.
