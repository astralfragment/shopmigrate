import 'dotenv/config';
import fetch from 'node-fetch';
import csvWriter from 'csv-write-stream';
import fs from 'fs';

// --- Config from environment ---
const {
  WC_STORE_URL,
  WC_CONSUMER_KEY,
  WC_CONSUMER_SECRET,
  SHOPIFY_VENDOR = 'My Store',
  OUTPUT_FILE = 'products_shopify.csv',
} = process.env;

if (!WC_STORE_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
  console.error(
    'Missing required environment variables.\n' +
    'Copy .env.example to .env and fill in your WooCommerce credentials.\n\n' +
    '  cp .env.example .env\n'
  );
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');
const apiBase = WC_STORE_URL.replace(/\/+$/, '') + '/wp-json/wc/v3/products';
const perPage = 100;

// --- Shopify CSV headers ---
const SHOPIFY_HEADERS = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags',
  'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
  'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker',
  'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service',
  'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable',
  'Variant Barcode', 'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card',
  'SEO Title', 'SEO Description', 'Variant Image', 'Variant Weight Unit', 'Variant Tax Code',
  'Cost per item', 'Status', 'Collection',
];

// --- Fetch all products with pagination ---
async function fetchAllProducts() {
  let products = [];
  let page = 1;

  while (true) {
    const url = `${apiBase}?per_page=${perPage}&page=${page}`;
    console.log(`Fetching page ${page}...`);

    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString('base64'),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WooCommerce API error (${response.status}): ${body}`);
    }

    const pageProducts = await response.json();

    if (!Array.isArray(pageProducts)) {
      throw new Error(`Unexpected API response: ${JSON.stringify(pageProducts).slice(0, 200)}`);
    }

    products = products.concat(pageProducts);
    console.log(`  Got ${pageProducts.length} products (${products.length} total)`);

    if (pageProducts.length < perPage) break;
    page++;
  }

  return products;
}

// --- Map a WooCommerce product to Shopify CSV row ---
function toShopifyRow(product) {
  const handle = product.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '';
  const tags = (product.tags || []).map(t => t.name).join(', ');
  const category = product.categories?.[0]?.name || '';
  const image = product.images?.[0]?.src || '';
  const imageAlt = product.images?.[0]?.alt || '';

  return {
    'Handle': handle,
    'Title': product.name || '',
    'Body (HTML)': product.description || '',
    'Vendor': SHOPIFY_VENDOR,
    'Product Category': category,
    'Type': product.type || '',
    'Tags': tags,
    'Published': product.status === 'publish' ? 'TRUE' : 'FALSE',
    'Option1 Name': '',
    'Option1 Value': '',
    'Option2 Name': '',
    'Option2 Value': '',
    'Option3 Name': '',
    'Option3 Value': '',
    'Variant SKU': product.sku || '',
    'Variant Grams': product.weight ? Math.round(parseFloat(product.weight) * 1000) : '',
    'Variant Inventory Tracker': 'shopify',
    'Variant Inventory Qty': product.stock_quantity ?? '',
    'Variant Inventory Policy': product.backorders === 'no' ? 'deny' : 'continue',
    'Variant Fulfillment Service': 'manual',
    'Variant Price': product.price || '',
    'Variant Compare At Price': product.regular_price !== product.sale_price ? product.regular_price : '',
    'Variant Requires Shipping': 'TRUE',
    'Variant Taxable': product.tax_status === 'taxable' ? 'TRUE' : 'FALSE',
    'Variant Barcode': '',
    'Image Src': image,
    'Image Position': image ? '1' : '',
    'Image Alt Text': imageAlt,
    'Gift Card': 'FALSE',
    'SEO Title': product.name || '',
    'SEO Description': product.short_description?.replace(/<[^>]*>/g, '').slice(0, 320) || '',
    'Variant Image': '',
    'Variant Weight Unit': product.weight ? 'g' : '',
    'Variant Tax Code': '',
    'Cost per item': '',
    'Status': product.status === 'publish' ? 'active' : 'draft',
    'Collection': category,
  };
}

// --- Write products with additional image rows ---
function writeProductRows(writer, product) {
  const mainRow = toShopifyRow(product);
  writer.write(mainRow);

  // Additional images get their own rows (Shopify format)
  if (product.images && product.images.length > 1) {
    for (let i = 1; i < product.images.length; i++) {
      const imageRow = {};
      SHOPIFY_HEADERS.forEach(h => imageRow[h] = '');
      imageRow['Handle'] = mainRow['Handle'];
      imageRow['Image Src'] = product.images[i].src;
      imageRow['Image Position'] = String(i + 1);
      imageRow['Image Alt Text'] = product.images[i].alt || '';
      writer.write(imageRow);
    }
  }
}

// --- Main ---
async function main() {
  console.log(`\nShopMigrate - WooCommerce to Shopify CSV Exporter`);
  console.log(`Store: ${WC_STORE_URL}`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  const products = await fetchAllProducts();

  if (products.length === 0) {
    console.log('No products found.');
    return;
  }

  if (isDryRun) {
    console.log(`\n[Dry run] Would export ${products.length} products. No file written.`);
    console.log('Sample product:', JSON.stringify(toShopifyRow(products[0]), null, 2));
    return;
  }

  const writer = csvWriter({ headers: SHOPIFY_HEADERS });
  writer.pipe(fs.createWriteStream(OUTPUT_FILE));

  let count = 0;
  for (const product of products) {
    writeProductRows(writer, product);
    count++;
  }

  writer.end();
  console.log(`\nExported ${count} products to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
