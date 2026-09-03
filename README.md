# Libre 3 Live Glucose Dashboard

A local web dashboard for viewing FreeStyle Libre 3 glucose readings in real time using LibreLinkUp.

## Features
- Live glucose value
- Trend arrows
- Dark dashboard UI
- Graph with target ranges
- Watch-friendly `/watch` page

## Setup

### 1. Install Node.js
https://nodejs.org (install LTS)

Verify:
node -v
npm -v

### 2. Install dependencies
npm install

### 3. Configure environment
Copy:
cp .env.example .env

Edit `.env`:
LIBRE_EMAIL=your_email
LIBRE_PASSWORD=your_password
LIBRE_REGION=us
LIBRE_LINK_UP_VERSION=5.1.1
POLL_SECONDS=60

### 4. Run
npm start

Open:
http://localhost:3000

Watch view:
http://localhost:3000/watch

## Notes
- Keep Libre app alarms enabled
- Do not share credentials
- Update LIBRE_LINK_UP_VERSION if errors occur
