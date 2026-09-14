import { Sen } from 'sen-ether-client';

const sen = await Sen.connect();

try {
  const counters = await sen.interest('SELECT demo.Counter FROM demo.devices');
  const counter = await counters.waitFor('counter-1');
  console.log('increment returned:', await counter.call('increment', [1]));
} finally {
  await sen.close();
}
