# OpenClass

Full-stack education platform with Firebase-powered frontend and Express backend.

## Stack

- **Frontend**: Vanilla JS + Vite
- **Backend**: Node.js + Express (Firebase as primary backend)
- **Auth**: Firebase Authentication
- **Database**: Firestore
- **Storage**: Firebase Storage
- **Realtime**: Firestore `onSnapshot`

## Quick Start

```bash
npm install
npm run dev
```

This starts both the frontend (Vite dev server on port 5173) and backend (Express on port 5000) concurrently.

## Project Structure

```
├── client/          # Frontend (Vite + Firebase)
│   ├── src/         # Application source
│   ├── public/      # Static assets
│   └── index.html   # Entry point
├── server/          # Backend (Express)
│   └── src/         # Server source
├── package.json     # Root workspace config
└── .gitignore
```
