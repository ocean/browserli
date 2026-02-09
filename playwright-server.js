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
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_PORT = 3000;

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

startServer();
