// Step `insert_incident { ip, type }`: queues an incident through the student program (`add --ip ... --type ...`)
// and keeps incidenty.txt in the scenario workdir. It replaces `insertIncident` of the old hand-written test project.
import { definePlugin, runSetup, z } from './support.js';

const params = z.strictObject({ ip: z.string().min(1), type: z.string().min(1).default('unknown') });

export default definePlugin(
  (app) => {
    app.step('insert_incident', {
      description: 'Setup: queues an incident by running `add --ip IP --type TYPE` of the student program in the scenario workdir.',
      example: '- insert_incident: { ip: 192.168.10.1, type: ddos }',
      params,
      async run(ctx, p) {
        const { ip, type } = ctx.interpolate(p);
        await runSetup(ctx, 'insert_incident', ['add', '--ip', ip, '--type', type], 'incidenty.txt');
      },
    });
  },
  { name: 'sentinel-insert-incident' },
);
