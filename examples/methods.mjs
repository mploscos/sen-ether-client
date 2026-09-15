// @ts-check
import { Sen } from 'sen-ether-client';
import { waitForCounter } from './stl.mjs';

const sen = await Sen.connect();

try {
  const counters = await sen.interest('SELECT demo.Counter FROM demo.devices');
  const counter = await waitForCounter(counters, 'counter-1');
  console.log('increment returned:', await counter.call('increment', [1]));
} finally {
  await sen.close();
}
