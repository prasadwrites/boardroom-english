# Boardroom English

Flashcards for spoken Business English. Each deck turns into a multiple-choice game:

- A card you get wrong goes to the **Repeat** pile and comes back more often.
- Get a card right **5 times in a row** and it moves to **Learned**, so you stop seeing it.
- Create new decks: describe a focus, choose how many questions (up to 500), and Claude writes them.

Starter decks: Business Phrases, Core Vocabulary, Meetings & Calls.

## Layout

| Path | What it is |
| --- | --- |
| `src/app.html` | The whole app (HTML, CSS, JS). The same file is also published as a Claude artifact. |
| `scripts/build.mjs` | Wraps `src/app.html` into `public/index.html` for Firebase Hosting. |
| `functions/index.js` | `POST /api/generate`: a Cloud Function that asks Claude (`claude-opus-5-5`) for a batch of up to 25 questions. |
| `firebase.json` | Hosting config and the `/api/generate` rewrite. |
| `.github/workflows/deploy.yml` | Deploys hosting and functions on every push to `main`. |

On the web, progress and your own decks are saved in the browser's localStorage. When the app runs as a Claude artifact, it uses the viewer's Claude account instead, and does not need the function.

## Deploying to Firebase

1. Create a Firebase project and upgrade it to the **Blaze** plan (Cloud Functions need it). Put its project ID in `.firebaserc`, or set the `FIREBASE_PROJECT_ID` repository variable.
2. Store your Anthropic API key as a function secret:
   `firebase functions:secrets:set ANTHROPIC_API_KEY`
3. Optional but recommended, so strangers can't spend your API credit:
   `firebase functions:secrets:set GENERATE_ACCESS_CODE`
   If you don't want an access code, set this secret to an empty value. The app asks for the code on the New deck form.
4. Deploy from your machine with `firebase deploy`, or let GitHub Actions do it: add a service-account key with the Firebase Admin role as the `FIREBASE_SERVICE_ACCOUNT` repository secret, then push to `main`.

## Local preview

```
node scripts/build.mjs
npx firebase-tools emulators:start --only hosting,functions
```
