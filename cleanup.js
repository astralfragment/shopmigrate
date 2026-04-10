import fs from 'fs';

const INPUT = process.argv[2] || 'products_shopify.csv';
const OUTPUT = process.argv[3] || INPUT.replace('.csv', '_clean.csv');

if (!fs.existsSync(INPUT)) {
  console.error(`File not found: ${INPUT}`);
  process.exit(1);
}

// --- Color hex map for Shopify swatches ---

const COLOR_HEX = {
  'white': '#FFFFFF',
  'black': '#000000',
  'gloss black': '#000000',
  'matte black': '#1A1A1A',
  'matte white': '#F5F5F5',
  'oak': '#C8A876',
  'walnut': '#5C4033',
  'blue': '#1E3A8A',
  'mocha': '#6F4E37',
  'red': '#DC2626',
  'grey': '#6B7280',
  'gray': '#6B7280',
  'silver': '#C0C0C0',
  'gold': '#D4AF37',
  'green': '#16A34A',
  'brown': '#7C4A2D',
  'cream': '#FFFDD0',
  'midnight': '#191970',
  'graphite': '#4A4A4A',
  'carbon': '#333333',
  'sand': '#C2B280',
  'charcoal': '#36454F',
  'navy': '#000080',
  'ivory': '#FFFFF0',
  'beige': '#F5F5DC',
  'bronze': '#CD7F32',
  'copper': '#B87333',
  'platinum': '#E5E4E2',
  'rose': '#FF007F',
  'datuk': '#4A3728',
  'cherry': '#DE3163',
  'olive': '#808000',
  'teal': '#008080',
  'pink': '#EC4899',
  'orange': '#F97316',
  'yellow': '#EAB308',
  'purple': '#7C3AED',
  'burgundy': '#800020',
  'matte': '#2C2C2C',
  'smoke': '#738276',
  'ebony': '#3B3B3B',
  'mahogany': '#4E0000',
  'satin': '#2E2E2E',
};

// --- HTML processing ---

function stripAttributes(html) {
  // Remove class, data-*, id, style attributes but keep href/src
  return html.replace(/\s+(class|data-[a-z-]+|id|style|nowrap)="[^"]*"/gi, '');
}

function extractSpecs(html) {
  const specs = [];
  let match;

  // Pattern 1: Consecutive div text pairs (Vogel's-style spec sheets)
  // Split on <div tags and look for adjacent short text fragments
  const divChunks = html.split(/(?=<div)/);
  for (let i = 0; i < divChunks.length - 1; i++) {
    const textA = divChunks[i].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    const textB = divChunks[i + 1]?.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (textA && textB && textA.length >= 3 && textA.length < 60 && textB.length >= 1 && textB.length < 120) {
      // Skip description text, headings, and junk
      if (textA.includes('.') && textA.length > 30) continue;
      if (/^\s*$/.test(textA) || /^\s*$/.test(textB)) continue;
      if (textA.length < 3 || textB.length < 1) continue;
      specs.push(`${textA}: ${textB}`);
      i++; // skip the value chunk
    }
  }

  // Only keep div-pair specs if we found at least 3 (confirms it's a spec sheet, not noise)
  if (specs.length > 0 && specs.length < 3) {
    specs.length = 0;
  }

  // Pattern 2: Feature list items in <p> tags inside feature containers
  const featurePRegex = /<p[^>]*>([^<]{3,80})<\/p>/gi;
  while ((match = featurePRegex.exec(html)) !== null) {
    const text = match[1].trim();
    // Only short, label-like text (features, not descriptions)
    if (text.length >= 3 && text.length < 50 && !text.includes('.') && !specs.some(s => s.includes(text))) {
      // Check if it's inside a feature-like context
      const before = html.slice(Math.max(0, match.index - 200), match.index);
      if (/feature|spec|detail|tech/i.test(before)) {
        specs.push(text);
      }
    }
  }

  // Pattern 3: Table rows
  const tableRowRegex = /<tr[^>]*>\s*<t[dh][^>]*>(?:<[^>]*>)*\s*([^<]+)(?:<[^>]*>)*\s*<\/t[dh]>\s*<t[dh][^>]*>(?:<[^>]*>)*\s*([^<]+)/gi;
  while ((match = tableRowRegex.exec(html)) !== null) {
    const key = match[1].trim();
    const val = match[2].trim();
    if (key && val && key.length < 60 && val.length < 120) {
      if (!/^(model|product|item|name)$/i.test(key)) {
        const entry = `${key}: ${val}`;
        if (!specs.includes(entry)) specs.push(entry);
      }
    }
  }

  // Dedupe
  return [...new Set(specs)];
}

function cleanHtml(html) {
  if (!html) return '';

  // Remove empty divs and spans with only attributes (no text)
  let clean = html;

  // Strip all attributes except href and src
  clean = clean.replace(/<(\w+)\s+[^>]*?((?:href|src)="[^"]*")[^>]*>/gi, '<$1 $2>');
  clean = clean.replace(/<(\w+)\s+(?:class|data-[a-z-]+|id|style|nowrap)="[^"]*"\s*>/gi, '<$1>');
  clean = stripAttributes(clean);

  // Remove empty elements
  clean = clean.replace(/<(div|span|section|p)\s*>\s*<\/\1>/gi, '');
  // Repeat for nested empties
  clean = clean.replace(/<(div|span|section|p)\s*>\s*<\/\1>/gi, '');
  clean = clean.replace(/<(div|span|section|p)\s*>\s*<\/\1>/gi, '');

  // Remove product feature container divs but keep their text content
  clean = clean.replace(/<div[^>]*>\s*<p>([^<]+)<\/p>\s*<\/div>/gi, '<li>$1</li>');

  // Convert remaining divs to semantic elements where possible
  clean = clean.replace(/<div>/g, '').replace(/<\/div>/g, '');
  clean = clean.replace(/<section>/g, '').replace(/<\/section>/g, '');

  // Clean up whitespace
  clean = clean.replace(/\n\s*\n\s*\n/g, '\n\n');
  clean = clean.replace(/^\s+|\s+$/gm, '');
  clean = clean.replace(/\n{3,}/g, '\n\n');

  return clean.trim();
}

// --- CSV processing ---

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function escapeCSV(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Split CSV text into logical rows, respecting quoted multi-line fields
function splitCSVRows(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (current.trim()) rows.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

// --- Main ---

console.log(`\nShopMigrate Cleanup`);
console.log(`Input:  ${INPUT}`);
console.log(`Output: ${OUTPUT}\n`);

const content = fs.readFileSync(INPUT, 'utf-8');
const lines = splitCSVRows(content);

if (lines.length < 2) {
  console.error('CSV has no data rows.');
  process.exit(1);
}

const headers = parseCSVLine(lines[0]);
const bodyIdx = headers.indexOf('Body (HTML)');
const opt1NameIdx = headers.indexOf('Option1 Name');
const opt1ValIdx = headers.indexOf('Option1 Value');

// Add new columns
const newHeaders = [...headers, 'Metafield: custom.specs_text [multi_line_text_field]', 'Variant Metafield: color_swatch.color [color]'];

const outputLines = [newHeaders.map(escapeCSV).join(',')];

let cleaned = 0;
let specsExtracted = 0;
let swatchesMapped = 0;

for (let i = 1; i < lines.length; i++) {
  const fields = parseCSVLine(lines[i]);

  // Clean HTML body
  let specsText = '';
  if (bodyIdx >= 0 && fields[bodyIdx]) {
    const rawHtml = fields[bodyIdx];
    const specs = extractSpecs(rawHtml);
    if (specs.length > 0) {
      specsText = specs.join('\n');
      specsExtracted++;
    }
    fields[bodyIdx] = cleanHtml(rawHtml);
    cleaned++;
  }

  // Color swatch hex
  let colorHex = '';
  if (opt1NameIdx >= 0 && opt1ValIdx >= 0) {
    const optName = fields[opt1NameIdx]?.toLowerCase();
    const optVal = fields[opt1ValIdx]?.toLowerCase();
    if (optName === 'color' && optVal && COLOR_HEX[optVal]) {
      colorHex = COLOR_HEX[optVal];
      swatchesMapped++;
    }
  }

  // Add new column values
  fields.push(specsText);
  fields.push(colorHex);

  outputLines.push(fields.map(escapeCSV).join(','));
}

fs.writeFileSync(OUTPUT, outputLines.join('\n'));

console.log(`Processed ${lines.length - 1} rows`);
console.log(`  HTML cleaned: ${cleaned}`);
console.log(`  Specs extracted: ${specsExtracted}`);
console.log(`  Color swatches mapped: ${swatchesMapped}`);
console.log(`\nSaved to ${OUTPUT}`);
console.log('\nMetafield columns added:');
console.log('  - custom.specs_text (multi-line text) — extracted specifications');
console.log('  - color_swatch.color (color) — hex values for variant color swatches');
console.log('\nDone.');
