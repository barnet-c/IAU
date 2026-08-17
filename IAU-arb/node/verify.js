#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Unexpected status ${res.statusCode}: ${body}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

async function waitForServer(port, attempts) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await requestJson(`http://127.0.0.1:${port}/api/state`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function main() {
  const port = await getFreePort();
  const appPath = path.join(__dirname, 'dist', 'dashboard.js');
  if (!fs.existsSync(appPath)) {
    throw new Error('dist/dashboard.js missing — run npm run build first');
  }

  const tradeLogPath = path.join(__dirname, 'dist', 'trades.csv');
  const child = spawn(process.execPath, [appPath, '--dry-run', '--port', String(port)], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISCORD_TOKEN: '' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const state = await waitForServer(port, 40);
    if (!state || typeof state.signal !== 'string') {
      throw new Error('Smoke test failed: /api/state payload was invalid');
    }
    if (!('btcPerShare' in state) || !('premBps' in state)) {
      throw new Error('Smoke test failed: snapshot missing required fields');
    }
    const health = await requestJson(`http://127.0.0.1:${port}/api/health`);
    if (!health.ok) throw new Error('health check failed');
    const cfg = await requestJson(`http://127.0.0.1:${port}/api/config`);
    if (!cfg.etf || !cfg.etf.creationUnitShares) throw new Error('config endpoint invalid');

    console.log(`Verified packaged dashboard at http://127.0.0.1:${port}`);
    console.log(`  signal=${state.signal} btcPerShare=${state.btcPerShare}`);
  } catch (error) {
    console.error(stdout.trim());
    console.error(stderr.trim());
    throw error;
  } finally {
    child.kill('SIGINT');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
    });
    if (fs.existsSync(tradeLogPath)) fs.rmSync(tradeLogPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
