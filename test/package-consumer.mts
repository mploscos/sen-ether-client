import {
  Sen,
  SenInterest,
  SenPublishedObject,
  SenRemoteObject,
  type SenChange,
  type SenConnectOptions,
  type SenRuntimeEvent
} from 'sen-ether-client';

const options: SenConnectOptions = {
  multicastDiscovery: false,
  methodTimeout: 30_000,
  resourceLimits: { maxFrameSize: 8 * 1024 * 1024 }
};

async function consume(sen: Sen): Promise<void> {
  const interest: SenInterest = await sen.interest('SELECT * FROM session.bus');
  const object: SenRemoteObject = await interest.waitFor('object-name');
  object.on('change:value', (change: SenChange) => console.log(change.value));
  object.on('event', (event: SenRuntimeEvent) => console.log(event.raw));
  await object.set('selected', true, { timeout: 30_000 });
  const result: unknown = await object.call('reset', [], { timeout: 0 });
  void result;

  const published: SenPublishedObject = await sen.publish('session.bus', {
    name: 'typescript-object',
    className: 'Example',
    properties: { selected: false }
  });
  await published.update({ selected: true });
}

void options;
void consume;
