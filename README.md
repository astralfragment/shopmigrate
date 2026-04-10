# ShopMigrate

CLI tool that exports products from a WooCommerce store into a Shopify-compatible CSV, with smart variant grouping, image downloads, and category mapping.

## Features

- Fetches all products via WooCommerce REST API with automatic pagination
- Fetches and maps **WooCommerce variable product variants** to Shopify's Option/Variant columns
- **Smart variant grouping** (`--smart-variants`) — detects simple products that are actually color/finish variants of the same product and merges them into a single Shopify product with variants
- Maps WooCommerce categories to **valid Shopify Product Taxonomy** values via `categories.json`
- Handles **multiple product images** (additional images become separate CSV rows per Shopify spec)
- **Downloads all product images** locally with `--images` flag
- Exports inventory, pricing, compare-at prices, SEO, tags, and publish status
- **Dry run** mode to preview without writing files

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

## Usage

```bash
# Basic export
npm start

# Smart variant grouping (recommended)
npm run smart

# Preview smart grouping without writing files
npm run smart:dry

# Dry run
npm run dry-run

# Export + download all product images
npm run images

# Combine flags
node index.js --smart-variants --images
```

## Smart Variant Grouping

Many WooCommerce stores list color/finish variants as separate simple products:

```
B+W 607 S3 Bookshelf (White) (Pair)   → simple product
B+W 607 S3 Bookshelf (Oak) (Pair)     → simple product
B+W 607 S3 Bookshelf (Black) (Pair)   → simple product
```

With `--smart-variants`, these get merged into **one Shopify product** with 3 color variants:

```
B+W 607 S3 Bookshelf (Pair)
  ├── White  | SKU: FP43966pr
  ├── Oak    | SKU: FP43974pr
  └── Black  | SKU: FP43958pr
```

It detects colors in parentheses like `(White)` or as trailing words like `Floorstander Oak`. Only groups with 2+ matching products are merged — single products are left as-is.

Run `npm run smart:dry` first to preview what will be grouped before exporting.

## Category Mapping

WooCommerce categories don't match Shopify's product taxonomy. Edit `categories.json` to map your store's categories to exact Shopify taxonomy strings:

```json
{
  "Audio": "Electronics > Audio",
  "Speakers": "Electronics > Audio > Audio Components > Speakers",
  "Security": "Home & Garden > Business & Home Security",
  "Uncategorized": ""
}
```

Set a category to `""` to intentionally leave it unmapped. Run `npm run dry-run` to see categories that are missing from the file entirely. Browse valid values at [shopify.github.io/product-taxonomy](https://shopify.github.io/product-taxonomy/).

## How Variants Work in the CSV

| Row | What it contains |
|-----|-----------------|
| 1st | Full product info (title, description, tags, etc.) + first variant's options/price/SKU |
| 2nd+ | Handle + each additional variant's options, price, SKU, inventory, variant image |
| Extra | Additional product images (one row per image) |

This applies to both WooCommerce variable products and smart-grouped products.

## Importing into Shopify

1. Go to **Shopify Admin > Products > Import**
2. Upload `products_shopify.csv`
3. Review the column mapping preview
4. Click **Import products**

The CSV references original WooCommerce image URLs — Shopify downloads them during import.

## Requirements

- Node.js 18+
- WooCommerce REST API enabled with read access

## License

MIT
