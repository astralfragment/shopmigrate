import 'dotenv/config';
import fetch from 'node-fetch';
import csvWriter from 'csv-write-stream';
import fs from 'fs';
import path from 'path';

// --- Config ---

const {
  WC_STORE_URL,
  WC_CONSUMER_KEY,
  WC_CONSUMER_SECRET,
  SHOPIFY_VENDOR = 'My Store',
  OUTPUT_FILE = 'products_shopify.csv',
  IMAGE_DIR = 'images',
} = process.env;

if (!WC_STORE_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
  console.error(
    'Missing required environment variables.\n' +
    'Copy .env.example to .env and fill in your WooCommerce credentials.\n\n' +
    '  cp .env.example .env\n'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const shouldDownloadImages = args.includes('--images');
const storeBase = WC_STORE_URL.replace(/\/+$/, '');
const apiBase = storeBase + '/wp-json/wc/v3';
const perPage = 100;

// --- Category mapping ---

let categoryMap = {};
const CATEGORY_MAP_FILE = 'categories.json';

if (fs.existsSync(CATEGORY_MAP_FILE)) {
  categoryMap = JSON.parse(fs.readFileSync(CATEGORY_MAP_FILE, 'utf-8'));
  console.log(`Loaded ${Object.keys(categoryMap).length} category mappings from ${CATEGORY_MAP_FILE}`);
}

function mapCategory(wcCategoryName) {
  if (!wcCategoryName) return '';
  return categoryMap[wcCategoryName] || '';
}

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

// --- API helpers ---

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString('base64'),
  };
}

async function apiFetch(url) {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error (${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchAllProducts() {
  let products = [];
  let page = 1;

  while (true) {
    console.log(`  Page ${page}...`);
    const pageProducts = await apiFetch(`${apiBase}/products?per_page=${perPage}&page=${page}`);

    if (!Array.isArray(pageProducts)) {
      throw new Error(`Unexpected response: ${JSON.stringify(pageProducts).slice(0, 200)}`);
    }

    products = products.concat(pageProducts);

    if (pageProducts.length < perPage) break;
    page++;
  }

  return products;
}

async function fetchVariations(productId) {
  let variations = [];
  let page = 1;

  while (true) {
    const pageVariations = await apiFetch(
      `${apiBase}/products/${productId}/variations?per_page=${perPage}&page=${page}`
    );

    if (!Array.isArray(pageVariations)) break;

    variations = variations.concat(pageVariations);

    if (pageVariations.length < perPage) break;
    page++;
  }

  return variations;
}

// --- Image downloading ---

async function downloadImage(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function downloadProductImages(products) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const product of products) {
    if (!product.images?.length) continue;

    const handle = makeHandle(product.name);

    for (let i = 0; i < product.images.length; i++) {
      const img = product.images[i];
      if (!img.src) continue;

      const ext = path.extname(new URL(img.src).pathname) || '.jpg';
      const filename = i === 0 ? `${handle}${ext}` : `${handle}_${i + 1}${ext}`;
      const destPath = path.join(IMAGE_DIR, filename);

      if (fs.existsSync(destPath)) {
        skipped++;
        continue;
      }

      try {
        await downloadImage(img.src, destPath);
        downloaded++;
        process.stdout.write(`\r  Downloaded ${downloaded} images...`);
      } catch (err) {
        failed++;
        console.error(`\n  Failed: ${img.src} (${err.message})`);
      }
    }
  }

  console.log(`\n  Done: ${downloaded} downloaded, ${skipped} already existed` + (failed ? `, ${failed} failed` : ''));
}

// --- CSV mapping ---

function makeHandle(name) {
  return name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '';
}

function emptyRow() {
  const row = {};
  SHOPIFY_HEADERS.forEach(h => row[h] = '');
  return row;
}

function buildProductRow(product, variant, isFirstRow) {
  const handle = makeHandle(product.name);
  const category = product.categories?.[0]?.name || '';

  const row = emptyRow();
  row['Handle'] = handle;

  // Product-level fields only on the first row
  if (isFirstRow) {
    row['Title'] = product.name || '';
    row['Body (HTML)'] = product.description || '';
    row['Vendor'] = SHOPIFY_VENDOR;
    row['Product Category'] = mapCategory(category);
    row['Type'] = category;
    row['Tags'] = (product.tags || []).map(t => t.name).join(', ');
    row['Published'] = product.status === 'publish' ? 'TRUE' : 'FALSE';
    row['Gift Card'] = 'FALSE';
    row['SEO Title'] = product.name || '';
    row['SEO Description'] = product.short_description?.replace(/<[^>]*>/g, '').slice(0, 320) || '';
    row['Status'] = product.status === 'publish' ? 'active' : 'draft';
    row['Collection'] = category;
  }

  // Variant-level fields
  if (variant) {
    // Map WooCommerce attributes to Shopify Option columns
    const attrs = variant.attributes || [];
    if (attrs[0]) { row['Option1 Name'] = attrs[0].name || ''; row['Option1 Value'] = attrs[0].option || ''; }
    if (attrs[1]) { row['Option2 Name'] = attrs[1].name || ''; row['Option2 Value'] = attrs[1].option || ''; }
    if (attrs[2]) { row['Option3 Name'] = attrs[2].name || ''; row['Option3 Value'] = attrs[2].option || ''; }

    row['Variant SKU'] = variant.sku || '';
    row['Variant Grams'] = variant.weight ? Math.round(parseFloat(variant.weight) * 1000) : '';
    row['Variant Inventory Tracker'] = 'shopify';
    row['Variant Inventory Qty'] = variant.stock_quantity ?? '';
    row['Variant Inventory Policy'] = variant.backorders === 'no' ? 'deny' : 'continue';
    row['Variant Fulfillment Service'] = 'manual';
    row['Variant Price'] = variant.price || '';
    row['Variant Compare At Price'] = (variant.regular_price && variant.sale_price && variant.regular_price !== variant.sale_price) ? variant.regular_price : '';
    row['Variant Requires Shipping'] = 'TRUE';
    row['Variant Taxable'] = variant.tax_status === 'taxable' ? 'TRUE' : 'FALSE';
    row['Variant Weight Unit'] = variant.weight ? 'g' : '';

    // Variant image
    if (variant.image?.src) {
      row['Variant Image'] = variant.image.src;
    }
  } else {
    // Simple product — variant fields come from the product itself
    row['Variant SKU'] = product.sku || '';
    row['Variant Grams'] = product.weight ? Math.round(parseFloat(product.weight) * 1000) : '';
    row['Variant Inventory Tracker'] = 'shopify';
    row['Variant Inventory Qty'] = product.stock_quantity ?? '';
    row['Variant Inventory Policy'] = product.backorders === 'no' ? 'deny' : 'continue';
    row['Variant Fulfillment Service'] = 'manual';
    row['Variant Price'] = product.price || '';
    row['Variant Compare At Price'] = (product.regular_price && product.sale_price && product.regular_price !== product.sale_price) ? product.regular_price : '';
    row['Variant Requires Shipping'] = 'TRUE';
    row['Variant Taxable'] = product.tax_status === 'taxable' ? 'TRUE' : 'FALSE';
    row['Variant Weight Unit'] = product.weight ? 'g' : '';
  }

  // First image on the first row
  if (isFirstRow && product.images?.[0]) {
    row['Image Src'] = product.images[0].src;
    row['Image Position'] = '1';
    row['Image Alt Text'] = product.images[0].alt || '';
  }

  return row;
}

function writeImageRows(writer, handle, images) {
  // Additional images (index 1+) get their own rows
  for (let i = 1; i < images.length; i++) {
    const row = emptyRow();
    row['Handle'] = handle;
    row['Image Src'] = images[i].src;
    row['Image Position'] = String(i + 1);
    row['Image Alt Text'] = images[i].alt || '';
    writer.write(row);
  }
}

// --- Main ---

async function main() {
  console.log(`\nShopMigrate - WooCommerce to Shopify`);
  console.log(`Store:  ${WC_STORE_URL}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  if (shouldDownloadImages) console.log(`Images: ./${IMAGE_DIR}/`);
  console.log('');

  // Fetch all products
  console.log('Fetching products...');
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products\n`);

  if (products.length === 0) return;

  // Fetch variations for variable products
  const variableProducts = products.filter(p => p.type === 'variable');
  const variationMap = new Map();

  if (variableProducts.length > 0) {
    console.log(`Fetching variations for ${variableProducts.length} variable products...`);
    for (const product of variableProducts) {
      process.stdout.write(`  ${product.name.slice(0, 40)}...`);
      const variations = await fetchVariations(product.id);
      variationMap.set(product.id, variations);
      console.log(` ${variations.length} variants`);
    }
    console.log('');
  }

  if (isDryRun) {
    const totalVariants = [...variationMap.values()].reduce((sum, v) => sum + v.length, 0);
    console.log(`[Dry run] ${products.length} products, ${variableProducts.length} variable, ${totalVariants} total variants`);
    console.log('No files written.\n');

    if (products[0]) {
      console.log('Sample row:', JSON.stringify(buildProductRow(products[0], null, true), null, 2));
    }

    // Show unmapped categories
    const unmapped = [...new Set(products.flatMap(p => (p.categories || []).map(c => c.name)))].filter(c => !categoryMap[c]);
    if (unmapped.length) {
      console.log(`\nUnmapped categories (add to ${CATEGORY_MAP_FILE}):`);
      unmapped.forEach(c => console.log(`  "${c}": ""`));
    }
    return;
  }

  // Write CSV
  const writer = csvWriter({ headers: SHOPIFY_HEADERS });
  writer.pipe(fs.createWriteStream(OUTPUT_FILE));

  let rowCount = 0;

  for (const product of products) {
    const handle = makeHandle(product.name);
    const variations = variationMap.get(product.id);

    if (variations && variations.length > 0) {
      // Variable product: one row per variation
      variations.forEach((variant, i) => {
        writer.write(buildProductRow(product, variant, i === 0));
        rowCount++;
      });
    } else {
      // Simple product: single row
      writer.write(buildProductRow(product, null, true));
      rowCount++;
    }

    // Additional image rows
    if (product.images && product.images.length > 1) {
      writeImageRows(writer, handle, product.images);
    }
  }

  writer.end();
  console.log(`Exported ${products.length} products (${rowCount} rows) to ${OUTPUT_FILE}`);

  // Download images
  if (shouldDownloadImages) {
    console.log('\nDownloading images...');
    await downloadProductImages(products);
  }

  // Warn about unmapped categories
  const unmapped = [...new Set(products.flatMap(p => (p.categories || []).map(c => c.name)))].filter(c => c && !categoryMap[c]);
  if (unmapped.length) {
    console.log(`\nWarning: ${unmapped.length} categories not mapped to Shopify taxonomy.`);
    console.log(`Add them to ${CATEGORY_MAP_FILE} to set Product Category. Run with --dry-run to see the list.`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
