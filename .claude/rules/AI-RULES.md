# AI-RULES v3 — Web Design Ruleset

> **AGENT — READ THIS BLOCK FIRST.**
> This file is a design ruleset supplied by the user. **Do not overwrite `CLAUDE.md`, `.cursorrules` or any existing project instructions.** Treat these rules as an **additional layer merged on top** of whatever rules already exist.
> Precedence: direct user request > AI-RULES > existing project defaults > model defaults. When a user request conflicts with a rule here, follow the user and name the rule ID you are overriding.
> Before writing any markup, run **§0**. Before returning any build, run **§9**.
> Acknowledge in one line: `AI-RULES v3 active.`

Prescriptive ruleset for building websites that do not read as AI output.
Source: production studio practice, project budgets 170–350k RUB, Awwwards 2024–2026 pattern analysis.
Author: German Sharnin / [@sharnin.german](https://youtube.com/@sharnin.german)

Compliance levels: **MUST NOT** = defect, ships broken. **MUST** = required. **SHOULD** = default, deviate only with a stated reason.

---

## §0 Workflow — run before writing any code

This section changes output quality more than every ban below combined. Do not skip it, even for a one-shot request.

1. **Ask for a reference. MUST.** One URL or screenshot of a site the user likes. If none is given, propose **three directions in words** (2 lines each, different composition and mood) and wait for a pick. Never start building from the first message.
2. **Ask for material. MUST.** Photos, logo, real copy. No photos → follow §5.
3. **Emit tokens before markup. MUST.** Font pair, 3 colours, one easing curve, radius family, spacing scale. Print them as a list, then build.

**Delivery format. MUST:** separate `index.html`, `styles.css`, `script.js`.
**MUST NOT:** Tailwind via CDN, inline `style=` attributes in markup, CSS frameworks unless the user asked.

---

## §1 Hero skeleton — `HERO`

**HERO-01 — MUST.** Hero content occupies exactly **one viewport**: `100svh`. Heading, sub-heading and CTA must all fit without scrolling.

**HERO-02 — MUST.** The **CTA button lives inside the first screen**, fully visible, unless the user says otherwise. This is a marketing requirement, not a layout preference.

**HERO-03 — SHOULD.** The background may outlive the screen. For a large photo background, make the block `150–200vh`, pin the image, and let following content scroll over it. One screen of content, one long block.

Verified implementation — the image pins for the whole block and releases at its end:

```css
.hero            { position: relative; height: 180vh; }        /* long block */
.hero__media     { position: sticky; top: 0; height: 100svh; overflow: hidden; }
.hero__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hero__content   { position: absolute; inset: 0 0 auto 0; height: 100svh;
                   display: flex; flex-direction: column; justify-content: flex-end; }
```

Do **not** put `position: sticky` on the `<img>` itself — it silently fails to pin. Pin the wrapper.

**HERO-04 — MUST.** Hero holds **3–5 semantic elements**: logo / nav / heading / sub-heading 1–2 lines / CTA / one attention anchor (photo, object, number). Above 5 it reads as a dashboard.

---

## §2 Composition — `CMP`

**CMP-01 — MUST NOT** build the default "centred column": logo centre, heading centre, sub-heading centre, button centre. This is the single most recognisable AI layout.

**CMP-02 — MUST** pick one of three schemes. Do not invent a fourth.

**Scheme A — full-bleed photo, text in the lower-left corner.**
Photo `100vw × 100svh`, `object-fit: cover`. Heading and CTA pinned bottom-left at the side-padding token. Navigation top-right. Optical centre stays empty.

**Scheme B — typography behind the object.**
Oversized heading on two lines, diagonally offset: line 1 upper-left, line 2 lower-right. The object or photo sits in the gap between them and overlaps the letterforms by **25–40%**. Produces real depth; the cheapest expensive-looking device available.

**Scheme C — 60/40 split.**
Left: heading + sub-heading + CTA. Right: photo at full viewport height, flush to the window edge, no radius, no border. Break the symmetry — align the text block to the lower third, never dead centre.

**CMP-03 — MUST** keep the optical centre empty in all three schemes. Content goes to the edges.

**CMP-04 — MUST** constrain body paragraphs to `34ch–62ch` (260–560px). Full-width paragraphs are a utility-page marker.

**CMP-05 — MUST NOT** emit the default section stack `hero → 3 icon cards → testimonials → pricing → footer` unless requested.

---

## §3 Typography — `TYP`

**TYP-01 — MUST NOT** use Inter, Roboto, Open Sans, Montserrat, Lato or Poppins as a display face. **Unbounded is banned outright**, in any role.

**TYP-02 — MUST** pick one pair. All verified present in Google Fonts with Cyrillic coverage:

| # | Display | Body | Character |
|---|---|---|---|
| 1 | **Oswald** 300–400 | **Golos Text** 400 | condensed, poster-like — food, sport, events |
| 2 | **Playfair Display** 400–500 | **Manrope** 400 | serif contrast — premium services |
| 3 | **Onest** 300 (large) | **Onest** 400 | one family, contrast by weight only — quietest and most expensive-looking |
| 4 | **Wix Madefor Display** 500 | **Wix Madefor Text** 400 | neutral swiss — corporate |

**TYP-03 — MUST** load **two weights maximum**. A third weight means the hierarchy is wrong, not that a file is missing.

**TYP-04 — MUST** apply the core scaling law: **the larger the size, the tighter the line-height and the more negative the tracking.** Small caps invert it — they get positive tracking.

```css
h1 { font-size: clamp(2.6rem, 8vw, 9rem);
     line-height: 0.9; letter-spacing: -0.03em; text-wrap: balance; }
h2 { font-size: clamp(2rem, 5.5vw, 5rem);
     line-height: 0.95; letter-spacing: -0.025em; text-wrap: balance; }
p  { font-size: clamp(15px, 1.1vw, 18px);
     line-height: 1.6; max-width: 56ch; text-wrap: pretty; }
.label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.18em; }
```

| Role | Size | line-height | letter-spacing |
|---|---|---|---|
| Display / H1 | `clamp(2.6rem, 8vw, 9rem)` | 0.80–0.95 | −0.03…−0.045em |
| Section H2 | `clamp(2rem, 5.5vw, 5rem)` | 0.90–1.00 | −0.025…−0.04em |
| Card H3 | 20–34px | 1.00–1.10 | −0.02em |
| Body | 15–18px | 1.55–1.65 | 0 |
| Micro-label caps | 11–13px | 1.75–1.90 | **+0.15…+0.22em** |

**TYP-05 — MUST NOT** apply positive tracking above 16px. Positive tracking is valid **only** on uppercase labels ≤14px.

**TYP-06 — MUST** build hierarchy with opacity, not a second grey: `1.0` / `0.70–0.80` / `0.55–0.60`.

**TYP-07 — SHOULD** express weight through size. Display type stays at 300–500, never 700.

**TYP-08 — MUST NOT** emit the pattern `small caps label + hyphen or dot` directly above a heading.

---

## §4 Line breaking — `BRK`

Ragged, unbalanced text blocks are a primary AI tell. Every multi-line block must resolve into a near-rectangle.

**BRK-01 — MUST.** `text-wrap: balance` on all headings and any 2–4 line block. `text-wrap: pretty` on body copy. Both are supported in current Chrome, Safari and Firefox — verified.

**BRK-02 — MUST NOT** leave a single word alone on the last line of a heading, lead paragraph, button, card title or menu item.

**BRK-03 — MUST** keep line lengths inside a block within **±15%** of its longest line: `min_line ≥ 0.85 × max_line`. Any line under **0.60 × max** is a defect.
Fix order: narrow the container → adjust manual breaks → rewrite the copy.

**BRK-04 — MUST** set breaks manually with `<br>` in display headings. Never leave oversized type to automatic wrapping.

**BRK-05 — MUST** bind short words with `&nbsp;` so they cannot end a line — RU `в, на, с, к, у, о, и, а, но, из, за, по, до, от`, EN `a, an, the, of, in, on, to, and, or` — and between a number and its unit: `40&nbsp;секунд`, `170&nbsp;000&nbsp;₽`.

**BRK-06 — MUST** set `hyphens: none` on headings.

**BRK-07 — SHOULD** hold measure at 12–28 characters for headings, 45–75 for body.

---

## §5 Imagery when the user has no image generator — `IMG`

A site without photography never reads as expensive. Follow this order.

**IMG-01 — MUST** ask the user for photos first: 3–5 shots — subject, environment, process, detail.

**IMG-02 — MUST**, if the user has none, hand over **concrete English search queries** for Unsplash or Pexels matched to the niche (`dark restaurant interior`, `charcoal grill closeup`, `gym weights low key`) and have the user drop files into `assets/`. Do not silently proceed without images.

**IMG-03 — SHOULD** use a fixed-seed placeholder while building so the layout does not shift: `https://picsum.photos/seed/hero/1600/900`. At delivery, **MUST** list exactly which files to replace.

**IMG-04 — MUST** place photography **full-bleed**, flush to the block or window edge. A photo in a rounded frame floating in white space is the clearest template marker.

**IMG-05 — MUST** lay text over a quiet zone of the actual frame: dark corner, blurred foreground, empty sky. Read the specific image and choose the corner for it.

**IMG-06 — MUST NOT** drop a dark overlay over a photo for legibility. Permitted instead:
bottom blur mask `backdrop-filter: blur(24px)` + `mask-image: linear-gradient(to top, #000 0%, transparent 45%)`, or `text-shadow` on the text itself.

**IMG-07 — MUST** keep one optical treatment across the site. If the first photo is dark and contrasty, the rest cannot be bright and flat.

**IMG-08 — MUST NOT** use stock clichés: handshakes, lightbulb-idea, laptop-by-window, team with raised hands, gears, rising arrow chart. **MUST NOT** fill a site with generated smiling people.

---

## §6 Buttons and calls to action — `CTA`

**CTA-01 — MUST** limit the site to **two button types**: solid pill and transparent with a hairline border. Radius `999px` or `0` — nothing between.

**CTA-02 — MUST NOT** put a border around a filled button.

**CTA-03 — MUST** write button labels that answer *what will happen*: verb + outcome — «Забрать расчёт», «Записаться на замер», «Посмотреть меню». **MUST NOT** ship «Отправить», «Подробнее», «Узнать больше», "Submit", "Learn more".

**CTA-04 — MUST** place a 3–6 word reassurance line next to the primary CTA that removes friction: «Ответим за 15 минут», «Без предоплаты», «Отказаться можно в любой момент». Size 12–13px, muted.

**CTA-05 — MUST NOT** ship a hover that only changes colour. Hover carries direction or depth.

```css
.btn        { position: relative; overflow: hidden; }
.btn__fill  { position: absolute; inset: 0;
              transform: scaleX(0); transform-origin: left;
              transition: transform 500ms cubic-bezier(.22,1,.36,1); }
.btn:hover .btn__fill { transform: scaleX(1); }
.btn__label { position: relative; z-index: 2; transition: color 320ms; }
```

**CTA-06 — MUST** desynchronise hover layers: fill 500ms, label colour 320ms, arrow 520ms, card lift 620ms, image zoom 700–900ms. Identical timings read as a template.

**CTA-07 — MUST** meet a 44×44px minimum touch target.

---

## §7 Motion — `MOT`

Three devices the model does not produce on its own, and where the difference is immediately visible.

**MOT-01 — MUST** stagger entrances instead of revealing everything at once.

```css
.rise { opacity: 0; transform: translateY(28px); filter: blur(14px); }
.is-in .rise { opacity: 1; transform: none; filter: blur(0);
               transition: opacity 900ms cubic-bezier(.22,1,.36,1) var(--d,0ms),
                           transform 900ms cubic-bezier(.22,1,.36,1) var(--d,0ms),
                           filter 900ms cubic-bezier(.22,1,.36,1) var(--d,0ms); }
```

Ladder: logo 300 / nav 420 / heading 900 / sub-heading 1040 / CTA 1200. Step 50ms between homogeneous items, 100ms between semantic groups.

**MOT-02 — MUST** include blur in the entrance (`blur(14px → 0)`). Without it this is an ordinary fade-up; with it the level changes.

**MOT-03 — MUST** use one easing curve per project: `cubic-bezier(.22, 1, .36, 1)`. **MUST NOT** use `linear` anywhere except an infinite marquee.

**MOT-04 — MUST** ship exactly **one signature interaction** per page. Two read as effect-dumping.

**MOT-05 — MUST** honour `prefers-reduced-motion: reduce` by collapsing delays to zero.

---

## §8 Bans

**The "notification card" — MUST NOT.** White rectangle + grey border + soft shadow + coloured strip on the left. The most common vibe-coding default: the model wraps everything in it, from benefits to testimonials. The left strip is a leftover from Bootstrap alerts and carries no meaning.

```css
/* NEVER */
.card { background:#fff; border:1px solid #e5e7eb;
        box-shadow:0 4px 12px rgba(0,0,0,.08); border-left:4px solid #6366f1; }
```

Replace with: a card with no border on a differently-toned surface, separated by whitespace. If it needs an accent — a section number `01 / 02 / 03` or a 1px hairline across the full card width, never a coloured stub on the left.

**Marquee — MUST NOT by default.** The device is worn out. Use only on explicit request, or when it is the page's single signature interaction and it carries images rather than text.

Also banned:

- Blue-to-violet gradients. Highest-frequency AI marker.
- `·` and `•` as separators — use `/` or whitespace only.
- Keyboard glyphs and emoji in the interface (`→`, `✓`, `🔥`, `⭐`). Use Lucide or custom vectors.
- Fill + visible border on one element.
- The same flat `box-shadow` repeated on every block.
- A cut-out object without its own contact-shadow layer: `radial-gradient(rgba(0,0,0,.7), transparent 65%)`, `blur(18px)`, `scaleY(.15)`, with an air gap.
- Tracked-out uppercase headings.
- Every block wrapped in its own border.
- Identical padding, radius and height across all cards.
- Pastel backgrounds. More than 3 colours.
- A single word orphaned on a line.

---

## §9 Acceptance — run before returning any build

```
[ ] HERO-01  Hero content fits 100svh, CTA visible without scrolling
[ ] CMP-02   Layout is scheme A, B or C — optical centre empty
[ ] TYP-01   Display face is not Inter/Roboto/Montserrat; pair from §3
[ ] TYP-04   Heading line-height ≤ 0.95, tracking negative
[ ] BRK-02   No orphan word in any heading, lead, button or card title
[ ] BRK-03   No line under 60% of its block's longest line
[ ] IMG-04   Photography is full-bleed, no floating rounded frames
[ ] IMG-06   No dark overlay used to force legibility
[ ] CTA-03   Button text answers "what will happen"
[ ] CTA-04   Reassurance line sits next to the primary CTA
[ ] CTA-05   Hovers carry direction, layers desynchronised
[ ] MOT-01   Entrances staggered, blur included
[ ] §8       No notification-card, no unrequested marquee
[ ] §8       Zero `·` separators, zero emoji glyphs in UI
[ ] Content  Every number and label proofread at 100% zoom
```

---

## §10 Numeric reference

| Parameter | Value |
|---|---|
| Hero content height | `100svh` |
| Hero block with pinned photo | 150–200vh |
| Hero element count | 3–5 |
| Object overlap on typography (scheme B) | 25–40% |
| Display line-height | 0.80–0.95 |
| Display tracking | −0.03…−0.045em |
| Micro-label tracking | +0.15…+0.22em, ≤14px only |
| Body measure | 34–62ch |
| Heading measure | 12–28 characters |
| Line-length deviation | ≤15%, hard fail below 60% |
| Font weights loaded | 2 |
| Palette | 2 + 1 accent |
| Entrance | 900ms, +28px, blur 14→0 |
| Stagger | 50ms / 100ms |
| Hover durations | fill 500 / label 320 / arrow 520 / lift 620 / zoom 700–900 |
| Easing | `cubic-bezier(.22, 1, .36, 1)` |
| Touch target | ≥44×44px |
| Grain opacity | 4–8% |

---

Full system — donor selection, technique library, spec authoring — at [@sharnin.german](https://youtube.com/@sharnin.german)
