// Step `insert_device { name, ip }`: registers a device through the student program (`new --name ... --ip ...`)
// and keeps zariadenia.txt in the scenario workdir. It replaces `insertDevice` of the old hand-written test project.
import { definePlugin, runSetup, z } from './support.js';

const params = z.strictObject({ name: z.string().min(1), ip: z.string().min(1) });

export default definePlugin(
  (app) => {
    app.step('insert_device', {
      description: 'Setup: adds a device by running `new --name NAME --ip IP` of the student program in the scenario workdir.',
      example: '- insert_device: { name: PC, ip: 192.168.10.1 }',
      params,
      async run(ctx, p) {
        const { name, ip } = ctx.interpolate(p);
        await runSetup(ctx, 'insert_device', ['new', '--name', name, '--ip', ip], 'zariadenia.txt');
      },
    });
  },
  { name: 'sentinel-insert-device' },
);
