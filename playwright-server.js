#!/usr/bin/env node

/**
 * Local Playwright Server
 * 
 * Starts a Playwright server on a fixed port (3000) for local development.
 * 
 * Usage: node playwright-server.js
 * 
 * The WebSocket endpoint will be: ws://localhost:3000/[token]
 * Update .env.local with: PLAYWRIGHT_SERVER_URL=ws://localhost:3000/[token]
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_PORT = 3000;
const HTTP_PORT = 3001;

// Store active pages keyed by sessionId
const activeSessions = new Map();

async function startServer() {
  console.log('🎭 Starting Playwright server...');
  
  try {
    const server = await chromium.launchServer({
      port: FIXED_PORT,
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    const wsEndpoint = server.wsEndpoint();
    
    // Also start HTTP API server for Worker-friendly proxy
    startHttpApiServer(server);
    
    console.log('');
    console.log('✅ Playwright server started');
    console.log(`📡 WebSocket endpoint: ${wsEndpoint}`);
    console.log('');
    console.log('⚠️  Update .env.local with:');
    console.log(`PLAYWRIGHT_SERVER_URL=${wsEndpoint}`);
    console.log('');
    console.log('Then restart wrangler dev:');
    console.log('npm run wrangler:dev');
    console.log('');
    console.log('Press Ctrl+C to stop the server');
    console.log('');

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log('\n');
      console.log('🛑 Shutting down Playwright server...');
      await server.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (error) {
    console.error('❌ Failed to start Playwright server:', error);
    process.exit(1);
  }
}

function startHttpApiServer(playwrightServer) {
  const httpServer = createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Collect request body
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        let data = {};
        if (body) {
          data = JSON.parse(body);
        }

        if (pathname === '/api/page/goto') {
          const sessionId = data.sessionId || `session-${Date.now()}`;
          
          if (!activeSessions.has(sessionId)) {
            const browser = await chromium.connect(playwrightServer.wsEndpoint());
            const context = await browser.newContext();
            const page = await context.newPage();
            activeSessions.set(sessionId, { browser, context, page });
          }

          const { page } = activeSessions.get(sessionId);
          await page.goto(data.url, data.options || {});

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, sessionId }));
        } else if (pathname === '/api/page/evaluate') {
          const sessionId = data.sessionId || `session-${Date.now()}`;
          
          if (!activeSessions.has(sessionId)) {
            const browser = await chromium.connect(playwrightServer.wsEndpoint());
            const context = await browser.newContext();
            const page = await context.newPage();
            activeSessions.set(sessionId, { browser, context, page });
          }

          const { page } = activeSessions.get(sessionId);
          const result = await page.evaluate(eval(`(${data.script})`));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result, sessionId }));
        } else if (pathname === '/api/page/close') {
          const sessionId = data.sessionId;
          if (sessionId && activeSessions.has(sessionId)) {
            const { browser, context, page } = activeSessions.get(sessionId);
            await page.close();
            await context.close();
            await browser.close();
            activeSessions.delete(sessionId);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (error) {
        console.error('[HTTP API] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`📡 HTTP API server listening on http://localhost:${HTTP_PORT}`);
  });
}

startServer();
