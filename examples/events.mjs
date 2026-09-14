import { Sen } from 'sen-ether-client';

const types = await Sen.loadStl(new URL('./stl', import.meta.url).pathname);
const sen = await Sen.connect({ session: 'demo', announceDiscovery: true, types });

try {
  const counter = await sen.publish('devices', {
    name: 'event-counter',
    className: 'demo.Counter',
    properties: { count: 10 }
  });

  await counter.emit('limitReached', [10]);
  console.log('Emitted limitReached.');
} finally {
  await sen.close();
}
