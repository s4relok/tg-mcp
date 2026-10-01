import { createRequire } from 'node:module';

import { createAuthorizedTelegramClient } from './telegramSync.js';

const require = createRequire(import.meta.url);
const { Api, utils } = require('telegram');
const DIALOG_LOOKUP_LIMIT = 500;

function normalizeBirthday(birthday) {
  return birthday ? {
    day: birthday.day,
    month: birthday.month,
    year: birthday.year ?? null
  } : null;
}

function normalizeUser(user, userId = user?.id) {
  return {
    userId: String(userId),
    firstName: user?.firstName || null,
    lastName: user?.lastName || null,
    displayName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || String(userId),
    username: user?.username || null,
    isContact: Boolean(user?.contact),
    isBot: Boolean(user?.bot),
    isDeleted: Boolean(user?.deleted)
  };
}

function validateUserId(userId) {
  if (typeof userId !== 'string') {
    throw new Error('userId must be a Telegram user ID, @username, or me');
  }
  const value = userId.trim();
  if (value === 'me' || /^@?[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(value)) {
    return value;
  }
  if (/^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n) {
    // Numeric strings are otherwise treated as phone numbers by GramJS.
    return BigInt(value);
  }
  throw new Error('userId must be a positive Telegram user ID, @username, or me; phone numbers and links are not supported');
}

async function resolveUser(client, target) {
  let peer;
  try {
    peer = await client.getInputEntity(target);
  } catch (error) {
    if (typeof target !== 'bigint' || !/^Could not find the input entity/.test(error.message)) {
      throw error;
    }
    // StringSession does not retain access hashes across connections. Resolve
    // a known private dialog by ID, with a bounded scan when it is not a contact.
    for await (const dialog of client.iterDialogs({ limit: DIALOG_LOOKUP_LIMIT })) {
      if (dialog.entity instanceof Api.User && String(dialog.entity.id) === String(target)) {
        peer = utils.getInputPeer(dialog.entity);
        break;
      }
    }
    if (!peer) {
      throw new Error(`User ID was not found in contacts or the latest ${DIALOG_LOOKUP_LIMIT} dialogs. Use an exact @username instead.`);
    }
  }
  if (!(peer instanceof Api.InputPeerUser) && !(peer instanceof Api.InputPeerSelf)) {
    throw new Error('The requested profile belongs to a chat or channel; specify a Telegram user');
  }
  return utils.getInputUser(peer);
}

export function createTelegramProfileService({
  config,
  createClient = createAuthorizedTelegramClient,
  now = () => new Date()
}) {
  async function withClient(run) {
    const client = await createClient(config);
    try {
      client.floodSleepThreshold = 0;
      return await run(client);
    } finally {
      // This is a disposable client: destroy also stops GramJS update loops.
      if (typeof client.destroy === 'function') {
        await client.destroy();
      } else {
        await client.disconnect();
      }
    }
  }

  return {
    async getProfile({ userId } = {}) {
      const target = validateUserId(userId);
      return withClient(async (client) => {
        const id = await resolveUser(client, target);
        const result = await client.invoke(new Api.users.GetFullUser({ id }));
        const full = result.fullUser;
        const user = (result.users || []).find((entry) => String(entry.id) === String(full.id));
        if (!user || user instanceof Api.UserEmpty) {
          throw new Error('Telegram did not return the requested user profile');
        }
        const birthday = normalizeBirthday(full.birthday);
        return {
          fetchedAt: now().toISOString(),
          profile: {
            ...normalizeUser(user),
            about: full.about || null,
            isPremium: Boolean(user.premium),
            isVerified: Boolean(user.verified),
            commonChatsCount: full.commonChatsCount ?? null,
            birthday,
            birthdayStatus: birthday ? 'visible' : 'not_set_or_not_visible'
          }
        };
      });
    },

    async getContactBirthdays() {
      return withClient(async (client) => {
        const result = await client.invoke(new Api.contacts.GetBirthdays());
        const users = new Map((result.users || []).map((user) => [String(user.id), user]));
        const contacts = (result.contacts || []).map((contact) => ({
          ...normalizeUser(users.get(String(contact.contactId)), contact.contactId),
          birthday: normalizeBirthday(contact.birthday)
        }));
        return {
          fetchedAt: now().toISOString(),
          window: { daysBefore: 1, daysAfter: 1, determinedBy: 'telegram' },
          note: 'Telegram returns visible birthdays near today (yesterday, today and tomorrow), not a complete birthday calendar. Missing birth years remain null.',
          count: contacts.length,
          contacts
        };
      });
    }
  };
}
