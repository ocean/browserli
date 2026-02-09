#!/usr/bin/env node

/**
 * Update .env.local with the Playwright server endpoint
 * 
 * Usage: node update-env.js <endpoint_url>
 * Example: node update-env.js "ws://localhost:63885/dafcefb27ee882c157f0edb564345bcf"
 */

import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';

const endpointUrl = process.argv[2];

if (!endpointUrl) {
  console.error('❌ Error: endpoint URL is required');
  console.error('Usage: node update-env.js <endpoint_url>');
  process.exit(1);
}

const envFile = '.env.local';

// Read existing .env.local or create empty
let envContent = '';
if (existsSync(envFile)) {
  envContent = readFileSync(envFile, 'utf-8');
}

// Update or add PLAYWRIGHT_SERVER_URL
const lines = envContent.split('\n');
const playgroundLineIndex = lines.findIndex(line => line.startsWith('PLAYWRIGHT_SERVER_URL='));

if (playgroundLineIndex >= 0) {
  // Update existing line
  lines[playgroundLineIndex] = `PLAYWRIGHT_SERVER_URL=${endpointUrl}`;
} else {
  // Add new line
  lines.push(`PLAYWRIGHT_SERVER_URL=${endpointUrl}`);
}

// Write back
const updatedContent = lines.filter(line => line.trim()).join('\n') + '\n';
writeFileSync(envFile, updatedContent);

console.log(`✅ Updated .env.local`);
console.log(`📝 PLAYWRIGHT_SERVER_URL=${endpointUrl}`);
console.log('');
console.log('⚠️  Restart wrangler dev for the change to take effect:');
console.log('   npm run wrangler:dev');
