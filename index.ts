import fs from 'fs';
import { sleep } from './utils/sleep';
import { askChatGPT } from './services/chatGPTclient';
import { webSocketServer } from './server/webSocketServer';

const questions: string[] = JSON.parse(
  fs.readFileSync('./bingo_prompts_all.json', 'utf-8')
);

(async () => {
  fs.writeFileSync('answers.txt', ''); // reset file

  await webSocketServer.waitForConnection();
  console.log('Browser connected – starting batch');

  let count = 0;

  for (const q of questions) {
    count += 1;
    console.log(`\n[${count}/${questions.length}]`);

    const raw = await askChatGPT(q);

    // grab the first JSON-array found (fallback: whole reply)
    const match = raw.match(/\[[\s\S]*?\]/);
    const extracted = match ? match[0] : raw.trim();

    console.log('  ↳', extracted);
    fs.appendFileSync('answers.txt', extracted + '\n');

    if (count < questions.length) {
      const delay = 8_000 + Math.random() * 7_000; // 8–15 s
      console.log(`  …waiting ${(delay / 1000).toFixed(1)} s`);
      await sleep(delay);
    }
  }

  console.log('\nBatch complete – answers saved to answers.txt');
})();