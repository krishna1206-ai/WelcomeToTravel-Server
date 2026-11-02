const PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BODY_LENGTH = 200;
const TIMEOUT_MS = 10_000;

// Returns the tokens Expo says no longer reach a device, so they can be forgotten.
export function createPushSender(fetchImpl = fetch) {
  return {
    async send(tokens, { title, body, data }) {
      const response = await fetchImpl(PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify(
          tokens.map((to) => ({
            to,
            title,
            body: body.slice(0, MAX_BODY_LENGTH),
            data,
            sound: 'default',
            channelId: 'default',
          })),
        ),
      });
      if (!response.ok) throw new Error(`Expo push failed with status ${response.status}`);
      const { data: tickets = [] } = await response.json();
      return tokens.filter((_, index) => tickets[index]?.details?.error === 'DeviceNotRegistered');
    },
  };
}
