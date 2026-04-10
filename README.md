# ShopMigrate

CLI tool that exports products from a WooCommerce store into a Shopify-compatible CSV, handling variants, multiple images, and category mapping.

## Features

- Fetches all products via WooCommerce REST API with automatic pagination
- Fetches and maps **product variants** (size, color, etc.) to Shopify's Option/Variant columns
- Maps WooCommerce categories to **valid Shopify Product Taxonomy** values via `categories.json`
- Handles **multiple product images** (additional images become separate CSV rows per Shopify spec)
- **Downloads all product images** locally with `--images` flag
- Exports inventory, pricing, compare-at prices, SEO, tags, and publish status
- **Dry run** mode to preview without writing files + see unmapped categories

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

## Category Mapping

WooCommerce categories don't match Shopify's product taxonomy. Edit `categories.json` to map your store's categories:

```json
{
  "Smart Home": "Electronics > Smart Home & Security > Smart Home Hubs",
  "Lighting": "Home & Garden > Lighting & Light Fixtures",
  "Uncategorized": ""
}
```

Run `npm run dry-run` to see which categories still need mapping. Browse valid Shopify categories at [shopify.github.io/product-taxonomy](https://shopify.github.io/product-taxonomy/).

## Usage

```bash
# Export products + variants to CSV
npm start

# Dry run — test connection, preview output, show unmapped categories
npm run dry-run

# Export CSV and download all product images
npm run images
```

You can combine flags:

```bash
node index.js --images --dry-run
```

## How Variants Work

WooCommerce "variable" products are exported as multiple CSV rows:

| Row | What it contains |
|-----|-----------------|
| 1st | Full product info (title, description, tags, etc.) + first variant's options/price/SKU |
| 2nd+ | Handle + each additional variant's options, price, SKU, inventory, image |
| Extra | Additional product images (one row per image) |

Simple products get a single row with all fields.

## Importing into Shopify

1. Go to **Shopify Admin > Products > Import**
2. Upload `products_shopify.csv`
3. Review the column mapping preview
4. Click **Import products**
5. If you used `--images`, the CSV still references the original WooCommerce URLs — Shopify will download them during import

## Requirements

- Node.js 18+
- WooCommerce REST API enabled with read access

## License

MIT
