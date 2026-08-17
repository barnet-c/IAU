#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');

const requiredFilesToCopy = [
  ['README.md', 'README.md'],
  ['analyze.js', 'analyze.js'],
  ['dashboard.js', 'dashboard.js'],
  ['monitor.js', 'monitor.js'],
  ['verify.js', 'verify.js'],
  ['config.json', 'config.json'],
  ['config.json', 'public/config.json'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['staticwebapp.config.json', 'staticwebapp.config.json'],
  ['public/index.html', 'index.html'],
  ['public/index.html', 'public/index.html'],
  ['public/app.js', 'app.js'],
  ['public/app.js', 'public/app.js'],
  ['public/config.json', 'config.json'],
  ['public/openexa_logo.webp', 'openexa_logo.webp'],
  ['public/openexa_logo.webp', 'public/openexa_logo.webp'],
  ['lib/utils.js', 'lib/utils.js'],
  ['lib/discord.js', 'lib/discord.js'],
  ['.env.example', '.env.example'],
];

const optionalFilesToCopy = [
  ['DEPLOYMENT.md', 'DEPLOYMENT.md'],
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(fromRelativePath, toRelativePath) {
  const sourcePath = path.join(rootDir, fromRelativePath);
  const targetPath = path.join(distDir, toRelativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required build input: ${fromRelativePath}`);
  }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function copyFileIfPresent(fromRelativePath, toRelativePath) {
  const sourcePath = path.join(rootDir, fromRelativePath);
  if (!fs.existsSync(sourcePath)) return;
  const targetPath = path.join(distDir, toRelativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function cleanDist() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(distDir);
}

function verifyDistManifest() {
  const requiredDistFiles = [
    'index.html',
    'app.js',
    'public/index.html',
    'public/app.js',
    'openexa_logo.webp',
    'public/openexa_logo.webp',
    'staticwebapp.config.json',
    'config.json',
    'dashboard.js',
    'monitor.js',
    'analyze.js',
    'verify.js',
    'lib/utils.js',
    'lib/discord.js',
    'package.json',
    'package-lock.json',
    '.env.example',
  ];

  const missing = requiredDistFiles.filter((relativePath) => {
    return !fs.existsSync(path.join(distDir, relativePath));
  });

  if (missing.length > 0) {
    throw new Error(`Build output is missing required files: ${missing.join(', ')}`);
  }
}

function main() {
  // Keep public/config.json in sync with root config for static hosting
  fs.copyFileSync(path.join(rootDir, 'config.json'), path.join(rootDir, 'public', 'config.json'));

  // public/ is what Azure Static Web Apps deploys (app_location), so the
  // routing + mime config has to live there too or it is silently dropped
  fs.copyFileSync(
    path.join(rootDir, 'staticwebapp.config.json'),
    path.join(rootDir, 'public', 'staticwebapp.config.json')
  );

  cleanDist();
  for (const [fromRelativePath, toRelativePath] of requiredFilesToCopy) {
    copyFile(fromRelativePath, toRelativePath);
  }
  for (const [fromRelativePath, toRelativePath] of optionalFilesToCopy) {
    copyFileIfPresent(fromRelativePath, toRelativePath);
  }
  verifyDistManifest();
  console.log(`Built dist at ${distDir}`);
}

main();
