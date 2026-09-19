# HoopBioPharma Shop

A full storefront (catalog + cart) for HoopBioPharma's 51-product research
peptide line. The design system — layout, typography, warm cream/espresso
palette, pill buttons, lot-numbered purity badges, protocol/stack
spotlight, trust-badge strip, giant wordmark footer — is modeled closely
on roehn.co, reskinned with HoopBioPharma's real name, products, prices,
and photography.

Plain Vite + vanilla JavaScript — no framework, no backend. All product
data lives in `src/data/products.js` and the cart is client-side
(persisted to `localStorage`).

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev
```

This starts a dev server, usually at **http://localhost:5173** — the
terminal output will show the exact URL. Edits to any file under `src/`
hot-reload in the browser automatically.

## Build for production

```bash
npm run build
```

Outputs a static site to `dist/`. Preview that build locally before
deploying with:

```bash
npm run preview
```

## Deploy to Vercel

No configuration needed — Vercel detects Vite automatically.

**Option A — Vercel CLI**

```bash
npm i -g vercel
vercel
```

Follow the prompts (link or create a project, accept the detected
Vite settings). Run `vercel --prod` when you're ready to ship to your
production domain.

**Option B — Git + Vercel dashboard**

1. Push this project to a GitHub/GitLab/Bitbucket repo.
2. In the [Vercel dashboard](https://vercel.com/new), import the repo.
3. Leave the framework preset on "Vite" (auto-detected), build command
   `npm run build`, output directory `dist`.
4. Deploy.

## Project structure

```
index.html              Page shell (fonts, cart drawer markup, toast)
src/main.js              Router, views, cart logic
src/style.css             Design tokens + all component styles
src/data/products.js      Catalog: 10 categories, 51 products
public/images/products/   One real photo per product (51 .webp files)
public/favicon.svg
```

## Notes

- The checkout button is a placeholder — it shows a toast ("This is a
  demo storefront — checkout isn't connected yet") rather than charging
  a card. Wire it up to a real payment provider (Stripe, etc.) before
  taking real orders.
- Product photography was pulled directly from hoopbiopharma.com's own
  per-product image URLs (`/images/products/<id>.png`), resized to
  640×640 and re-encoded as WebP to keep the repo small.
- Design tokens live at the top of `src/style.css` — cream/panel/ink for
  surfaces and text, bronze/espresso for the secondary accent, sage green
  for the purity/verified badges, near-black for primary buttons. Fonts
  are Cinzel (wordmark/serif), Hanken Grotesk (body), and Azeret Mono
  (lot numbers, SKUs, labels), loaded from Google Fonts in `index.html`.
- The "Featured Protocols" section spotlights the catalog's real
  multi-peptide blend products (BPC-157/TB-500 "Wolverine", GLOW, KLOW,
  etc.) rather than fabricated bundle SKUs — arrow navigation cycles
  through them (`STACK_IDS` in `src/main.js`).
- What's intentionally **not** reproduced from roehn.co: its "from the
  lab" chromatography-graph / lot-certificate section. That data would
  have meant inventing specific HPLC test results and Certificate-of-
  Analysis lot codes with no real lab data behind them — fabricated
  test records presented as genuine. The purity badges here instead use
  the ≥98% HPLC figure HoopBioPharma's own real site already publishes.
