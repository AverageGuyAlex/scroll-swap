/* Guard for the Content-Security-Policy script hashes.
 *
 * netlify.toml sends a CSP whose script-src is a plain allow-list: this site's
 * own origin, identity.netlify.com for the login widget, and one sha256 hash
 * per inline <script> block. There is deliberately no 'unsafe-inline' — that
 * is what makes an injected onerror="" or <script> unable to run even if an
 * escaping bug ever slips past tests/escaping-test.js.
 *
 * The cost of that is bookkeeping: edit an inline script, and its hash changes.
 * Ship without regenerating and the browser refuses to run the page's own
 * script — a completely blank app, for everyone, until the next deploy. This
 * test makes that impossible to do quietly. Same job as cache-version-check.js.
 *
 *   node tests/csp-hash-check.js            # verify
 *   node tests/csp-hash-check.js --update   # regenerate, then commit netlify.toml
 *
 * WHY EVERY BLOCK GETS TWO HASHES
 *
 * A CSP hash must match the bytes the browser actually received. This working
 * folder stores HTML as LF; the GitHub repo stores it as CRLF. A hash computed
 * in one place would not match what Netlify serves from the other, and the
 * failure mode is the site going blank rather than anything obvious. Rather
 * than trying to guess which form ships, both are listed. An unused hash costs
 * nothing but header bytes and weakens nothing — a hash only ever permits the
 * exact script it was computed from.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TOML = path.join(ROOT, 'netlify.toml');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const forceUpdate = process.argv.includes('--update');
const problems = [];

/* Matches an inline <script> — one with no src attribute. The same expression
   sync-test.js and escaping-test.js use to find a page's app script. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

function sha256b64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

// ---- 1. Collect the hashes every page needs ----

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const required = new Set();
const perPage = [];

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const blocks = [...html.matchAll(INLINE_SCRIPT)].map(m => m[1]);
  perPage.push({ page, count: blocks.length });
  for (const raw of blocks) {
    const lf = raw.split(CR + LF).join(LF);
    const crlf = lf.split(LF).join(CR + LF);
    required.add("'sha256-" + sha256b64(lf) + "'");
    required.add("'sha256-" + sha256b64(crlf) + "'");
  }
}

if (required.size === 0) {
  problems.push('No inline <script> blocks found in any page — did the pages move?');
}

// ---- 2. Compare against what netlify.toml actually sends ----

let toml = fs.readFileSync(TOML, 'utf8');
const cspLine = /(Content-Security-Policy = ")([^"]*)(")/.exec(toml);

if (!cspLine) {
  problems.push('No Content-Security-Policy line in netlify.toml. Without it every inline script runs unrestricted.');
} else {
  const policy = cspLine[2];
  const scriptSrc = /script-src ([^;]*)/.exec(policy);

  if (!scriptSrc) {
    problems.push('The CSP in netlify.toml has no script-src directive.');
  } else {
    const present = new Set(scriptSrc[1].trim().split(/\s+/).filter(t => t.startsWith("'sha256-")));

    if (forceUpdate) {
      /* Keep every non-hash source exactly as written — 'self', the widget's
         origin, anything added later — and swap only the hash list. */
      const keep = scriptSrc[1].trim().split(/\s+/).filter(t => !t.startsWith("'sha256-"));
      const rebuilt = 'script-src ' + keep.concat([...required].sort()).join(' ');
      const newPolicy = policy.replace(/script-src [^;]*/, rebuilt);
      toml = toml.replace(cspLine[0], cspLine[1] + newPolicy + cspLine[3]);
      fs.writeFileSync(TOML, toml);
      console.log(`  recorded ${required.size} script hashes in netlify.toml (--update)`);
      console.log('  commit netlify.toml along with your change.');
    } else {
      const missing = [...required].filter(h => !present.has(h));
      const extra = [...present].filter(h => !required.has(h));

      if (missing.length) {
        problems.push(
          `${missing.length} inline script(s) have no matching hash in the CSP.\n` +
          '      The browser would refuse to run them and the page would render blank.\n' +
          '      Fix: node tests/csp-hash-check.js --update  (then commit netlify.toml)\n' +
          '      Missing: ' + missing.slice(0, 4).join(' ') + (missing.length > 4 ? ' …' : '')
        );
      }
      if (extra.length) {
        problems.push(
          `${extra.length} hash(es) in the CSP no longer match any inline script.\n` +
          '      Harmless to visitors, but it means the list has drifted — a stale hash\n' +
          '      keeps permitting a script that no longer exists.\n' +
          '      Fix: node tests/csp-hash-check.js --update'
        );
      }
    }
  }

  /* 'unsafe-inline' would make every hash above pointless: browsers ignore it
     when hashes are present, but if it were ever added on its own, injected
     handlers would run again. Worth failing loudly on. */
  if (/script-src [^;]*'unsafe-inline'/.test(policy)) {
    problems.push("script-src contains 'unsafe-inline'. That defeats the hash list entirely — remove it.");
  }
  if (/script-src [^;]*'unsafe-eval'/.test(policy)) {
    problems.push("script-src contains 'unsafe-eval'. Nothing in Rotulus needs it.");
  }
}

// ---- Report ----

if (problems.length === 0) {
  const total = perPage.reduce((n, p) => n + p.count, 0);
  console.log(`\n  ok   ${total} inline script(s) across ${perPage.length} pages, ${required.size} hashes in the CSP`);
  console.log('CSP hash check passed.');
  process.exit(0);
}
console.log('');
problems.forEach(p => console.log(`  FAIL ${p}`));
console.log(`\n${problems.length} CSP HASH FAILURE(S)`);
process.exit(1);
