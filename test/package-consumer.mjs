import {
  Sen,
  SenInterest,
  SenPublishedObject,
  SenRemoteObject
} from 'sen-ether-client';

for (const exportedClass of [Sen, SenInterest, SenPublishedObject, SenRemoteObject]) {
  if (typeof exportedClass !== 'function') {
    throw new TypeError('main package export is missing');
  }
}

const rprTypes = await Sen.loadRprFom();
if (!rprTypes.has('rpr.PhysicalEntity')) {
  throw new TypeError('bundled RPR FOM is missing PhysicalEntity');
}
