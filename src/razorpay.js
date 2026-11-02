import { HttpError } from './validate.js';

const API_URL = 'https://api.razorpay.com/v1';
// Returns null when no keys are set, so bookings still work without online payment.
export function createRazorpay(env = process.env, fetchImpl = fetch) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const currency = env.RAZORPAY_CURRENCY ?? 'AUD';

  async function call(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(API_URL + path, {
        ...options,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Could not reach Razorpay', error);
      throw new HttpError(502, 'Payment could not be started. Please try again.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Razorpay ${path} failed (${response.status}):`, data?.error?.description ?? data);
      throw new HttpError(502, 'Payment could not be started. Please try again.');
    }
    return data;
  }

  return {
    currency,
    // Amounts are in cents, which is the smallest unit Razorpay expects for AUD and INR.
    createLink: ({ amountCents, description, customer, callbackUrl, bookingId }) =>
      call('/payment_links/', {
        method: 'POST',
        body: JSON.stringify({
          amount: amountCents,
          currency,
          description,
          customer,
          notify: { sms: false, email: false },
          reminder_enable: false,
          notes: { booking_id: String(bookingId) },
          callback_url: callbackUrl,
          callback_method: 'get',
        }),
      }),
    fetchLink: (id) => call(`/payment_links/${encodeURIComponent(id)}`),
  };
}
