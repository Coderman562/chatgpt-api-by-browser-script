import fs from 'fs';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { ChartConfiguration } from 'chart.js';

const canvas = new ChartJSNodeCanvas({ width: 600, height: 300 });

export async function writeChart(durations: number[], file = 'response-times.png'): Promise<void> {
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
  fs.writeFileSync(file, image);
}
