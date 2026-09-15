// @ts-check
import { Sen } from 'sen-ether-client';
import { publishCounter } from './stl.mjs';

import path from 'path';

const types = await Sen.loadStl(path.join(process.cwd(), './stl'));
const sen = await Sen.connect({ session: 'demo', announceDiscovery: true, types });

try {
  const counter = await publishCounter(sen, 'devices', {
    name: 'event-counter',
    className: 'demo.Counter',
    properties: { count: 10 }
  });

  await counter.emit('limitReached', [10]);
  console.log('Emitted limitReached.');
} finally {
  await sen.close();
}
