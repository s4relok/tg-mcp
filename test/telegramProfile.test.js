import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { createTelegramProfileService } from '../src/telegram/profileService.js';

const require = createRequire(import.meta.url);
const { Api } = require('telegram');
const fetchedAt = '2026-10-01T10:00:00.000Z';

function fixture(overrides = {}) {
  const state = { connections: 0, destroyed: 0, targets: [], requests: [] };
  const client = {
    async getInputEntity(target) {
      state.targets.push(target);
      return new Api.InputPeerUser({ userId: 123n, accessHash: 456n });
    },
    async invoke(request) {
      state.requests.push(request);
      return {
        fullUser: { id: 123n, about: 'Hello', commonChatsCount: 2, birthday: { day: 1, month: 10 } },
        users: [new Api.User({ id: 123n, firstName: 'Anna', username: 'anna', contact: true, phone: 'private', accessHash: 456n })]
      };
    },
    async destroy() { state.destroyed++; },
    ...overrides
  };
  const service = createTelegramProfileService({
    config: {}, now: () => new Date(fetchedAt),
    createClient: async () => { state.connections++; return client; }
  });
  return { service, state, client };
}

test('profile reads the full user, preserves absent birth year and excludes raw Telegram fields', async () => {
  const { service, state, client } = fixture();
  const result = await service.getProfile({ userId: ' @anna ' });
  assert.equal(result.fetchedAt, fetchedAt);
  assert.deepEqual(result.profile, {
    userId: '123', firstName: 'Anna', lastName: null, displayName: 'Anna', username: 'anna',
    isContact: true, isBot: false, isDeleted: false, about: 'Hello', isPremium: false,
    isVerified: false, commonChatsCount: 2, birthday: { day: 1, month: 10, year: null },
    birthdayStatus: 'visible'
  });
  assert.deepEqual(state.targets, ['@anna']);
  assert.ok(state.requests[0] instanceof Api.users.GetFullUser);
  assert.ok(state.requests[0].id instanceof Api.InputUser);
  assert.ok(state.requests[0].getBytes().length > 0);
  assert.equal(client.floodSleepThreshold, 0);
  assert.equal(state.destroyed, 1);
  assert.doesNotMatch(JSON.stringify(result), /accessHash|private/);
});

test('numeric user IDs retain precision and are never interpreted as phone numbers', async () => {
  const { service, state } = fixture();
  await service.getProfile({ userId: '9007199254740993' });
  assert.deepEqual(state.targets, [9007199254740993n]);
});

test('profile represents an unavailable birthday without guessing the privacy reason', async () => {
  const { service } = fixture({
    async getInputEntity(target) {
      assert.equal(target, 'me');
      return new Api.InputPeerSelf();
    },
    async invoke(request) {
      assert.ok(request.id instanceof Api.InputUserSelf);
      return { fullUser: { id: 123n }, users: [new Api.User({ id: 123n, firstName: 'Anna' })] };
    }
  });
  const { profile } = await service.getProfile({ userId: 'me' });
  assert.equal(profile.birthday, null);
  assert.equal(profile.birthdayStatus, 'not_set_or_not_visible');
});

test('profile resolves a non-contact numeric ID through a bounded dialog lookup', async () => {
  let scanned = 0;
  const { service, state } = fixture({
    async getInputEntity() { throw new Error('Could not find the input entity for user'); },
    async *iterDialogs(options) {
      assert.equal(options.limit, 500);
      scanned++;
      yield { entity: new Api.Channel({ id: 123n }) };
      scanned++;
      yield { entity: new Api.User({ id: 123n, accessHash: 789n }) };
      throw new Error('Must stop after the matching user');
    }
  });
  await service.getProfile({ userId: '123' });
  assert.equal(scanned, 2);
  assert.equal(String(state.requests[0].id.accessHash), '789');
  assert.equal(state.destroyed, 1);
});

test('profile validates selectors before connecting and rejects chat/channel profiles', async () => {
  const { service, state } = fixture({
    async getInputEntity() { return new Api.InputPeerChannel({ channelId: 1n, accessHash: 2n }); }
  });
  for (const userId of [undefined, 123, '', ' ', '-100123', '0', '+37312345678', 'https://t.me/anna', 'Anna Smith', '9223372036854775808']) {
    await assert.rejects(service.getProfile({ userId }), /userId must/);
  }
  assert.equal(state.connections, 0);
  await assert.rejects(service.getProfile({ userId: '@channel' }), /chat or channel/);
  assert.equal(state.requests.length, 0);
  assert.equal(state.destroyed, 1);
});

test('profile reports an unknown ID and releases the client', async () => {
  const { service, state } = fixture({
    async getInputEntity() { throw new Error('Could not find the input entity for user'); },
    async *iterDialogs() {}
  });
  await assert.rejects(service.getProfile({ userId: '123' }), /Use an exact @username/);
  assert.equal(state.destroyed, 1);
});

test('profile preserves RPC failures without attempting a dialog scan', async () => {
  const failure = new Error('FLOOD_WAIT_300');
  const { service, state } = fixture({ async getInputEntity() { throw failure; } });
  await assert.rejects(service.getProfile({ userId: '123' }), (error) => error === failure);
  assert.equal(state.destroyed, 1);
});

test('birthday list joins users by ID, preserves year and exposes the fixed Telegram window', async () => {
  const { service, state } = fixture({
    async invoke(request) {
      assert.ok(request instanceof Api.contacts.GetBirthdays);
      return {
        contacts: [
          { contactId: 123n, birthday: { day: 31, month: 12, year: 1990 } },
          { contactId: 456n, birthday: { day: 1, month: 1 } },
          { contactId: 789n, birthday: { day: 2, month: 1 } }
        ],
        users: [new Api.User({ id: 456n, firstName: 'B' }), new Api.User({ id: 123n, firstName: 'A' })]
      };
    }
  });
  const result = await service.getContactBirthdays();
  assert.equal(result.count, 3);
  assert.equal(result.fetchedAt, fetchedAt);
  assert.deepEqual(result.window, { daysBefore: 1, daysAfter: 1, determinedBy: 'telegram' });
  assert.deepEqual(result.contacts.map((user) => user.displayName), ['A', 'B', '789']);
  assert.deepEqual(result.contacts.map((user) => user.birthday.year), [1990, null, null]);
  assert.equal(state.destroyed, 1);
});

test('birthday list handles an empty result and destroys the client on RPC failure', async () => {
  const empty = fixture({ async invoke() { return { contacts: [], users: [] }; } });
  const result = await empty.service.getContactBirthdays();
  assert.equal(result.count, 0);
  assert.deepEqual(result.contacts, []);
  assert.equal(empty.state.destroyed, 1);
  const failure = new Error('Telegram unavailable');
  const failing = fixture({ async invoke() { throw failure; } });
  await assert.rejects(failing.service.getContactBirthdays(), (error) => error === failure);
  assert.equal(failing.state.destroyed, 1);
});
