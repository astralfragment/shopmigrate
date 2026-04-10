import 'dotenv/config';
import fetch from 'node-fetch';
import csvWriter from 'csv-write-stream';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

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
const smartVariants = args.includes('--smart-variants');
const brandCollections = args.includes('--brand-collections');
const isInit = args.includes('--init');
const storeBase = WC_STORE_URL.replace(/\/+$/, '');
const apiBase = storeBase + '/wp-json/wc/v3';
const perPage = 100;

// --- Mapping files ---

const CATEGORY_MAP_FILE = 'categories.json';
const BRANDS_MAP_FILE = 'brands.json';
const COLLECTIONS_MAP_FILE = 'collections.json';

function loadJsonFile(filepath) {
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  return {};
}

let categoryMap = loadJsonFile(CATEGORY_MAP_FILE);
let brandsMap = loadJsonFile(BRANDS_MAP_FILE);
let collectionsMap = loadJsonFile(COLLECTIONS_MAP_FILE);

function mapCategory(wcCategoryName) {
  if (!wcCategoryName) return '';
  return categoryMap[wcCategoryName] || '';
}

function mapBrand(productName) {
  // Check brands.json for a matching prefix
  for (const [prefix, shopifyVendor] of Object.entries(brandsMap)) {
    if (productName.toLowerCase().startsWith(prefix.toLowerCase())) {
      return shopifyVendor;
    }
  }
  return SHOPIFY_VENDOR;
}

function mapCollection(wcCategoryName) {
  if (!wcCategoryName) return '';
  if (wcCategoryName in collectionsMap) return collectionsMap[wcCategoryName];
  return wcCategoryName;
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

// --- Inventory helpers ---

function inventoryFields(item) {
  if (item.manage_stock) {
    return {
      tracker: 'shopify',
      qty: item.stock_quantity ?? 0,
      policy: item.backorders === 'no' ? 'deny' : 'continue',
    };
  }
  // Not tracking stock — leave tracker empty so Shopify doesn't show 0
  return {
    tracker: '',
    qty: '',
    policy: item.stock_status === 'instock' ? 'deny' : 'deny',
  };
}

// --- Smart variant grouping ---

const COLOR_WORDS = new Set([
  'white', 'black', 'oak', 'blue', 'mocha', 'red', 'grey', 'gray', 'silver',
  'gold', 'green', 'brown', 'cream', 'walnut', 'midnight', 'graphite', 'carbon',
  'sand', 'smoke', 'charcoal', 'navy', 'ivory', 'beige', 'bronze', 'copper',
  'platinum', 'rose', 'matte', 'satin', 'datuk', 'crimson', 'ebony', 'mahogany',
  'cherry', 'olive', 'teal', 'pink', 'orange', 'yellow', 'purple', 'violet',
  'indigo', 'maroon', 'burgundy', 'aqua', 'turquoise', 'coral', 'peach',
  'gloss black', 'matte black', 'matte white',
]);

function extractVariantInfo(name) {
  const parenRegex = /\(([^)]+)\)/g;
  let match;
  let colorMatch = null;
  let colorStart = -1;
  let colorEnd = -1;

  while ((match = parenRegex.exec(name)) !== null) {
    const inner = match[1].trim();
    if (COLOR_WORDS.has(inner.toLowerCase())) {
      colorMatch = inner;
      colorStart = match.index;
      colorEnd = match.index + match[0].length;
      break;
    }
  }

  if (colorMatch) {
    const baseName = (name.slice(0, colorStart) + name.slice(colorEnd)).replace(/\s+/g, ' ').trim();
    return { baseName, variantValue: colorMatch };
  }

  const words = name.split(/\s+/);
  if (words.length >= 2) {
    const lastWord = words[words.length - 1];
    if (COLOR_WORDS.has(lastWord.toLowerCase())) {
      return { baseName: words.slice(0, -1).join(' '), variantValue: lastWord };
    }
    if (words.length >= 3) {
      const lastTwo = words.slice(-2).join(' ');
      if (COLOR_WORDS.has(lastTwo.toLowerCase())) {
        return { baseName: words.slice(0, -2).join(' '), variantValue: lastTwo };
      }
    }
  }

  return null;
}

function groupSmartVariants(products) {
  const groups = new Map();
  const ungrouped = [];

  for (const product of products) {
    if (product.type !== 'simple') {
      ungrouped.push(product);
      continue;
    }

    const info = extractVariantInfo(product.name);
    if (info) {
      const key = info.baseName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { baseName: info.baseName, products: [] });
      }
      groups.get(key).products.push({ product, variantValue: info.variantValue });
    } else {
      ungrouped.push(product);
    }
  }

  const mergedGroups = [];
  for (const [, group] of groups) {
    if (group.products.length >= 2) {
      mergedGroups.push(group);
    } else {
      ungrouped.push(group.products[0].product);
    }
  }

  return { mergedGroups, ungrouped };
}

// --- Brand detection ---

const KNOWN_MULTI_WORD_BRANDS = [
  'Monitor Audio', 'Polk Audio', 'B+W',
];

function detectBrand(productName) {
  // Check multi-word brands first
  for (const brand of KNOWN_MULTI_WORD_BRANDS) {
    if (productName.startsWith(brand)) return brand;
  }
  // Fall back to first word
  return productName.split(/\s+/)[0] || '';
}

function detectAllBrands(products) {
  const brandCounts = {};
  for (const p of products) {
    const brand = detectBrand(p.name);
    if (!brandCounts[brand]) brandCounts[brand] = 0;
    brandCounts[brand]++;
  }
  return Object.entries(brandCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);
}

// --- Interactive init ---

function createInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function runInit() {
  console.log('\nShopMigrate - Interactive Setup');
  console.log(`Store: ${WC_STORE_URL}\n`);

  console.log('Fetching products...');
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products\n`);

  if (products.length === 0) return;

  const rl = createInterface();

  // --- Brand mapping ---
  console.log('=== Brand / Vendor Mapping ===\n');
  const detectedBrands = detectAllBrands(products);
  console.log(`Detected ${detectedBrands.length} brands from product names:\n`);

  const existingBrands = loadJsonFile(BRANDS_MAP_FILE);
  const newBrands = {};

  for (const [brand, count] of detectedBrands) {
    const existing = existingBrands[brand];
    if (existing) {
      console.log(`  ${brand} (${count} products) -> "${existing}" [already mapped]`);
      newBrands[brand] = existing;
      continue;
    }
    const answer = await ask(rl, `  ${brand} (${count} products) — Shopify vendor name [${brand}]: `);
    newBrands[brand] = answer.trim() || brand;
  }

  fs.writeFileSync(BRANDS_MAP_FILE, JSON.stringify(newBrands, null, 2) + '\n');
  console.log(`\nSaved ${Object.keys(newBrands).length} brands to ${BRANDS_MAP_FILE}\n`);

  // --- Collection mapping ---
  console.log('=== Collection Mapping ===\n');
  const allCategories = [...new Set(products.flatMap(p => (p.categories || []).map(c => c.name)))].sort();
  console.log(`Found ${allCategories.length} WooCommerce categories:\n`);

  const existingCollections = loadJsonFile(COLLECTIONS_MAP_FILE);
  const newCollections = {};

  for (const cat of allCategories) {
    const existing = existingCollections[cat];
    if (existing !== undefined) {
      console.log(`  "${cat}" -> "${existing}" [already mapped]`);
      newCollections[cat] = existing;
      continue;
    }
    const answer = await ask(rl, `  "${cat}" — Shopify collection name [${cat}]: `);
    newCollections[cat] = answer.trim() || cat;
  }

  fs.writeFileSync(COLLECTIONS_MAP_FILE, JSON.stringify(newCollections, null, 2) + '\n');
  console.log(`\nSaved ${Object.keys(newCollections).length} collections to ${COLLECTIONS_MAP_FILE}\n`);

  // --- Category taxonomy check ---
  const unmappedCats = allCategories.filter(c => c && !(c in categoryMap));
  if (unmappedCats.length > 0) {
    console.log(`Note: ${unmappedCats.length} categories not yet mapped to Shopify taxonomy in ${CATEGORY_MAP_FILE}:`);
    unmappedCats.forEach(c => console.log(`  "${c}"`));
    console.log(`\nEdit ${CATEGORY_MAP_FILE} to add valid Shopify Product Taxonomy values.`);
    console.log('Browse: https://shopify.github.io/product-taxonomy/\n');
  }

  // --- Summary ---
  const smartResult = groupSmartVariants(products);
  if (smartResult.mergedGroups.length > 0) {
    console.log(`Tip: ${smartResult.mergedGroups.length} products can be auto-grouped with --smart-variants:`);
    for (const g of smartResult.mergedGroups) {
      console.log(`  ${g.baseName} (${g.products.length} color variants)`);
    }
    console.log('');
  }

  console.log('Setup complete. Run your export:');
  console.log('  npm start                         # basic export');
  console.log('  npm run smart                     # with smart variant grouping');
  console.log('  node index.js --smart-variants --images  # full export with images\n');

  rl.close();
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

function cleanTitle(name) {
  const info = extractVariantInfo(name);
  return info ? info.baseName : name;
}

function makeHandle(name) {
  return name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '';
}

function emptyRow() {
  const row = {};
  SHOPIFY_HEADERS.forEach(h => row[h] = '');
  return row;
}

function buildProductRow(product, variant, isFirstRow) {
  const handle = makeHandle(cleanTitle(product.name) || product.name);
  const category = product.categories?.[0]?.name || '';

  const row = emptyRow();
  row['Handle'] = handle;

  if (isFirstRow) {
    const title = cleanTitle(product.name) || product.name || '';
    row['Title'] = title;
    row['Body (HTML)'] = product.description || '';
    row['Vendor'] = mapBrand(product.name);
    row['Product Category'] = mapCategory(category);
    row['Type'] = category;
    row['Tags'] = (product.tags || []).map(t => t.name).join(', ');
    row['Published'] = product.status === 'publish' ? 'TRUE' : 'FALSE';
    row['Gift Card'] = 'FALSE';
    row['SEO Title'] = title;
    row['SEO Description'] = product.short_description?.replace(/<[^>]*>/g, '').slice(0, 320) || '';
    row['Status'] = product.status === 'publish' ? 'active' : 'draft';
    row['Collection'] = mapCollection(category);
  }

  if (variant) {
    const attrs = variant.attributes || [];
    if (attrs[0]) { row['Option1 Name'] = attrs[0].name || ''; row['Option1 Value'] = attrs[0].option || ''; }
    if (attrs[1]) { row['Option2 Name'] = attrs[1].name || ''; row['Option2 Value'] = attrs[1].option || ''; }
    if (attrs[2]) { row['Option3 Name'] = attrs[2].name || ''; row['Option3 Value'] = attrs[2].option || ''; }

    const inv = inventoryFields(variant);
    row['Variant SKU'] = variant.sku || '';
    row['Variant Grams'] = variant.weight ? Math.round(parseFloat(variant.weight) * 1000) : '';
    row['Variant Inventory Tracker'] = inv.tracker;
    row['Variant Inventory Qty'] = inv.qty;
    row['Variant Inventory Policy'] = inv.policy;
    row['Variant Fulfillment Service'] = 'manual';
    row['Variant Price'] = variant.price || '';
    row['Variant Compare At Price'] = (variant.regular_price && variant.sale_price && variant.regular_price !== variant.sale_price) ? variant.regular_price : '';
    row['Variant Requires Shipping'] = 'TRUE';
    row['Variant Taxable'] = variant.tax_status === 'taxable' ? 'TRUE' : 'FALSE';
    row['Variant Weight Unit'] = variant.weight ? 'g' : '';

    if (variant.image?.src) {
      row['Variant Image'] = variant.image.src;
    }
  } else {
    // Detect color in name and set as variant option
    const colorInfo = extractVariantInfo(product.name);
    if (colorInfo) {
      row['Option1 Name'] = 'Color';
      row['Option1 Value'] = colorInfo.variantValue;
    }

    const inv = inventoryFields(product);
    row['Variant SKU'] = product.sku || '';
    row['Variant Grams'] = product.weight ? Math.round(parseFloat(product.weight) * 1000) : '';
    row['Variant Inventory Tracker'] = inv.tracker;
    row['Variant Inventory Qty'] = inv.qty;
    row['Variant Inventory Policy'] = inv.policy;
    row['Variant Fulfillment Service'] = 'manual';
    row['Variant Price'] = product.price || '';
    row['Variant Compare At Price'] = (product.regular_price && product.sale_price && product.regular_price !== product.sale_price) ? product.regular_price : '';
    row['Variant Requires Shipping'] = 'TRUE';
    row['Variant Taxable'] = product.tax_status === 'taxable' ? 'TRUE' : 'FALSE';
    row['Variant Weight Unit'] = product.weight ? 'g' : '';
  }

  if (isFirstRow && product.images?.[0]) {
    row['Image Src'] = product.images[0].src;
    row['Image Position'] = '1';
    row['Image Alt Text'] = product.images[0].alt || '';
  }

  return row;
}

function buildSmartVariantRow(group, memberProduct, variantValue, isFirstRow) {
  const handle = makeHandle(group.baseName);
  const category = memberProduct.categories?.[0]?.name || '';

  const row = emptyRow();
  row['Handle'] = handle;

  if (isFirstRow) {
    row['Title'] = group.baseName;
    const best = group.products.reduce((a, b) =>
      (b.product.description || '').length > (a.product.description || '').length ? b : a
    );
    row['Body (HTML)'] = best.product.description || '';
    row['Vendor'] = mapBrand(group.baseName);
    row['Product Category'] = mapCategory(category);
    row['Type'] = category;
    const allTags = [...new Set(group.products.flatMap(m => (m.product.tags || []).map(t => t.name)))];
    row['Tags'] = allTags.join(', ');
    row['Published'] = group.products.some(m => m.product.status === 'publish') ? 'TRUE' : 'FALSE';
    row['Gift Card'] = 'FALSE';
    row['SEO Title'] = group.baseName;
    const bestShort = group.products.reduce((a, b) =>
      (b.product.short_description || '').length > (a.product.short_description || '').length ? b : a
    );
    row['SEO Description'] = bestShort.product.short_description?.replace(/<[^>]*>/g, '').slice(0, 320) || '';
    row['Status'] = group.products.some(m => m.product.status === 'publish') ? 'active' : 'draft';
    row['Collection'] = mapCollection(category);
  }

  row['Option1 Name'] = 'Color';
  row['Option1 Value'] = variantValue;

  const inv = inventoryFields(memberProduct);
  row['Variant SKU'] = memberProduct.sku || '';
  row['Variant Grams'] = memberProduct.weight ? Math.round(parseFloat(memberProduct.weight) * 1000) : '';
  row['Variant Inventory Tracker'] = inv.tracker;
  row['Variant Inventory Qty'] = inv.qty;
  row['Variant Inventory Policy'] = inv.policy;
  row['Variant Fulfillment Service'] = 'manual';
  row['Variant Price'] = memberProduct.price || '';
  row['Variant Compare At Price'] = (memberProduct.regular_price && memberProduct.sale_price && memberProduct.regular_price !== memberProduct.sale_price) ? memberProduct.regular_price : '';
  row['Variant Requires Shipping'] = 'TRUE';
  row['Variant Taxable'] = memberProduct.tax_status === 'taxable' ? 'TRUE' : 'FALSE';
  row['Variant Weight Unit'] = memberProduct.weight ? 'g' : '';

  if (memberProduct.images?.[0]?.src) {
    row['Variant Image'] = memberProduct.images[0].src;
  }

  if (isFirstRow && memberProduct.images?.[0]) {
    row['Image Src'] = memberProduct.images[0].src;
    row['Image Position'] = '1';
    row['Image Alt Text'] = memberProduct.images[0].alt || '';
  }

  return row;
}

function writeImageRows(writer, handle, images) {
  for (let i = 1; i < images.length; i++) {
    const row = emptyRow();
    row['Handle'] = handle;
    row['Image Src'] = images[i].src;
    row['Image Position'] = String(i + 1);
    row['Image Alt Text'] = images[i].alt || '';
    writer.write(row);
  }
}

function writeBrandCollectionRow(writer, handle, brandName) {
  const row = emptyRow();
  row['Handle'] = handle;
  row['Collection'] = brandName;
  writer.write(row);
}

// --- Main ---

async function main() {
  // Interactive init mode
  if (isInit) {
    await runInit();
    return;
  }

  const mappingStatus = [];
  if (Object.keys(categoryMap).length) mappingStatus.push(`${Object.keys(categoryMap).length} categories`);
  if (Object.keys(brandsMap).length) mappingStatus.push(`${Object.keys(brandsMap).length} brands`);
  if (Object.keys(collectionsMap).length) mappingStatus.push(`${Object.keys(collectionsMap).length} collections`);

  console.log(`\nShopMigrate - WooCommerce to Shopify`);
  console.log(`Store:  ${WC_STORE_URL}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  if (mappingStatus.length) console.log(`Maps:   ${mappingStatus.join(', ')}`);
  if (smartVariants) console.log(`Mode:   Smart variant grouping enabled`);
  if (brandCollections) console.log(`Mode:   Brand collections enabled`);
  if (shouldDownloadImages) console.log(`Images: ./${IMAGE_DIR}/`);
  console.log('');

  console.log('Fetching products...');
  const products = await fetchAllProducts();
  console.log(`Found ${products.length} products\n`);

  if (products.length === 0) return;

  // Fetch variations for WooCommerce variable products
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

  // Smart variant grouping
  let mergedGroups = [];
  let processProducts = products;

  if (smartVariants) {
    const result = groupSmartVariants(products);
    mergedGroups = result.mergedGroups;
    processProducts = result.ungrouped;

    if (mergedGroups.length > 0) {
      console.log(`Smart variants: grouped ${mergedGroups.reduce((s, g) => s + g.products.length, 0)} simple products into ${mergedGroups.length} variant products:\n`);
      for (const group of mergedGroups) {
        console.log(`  [grouped]  ${group.baseName} — ${group.products.length} variants`);
        for (const member of group.products) {
          console.log(`    ${member.variantValue} | ${member.product.price || 'no price'} | SKU: ${member.product.sku || 'none'}`);
        }
      }
      console.log('');
    } else {
      console.log('Smart variants: no groupable products found.\n');
    }
  }

  if (isDryRun) {
    const totalWcVariants = [...variationMap.values()].reduce((sum, v) => sum + v.length, 0);
    const smartGrouped = mergedGroups.reduce((s, g) => s + g.products.length, 0);
    console.log(`[Dry run] ${products.length} products total`);
    console.log(`  WooCommerce variable: ${variableProducts.length} (${totalWcVariants} variants)`);
    if (smartVariants) {
      console.log(`  Smart-grouped: ${mergedGroups.length} products (${smartGrouped} merged simple products)`);
      console.log(`  Remaining simple: ${processProducts.filter(p => p.type === 'simple').length}`);
    }

    // Stock stats
    const managed = products.filter(p => p.manage_stock).length;
    const unmanaged = products.length - managed;
    console.log(`  Inventory tracked: ${managed}, untracked: ${unmanaged}`);
    console.log('No files written.\n');

    const unmapped = [...new Set(products.flatMap(p => (p.categories || []).map(c => c.name)))].filter(c => c && !(c in categoryMap));
    if (unmapped.length) {
      console.log(`Unmapped categories (add to ${CATEGORY_MAP_FILE}):`);
      unmapped.forEach(c => console.log(`  "${c}": ""`));
    }

    if (!Object.keys(brandsMap).length) {
      console.log(`\nTip: Run "npm run init" to set up brand and collection mappings.`);
    }
    return;
  }

  // Write CSV
  const writer = csvWriter({ headers: SHOPIFY_HEADERS });
  writer.pipe(fs.createWriteStream(OUTPUT_FILE));

  let rowCount = 0;
  let simpleCount = 0;
  let variableCount = 0;
  let variantCount = 0;
  let smartGroupCount = mergedGroups.length;
  let smartVariantCount = 0;

  // Write smart-grouped products first
  for (const group of mergedGroups) {
    const handle = makeHandle(group.baseName);
    smartVariantCount += group.products.length;
    console.log(`  [grouped]  ${group.baseName} — ${group.products.length} variants`);

    group.products.forEach((member, i) => {
      console.log(`    ${member.variantValue} | ${member.product.price || 'no price'} | SKU: ${member.product.sku || 'none'}`);
      writer.write(buildSmartVariantRow(group, member.product, member.variantValue, i === 0));
      rowCount++;
    });

    const allImages = [];
    const seenUrls = new Set();
    for (const member of group.products) {
      for (const img of (member.product.images || [])) {
        if (img.src && !seenUrls.has(img.src)) {
          seenUrls.add(img.src);
          allImages.push(img);
        }
      }
    }
    if (allImages.length > 1) {
      writeImageRows(writer, handle, allImages);
    }

    // Brand collection row
    if (brandCollections) {
      const brand = mapBrand(group.baseName);
      if (brand && brand !== SHOPIFY_VENDOR) {
        writeBrandCollectionRow(writer, handle, brand);
      }
    }
  }

  // Write remaining products
  for (const product of processProducts) {
    const handle = makeHandle(product.name);
    const variations = variationMap.get(product.id);

    if (variations && variations.length > 0) {
      variableCount++;
      variantCount += variations.length;
      console.log(`  [variable] ${product.name} — ${variations.length} variants`);
      variations.forEach((variant, i) => {
        const attrs = (variant.attributes || []).map(a => `${a.name}: ${a.option}`).join(', ');
        console.log(`    variant ${i + 1}: ${attrs || 'default'} | ${variant.price || 'no price'} | SKU: ${variant.sku || 'none'}`);
        writer.write(buildProductRow(product, variant, i === 0));
        rowCount++;
      });
    } else {
      simpleCount++;
      const colorInfo = extractVariantInfo(product.name);
      const title = colorInfo ? colorInfo.baseName : product.name;
      if (colorInfo) {
        console.log(`  [simple]   ${title} | Color: ${colorInfo.variantValue} | ${product.price || 'no price'} | SKU: ${product.sku || 'none'}`);
      } else {
        console.log(`  [simple]   ${title} | ${product.price || 'no price'} | SKU: ${product.sku || 'none'}`);
      }
      writer.write(buildProductRow(product, null, true));
      rowCount++;
    }

    if (product.images && product.images.length > 1) {
      writeImageRows(writer, handle, product.images);
    }

    // Brand collection row
    if (brandCollections) {
      const brand = mapBrand(product.name);
      if (brand && brand !== SHOPIFY_VENDOR) {
        writeBrandCollectionRow(writer, handle, brand);
      }
    }
  }

  writer.end();
  console.log(`\nExported to ${OUTPUT_FILE} (${rowCount} rows)`);
  if (smartGroupCount > 0) {
    console.log(`  Smart-grouped: ${smartGroupCount} products (${smartVariantCount} color variants)`);
  }
  console.log(`  Simple:   ${simpleCount}`);
  console.log(`  Variable: ${variableCount} (${variantCount} WC variants)`);
  if (brandCollections) {
    const brandSet = new Set();
    for (const p of products) {
      const b = mapBrand(p.name);
      if (b && b !== SHOPIFY_VENDOR) brandSet.add(b);
    }
    console.log(`  Brand collections: ${brandSet.size} (${[...brandSet].join(', ')})`);
  }

  if (shouldDownloadImages) {
    console.log('\nDownloading images...');
    await downloadProductImages(products);
  }

  const unmapped = [...new Set(products.flatMap(p => (p.categories || []).map(c => c.name)))].filter(c => c && !(c in categoryMap));
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
