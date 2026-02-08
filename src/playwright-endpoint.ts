/**
 * Playwright Endpoint Discovery
 * 
 * Reads the WebSocket endpoint from .playwright-endpoint.json
 * created by the local Playwright server.
 * 
 * This allows Placemake and Browserli to auto-discover the server.
 */

import { readFileSync } from "fs";
import { join } from "path";

interface EndpointData {
  url: string;
  timestamp: string;
  pid: number;
}

/**
 * Get the Playwright server endpoint from the endpoint file
 * Returns null if the file doesn't exist (running in production)
 */
export function getPlaywrightEndpoint(): string | null {
  try {
    // Try to read from the root directory (where playwright-server.js runs)
    const endpointFile = join(process.cwd(), ".playwright-endpoint.json");
    const data = readFileSync(endpointFile, "utf-8");
    const endpoint = JSON.parse(data) as EndpointData;
    return endpoint.url;
  } catch (error) {
    // File doesn't exist (production) or is invalid
    return null;
  }
}

/**
 * Check if the local Playwright server is running
 */
export function isLocalPlaywrightAvailable(): boolean {
  return getPlaywrightEndpoint() !== null;
}
