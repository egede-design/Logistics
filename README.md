# Internal Requisition Management System

A small internal workflow application for requesting, approving, and issuing supplies. It uses an Express backend, JSON files stored outside the public directory, file-backed sessions, bcrypt password hashes, and real `.xlsx` exports.

## Requirements

- Node.js 18 or newer
- npm

## Install and run

From this project folder:

```powershell
Copy-Item .env.example .env
npm.cmd install
```

Create a `.env` file by copying `.env.example`, then set a unique session secret of at least 32 characters and your organization name. For example, PowerShell can generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the generated value in `SESSION_SECRET` in `.env`. Do not commit `.env`.

Start the service:

```powershell
npm.cmd start
```

Open `http://localhost:3000`. The first visit presents the one-time administrator setup form. Create the Administrator account with a unique username and a strong password of at least 12 characters. There are no default credentials.

The organization name defaults to **Liberia Medicines & Health Product Regulatory Authority (LMHRA)**. To change the logo, place the image at `public/pictures/logo.png` and refresh the browser. The `public/pictures/README.md` file contains the logo instructions; until an image is added, the interface shows the IR placeholder.

For development with automatic server restarts:

```powershell
npm.cmd run dev
```

## Accounts and workflow

1. The Administrator creates Issuer and Requester accounts from **User management**. The initial password is temporary; the user must set a new password at first sign-in.
2. A Requester creates a requisition, adds one or more items, then submits it for approval.
3. The Administrator reviews pending requests, records decision remarks, and approves or rejects.
4. An Issuer opens approved or partially issued requests, enters additional quantities, and records remarks for shortages or unavailable items. Each saved issue remains in the transaction history.
5. Requesters and Administrators can view issued totals, outstanding quantities, item remarks, and issuance history from the requisition details and print a current requisition document.

Permissions and quantity rules are enforced by the backend. The Issuer cannot issue more than the remaining quantity; quantities must be whole numbers. Rejection reasons are required.

## Reports

Administrators can choose a month and year under **Reports**, optionally filter by department, requester, issuer, requisition number, or status, and download a formatted Microsoft Excel workbook. It contains summary totals, a requisition/item worksheet, and a detailed issuance-history worksheet. Requisition submission date determines the monthly period. Administrators can also export the currently filtered requisition register to Excel.

## Backup and restore

Use **Settings & backup** to download a JSON backup or restore a trusted backup. Restore replaces the current application records and requires an active Administrator in the backup. Keep backup files private: they contain account information and password hashes.

## Storage and configuration

Persistent application data and file-backed sessions are created under `data/` and are not served publicly. JSON writes are serialized and written through temporary files before replacement. Backups are downloaded to the Administrator's computer rather than exposed as public files. `data/`, `backups/`, `.env`, and installed dependencies are excluded from version control.

Relevant environment variables:

| Name | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to `3000`) |
| `SESSION_SECRET` | Required random session-signing secret (at least 32 characters) |
| `ORGANIZATION_NAME` | Organization name shown in the interface and initial settings |
| `NODE_ENV` | Set to `production` when deployed over HTTPS to enable secure session cookies |
| `DATA_DIR` | Optional absolute path for JSON and session files (defaults to the project's `data/` directory) |

For production, serve behind HTTPS, use a strong private session secret, restrict network access to authorized staff, and protect backups and the host filesystem. The file-backed JSON store is intended for a small internal deployment; it is not a substitute for a transactional database at larger scale.
