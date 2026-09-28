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
