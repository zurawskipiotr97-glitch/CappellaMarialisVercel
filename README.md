# Cappella Marialis – Website & Serverless Backend

## Overview
This repository contains the source code for **Cappella Marialis**, a real-world production website built with a static frontend and a serverless backend deployed on Vercel.

The project demonstrates full-stack web development with a focus on security, external service integrations, and production-ready architecture.

---

## Tech Stack

### Frontend
- HTML5 / CSS3 / JavaScript
- Multilingual content (PL / EN)
- Responsive, accessible layout
- Static delivery via Vercel

### Backend
- Vercel Serverless Functions (`/api`)
- Node.js runtime

### Integrations
- **Przelewy24** – online payments and donations
- **Supabase** – database and backend services
- **Facebook API** – external content / OAuth integration
- **Email service** – transactional notifications

---

## Architecture

- The frontend is fully static and contains **no secrets**.
- All sensitive logic (payments, database access, external APIs) is handled server-side.
- Secrets and credentials are injected exclusively via environment variables.

```
Browser
  ↓
Static Frontend (HTML / CSS / JS)
  ↓
Vercel Serverless API (/api)
  ↓
External Services (Przelewy24, Supabase, Facebook)
```

---

## Environment Variables & Secrets

This repository intentionally contains **no API keys, secrets, or credentials**.

All sensitive configuration values are provided via environment variables at runtime, for example:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PRZELEWY24_MERCHANT_ID`
- `PRZELEWY24_API_KEY`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`

`.env` files are excluded via `.gitignore` and must never be committed.

---

## Security

- The full Git history has been scanned with **gitleaks** (all commits, all branches).
- No leaked secrets were found.
- Sensitive keys are used **only server-side** and are never exposed to the client.
- Payment processing is delegated entirely to **Przelewy24** – no card data is stored or processed by this application.

A dedicated `SECURITY.md` file describes the security policy and responsible disclosure process.

---

## Deployment

The project is designed for deployment on **Vercel**:

1. Import the repository into Vercel
2. Configure required environment variables in the Vercel dashboard
3. Deploy

No additional build steps are required for the frontend.

---

## GDPR & Privacy

- The repository does not contain personal data
- No user data is stored in the frontend
- Personal or payment-related data is processed exclusively by trusted third-party providers

---

## Portfolio Use

This repository represents a **real production project** and is suitable for portfolio and CV presentation.

It demonstrates:
- Full-stack web development
- Serverless backend architecture
- Secure secret management
- Integration with external APIs and payment systems

---

## License

This project is provided for educational and portfolio purposes.

