# Scratch & Win: QR scratch coupons for bakeries

A multi-bakery platform. Each bakery prints its own QR coupons and hands them to customers. A customer scans the QR, enters their details, scratches a card on their phone and wins a random gift. At the counter, staff scan the reward QR to hand the gift over.

The **platform owner** (Super Admin) adds bakeries, sets their passwords and controls their plans. Every bakery sees only its own gifts, coupons and customers, and its customers see the bakery's own logo, colours and details.

Live: https://navya-scratch-coupons.vercel.app (Navya Bakers was the first bakery).

## Who uses what

| Page | Who | What they do |
|---|---|---|
| `/super` | You, the platform owner | Add bakeries; set or reset their passwords; suspend them; set plan end dates and coupon limits; see each bakery's usage; **Open as bakery** to help them; delete a bakery |
| `/admin` | Each bakery (username + password) | Dashboard, gifts, coupon batches and printing, customers, counter redemption, its own branding and settings |
| `/c/CODE` | The bakery's customers | Scan → details → scratch → reward, in the bakery's branding |

### Account rules
- **Pausing:** a **suspended** bakery, or one past its **plan end date**, can't log in. Its customers see "This offer is paused", and existing winners can still see their reward.
- **Coupon limit:** a bakery can't create more coupons than its plan allows.
- **Password resets:** resetting a bakery's password, or suspending it, signs it out everywhere. A bakery can change its own password; doing so requires the current one.
- **Open as bakery:** this needs a live Super Admin session and expires after 2 hours. It can't change the bakery's password.
- **Storage:** passwords are stored as salted scrypt hashes, never as plain text.

## Run it locally

```
npm install
neon link --project-id <neon-project-id> --branch production   # writes DATABASE_URL to .env.local
npm run db:setup          # creates the tables
npm start
```

- Bakery admin: http://localhost:3000/admin · Super Admin: http://localhost:3000/super
- **Use a Neon branch for development** (e.g. `dev`), so local testing never touches live data. The Claude preview config loads `.env.dev`, which points at the `dev` branch.
- Requires Node 22.9 or newer.

### Environment variables

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `SESSION_SECRET` | recommended | Signs login cookies (otherwise a secret stored in the database is used) |
| `SUPER_ADMIN_PASSWORD` | first run | Initial Super Admin password. Without it a random one is printed in the server log on first start |

**Forgot the Super Admin password?** Put a new one (10+ characters) in `SUPER_ADMIN_PASSWORD` in `.env.local` and run `npm run super:password`.

## Database

Tables are defined in [`db/schema.sql`](db/schema.sql) and created or updated automatically on start:

| Table | Holds |
|---|---|
| `tenants` | One row per bakery: login, branding, plan, status |
| `gifts` | Each bakery's prizes, with chance, stock and validity |
| `batches` | Each print run of coupons |
| `coupons` | Every printed coupon, with the customer's details, what they won, and claim and redeem times |
| `settings` | Platform values (session secret, Super Admin password hash) |

**Fairness and safety:** the gift is chosen on the server, at the moment of claiming, from the bakery's own gifts, weighted by chance and limited by stock. Claims lock the coupon and gift rows, so a coupon can't be claimed twice and the last unit of a prize can't be won twice. Redemption is a single conditional update, so two counters can't redeem the same reward. Every bakery-admin query is scoped to the signed-in bakery.

## Deploying

- **Vercel** (current): every push to `main` deploys. The project needs `DATABASE_URL` and `SESSION_SECRET` set as environment variables.
- **VPS:** run `npm install --omit=dev`, then `PORT=3000 DATABASE_URL=... node --no-warnings server.js` under pm2/systemd, with Nginx + HTTPS in front. HTTPS is required for the counter camera scanner on phones.

Before a bakery prints real coupons, check the QR web address in its **Settings**.

## Ideas for next versions

- Each bakery on its own web address (custom domain or subdomain)
- Staff logins per bakery (counter-only access for redemption)
- Billing reminders when a plan is close to its end date
- WhatsApp OTP check of the mobile number, and automatic WhatsApp messages with the reward code
