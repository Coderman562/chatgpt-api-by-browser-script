import fs from 'fs';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration } from 'chart.js';
import { sleep } from './utils/sleep';
import { type ChatGPTResponse } from './services/chatGPTclient';
import { askWithReconnect } from './services/askWithReconnect';
import { webSocketServer } from './server/webSocketServer';

const durations: number[] = [];

const canvas = new ChartJSNodeCanvas({ width: 600, height: 300 });
async function writeChart() {
  const config: ChartConfiguration = {
    type: 'line',
    data: {
      labels: durations.map((_, i) => i + 1),
      datasets: [
        {
          label: 'Time (ms)',
          data: durations,
          borderColor: 'blue',
          fill: false
        }
      ]
    },
    options: {
      scales: {
        x: { title: { display: true, text: 'request' } },
        y: { title: { display: true, text: 'ms' } }
      }
    }
  };

  const image = await canvas.renderToBuffer(config);
  fs.writeFileSync('response-times.png', image);
}

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

    const newChat = count % 50 === 1;
    const start = Date.now();
    const resp: ChatGPTResponse = await askWithReconnect(q, newChat);
    const elapsed = Date.now() - start;
    durations.push(elapsed);
    await writeChart();
    const raw = resp.text;

    // grab the first JSON-array found (fallback: whole reply)
    const match = raw.match(/\[[\s\S]*?\]/);
    const extracted = match ? match[0] : raw.trim();
    const oneLine = extracted.replace(/\s*\n+\s*/g, ' ').trim();

    console.log('  ↳', oneLine, `(model: ${resp.the_model}, ${elapsed} ms)`);
    fs.appendFileSync('answers.txt', oneLine + `\t${resp.the_model}\n`);

    if (count < questions.length) {
      const delay = 8_000 + Math.random() * 7_000; // 8–15 s
      console.log(`  …waiting ${(delay / 1000).toFixed(1)} s`);
      await sleep(delay);
    }
  }

console.log('\nBatch complete – answers saved to answers.txt');
console.log('Response times chart written to response-times.png');
})();
