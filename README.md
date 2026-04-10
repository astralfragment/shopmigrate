# ShopMigrate

CLI tool that exports all products from a WooCommerce store into a Shopify-compatible CSV file, ready for import.

## What it does

- Connects to the WooCommerce REST API and fetches all products (handles pagination automatically)
- Maps WooCommerce product fields to Shopify's CSV import format
- Handles multiple product images (additional images become separate rows per Shopify spec)
- Exports inventory, pricing, SEO, tags, categories, and product status
- Outputs a single CSV file you can upload directly to Shopify Admin > Products > Import

## Setup

```bash
git clone https://github.com/astralfragment/shopmigrate.git
cd shopmigrate
npm install
```

Copy the example env file and fill in your WooCommerce API credentials:

```bash
cp .env.example .env
```

Edit `.env` with your store details:

```
WC_STORE_URL=https://yourstore.com
WC_CONSUMER_KEY=ck_your_key_here
WC_CONSUMER_SECRET=cs_your_secret_here
SHOPIFY_VENDOR=Your Store Name
OUTPUT_FILE=products_shopify.csv
```

You can generate WooCommerce API keys at:
**WP Admin > WooCommerce > Settings > Advanced > REST API**

## Usage

```bash
# Export products to CSV
npm start

# Dry run (test connection, preview output, no file written)
npm test
```

The CSV file will be created in the project directory, ready to import into Shopify.

## Importing into Shopify

1. Go to **Shopify Admin > Products > Import**
2. Upload the generated `products_shopify.csv`
3. Review the column mapping preview
4. Click **Import products**

## Requirements

- Node.js 18+
- WooCommerce store with REST API enabled
- API keys with read access to products

## License

MIT
