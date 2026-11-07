import { resolveTestBrowser } from './default-test-browser.mjs';
try {
  const browser=await resolveTestBrowser();
  console.log(`Selected browser: ${browser.name}\nSelection: ${browser.source}\nAutomation: ${browser.engine==='firefox'?'WebDriver BiDi':'Chrome DevTools Protocol'}\nExecutable: ${browser.executable}\nNo browser was launched.`);
} catch(error) {console.error(error.message);process.exitCode=1;}
