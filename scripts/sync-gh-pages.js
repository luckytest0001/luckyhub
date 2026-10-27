import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const distAssetsDir = path.join(distDir, 'assets');
const rootAssetsDir = path.join(rootDir, 'assets');
const distIndexHtml = path.join(distDir, 'index.html');
const rootIndexHtml = path.join(rootDir, 'index.html');
const dist404Html = path.join(distDir, '404.html');
const root404Html = path.join(rootDir, '404.html');

console.log('🔄 Syncing GitHub Pages deployment files...');

// 1. Sync assets folder
if (fs.existsSync(distAssetsDir)) {
  fs.mkdirSync(rootAssetsDir, { recursive: true });
  // Clean old root assets
  for (const oldFile of fs.readdirSync(rootAssetsDir)) {
    try {
      fs.rmSync(path.join(rootAssetsDir, oldFile), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // Copy new assets
  fs.cpSync(distAssetsDir, rootAssetsDir, { recursive: true });
  console.log('✅ Synced dist/assets -> root assets/');
}

// 2. Sync index.html and 404.html with relative asset paths for universal GitHub Pages hosting
if (fs.existsSync(distIndexHtml)) {
  let html = fs.readFileSync(distIndexHtml, 'utf8');
  // Ensure all asset paths are relative (./assets/...) so they load properly under any repository subpath
  html = html.replace(/(?:src|href)=["'](?:\/[^"'/]+)?\/assets\//g, (match) => {
    return match.startsWith('src') ? 'src="./assets/' : 'href="./assets/';
  });

  fs.writeFileSync(distIndexHtml, html, 'utf8');
  fs.writeFileSync(rootIndexHtml, html, 'utf8');
  fs.writeFileSync(dist404Html, html, 'utf8');
  fs.writeFileSync(root404Html, html, 'utf8');
  console.log('✅ Synced index.html and generated 404.html with relative ./assets paths in root and dist/');
}

// 3. Ensure .nojekyll in root and dist so GitHub Pages Jekyll does not ignore assets
const nojekyllContent = '# Disable Jekyll processing on GitHub Pages\n';
fs.writeFileSync(path.join(rootDir, '.nojekyll'), nojekyllContent, 'utf8');
fs.writeFileSync(path.join(distDir, '.nojekyll'), nojekyllContent, 'utf8');
console.log('✅ Verified .nojekyll in root and dist/');

// 4. Ensure cloudflare-worker.js is present in both root and dist
const rootWorker = path.join(rootDir, 'cloudflare-worker.js');
const distWorker = path.join(distDir, 'cloudflare-worker.js');
if (fs.existsSync(rootWorker) && fs.existsSync(distDir)) {
  fs.copyFileSync(rootWorker, distWorker);
  console.log('✅ Synced cloudflare-worker.js to dist/');
}

console.log('🎉 GitHub Pages deployment files successfully prepared!');
