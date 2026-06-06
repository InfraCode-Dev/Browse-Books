#!/usr/bin/env node
// Reads the Audible library data files and generates three LLM-readable outputs
// that work without JavaScript:
//
//   llms.txt          – plain-text book list (llmstxt.org convention)
//   library.json      – clean JSON (no JS window.* wrapper)
//   library-list.html – static HTML, zero JS required

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');
const dataDir  = path.join(repoRoot, 'data');

// ── helpers ──────────────────────────────────────────────────────────────────

function parseJsDataFile(filePath, varName) {
  const content = fs.readFileSync(filePath, 'utf8');
  const prefix  = `window.${varName} = `;
  const start   = content.indexOf(prefix);
  if (start === -1) throw new Error(`${varName} not found in ${filePath}`);
  const json = content.slice(start + prefix.length).trimEnd().replace(/;$/, '');
  return JSON.parse(json);
}

function decodeHtmlEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g,  '&');  // amp must be last to avoid double-decoding
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stars(n) {
  const full  = Math.max(0, Math.min(5, parseInt(n) || 0));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// Decode any HTML entities in every string field once at load time so that
// all downstream code (text, JSON, HTML) works with clean values. Callers
// still call escapeHtml() at the HTML-output boundary.
function normalizeBook(b) {
  const d = decodeHtmlEntities;
  return {
    ...b,
    title:     d(b.title),
    blurb:     b.blurb    ? d(b.blurb)    : b.blurb,
    progress:  b.progress ? d(b.progress) : b.progress,
    authors:   (b.authors   || []).map(a => ({ ...a, name: d(a.name) })),
    narrators: (b.narrators || []).map(n => ({ ...n, name: d(n.name) })),
    series:    (b.series    || []).map(s => ({ ...s, name: d(s.name) })),
  };
}

// Reads data/split-book-data/[ASIN].[cacheID].js files.
// Each sets window.bookSummaryJSON = "<p>...</p>" (a JSON-encoded HTML string).
// Returns ASIN → plain-text description map.
function loadSplitDescriptions() {
  const splitDir = path.join(dataDir, 'split-book-data');
  const map = {};
  if (!fs.existsSync(splitDir)) return map;
  for (const file of fs.readdirSync(splitDir)) {
    const match = file.match(/^([^.]+)\.\d+\.js$/);
    if (!match) continue;
    const asin = match[1];
    try {
      const content = fs.readFileSync(path.join(splitDir, file), 'utf8');
      const prefix  = 'window.bookSummaryJSON = ';
      const start   = content.indexOf(prefix);
      if (start === -1) continue;
      // Value is a JS string literal (quoted HTML), JSON.parse unwraps the quotes.
      const html = JSON.parse(content.slice(start + prefix.length).trimEnd().replace(/;\s*$/, ''));
      const text = decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (text) map[asin] = text;
    } catch { /* skip malformed files */ }
  }
  return map;
}

// ── load data ─────────────────────────────────────────────────────────────────

const dataFiles  = fs.readdirSync(dataDir);
const libraryFile = dataFiles.find(f => /^library\.\d+\.js$/.test(f));
if (!libraryFile) { console.error('No library.*.js file found in data/'); process.exit(1); }

const books            = parseJsDataFile(path.join(dataDir, libraryFile), 'libraryJSON').map(normalizeBook);
const splitDescriptions = loadSplitDescriptions();
const today            = new Date().toISOString().split('T')[0];
const sortedBooks      = [...books].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

console.log(`Loaded ${Object.keys(splitDescriptions).length} full descriptions from split-book-data`);

const finished   = books.filter(b => b.progress === 'Finished').length;
const inProgress = books.filter(b => b.progress && b.progress !== 'Finished').length;
const rated      = books.filter(b => b.myRating).length;

console.log(`Loaded ${books.length} books from ${libraryFile}`);

// ── helpers for per-book metadata ─────────────────────────────────────────────

function authorNames(book)   { return (book.authors   || []).map(a => a.name).join(', '); }
function narratorNames(book) { return (book.narrators  || []).map(n => n.name).join(', '); }
function seriesLabel(book) {
  return (book.series || [])
    .map(s => s.bookNumbers ? `${s.name} #${s.bookNumbers.join('/')}` : s.name)
    .join('; ');
}

// ── 1. library.json ───────────────────────────────────────────────────────────

const cleanBooks = books.map(b => ({
  title:      b.title,
  asin:       b.asin,
  authors:    (b.authors   || []).map(a => a.name),
  narrators:  (b.narrators || []).map(n => n.name),
  series:     (b.series    || []).map(s => ({
    name:       s.name,
    bookNumber: s.bookNumbers ? s.bookNumbers.join('/') : null,
    asin:       s.asin || null,
  })),
  blurb:       b.blurb    || null,
  description: splitDescriptions[b.asin] || b.blurb || null,
  rating:     b.myRating ? parseInt(b.myRating) : null,
  progress:   b.progress || null,
  cover_url:  b.cover ? `https://m.media-amazon.com/images/I/${b.cover}._SL200_.jpg` : null,
  audible_url: `https://www.audible.com/pd/${b.asin}`,
}));

fs.writeFileSync(path.join(repoRoot, 'library.json'), JSON.stringify(cleanBooks, null, 2));
console.log('Generated library.json');

// ── 2a. llms-full.txt (complete per-book dump) ────────────────────────────────

let fullTxt = `# My Audible Library — Full Book List

A personal audiobook library with ${books.length} titles, sorted A–Z.

> Interactive site:      https://infracode-dev.github.io/Browse-Books/#/library
> Static HTML version:   https://infracode-dev.github.io/Browse-Books/library-list.html
> Machine-readable JSON: https://infracode-dev.github.io/Browse-Books/library.json
> Short index (llms.txt): https://infracode-dev.github.io/Browse-Books/llms.txt
> Last generated: ${today}

## Stats

- Total: ${books.length} audiobooks
- Finished: ${finished} | In progress: ${inProgress} | Not started: ${books.length - finished - inProgress}
- Rated: ${rated}

## Books (A–Z)

`;

for (const book of sortedBooks) {
  const narr   = narratorNames(book);
  const series = seriesLabel(book);
  fullTxt += `### ${book.title}\n`;
  fullTxt += `- Author(s): ${authorNames(book)}\n`;
  if (narr)          fullTxt += `- Narrator(s): ${narr}\n`;
  if (series)        fullTxt += `- Series: ${series}\n`;
  if (book.myRating) fullTxt += `- My rating: ${book.myRating}/5\n`;
  if (book.progress) fullTxt += `- Progress: ${book.progress}\n`;
  const desc = splitDescriptions[book.asin] || book.blurb;
  if (desc)          fullTxt += `- Description: ${desc}\n`;
  fullTxt += `- ASIN: ${book.asin}\n`;
  fullTxt += '\n';
}

fs.writeFileSync(path.join(repoRoot, 'llms-full.txt'), fullTxt);
console.log('Generated llms-full.txt');

// ── 2b. llms.txt (short navigational index, per llmstxt.org convention) ──────

const topRated = books
  .filter(b => b.myRating === '5')
  .sort((a, b) => (b.added || 0) - (a.added || 0))
  .slice(0, 10);

const recentlyAdded = [...books]
  .sort((a, b) => (b.added || 0) - (a.added || 0))
  .slice(0, 5);

function bookOneLiner(book) {
  const authors = authorNames(book);
  const narr    = narratorNames(book);
  const series  = seriesLabel(book);
  let line = `- ${book.title} — by ${authors}`;
  if (narr)   line += `, narrated by ${narr}`;
  if (series) line += ` (${series})`;
  return line;
}

let indexTxt = `# My Audible Library

> A personal Audible audiobook library with ${books.length} titles.
> Last generated: ${today}

## Formats

- Full book list (plain text, A–Z): https://infracode-dev.github.io/Browse-Books/llms-full.txt
- Machine-readable JSON:            https://infracode-dev.github.io/Browse-Books/library.json
- Static HTML (no JavaScript):      https://infracode-dev.github.io/Browse-Books/library-list.html
- Interactive site:                 https://infracode-dev.github.io/Browse-Books/#/library

## Stats

- Total: ${books.length} audiobooks
- Finished: ${finished} | In progress: ${inProgress} | Not started: ${books.length - finished - inProgress}
- Rated: ${rated}

## Top Rated (5★, most recent first)

${topRated.map(bookOneLiner).join('\n')}

## Recently Added

${recentlyAdded.map(bookOneLiner).join('\n')}
`;

fs.writeFileSync(path.join(repoRoot, 'llms.txt'), indexTxt);
console.log('Generated llms.txt (short index)');

// ── 3. library-list.html ──────────────────────────────────────────────────────

const bookCards = sortedBooks.map(book => {
  const authors  = escapeHtml(authorNames(book));
  const narr     = escapeHtml(narratorNames(book));
  const series   = escapeHtml(seriesLabel(book));
  const rating   = book.myRating ? escapeHtml(stars(book.myRating)) : null;
  const ratingN  = book.myRating ? parseInt(book.myRating) : null;
  const progress = book.progress ? escapeHtml(book.progress) : null;
  const coverUrl = book.cover
    ? `https://m.media-amazon.com/images/I/${book.cover}._SL200_.jpg`
    : null;
  const audibleUrl = `https://www.audible.com/pd/${book.asin}`;

  const fullDesc = splitDescriptions[book.asin] || null;

  let descHtml = '';
  if (fullDesc) {
    // Full description available: show blurb as the summary line, full text expanded
    descHtml = `
      <details class="full-desc">
        <summary class="blurb">${escapeHtml(book.blurb)}</summary>
        <p class="full-desc-text">${escapeHtml(fullDesc)}</p>
      </details>`;
  } else if (book.blurb) {
    descHtml = `\n      <p class="blurb">${escapeHtml(book.blurb)}</p>`;
  }

  return `  <article class="book">
    ${coverUrl
      ? `<img class="cover" src="${escapeHtml(coverUrl)}" alt="" loading="lazy" width="80" height="80">`
      : '<div class="cover cover-placeholder"></div>'}
    <div class="details">
      <h2><a href="${escapeHtml(audibleUrl)}">${escapeHtml(book.title)}</a></h2>
      <p class="meta">
        <span class="authors">By ${authors}</span>${narr
          ? `<span class="narrators">Narrated by ${narr}</span>`
          : ''}${series
          ? `<span class="series">${series}</span>`
          : ''}${rating
          ? `<span class="rating" aria-label="${ratingN} out of 5 stars">${rating}</span>`
          : ''}${progress
          ? `<span class="progress">${progress}</span>`
          : ''}
      </p>${descHtml}
    </div>
  </article>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Audible Library — ${books.length} Books</title>
  <meta name="description" content="A personal Audible audiobook library with ${books.length} titles. No JavaScript required.">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root { font-family: system-ui, -apple-system, sans-serif; color-scheme: light dark; }
    body { max-width: 860px; margin: 0 auto; padding: 1.5rem; line-height: 1.5; }
    h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
    .subtitle { color: #666; font-size: 0.9rem; margin: 0 0 0.75rem; }
    .nav { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 1rem; }
    .nav a { text-decoration: none; color: #0070f3; border: 1px solid currentColor; padding: 0.2rem 0.5rem; border-radius: 4px; }
    .nav a:hover { background: #0070f3; color: #fff; }
    .stats { display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: 0.85rem; color: #666; margin-bottom: 1.5rem; padding: 0.75rem 1rem; background: #f5f5f5; border-radius: 6px; }
    #library { display: flex; flex-direction: column; gap: 0; }
    .book { display: grid; grid-template-columns: 80px 1fr; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid #eee; }
    .cover { width: 80px; height: 80px; object-fit: cover; border-radius: 4px; }
    .cover-placeholder { background: #ddd; border-radius: 4px; }
    h2 { margin: 0 0 0.3rem; font-size: 1rem; font-weight: 600; }
    h2 a { color: inherit; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    .meta { margin: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; font-size: 0.82rem; color: #555; }
    .series { font-style: italic; }
    .rating { color: #e08800; letter-spacing: 0.05em; }
    .progress { color: #0a7; font-weight: 500; }
    .blurb { margin: 0.4rem 0 0; font-size: 0.82rem; color: #444; }
    details.full-desc { margin: 0.4rem 0 0; }
    details.full-desc summary.blurb { cursor: pointer; list-style: none; margin: 0; }
    details.full-desc summary.blurb::after { content: ' ▸ full'; font-size: 0.75rem; color: #0070f3; }
    details.full-desc[open] summary.blurb::after { content: ' ▴ collapse'; }
    .full-desc-text { margin: 0.4rem 0 0; padding: 0.5rem; background: #f9f9f9; border-radius: 4px; font-size: 0.82rem; line-height: 1.6; }
    .generated { text-align: center; font-size: 0.75rem; color: #aaa; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; }
    @media (max-width: 480px) { .book { grid-template-columns: 60px 1fr; } .cover { width: 60px; height: 60px; } }
    @media (prefers-color-scheme: dark) {
      .stats { background: #1a1a1a; color: #aaa; }
      .meta, .subtitle, .subtitle { color: #888; }
      .blurb { color: #bbb; }
      .full-desc-text { background: #1e1e1e; color: #bbb; }
      .book { border-color: #2a2a2a; }
      .cover-placeholder { background: #333; }
      .nav a { color: #4da6ff; }
      .nav a:hover { background: #4da6ff; color: #000; }
      .generated { color: #555; border-color: #2a2a2a; }
    }
  </style>
</head>
<body>
  <h1>My Audible Library</h1>
  <p class="subtitle">Sorted A–Z &middot; ${books.length} audiobooks &middot; No JavaScript required</p>
  <nav class="nav" aria-label="Other formats">
    <a href="./#/library">Interactive view</a>
    <a href="./library.json">JSON data</a>
    <a href="./llms.txt">llms.txt</a>
    <a href="./llms-full.txt">llms-full.txt</a>
  </nav>
  <div class="stats" aria-label="Library statistics">
    <span>${books.length} total</span>
    <span>${finished} finished</span>
    <span>${inProgress} in&nbsp;progress</span>
    <span>${books.length - finished - inProgress} not&nbsp;started</span>
    ${rated ? `<span>${rated} rated</span>` : ''}
  </div>
  <main id="library" aria-label="Book list">
${bookCards}
  </main>
  <p class="generated">Generated ${today}</p>
</body>
</html>`;

fs.writeFileSync(path.join(repoRoot, 'library-list.html'), html);
console.log('Generated library-list.html');

// ── 4. Patch index.html (CI workspace only, never committed) ──────────────────
// Adds a <link rel="alternate"> discovery tag and upgrades the bare <noscript>
// with a link to library-list.html so non-JS visitors and crawlers aren't
// stranded on a blank page.

const indexPath = path.join(repoRoot, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

const altLink = '<link rel="alternate" type="text/html" href="./library-list.html" title="Browse without JavaScript">';
const betterNoscript = '<noscript><p style="font-family:sans-serif;padding:2rem">JavaScript is required for the interactive view. <a href="./library-list.html">Browse the library without JavaScript →</a></p></noscript>';

let indexPatched = false;

if (!indexHtml.includes('rel="alternate"')) {
  indexHtml = indexHtml.replace('</head>', `${altLink}</head>`);
  indexPatched = true;
}

if (indexHtml.includes('<noscript>This library requires javascript to work!</noscript>')) {
  indexHtml = indexHtml.replace(
    '<noscript>This library requires javascript to work!</noscript>',
    betterNoscript
  );
  indexPatched = true;
}

if (indexPatched) {
  fs.writeFileSync(indexPath, indexHtml);
  console.log('Patched index.html (alternate link + noscript)');
} else {
  console.log('index.html already patched, skipping');
}

// ── 5. sitemap.xml ────────────────────────────────────────────────────────────

const base = 'https://infracode-dev.github.io/Browse-Books';
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/library-list.html</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${base}/library.json</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${base}/llms.txt</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${base}/llms-full.txt</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>`;

fs.writeFileSync(path.join(repoRoot, 'sitemap.xml'), sitemap);
console.log('Generated sitemap.xml');

console.log('Done.');
