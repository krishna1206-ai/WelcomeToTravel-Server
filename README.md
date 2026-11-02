# Welcome to Travel server

Stores accounts, trips, photos, bookings, trip requests and help messages for the
customer app (`welcometo-travel`) and the admin app (`welcometo-travel-admin`).

Requires Node.js 22.13 or newer.

## Run it

```
npm install
npm run create-admin   # first time only: creates your admin login
npm start              # runs on http://localhost:4100
```

The starter trips are added the first time it runs. All data is kept in the `data` folder:
`data/app.db` is the database and `data/uploads` holds the photos.

**Back up the `data` folder.** Deleting it deletes every account, trip and booking.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database and photos are stored |
| `PUBLIC_URL` | address the app used | Public address of this server, used to bring customers back after paying |
| `RAZORPAY_KEY_ID` | | Razorpay key ID. Online payment is off until both keys are set |
| `RAZORPAY_KEY_SECRET` | | Razorpay key secret. Never put this in either app |
| `RAZORPAY_CURRENCY` | `AUD` | Currency trip prices are charged in |
| `DEPOSIT_PER_TRAVELLER` | `200` | Deposit customers can pay instead of the full amount, per traveller. `0` turns deposits off |
| `CARD_FEE_PERCENT` | `1.75` | Card fee added to the trip price at checkout. `0` turns it off |
| `SMTP_HOST` | | Mail server. Status emails are off until this is set |
| `SMTP_PORT` | `587` | Mail server port |
| `SMTP_USER` | | Mail server username |
| `SMTP_PASS` | | Mail server password |
| `EMAIL_FROM` | `SMTP_USER` | Sender of status emails |

Put these in a `.env` file in this folder. `npm start` reads it, and git ignores it.

Forgot password needs the mail server settings, because the reset code is sent by email.

## Trip reminders

While running, the server checks every hour and reminds customers about confirmed trips 7 days and 1 day
before they start, in the app, by email and by push. It only runs while the server is on.

## Payments

Customers pay on a Razorpay Payment Link after sending a booking. Paying doesn't confirm the booking: it
stays a request until an admin confirms or cancels it. Refunds aren't automatic. If a paid booking is
cancelled, refund it from the Razorpay dashboard.

Run `npm run create-admin` with an existing email to reset that account's password or make it an admin.

## Going online

The included `Dockerfile` runs the server on any host that runs containers, such as Railway, Render or
Fly.io.

1. **Permanent storage is required.** Attach a volume or disk mounted at `/data`. Without it, every
   deploy or restart deletes all accounts, bookings, reviews and photos.
2. **Copy your current data across.** Upload the contents of your local `data` folder into that volume
   before customers start using it.
3. **Set the settings** from the table above as the host's environment variables, plus
   `PUBLIC_URL=https://<your server address>`.
4. **Use the HTTPS address** the host gives you. Then set `EXPO_PUBLIC_API_URL` in the `.env` file of
   both apps to it and rebuild them.
5. **Run one copy only.** The database is a single file, so the server must not be scaled to more than
   one instance.

## Tests

```
npm test
```
