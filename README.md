# Navya Bakers: Scratch & Win (demo)

QR scratch-coupon system for Navya Bakers. Staff print coupons from the admin panel and hand them to customers. A customer scans the QR, enters their details, scratches a card on their phone and wins a random gift. At the counter, staff scan the reward QR to hand over the gift.

## Run it

```
npm install
npm start
```

- Admin: http://localhost:3000/admin
- Admin password: set the `ADMIN_PASSWORD` env var before the first run. Otherwise a random password is generated and printed in the server console on first start. You can change it later in **Settings**.
- Requires Node 22.13 or newer (uses the built-in `node:sqlite`; data is stored in `data/navya.db`)

## Testing with a phone

When you open the admin on `localhost`, the printed QR codes point to your PC's Wi-Fi address (for example `http://192.168.1.7:3000`). A phone on the **same Wi-Fi** can scan them straight off the screen or a printout. If Windows Firewall asks, allow Node on private networks.

For real use, deploy the app and put its domain in **Settings → Website address printed in QR codes** *before* printing.

## What's inside

| Area | What it does |
|---|---|
| Dashboard | Printed, scanned, scratched, winners and redeemed counts; 14-day chart; gift stock; latest winners; top areas |
| Gifts | Add, edit, pause or delete gifts with a photo (upload or preset), win chance (weight), stock limit, validity days, ★ bumper flag, and "Better luck next time" cards. Shows the live odds bar |
| Coupons & Print | Create batches of unique QR coupons (3 designs, expiry date, headline). A4 print sheet with 8 per page and cut marks. View each coupon's status, void unused ones |
| Customer page (`/c/CODE`) | Branded form (name, mobile, area, birthday, WhatsApp opt-in), then a scratch card with foil, confetti and vibration, then the reward code + QR, validity, WhatsApp share and shop directions. Shows "Already claimed" on re-scan from another phone; the winner's own phone shows their reward again |
| Redeem at counter | Camera QR scanner or typed code. Shows the customer, gift and validity, then **Mark redeemed**. Blocks double redemption and expired rewards |
| Customers | Search, CSV export (opens in Excel), and one-tap WhatsApp message with the reward code |
| Settings | QR base URL, one win per mobile number per campaign, terms, shop details, admin password, remove demo data |

**Fairness and safety:** the gift is chosen on the server, weighted by chance and limited by stock, at the moment of claiming, so it can't be changed from the phone. Each coupon can only be claimed once (enforced in a database transaction). Claim attempts are throttled per IP.

## Demo data

On first run the app seeds 7 gifts and a "Festive Sweet Scratch" batch of 24 coupons. Nine of them come with sample customers so the dashboard isn't empty. Remove them in **Settings → Demo data**. To start completely fresh, stop the server and delete the `data/` folder.

## Deploying (IntelliJohn VPS)

1. Copy the folder and run `npm install --omit=dev`.
2. Start it with `PORT=3000 ADMIN_PASSWORD=... node --no-warnings server.js` under pm2 or systemd.
3. Put Nginx with HTTPS in front of it, for example at `scratch.navyabakers.com`. HTTPS is required for the counter camera scanner on phones.
4. Set that URL in Settings, then print.

## Ideas for v2

- WhatsApp OTP check of the mobile number before scratching (through the WhatsApp bot)
- Automatic WhatsApp message with the reward code, plus reminders before it expires
- Birthday greetings and offers using the collected birthdays
- Multiple outlets, with redemption tracked per branch and per staff login
