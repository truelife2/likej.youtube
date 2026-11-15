// 開發輔助：檢查 popup.js 用到的元素 id 是否都存在於 popup.html
const fs = require('fs');
const js = fs.readFileSync('popup.js', 'utf8');
const html = fs.readFileSync('popup.html', 'utf8');
const used = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [...new Set(used)].filter((x) => !defined.has(x));
console.log('ids used:', new Set(used).size);
console.log('missing:', missing.length ? missing.join(', ') : 'none');
