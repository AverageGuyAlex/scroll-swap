// Syntax-check every inline <script> block in the app's pages.
const fs = require('fs');
const path = require('path');

const DIR = 'C:/Users/gamer/OneDrive/Dokumenter/claude code/scroll-swap-main';
const PAGES = ['index', 'dashboard', 'pomodoro', 'diary', 'todo', 'goals', 'lock-in', 'settings'];

let failures = 0;
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(DIR, page + '.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  blocks.forEach((m, i) => {
    try {
      new Function(m[1]);
      console.log(`  ok   ${page}.html  block#${i}  (${m[1].length} chars)`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${page}.html  block#${i}: ${e.message}`);
    }
  });
}
console.log(failures === 0 ? '\nAll inline scripts parse cleanly.' : `\n${failures} SYNTAX FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
