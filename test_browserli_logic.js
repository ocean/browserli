// Simulate the browserli data-import endpoint logic

async function testDataImport() {
  const url = 'https://www.google.com/collections/s/list/1kYZv2veQuDDbrE7-WeHrOirFMuo/N25VG9BUeoY';
  const wsEndpoint = 'ws://localhost:59012/b883efe81396b5765a7825e55faed719';
  
  console.log('Testing browserli import logic...');
  console.log('URL:', url);
  console.log('WS Endpoint:', wsEndpoint);
  
  try {
    // This is what the handler does
    const { chromium } = await import('playwright');
    console.log('✓ Imported playwright');
    
    const browser = await chromium.connect(wsEndpoint);
    console.log('✓ Connected to browser');
    
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log('✓ Created page');
    
    console.log('Navigating to:', url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✓ Page loaded');
    
    // Check what we got
    const title = await page.title();
    console.log('Page title:', title);
    
    await browser.close();
    console.log('✓ Test successful!');
    
  } catch (error) {
    console.error('✗ Test failed:', error.message);
  }
}

testDataImport();
