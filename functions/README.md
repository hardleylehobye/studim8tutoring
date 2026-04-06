# StudiM8 Cloud Functions (PayFast)

Uses **Cloud Functions 1st gen** (`firebase-functions/v1`).

Firebase does **not** support turning an existing Gen1 function into Gen2 with the same name. If you see that error, delete the old functions first:

```powershell
firebase functions:delete payfastInit --region europe-west1 --force
firebase functions:delete payfastItn --region europe-west1 --force
```

## Prerequisites

- Firebase **Blaze** plan.

## Configuration (Gen1): `functions.config()`

Gen1 **does not** use `functions/.env` at runtime. Set config once (use **your** PayFast values; live vs sandbox):

```powershell
firebase functions:config:set `
  payfast.merchant_id="YOUR_ID" `
  payfast.merchant_key="YOUR_KEY" `
  payfast.passphrase="" `
  payfast.sandbox="false" `
  app.public_origin="https://hardleylehobye.github.io/studim8tutoring"
```

- Use `payfast.sandbox="true"` only with **sandbox** merchant credentials from [sandbox.payfast.co.za](https://sandbox.payfast.co.za).
- If you use a PayFast passphrase, set `payfast.passphrase="your-phrase"` (must match PayFast dashboard).

`functions/.env` is optional — only for your own notes; mirror the same values if you like.

## Deploy

```powershell
cd functions
npm install
cd ..
firebase deploy --only functions
```

**PowerShell** (with Firestore rules):

```powershell
firebase deploy --only "functions,firestore:rules"
```

## PayFast ITN URL

`https://europe-west1-studim8tutoring-bba8e.cloudfunctions.net/payfastItn`

## Troubleshooting

- **Cloud Build / bucket errors:** IAM for `408589098560-compute@developer.gserviceaccount.com` (Storage Object Viewer) and `408589098560@cloudbuild.gserviceaccount.com` (Artifact Registry Writer, Service Account User).
- **Gen2:** If you later need Gen2, create **new** function names (e.g. `payfastInitV2`), point the app at them, then remove Gen1 — do not “upgrade in place.”
