// @ts-check
import { Sen } from 'sen-ether-client';
import { waitForCounter } from './stl.mjs';

const sen = await Sen.connect();

try {
  const counters = await sen.interest('SELECT demo.Counter FROM demo.devices');
  const counter = await waitForCounter(counters, 'counter-1');

  console.log('snapshot:', counter.snapshot);
  counter.on('change:count', ({ value }) => console.log('count:', value));
  counter.on('limitReached', ({ args }) => console.log('limit:', args[0]));

  await new Promise(resolve => process.once('SIGINT', resolve));
} finally {
  await sen.close();
}
