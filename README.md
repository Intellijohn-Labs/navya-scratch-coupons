# Genuine Draw: QR coupons & lucky draws you can trust

A multi-merchant platform (formerly "Scratch & Win"). Each bakery prints its own QR coupons and hands them to customers. A customer scans the QR, enters their details, scratches a card on their phone and wins a random gift. At the counter, staff scan the reward QR to hand the gift over.

The **platform owner** (Super Admin) adds bakeries, sets their passwords and controls their plans. Every bakery sees only its own gifts, coupons and customers, and its customers see the bakery's own logo, colours and details.

Live: https://genuinedraw.in (Super Admin, sign-up, verify, customer portal) and https://<merchant>.genuinedraw.in (each merchant's admin and coupons). Navya Bakers was the first merchant.

## Who uses what

| Page | Who | What they do |
|---|---|---|
| `/super` | You, the platform owner | Add bakeries; set or reset their passwords; suspend them; set plan end dates and coupon limits; see each bakery's usage; **Open as bakery** to help them; delete a bakery |
| `/admin` | Each merchant: the owner, plus staff logins | Dashboard, gifts, coupon batches and printing, customers, counter redemption, **outlets**, **team**, **activity log**, branding and settings |
| `/c/CODE` | The bakery's customers | Scan → details → scratch → reward (Instant Win) or a draw entry (Lucky Draw), in the merchant's branding |
| `/register` | New businesses | Sign up; the account waits for Super Admin approval |
| `/verify` | Anyone | Check a coupon or reward code: genuine or not, its status, and its tamper-evident log fingerprint |
| `/my` | Customers | Sign in with a WhatsApp code; see coupons from every shop; raise and follow complaints |

### Campaigns (Phase 1)
Coupon batches belong to a **campaign** with start and end dates, terms, and a type:
- **Instant Win:** scratch and win one of the merchant's gifts on the spot.
- **Lucky Draw:** each coupon is one entry; the campaign has a prize list and a draw date. (The draw itself is Phase 3.)

Coupons only work between the campaign's start and end dates, and not while it is paused. Once customers have played, the campaign's type can't change and it can't be deleted. **Reports** show printed, scanned, played, winners, entries and redeemed per campaign and per outlet for any date range, with a CSV download.

### Sign-up and approval (Phase 1)
Businesses register at `/register` and start as **pending**. Super Admin → **Approvals** approves them (optionally setting a plan end date and coupon limit) or rejects them with a reason, which the merchant sees when they try to sign in.

### Lucky Draw (Phase 3)
On or after the draw date the owner presses **Run the draw** on the campaign:
1. **Seal:** the entry list is frozen (no new entries), its SHA-256 fingerprint is written to the activity log, and a drand round about 90 s in the future is chosen.
2. **Draw:** when that round is published, `seed = sha256(fingerprint + ":" + drand randomness)`. Pick k takes `sha256(seed + ":" + k)` modulo the entries left; one prize per person; prizes from rank 1 down, then backups.

Winners' coupons become prizes with a reward code (valid for the campaign's "collect within" days) and are redeemed at the counter like any prize. **Forfeit** passes a prize to the next backup. `/draw/:id` is the public live page with a "Verify in my browser" button that re-runs every step; `/winners` lists all draws. Winners get the `gd_draw_winner` WhatsApp template.

### Complaints (Phase 2)
Customers raise tickets (`GD-XXXXXX`) from `/my`. The coupon, outlet, campaign and time are attached automatically; a photo is optional. The merchant answers from **Complaints**. A ticket not resolved within **24 hours** escalates to Super Admin → **Complaints** automatically, and the customer can escalate it at any time.

### WhatsApp
Set `WHATSAPP_WEBHOOK_URL` to an n8n / WAAU webhook. The app POSTs `{ to, type, message, data }` for: login codes (`otp`), new and updated complaints, escalations, sign-ups, approvals and rejections. Without it, nothing is sent; locally the login code is shown on screen, and on Vercel the customer login says it is being set up (set `OTP_DEV_MODE=1` to show codes on screen there too, for testing only).

### Merchant staff (Phase 0)
| Role | Can do |
|---|---|
| **Owner** (merchant username) | Everything |
| **Manager** | Gifts, coupons, customers, redemption, view outlets. Not settings, team or the activity log |
| **Counter** | Only check and redeem rewards, always recorded at their own outlet |

Batches can be assigned to an **outlet**. The dashboard shows coupons handed out, scratched and redeemed per outlet.

### Activity log (tamper-evident)
Every important action (sign-ins; gift, batch, staff and outlet changes; customer claims; redemptions; Super Admin actions) is written to `audit_log`. Each entry stores the SHA-256 of the previous entry, so editing or deleting history breaks the chain. Super Admin → Activity log → **Verify log** re-checks every entry. Customer names and phone numbers are masked in the log.

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
| `WAAU_PHONE_NUMBER_ID`, `WAAU_ACCESS_TOKEN` | for WhatsApp | WAAU bot that sends the approved `gd_*` templates (login codes, sign-up, approval, complaints) |
| `SUPER_WHATSAPP` | optional | Super Admin's WhatsApp number for sign-up and escalation alerts |
| `OTP_DEV_MODE` | testing only | `1` shows customer login codes on screen when no webhook is set |

**Forgot the Super Admin password?** Put a new one (10+ characters) in `SUPER_ADMIN_PASSWORD` in `.env.local` and run `npm run super:password`.

## Database

Tables are defined in [`db/schema.sql`](db/schema.sql) and created or updated automatically on start:

| Table | Holds |
|---|---|
| `tenants` | One row per merchant: owner login, branding, plan, status |
| `outlets` | A merchant's branches |
| `staff` | Manager and counter logins |
| `audit_log` | Hash-chained activity log (never updated) |
| `gifts` | Each bakery's prizes, with chance, stock and validity |
| `campaigns` | Instant Win / Lucky Draw campaigns with dates, terms and status |
| `campaign_prizes` | A Lucky Draw's announced prizes |
| `batches` | Each print run of coupons, inside a campaign |
| `complaints`, `complaint_messages` | Customer tickets and their conversation |
| `otp_codes` | Hashed one-time login codes for the customer portal |
| `coupons` | Every printed coupon, with the customer's details, what they won, and claim and redeem times |
| `settings` | Platform values (session secret, Super Admin password hash) |

**Fairness and safety:** the gift is chosen on the server, at the moment of claiming, from the bakery's own gifts, weighted by chance and limited by stock. Claims lock the coupon and gift rows, so a coupon can't be claimed twice and the last unit of a prize can't be won twice. Redemption is a single conditional update, so two counters can't redeem the same reward. Every bakery-admin query is scoped to the signed-in bakery.

## Deploying

- **Vercel** (current): every push to `main` deploys. The project needs `DATABASE_URL` and `SESSION_SECRET` set as environment variables.
- **VPS:** run `npm install --omit=dev`, then `PORT=3000 DATABASE_URL=... node --no-warnings server.js` under pm2/systemd, with Nginx + HTTPS in front. HTTPS is required for the counter camera scanner on phones.

Before a bakery prints real coupons, check the QR web address in its **Settings**.

## Ideas for next versions

- Phase 3: the transparent Lucky Draw itself (seeded, verifiable winner selection, public winners page)
- Billing reminders when a plan is close to its end date
- WhatsApp message with the reward code right after a win
