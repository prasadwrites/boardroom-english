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
| `scripts/build.mjs` | Wraps `src/app.html` into `public/index.html` for Firebase Hosting and bundles `web/auth.js` into `public/auth.js`. |
| `web/auth.js` | Web-only sign-in (Google or email and password, via Firebase Authentication) and Firestore sync of each user's decks and piles. |
| `firestore.rules` | Lets each signed-in user read and write only `users/<their uid>/…`. |
| `functions/index.js` | `POST /api/generate`: a Cloud Function that asks Claude (`claude-opus-5-5`) for a batch of up to 25 questions. |
| `firebase.json` | Hosting config and the `/api/generate` rewrite. |
| `.github/workflows/deploy.yml` | Deploys hosting and functions on every push to `main`. |

On the web, signed-out visitors keep their decks and progress in the browser's localStorage. After signing in, everything is saved to their account in Firestore (`users/<uid>/items`, docs `deck-<id>` and `prog-<id>`), and decks made before signing in are copied into the account. Signing out clears the browser's copy. When the app runs as a Claude artifact, it uses the viewer's Claude account instead, and does not need the function.

## Deploying to Firebase

1. Create a Firebase project and upgrade it to the **Blaze** plan (Cloud Functions need it). Put its project ID in `.firebaserc`, or set the `FIREBASE_PROJECT_ID` repository variable.
2. In the GitHub repo, open Settings > Environments > `FIREBASE_SERVICE_ACCOUNT` and add these environment secrets:
   - `FIREBASE_SERVICE_ACCOUNT`: the Firebase service-account JSON key. The account needs the Editor, Service Account User, Secret Manager Admin and Cloud Functions Admin roles.
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `GENERATE_ACCESS_CODE` (optional): a code people must type before generating decks. If you leave it unset, no code is required.
   The deploy workflow copies the last two into Google Secret Manager for the Cloud Function.
3. In the Firebase console, open Authentication > Sign-in method and enable **Google** and **Email/Password**. The deploy workflow creates the Firestore database and registers the web app if they don't exist yet.
4. Push to `main` (or run the "Deploy to Firebase" workflow) to deploy. You can also run `firebase deploy` from your own machine after setting the secrets with `firebase functions:secrets:set`.

## Local preview

```
node scripts/build.mjs
npx firebase-tools emulators:start --only hosting,functions
```
