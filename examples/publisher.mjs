import { Sen } from 'sen-ether-client';

const types = await Sen.loadStl(new URL('./stl', import.meta.url).pathname);
const sen = await Sen.connect({ session: 'demo', announceDiscovery: true, types });

try {
  let counter;
  counter = await sen.publish('devices', {
    name: 'counter-1',
    className: 'demo.Counter',
    properties: { count: 0 },
    methods: {
      async increment(delta) {
        const count = counter.snapshot.count + delta;
        await counter.update({ count });
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
