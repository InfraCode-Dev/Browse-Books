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

// ── load data ─────────────────────────────────────────────────────────────────

const dataFiles  = fs.readdirSync(dataDir);
const libraryFile = dataFiles.find(f => /^library\.\d+\.js$/.test(f));
if (!libraryFile) { console.error('No library.*.js file found in data/'); process.exit(1); }

const books      = parseJsDataFile(path.join(dataDir, libraryFile), 'libraryJSON').map(normalizeBook);
const today      = new Date().toISOString().split('T')[0];
const sortedBooks = [...books].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

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
  blurb:      b.blurb    || null,
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
  if (book.blurb)    fullTxt += `- Description: ${book.blurb}\n`;
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
      </p>${book.blurb
        ? `\n      <p class="blurb">${escapeHtml(book.blurb)}</p>`
        : ''}
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
    .generated { text-align: center; font-size: 0.75rem; color: #aaa; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; }
    @media (max-width: 480px) { .book { grid-template-columns: 60px 1fr; } .cover { width: 60px; height: 60px; } }
    @media (prefers-color-scheme: dark) {
      .stats { background: #1a1a1a; color: #aaa; }
      .meta, .subtitle, .subtitle { color: #888; }
      .blurb { color: #bbb; }
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

console.log('Done.');
