import { Replay } from './';

it('throws on creating multiple instances', function () {
  expect(() => {
    new Replay();
    new Replay();
  }).toThrow();
});
