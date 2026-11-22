import { chromium } from 'playwright';

export function launchChrome() {
  const executablePath = process.env.PUNCHLIST_CHROME_PATH || '/usr/bin/google-chrome';
  return chromium.launch({ executablePath });
}
