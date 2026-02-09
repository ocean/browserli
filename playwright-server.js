#!/usr/bin/env node

/**
 * Local Playwright Server
 * 
 * Starts a Playwright server for local development.
 * Writes the WebSocket endpoint to .playwright-endpoint.json
 * so that both Browserli and Placemake can auto-discover it.
 * 
 * Usage: node playwright-server.js
 * 
 * Creates: .playwright-endpoint.json with the actual WebSocket URL
 */

import { chromium } from 'playwright';
import { writeFileSync, execSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENDPOINT_FILE = `${__dirname}/.playwright-endpoint.json`;

async function startServer() {
  console.log('🎭 Starting Playwright server...');
  
  try {
    const server = await chromium.launchServer({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    const wsEndpoint = server.wsEndpoint();
    
    // Write endpoint to file for auto-discovery
    const endpointData = {
      url: wsEndpoint,
      timestamp: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(ENDPOINT_FILE, JSON.stringify(endpointData, null, 2));
    
    console.log('');
    console.log('✅ Playwright server started');
    console.log(`📡 WebSocket endpoint: ${wsEndpoint}`);
    console.log(`📝 Endpoint file: ${ENDPOINT_FILE}`);
    console.log('');
    
    // Update .env.local with the endpoint
    try {
      execSync(`node update-env.js "${wsEndpoint}"`, { cwd: __dirname, stdio: 'inherit' });
    } catch (error) {
      console.error('⚠️  Failed to update .env.local automatically');
      console.error('Please manually update .env.local with:');
      console.error(`PLAYWRIGHT_SERVER_URL=${wsEndpoint}`);
    }
    
    console.log('');
    console.log('Press Ctrl+C to stop the server');
    console.log('');

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log('\n');
      console.log('🛑 Shutting down Playwright server...');
      try {
        // Remove endpoint file
        const fs = await import('fs');
        fs.unlinkSync(ENDPOINT_FILE);
      } catch (e) {
        // File might already be deleted
      }
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
