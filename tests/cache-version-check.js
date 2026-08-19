/* Guard for the ?v= cache-busting version.
 *
 * netlify.toml serves /css/* and /js/* with `max-age=31536000, immutable`, so a
 * browser that has rotulus.css?v=6 will never ask for it again. The only thing
 * that gets a user onto a new copy is bumping the ?v= number in every page that
 * links it. Forget the bump and people sit on stale CSS for a year — this test
 * makes that impossible to ship quietly.
 *
 * It checks two things:
 *   1. every page agrees on one version number (a partial bump across seven
 *      files is the easy mistake here)
 *   2. neither shared file has changed content since the last recorded version
 *      without that number going up
 *
 * tests/asset-versions.json records what was last shipped. This folder has no
 * .git, so a recorded hash — not a git diff — is what makes the check work.
 *
 * When the version was correctly bumped the record updates itself and says so,
 * so the guard can never go stale behind your back. Commit the updated JSON
 * along with the change. `--update` forces a re-record by hand.
 *
 *   node tests/cache-version-check.js
 *   node tests/cache-version-check.js --update
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Derived from this file's own location rather than hardcoded, because the
   deploy flow runs the tests from a fresh clone in a temp folder. */
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'asset-versions.json');

const WATCHED = {
  css: { file: 'css/rotulus.css', link: '/css/rotulus.css' },
  js: { file: 'js/rotulus-shared.js', link: '/js/rotulus-shared.js' },
};

const forceUpdate = process.argv.includes('--update');
const problems = [];

/* Hash the CONTENT, not the raw bytes. The GitHub repo stores css/js as CRLF
   while the working copy here is LF, so a byte-level hash of identical content
   differs between the two and the recorded manifest could never be valid in
   both places — the guard would fail on every deploy from a fresh clone. What
   this test actually cares about is whether the file changed, and a line-ending
   difference is not a change worth forcing a ?v= bump for. */
function sha256(relPath) {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const normalised = text.split(CR + LF).join(LF);
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

// ---- 1. Every page must agree on one version number ----

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const seen = new Map(); // version -> [ "page.html (css)", ... ]
let linkingPages = 0;

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const found = {};

  for (const [key, spec] of Object.entries(WATCHED)) {
    /* Plain string search rather than a built regex: the link paths contain
       dots, and hand-escaping them is exactly the kind of fiddly detail this
       test exists to stop anyone getting wrong. */
    const marker = spec.link + '?v=';
    const at = html.indexOf(marker);
    if (at !== -1) {
      const digits = html.slice(at + marker.length).match(/^[0-9]+/);
      if (digits) found[key] = Number(digits[0]);
    }
  }

  const keys = Object.keys(found);
  if (keys.length === 0) continue; // lock-in.html deliberately loads neither
  linkingPages++;

  if (keys.length !== Object.keys(WATCHED).length) {
    problems.push(`${page} links ${keys.join(' and ')} but not the other — pages should load both or neither.`);
  }
  for (const [key, version] of Object.entries(found)) {
    if (!seen.has(version)) seen.set(version, []);
    seen.get(version).push(`${page} (${key})`);
  }
}

if (linkingPages === 0) {
  problems.push('No page links rotulus.css or rotulus-shared.js — did the paths change?');
}

if (seen.size > 1) {
  const detail = [...seen.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([v, where]) => `      ?v=${v}  <-  ${where.join(', ')}`)
    .join('\n');
  problems.push(
    'Pages disagree on the version number. Every page must use the same one:\n' + detail
  );
}

const version = seen.size === 1 ? [...seen.keys()][0] : null;

// ---- 2. Content must not change without the number going up ----

const current = { version, css: sha256(WATCHED.css.file), js: sha256(WATCHED.js.file) };

let record = null;
try {
  record = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  // Missing or unreadable: treated as first run below.
}

function writeRecord(why) {
  fs.writeFileSync(MANIFEST, JSON.stringify(current, null, 2) + '\n');
  console.log(`  recorded ?v=${current.version} in tests/asset-versions.json (${why})`);
  console.log('  commit that file along with your change.');
}

if (problems.length === 0 && version !== null) {
  const changed = Object.keys(WATCHED).filter(k => !record || record[k] !== current[k]);

  if (!record) {
    console.log('  no previous record found — initialising.');
    writeRecord('first run');
  } else if (forceUpdate) {
    writeRecord('--update');
  } else if (changed.length === 0) {
    if (version !== record.version) writeRecord('version bumped, content unchanged');
    console.log(`  ok   nothing changed in the shared files (still ?v=${version})`);
  } else if (version > record.version) {
    console.log(`  ok   ${changed.map(k => WATCHED[k].file).join(' and ')} changed, and ?v= went ${record.version} -> ${version}`);
    writeRecord('version bumped correctly');
  } else {
    problems.push(
      `${changed.map(k => WATCHED[k].file).join(' and ')} changed, but ?v= is still ${version}.\n` +
      '      Because /css/* and /js/* are cached for a year, anyone who already\n' +
      '      loaded the site would keep the OLD copy and never see this change.\n' +
      `      Fix: change ?v=${version} to ?v=${version + 1} on BOTH the <link> and <script>\n` +
      `      lines in all ${linkingPages} pages that load them, then re-run this test.`
    );
  }
}

// ---- Report ----

if (problems.length === 0) {
  console.log('\nCache version check passed.');
  process.exit(0);
}
console.log('');
problems.forEach(p => console.log(`  FAIL ${p}`));
console.log(`\n${problems.length} CACHE VERSION FAILURE(S)`);
process.exit(1);
