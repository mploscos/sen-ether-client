// @ts-check
import { Sen } from 'sen-ether-client';
import { publishCounter } from './stl.mjs';
import path from 'path';

const types = await Sen.loadStl(path.join(process.cwd(), './stl'));
const sen = await Sen.connect({ session: 'demo', announceDiscovery: true, types });

try {
  const counter = await publishCounter(sen, 'devices', {
    name: 'counter-1',
    className: 'demo.Counter',
    properties: { count: 0 },
    methods: {
      async increment(delta) {
        const count = this.state.count + delta;
        await this.update({ count });
        return count;
      }
    }
  });

  await counter.update({ count: 1 });
  console.log('Published counter-1. Press Ctrl+C to stop.');
  await new Promise(resolve => process.once('SIGINT', resolve));
} finally {
  await sen.close();
}
