# ShopMigrate

CLI tool that exports products from a WooCommerce store into a Shopify-compatible CSV, with smart variant grouping, brand/collection mapping, image downloads, and proper inventory handling.

## Features

- Fetches all products via WooCommerce REST API with automatic pagination
- **Smart variant grouping** — detects simple products that are color/finish variants and merges them
- **Interactive setup** (`--init`) — scans your store and walks you through mapping brands and collections
- **Brand detection** — auto-detects vendor names from product titles via `brands.json`
- **Collection mapping** — maps WooCommerce categories to Shopify collections via `collections.json`
- **Category taxonomy mapping** — maps to valid Shopify Product Taxonomy values via `categories.json`
- **Proper inventory** — respects WooCommerce `manage_stock` flag; untracked products won't show as "0 stock" in Shopify
- Handles multiple product images and WooCommerce variable product variants
- Downloads all product images locally with `--images`

## Setup

```bash
git clone https://github.com/astralfragment/shopmigrate.git
cd shopmigrate
npm install
cp .env.example .env
```

Edit `.env` with your WooCommerce credentials:

```
WC_STORE_URL=https://yourstore.com
WC_CONSUMER_KEY=ck_your_key_here
WC_CONSUMER_SECRET=cs_your_secret_here
SHOPIFY_VENDOR=Your Store Name
OUTPUT_FILE=products_shopify.csv
IMAGE_DIR=images
```

Generate WooCommerce API keys at **WP Admin > WooCommerce > Settings > Advanced > REST API** (read-only access is fine).

## Quick Start

Run the interactive setup first — it scans your products and lets you map brands and collections:

```bash
npm run init
```

This creates:
- **`brands.json`** — maps product name prefixes to Shopify vendor names
- **`collections.json`** — maps WooCommerce categories to Shopify collection names

Then export:

```bash
npm run smart          # export with smart variant grouping (recommended)
npm run smart:dry      # preview without writing files
npm start              # basic export without smart grouping
npm run images         # export + download all images
node index.js --smart-variants --images  # combine flags
```

## How It Works

### Brand Detection

Products are scanned for brand prefixes in their names:

```
"SONOS Era 100 Smart Speaker"    → Vendor: Sonos
"B+W 607 S3 Bookshelf (Pair)"   → Vendor: Bowers & Wilkins
"Monitor Audio A10 Speaker"      → Vendor: Monitor Audio
```

During `--init`, you confirm or rename each detected brand. The mapping is saved to `brands.json`:

```json
{
  "SONOS": "Sonos",
  "B+W": "Bowers & Wilkins",
  "Monitor Audio": "Monitor Audio",
  "Denon": "Denon"
}
```

### Smart Variant Grouping

WooCommerce stores often list color variants as separate simple products:

```
B+W 607 S3 Bookshelf (White) (Pair)  → separate product
B+W 607 S3 Bookshelf (Oak) (Pair)    → separate product
B+W 607 S3 Bookshelf (Black) (Pair)  → separate product
```

With `--smart-variants`, these become **one Shopify product** with 3 color variants. Only groups with 2+ matching products are merged.

### Inventory Tracking

- **`manage_stock: true`** → Shopify tracks inventory with the WooCommerce stock quantity
- **`manage_stock: false`** → inventory tracking is disabled in Shopify (no misleading "0 stock")

### Collection Mapping

`collections.json` maps WooCommerce categories to Shopify collection names:

```json
{
  "Audio": "Audio & Speakers",
  "Audio/Video": "Home Theater",
  "Black Friday Specials": "",
  "test": ""
}
```

Set to `""` to exclude from collections.

### Category Taxonomy

`categories.json` maps to Shopify's official product taxonomy (separate from collections):

```json
{
  "Audio": "Electronics > Audio",
  "Speakers": "Electronics > Audio > Audio Components > Speakers",
  "Security": "Home & Garden > Business & Home Security"
}
```

Browse valid values at [shopify.github.io/product-taxonomy](https://shopify.github.io/product-taxonomy/).

## All Commands

| Command | Description |
|---------|-------------|
| `npm run init` | Interactive setup — map brands and collections |
| `npm start` | Export products to CSV |
| `npm run smart` | Export with smart variant grouping |
| `npm run smart:dry` | Preview smart grouping (no files written) |
| `npm run dry-run` | Preview export (no files written) |
| `npm run images` | Export + download all product images |

Flags can be combined: `node index.js --smart-variants --images --dry-run`

## Importing into Shopify

1. Go to **Shopify Admin > Products > Import**
2. Upload `products_shopify.csv`
3. Review the column mapping preview
4. Click **Import products**

## Requirements

- Node.js 18+
- WooCommerce REST API enabled with read access

## License

MIT
